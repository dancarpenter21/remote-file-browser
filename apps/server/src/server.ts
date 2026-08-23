import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, stat, statfs } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import Fastify, { type FastifyReply } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import {
  projectPatchSchema,
  renderRequestSchema,
  effectiveHighlightRange,
  validateHighlightRange,
  validateSections,
  type Project,
} from "@vfx/shared";
import { inspectSource, extractFrame, normalizeCustomCrowd, prepareProjectMedia, readMediaFile } from "./media.js";
import { dataDirectory, webDistDirectory } from "./paths.js";
import {
  createProjectRecord,
  cleanupInterruptedArtifacts,
  deleteProject,
  ensureStorage,
  listProjects,
  projectFile,
  readProject,
  saveProject,
} from "./storage.js";
import { RenderQueue } from "./jobs.js";

function safeExtension(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".media";
}

async function sendRangedFile(requestRange: string | undefined, file: string, reply: FastifyReply, contentType: string, downloadName?: string): Promise<void> {
  const details = await stat(file);
  reply.header("Accept-Ranges", "bytes").header("Content-Type", contentType);
  if (downloadName) reply.header("Content-Disposition", `attachment; filename="${downloadName.replaceAll('"', '')}"`);
  if (!requestRange) {
    reply.header("Content-Length", details.size);
    return reply.send(createReadStream(file));
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(requestRange);
  if (!match) return reply.code(416).send();
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), details.size - 1) : details.size - 1;
  if (start >= details.size || end < start) return reply.code(416).send();
  reply.code(206).header("Content-Range", `bytes ${start}-${end}/${details.size}`).header("Content-Length", end - start + 1);
  return reply.send(createReadStream(file, { start, end }));
}

async function markPreparation(project: Project): Promise<void> {
  try {
    const prepared = await prepareProjectMedia(project);
    const current = await readProject(project.id);
    const highlightWasFullSource = !current.highlightRange || (
      current.highlightRange.startFrame === 0 && current.highlightRange.endFrameExclusive === current.source.frameCount
    );
    current.source.frameCount = prepared.frameCount;
    current.source.durationSeconds = prepared.durationSeconds;
    if (highlightWasFullSource) current.highlightRange = { startFrame: 0, endFrameExclusive: prepared.frameCount };
    current.proxyFilename = prepared.proxyFilename;
    current.waveformFilename = prepared.waveformFilename;
    current.status = "ready";
    current.error = undefined;
    current.updatedAt = new Date().toISOString();
    await saveProject(current);
  } catch (error) {
    const current = await readProject(project.id);
    current.status = "error";
    current.error = error instanceof Error ? error.message : "Media preparation failed.";
    current.updatedAt = new Date().toISOString();
    await saveProject(current);
  }
}

