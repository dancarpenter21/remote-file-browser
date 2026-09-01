import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, link, mkdir, mkdtemp, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
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
} from "@remote-workspace/video-shared";
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
import { ffmpegPath } from "./binaries.js";
import { runProcess } from "./process.js";
import {
  ensureLocalSource,
  exchangeRemoteTicket,
  publishRemoteOutput,
  remoteContentUrl,
  remoteFetch,
  remoteFile,
  remoteMediaInfoUrl,
  remoteSession,
  type RemoteFile,
} from "./remote.js";

type UtilityJob = {
  key: string;
  status: "working" | "ready" | "failed";
  progress?: number;
  playable?: boolean;
  playlistUrl?: string;
  error?: string;
  result?: { id: string; name: string };
};

function outputName(value: string, fallback: string): string {
  const name = path.basename(value).replaceAll(/[^a-zA-Z0-9._-]/g, "-");
  return name && name !== "." && name !== ".." ? name : fallback;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

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
  const localOrigins = [
    "http://127.0.0.1:4317",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://linux-server:5173",
    "http://linux-server.local:5173",
  ];
  const configuredOrigins = (process.env.VIDEO_STUDIO_ALLOWED_ORIGINS ?? process.env.VFX_EDITOR_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of configuredOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid VIDEO_STUDIO_ALLOWED_ORIGINS entry: ${origin}`);
    }
    if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`VIDEO_STUDIO_ALLOWED_ORIGINS entries must be HTTP(S) origins without paths: ${origin}`);
    }
  }
  if (process.env.NODE_ENV === "production" && configuredOrigins.length === 0) {
    throw new Error("Set VIDEO_STUDIO_ALLOWED_ORIGINS to the public reverse-proxy origin before starting production.");
  }
  const allowedOrigins = new Set([...localOrigins, ...configuredOrigins]);
  const existingProjects = await listProjects();
  for (const project of existingProjects) {
    await cleanupInterruptedArtifacts(project.id);
    if (project.status === "importing") void markPreparation(project);
  }
  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
  const queue = new RenderQueue();
  const integrationImports = new Map<string, Promise<Project>>();
  const utilityJobs = new Map<string, UtilityJob>();
  await app.register(multipart, { limits: { files: 1, fileSize: 40 * 1024 * 1024 * 1024 } });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return reply.code(403).send({ error: "Unexpected request origin." });
  });

  app.setErrorHandler((error, _request, reply) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    app.log.error(normalized);
    const candidate = error as { statusCode?: unknown };
    const status = typeof candidate.statusCode === "number" ? candidate.statusCode : 400;
    reply.code(status >= 400 && status < 600 ? status : 500).send({ error: normalized.message });
  });

  app.get("/api/health", async () => ({ ok: true }));
  app.post("/api/handoffs/exchange", async (request) => {
    const ticket = (request.body as { ticket?: unknown })?.ticket;
    if (typeof ticket !== "string" || !ticket) throw new Error("A launch ticket is required.");
    return exchangeRemoteTicket(ticket);
  });

  app.get<{ Params: { session: string; reference: string } }>("/api/handoffs/:session/files/:reference/content", async (request, reply) => {
    const session = remoteSession(request.params.session);
    const file = remoteFile(session, request.params.reference);
    const headers = new Headers();
    if (request.headers.range) headers.set("range", request.headers.range);
    const response = await remoteFetch(session, remoteContentUrl(session, file), { headers });
    reply.code(response.status);
    for (const header of ["accept-ranges", "content-length", "content-range", "content-type", "etag", "last-modified"]) {
      const value = response.headers.get(header);
      if (value) reply.header(header, value);
    }
    if (!response.body) return reply.send();
    return reply.send(Readable.fromWeb(response.body as never));
  });

  app.get<{ Params: { session: string; reference: string } }>("/api/handoffs/:session/files/:reference/media-info", async (request) => {
    const session = remoteSession(request.params.session);
    const file = remoteFile(session, request.params.reference);
    const response = await remoteFetch(session, remoteMediaInfoUrl(session, file));
    const body = await response.json().catch(() => ({ message: response.statusText })) as { durationSeconds?: unknown; frameRate?: unknown; message?: string };
    if (!response.ok) throw Object.assign(new Error(body.message ?? "Files could not inspect the video."), { statusCode: response.status });
    if (typeof body.durationSeconds !== "number" || !Number.isFinite(body.durationSeconds) || body.durationSeconds <= 0) {
      throw new Error("Files returned invalid video metadata.");
    }
    return {
      durationSeconds: body.durationSeconds,
      frameRate: typeof body.frameRate === "number" && Number.isFinite(body.frameRate) && body.frameRate > 0 ? body.frameRate : null,
    };
  });

  app.post<{ Params: { session: string; reference: string } }>("/api/handoffs/:session/files/:reference/extractions", async (request, reply) => {
    const session = remoteSession(request.params.session);
    const file = remoteFile(session, request.params.reference);
    const body = request.body as { kind?: string; time?: number; startTime?: number; endTime?: number };
    if (!session.canCreateSibling || !["frame", "segment"].includes(body.kind ?? "")) return reply.code(403).send({ error: "Extraction was not granted." });
    const key = randomUUID();
    const job: UtilityJob = { key, status: "working", progress: 0 };
    utilityJobs.set(key, job);
    void (async () => {
      try {
        const source = await ensureLocalSource(session, file);
        const stem = path.basename(file.name, path.extname(file.name));
        const directory = path.join(dataDirectory, "handoffs", session.localId);
        let resultFile: string;
        let name: string;
        if (body.kind === "frame") {
          const time = Number(body.time);
          if (!Number.isFinite(time) || time < 0) throw new Error("Choose a valid frame time.");
          name = `${stem}-frame-${Math.round(time * 1000)}ms.jpg`;
          resultFile = path.join(directory, `${key}.jpg`);
          await runProcess(ffmpegPath, ["-hide_banner", "-y", "-ss", time.toFixed(6), "-i", source, "-frames:v", "1", "-q:v", "2", resultFile]);
        } else {
          const start = Number(body.startTime), end = Number(body.endTime);
          if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error("Choose a valid in/out range.");
          name = `${stem}-segment.mp4`;
          resultFile = path.join(directory, `${key}.mp4`);
          await runProcess(ffmpegPath, ["-hide_banner", "-y", "-ss", start.toFixed(6), "-to", end.toFixed(6), "-i", source, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", resultFile]);
        }
        job.result = await publishRemoteOutput(session, file, resultFile, name);
        job.status = "ready"; job.progress = 1;
      } catch (error) { job.status = "failed"; job.error = error instanceof Error ? error.message : "Extraction failed."; }
    })();
    return reply.code(202).send(job);
  });

  app.get<{ Params: { session: string; key: string } }>("/api/handoffs/:session/jobs/:key", async (request, reply) => {
    remoteSession(request.params.session);
    return utilityJobs.get(request.params.key) ?? reply.code(404).send({ error: "Job not found." });
  });

  app.post<{ Params: { session: string; reference: string } }>("/api/handoffs/:session/files/:reference/hls", async (request, reply) => {
    const session = remoteSession(request.params.session);
    const file = remoteFile(session, request.params.reference);
    const key = randomUUID();
    const directory = path.join(dataDirectory, "handoffs", session.localId, `hls-${key}`);
    const job: UtilityJob = { key, status: "working", playable: false, progress: 0, playlistUrl: `/apps/video/api/handoffs/${session.localId}/hls/${key}/index.m3u8` };
    utilityJobs.set(key, job);
    void (async () => {
      try {
        const source = await ensureLocalSource(session, file);
        await mkdir(directory, { recursive: true });
        await runProcess(ffmpegPath, ["-hide_banner", "-y", "-i", source, "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale='min(1920,iw)':-2", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-hls_time", "4", "-hls_playlist_type", "event", "-hls_segment_filename", path.join(directory, "segment-%05d.ts"), path.join(directory, "index.m3u8")]);
        job.status = "ready"; job.playable = true; job.progress = 1;
      } catch (error) { job.status = "failed"; job.error = error instanceof Error ? error.message : "Video conversion failed."; }
    })();
    return reply.code(202).send(job);
  });

  app.get<{ Params: { session: string; key: string; file: string } }>("/api/handoffs/:session/hls/:key/:file", async (request, reply) => {
    const session = remoteSession(request.params.session);
    if (!utilityJobs.has(request.params.key) || !/^(index\.m3u8|segment-\d{5}\.ts)$/.test(request.params.file)) return reply.code(404).send();
    const file = path.join(dataDirectory, "handoffs", session.localId, `hls-${request.params.key}`, request.params.file);
    return reply.type(request.params.file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t").send(createReadStream(file));
  });

  app.post<{ Params: { session: string } }>("/api/handoffs/:session/concatenations", async (request, reply) => {
    const session = remoteSession(request.params.session);
    if (session.action !== "concatenate" || session.files.length < 2) return reply.code(403).send({ error: "Concatenation was not granted." });
    const name = outputName((request.body as { outputName?: string })?.outputName ?? "", "concatenated.mp4");
    if (!name.toLowerCase().endsWith(".mp4")) return reply.code(400).send({ error: "Choose an .mp4 output filename." });
    const key = randomUUID();
    const job: UtilityJob = { key, status: "working", progress: 0 };
    utilityJobs.set(key, job);
    void (async () => {
      try {
        const sources: string[] = [];
        for (const file of session.files) sources.push(await ensureLocalSource(session, file));
        const directory = path.join(dataDirectory, "handoffs", session.localId);
        const list = path.join(directory, `${key}.txt`);
        await writeFile(list, sources.map((source) => `file '${source.replaceAll("'", "'\\''")}'`).join("\n"), { mode: 0o600 });
        const resultFile = path.join(directory, `${key}.mp4`);
        await runProcess(ffmpegPath, ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", resultFile]);
        job.result = await publishRemoteOutput(session, session.files[0]!, resultFile, name);
        job.status = "ready"; job.progress = 1;
      } catch (error) { job.status = "failed"; job.error = error instanceof Error ? error.message : "Concatenation failed."; }
    })();
    return reply.code(202).send(job);
  });

  app.get("/api/projects", async () => listProjects());
  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request) => readProject(request.params.id));

  const findIntegratedProject = async (key: string) => (await listProjects()).find((project) => ["remote-workspace-files", "remote-file-browser"].includes(project.integration?.provider ?? "") && project.integration?.key === key);
  const validateIntegrationKey = (key: string) => {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid Remote Files integration key.");
  };

  app.get<{ Params: { key: string } }>("/api/integrations/remote-file-browser/projects/:key", async (request, reply) => {
    validateIntegrationKey(request.params.key);
    return await findIntegratedProject(request.params.key) ?? reply.code(404).send({ error: "Integrated project not found." });
  });

  app.post<{ Params: { session: string } }>("/api/handoffs/:session/projects", async (request, reply) => {
    const session = remoteSession(request.params.session);
    if (!session.files[0] || !["play", "edit"].includes(session.action)) return reply.code(403).send({ error: "Editing was not granted." });
    const file = session.files[0];
    const existing = await findIntegratedProject(file.integrationKey);
    if (existing) {
      if (existing.integration?.provider === "remote-file-browser") {
        existing.integration.provider = "remote-workspace-files";
        await saveProject(existing);
      }
      return { projectId: existing.id, reused: true };
    }
    const source = await ensureLocalSource(session, file);
    const storedName = `source${safeExtension(file.name)}`;
    const metadata = await inspectSource(source, file.name, storedName, await sha256File(source));
    const name = path.basename(file.name, path.extname(file.name)) || "Untitled video";
    const project = await createProjectRecord(name, metadata, { provider: "remote-workspace-files", key: file.integrationKey });
    await link(source, projectFile(project.id, storedName));
    void markPreparation(project);
    return reply.code(202).send({ projectId: project.id, reused: false });
  });

  app.post<{ Params: { session: string; id: string } }>("/api/handoffs/:session/projects/:id/publish", async (request) => {
    const session = remoteSession(request.params.session);
    const source = session.files[0];
    if (!source || !session.canCreateSibling) throw Object.assign(new Error("Publishing was not granted."), { statusCode: 403 });
    const project = await readProject(request.params.id);
    if (project.integration?.key !== source.integrationKey) throw Object.assign(new Error("This project does not belong to the current Files handoff."), { statusCode: 403 });
    const exportFile = await readMediaFile(project, "export");
    const name = `${project.name.replaceAll(/[^a-z0-9_-]+/gi, "-") || "video"}-edited.mp4`;
    return publishRemoteOutput(session, source, exportFile, name);
  });

  app.post<{ Params: { key: string } }>("/api/integrations/remote-file-browser/projects/:key", async (request, reply) => {
    const key = request.params.key;
    validateIntegrationKey(key);
    const existing = await findIntegratedProject(key);
    if (existing) return existing;
    const pending = integrationImports.get(key);
    if (pending) return pending;

    const importing = (async () => {
      const upload = await request.file();
      if (!upload) throw new Error("Choose a source video.");
      const declaredBytes = Number(request.headers["content-length"] ?? 0);
      if (declaredBytes > 0) {
        const filesystem = await statfs(dataDirectory);
        const availableBytes = filesystem.bavail * filesystem.bsize;
        if (availableBytes < declaredBytes * 2 + 1024 ** 3) throw Object.assign(new Error("Not enough free disk space to import this source and create working media."), { statusCode: 507 });
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
        const project = await createProjectRecord(name, source, { provider: "remote-file-browser", key });
        await rename(temporary, projectFile(project.id, storedName));
        await chmod(projectFile(project.id, storedName), 0o400);
        void markPreparation(project);
        return project;
      } finally {
        await rm(importDirectory, { recursive: true, force: true });
      }
    })();
    integrationImports.set(key, importing);
    try {
      return reply.code(202).send(await importing);
    } finally {
      integrationImports.delete(key);
    }
  });

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