export async function buildServer() {
  await ensureStorage();
  const existingProjects = await listProjects();
  for (const project of existingProjects) {
    await cleanupInterruptedArtifacts(project.id);
    if (project.status === "importing") void markPreparation(project);
  }
  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
  const queue = new RenderQueue();
  await app.register(multipart, { limits: { files: 1, fileSize: 40 * 1024 * 1024 * 1024 } });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin) {
      const allowed = new Set(["http://127.0.0.1:4317", "http://127.0.0.1:5173", "http://localhost:5173"]);
      if (!allowed.has(origin)) return reply.code(403).send({ error: "Unexpected request origin." });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    app.log.error(normalized);
    const candidate = error as { statusCode?: unknown };
    const status = typeof candidate.statusCode === "number" ? candidate.statusCode : 400;
    reply.code(status >= 400 && status < 600 ? status : 500).send({ error: normalized.message });
  });

  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/projects", async () => listProjects());
  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request) => readProject(request.params.id));

  app.post("/api/projects", async (request, reply) => {
    const upload = await request.file();
    if (!upload) return reply.code(400).send({ error: "Choose a source video." });
    const declaredBytes = Number(request.headers["content-length"] ?? 0);
    if (declaredBytes > 0) {
      const filesystem = await statfs(dataDirectory);
      const availableBytes = filesystem.bavail * filesystem.bsize;
      if (availableBytes < declaredBytes * 2 + 1024 ** 3) {
        return reply.code(507).send({ error: "Not enough free disk space to import this source and create working media." });
      }
    }
    const importDirectory = await mkdtemp(path.join(dataDirectory, "import-"));
    const temporary = path.join(importDirectory, "source-upload");
    const hash = createHash("sha256");
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(upload.file, meter, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      const storedName = `source${safeExtension(upload.filename)}`;
      const source = await inspectSource(temporary, upload.filename, storedName, hash.digest("hex"));
      const name = path.basename(upload.filename, path.extname(upload.filename)) || "Untitled video";
      const project = await createProjectRecord(name, source);
      await rename(temporary, projectFile(project.id, storedName));
      await chmod(projectFile(project.id, storedName), 0o400);
      void markPreparation(project);
      return reply.code(202).send(project);
    } finally {
      await rm(importDirectory, { recursive: true, force: true });
    }
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const patch = projectPatchSchema.parse(request.body);
    const project = await readProject(request.params.id);
    if (patch.expectedRevision !== project.revision) return reply.code(409).send({ error: "Project changed in another tab. Reload before editing." });
    const nextSections = patch.sections ?? project.sections;
    const nextHighlight = patch.highlightRange ?? effectiveHighlightRange(project.source.frameCount, project.highlightRange);
    validateSections(nextSections, project.source.frameCount);
    validateHighlightRange(nextHighlight, project.source.frameCount, nextSections);
    if (patch.sections) project.sections = [...patch.sections].sort((a, b) => a.startFrame - b.startFrame);
    if (patch.highlightRange) project.highlightRange = patch.highlightRange;
    if (patch.name !== undefined) project.name = patch.name;
    if (patch.audio !== undefined) project.audio = patch.audio;
    project.revision += 1;
    project.updatedAt = new Date().toISOString();
    return saveProject(project);
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    await readProject(request.params.id);
    await deleteProject(request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/crowd", async (request, reply) => {
    const project = await readProject(request.params.id);
    const upload = await request.file();
    if (!upload) return reply.code(400).send({ error: "Choose an ambience audio file." });
    const temporary = projectFile(project.id, `custom-crowd-${randomUUID()}.upload`);
    try {
      await pipeline(upload.file, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      await normalizeCustomCrowd(project, temporary);
      project.audio.crowdSource = "custom";
      project.revision += 1;
      project.updatedAt = new Date().toISOString();
      return saveProject(project);
    } finally {
      await rm(temporary, { force: true });
    }
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/renders", async (request, reply) => {
    const body = renderRequestSchema.parse(request.body);
    const project = await readProject(request.params.id);
    if (project.status !== "ready") return reply.code(409).send({ error: "Project media is not ready." });
    if (body.expectedRevision !== project.revision) return reply.code(409).send({ error: "Project revision is stale." });
    return reply.code(202).send(queue.enqueue(project, body.kind));
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = queue.get(request.params.id);
    return job ?? reply.code(404).send({ error: "Render job not found." });
  });

  app.delete<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = queue.cancel(request.params.id);
    return job ?? reply.code(404).send({ error: "Render job not found." });
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/events", async (request, reply) => {
    if (!queue.get(request.params.id)) return reply.code(404).send({ error: "Render job not found." });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const unsubscribe = queue.subscribe(request.params.id, (job) => {
      reply.raw.write(`data: ${JSON.stringify(job)}\n\n`);
      if (["succeeded", "failed", "cancelled"].includes(job.status)) {
        unsubscribe();
        reply.raw.end();
      }
    });
    request.raw.on("close", unsubscribe);
  });

  app.get<{ Params: { id: string; frame: string } }>("/api/projects/:id/frames/:frame", async (request, reply) => {
    const project = await readProject(request.params.id);
    const frame = Number(request.params.frame);
    if (!Number.isInteger(frame) || frame < 0 || frame >= project.source.frameCount) return reply.code(400).send({ error: "Invalid frame index." });
    const jpeg = await extractFrame(project, frame);
    return reply.type("image/jpeg").header("Cache-Control", "private, max-age=31536000, immutable").send(jpeg);
  });

  app.get<{ Params: { id: string; kind: "proxy" | "waveform" | "preview" | "export" } }>("/api/projects/:id/media/:kind", async (request, reply) => {
    const project = await readProject(request.params.id);
    if (!["proxy", "waveform", "preview", "export"].includes(request.params.kind)) return reply.code(404).send();
    const file = await readMediaFile(project, request.params.kind);
    const isWaveform = request.params.kind === "waveform";
    const download = request.params.kind === "export" ? `${project.name.replaceAll(/[^a-z0-9_-]+/gi, "-") || "video"}-edited.mp4` : undefined;
    return sendRangedFile(request.headers.range, file, reply, isWaveform ? "image/png" : "video/mp4", download);
  });

  try {
    await app.register(fastifyStatic, { root: webDistDirectory, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found." });
      return reply.sendFile("index.html");
    });
  } catch {
    app.log.warn("Web build not found; API-only mode enabled.");
  }
  return app;
}
