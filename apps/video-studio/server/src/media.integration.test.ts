import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { addCrowdAccent, compileHighlightTimeline, defaultRampFrames, type Project } from "@remote-workspace/video-shared";

const testRoot = await mkdtemp(path.join(tmpdir(), "video-studio-test-"));
process.env.VIDEO_STUDIO_DATA_DIR = path.join(testRoot, "data");

const { ffmpegPath, ffprobePath } = await import("./binaries.js");
const { runProcess } = await import("./process.js");
const { inspectSource, prepareProjectMedia, renderProject, buildTempoCommands } = await import("./media.js");
const { createProjectRecord, projectFile, saveProject } = await import("./storage.js");

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function maxAudioVolume(file: string): Promise<number> {
  const { stderr } = await runProcess(ffmpegPath, [
    "-hide_banner", "-i", file, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-",
  ]);
  const value = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1];
  if (!value) throw new Error(`Could not read max audio volume.\n${stderr}`);
  return Number(value);
}

async function meanAudioVolume(file: string, start: number, duration: number): Promise<number> {
  const { stderr } = await runProcess(ffmpegPath, [
    "-hide_banner", "-ss", String(start), "-t", String(duration), "-i", file, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-",
  ]);
  const value = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1];
  if (!value) throw new Error(`Could not read mean audio volume.\n${stderr}`);
  return Number(value);
}

describe("media pipeline", () => {
  let externalSource: string;
  let project: Project;
  let originalHash: string;
  let originalMtime: number;

  beforeAll(async () => {
    externalSource = path.join(testRoot, "external-source.mp4");
    await runProcess(ffmpegPath, [
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", externalSource,
    ]);
    originalHash = await sha256(externalSource);
    originalMtime = (await stat(externalSource)).mtimeMs;
    const source = await inspectSource(externalSource, "external-source.mp4", "source.mp4", originalHash);
    project = await createProjectRecord("Integration fixture", source, { provider: "remote-file-browser", key: "a".repeat(64) });
    await copyFile(externalSource, projectFile(project.id, source.storedName));
    await chmod(projectFile(project.id, source.storedName), 0o400);
    const prepared = await prepareProjectMedia(project);
    project.source.frameCount = prepared.frameCount;
    project.source.durationSeconds = prepared.durationSeconds;
    project.proxyFilename = prepared.proxyFilename;
    project.waveformFilename = prepared.waveformFilename;
    project.status = "ready";
    const ramp = defaultRampFrames(30, project.source.fps);
    project.sections = [{
      id: "slow-one",
      startFrame: 30,
      endFrameExclusive: 60,
      speed: 0.125,
      rampInFrames: ramp,
      rampOutFrames: ramp,
    }, {
      id: "slow-two",
      startFrame: 65,
      endFrameExclusive: 72,
      speed: 0.5,
      rampInFrames: 1,
      rampOutFrames: 1,
    }];
    project.highlightRange = { startFrame: 30, endFrameExclusive: 75 };
    project.revision = 1;
    await saveProject(project);
  }, 30_000);

  afterAll(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("renders draft and interpolated outputs with exact timeline duration", async () => {
    const expected = compileHighlightTimeline(project.source.frameCount, project.source.fps, project.sections, project.highlightRange);
    const preview = await renderProject(project, { kind: "preview" });
    const final = await renderProject(project, { kind: "export" });
    for (const artifact of [preview, final]) {
      const { stdout } = await runProcess(ffprobePath, [
        "-v", "error", "-count_frames", "-select_streams", "v:0",
        "-show_entries", "stream=avg_frame_rate,nb_read_frames", "-of", "json",
        projectFile(project.id, artifact.filename),
      ]);
      const result = JSON.parse(stdout.toString()) as { streams: Array<{ avg_frame_rate: string; nb_read_frames: string }> };
      expect(result.streams[0]?.avg_frame_rate).toBe("30/1");
      expect(Number(result.streams[0]?.nb_read_frames), artifact.filename).toBe(expected.outputFrameCount);
      expect(artifact.durationSeconds).toBeCloseTo(expected.durationSeconds, 8);
    }
  }, 30_000);

  it("renders decimal and 0.01x speeds with synchronized audio and exact frame counts", async () => {
    const decimalProject: Project = {
      ...project,
      revision: 200,
      highlightRange: { startFrame: 0, endFrameExclusive: 20 },
      sections: [
        { id: "very-slow", startFrame: 2, endFrameExclusive: 4, speed: 0.01, rampInFrames: 0, rampOutFrames: 0 },
        { id: "decimal", startFrame: 8, endFrameExclusive: 16, speed: 0.333, rampInFrames: 2, rampOutFrames: 2 },
      ],
      audio: { ...project.audio, useOriginalAudio: true, crowdMuted: true },
    };
    const expected = compileHighlightTimeline(decimalProject.source.frameCount, decimalProject.source.fps, decimalProject.sections, decimalProject.highlightRange);
    const commands = buildTempoCommands(20, decimalProject.source.fps, decimalProject.sections);
    const groups = new Map<string, number[]>();
    for (const line of commands.trim().split("\n")) {
      const [time, , , raw] = line.split(" ");
      const factor = Number(raw!.replace(";", ""));
      expect(factor).toBeGreaterThanOrEqual(0.5);
      expect(factor).toBeLessThanOrEqual(1);
      groups.set(time!, [...(groups.get(time!) ?? []), factor]);
    }
    for (const [time, factors] of groups) {
      expect(factors).toHaveLength(7);
      const frame = Math.round(Number(time) * 30);
      const speed = frame < 20 ? 1 / expected.frameExpansion[frame]! : 1;
      expect(factors.reduce((a, b) => a * b, 1)).toBeCloseTo(speed, 7);
    }
    for (const kind of ["preview", "export"] as const) {
      const artifact = await renderProject(decimalProject, { kind });
      const file = projectFile(project.id, artifact.filename);
      const { stdout } = await runProcess(ffprobePath, ["-v", "error", "-count_frames", "-show_streams", "-of", "json", file]);
      const result = JSON.parse(stdout.toString()) as { streams: Array<{ codec_type: string; nb_read_frames: string; duration: string }> };
      const video = result.streams.find((stream) => stream.codec_type === "video")!;
      const audio = result.streams.find((stream) => stream.codec_type === "audio")!;
      expect(Number(video.nb_read_frames)).toBe(expected.outputFrameCount);
      expect(Math.abs(Number(audio.duration) - expected.durationSeconds)).toBeLessThan(0.1);
      expect(await maxAudioVolume(file)).toBeGreaterThan(-60);
    }
  }, 30_000);

  it("never mutates the external source", async () => {
    expect(await sha256(externalSource)).toBe(originalHash);
    expect((await stat(externalSource)).mtimeMs).toBe(originalMtime);
  });

  it("finds an existing Remote Files project by integration key", async () => {
    const { buildServer } = await import("./server.js");
    const app = await buildServer();
    try {
      const response = await app.inject({ method: "GET", url: `/api/integrations/remote-file-browser/projects/${"a".repeat(64)}` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: project.id, integration: { provider: "remote-file-browser", key: "a".repeat(64) } });
    } finally {
      await app.close();
    }
  });

  it("persists arbitrary decimal speeds through the project API and rejects invalid updates", async () => {
    const { buildServer } = await import("./server.js");
    const app = await buildServer();
    const url = `/api/projects/${project.id}`;
    try {
      const sections = project.sections.map((section, index) => ({ ...section, speed: index === 0 ? 0.333123 : 0.01 }));
      const saved = await app.inject({ method: "PATCH", url, payload: { expectedRevision: project.revision, sections } });
      expect(saved.statusCode).toBe(200);
      const revision = saved.json<Project>().revision;
      const loaded = await app.inject({ method: "GET", url });
      expect(loaded.json<Project>().sections).toEqual(sections);
      const rejected = await app.inject({ method: "PATCH", url, payload: { expectedRevision: revision, sections: sections.map((section) => ({ ...section, speed: 0.009 })) } });
      expect(rejected.statusCode).toBe(400);
      const unchanged = await app.inject({ method: "GET", url });
      expect(unchanged.json<Project>().revision).toBe(revision);
      expect(unchanged.json<Project>().sections).toEqual(sections);
    } finally {
      await saveProject(project);
      await app.close();
    }
  });

  it("uses the chosen download and publish filename while retaining collision-safe Files output", async () => {
    const { buildServer } = await import("./server.js");
    const app = await buildServer();
    const exportFilename = "named-export.mp4";
    await writeFile(projectFile(project.id, exportFilename), "export fixture");
    await saveProject({ ...project, export: { revision: project.revision, filename: exportFilename, createdAt: new Date().toISOString(), durationSeconds: 1 } });
    let fetchMock: MockInstance<typeof globalThis.fetch> | undefined;
    try {
      const url = `/api/projects/${project.id}/media/export`;
      const download = await app.inject({ method: "GET", url: `${url}?name=${encodeURIComponent("résumé slow.mp4")}` });
      expect(download.statusCode).toBe(200);
      expect(download.headers["content-disposition"]).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20slow.mp4");
      expect(download.body).toBe("export fixture");
      const fallback = await app.inject({ method: "GET", url });
      expect(fallback.headers["content-disposition"]).toContain('filename="Integration-fixture-edited.mp4"');
      const invalid = await app.inject({ method: "GET", url: `${url}?name=..%2Fclip.mp4` });
      expect(invalid.statusCode).toBe(400);

      fetchMock = vi.spyOn(globalThis, "fetch");
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        sessionId: "test-session", appId: "video-studio", action: "edit", csrfToken: "csrf",
        expiresAt: new Date(Date.now() + 60_000).toISOString(), canCreateSibling: true,
        files: [{ reference: "source", id: "file-id", name: "match.mp4", path: "/match.mp4", mime: "video/mp4", size: 1, etag: "etag", integrationKey: "a".repeat(64) }],
      }), { headers: { "content-type": "application/json", "set-cookie": "rfb_cap_test-session=token; Path=/" } }));
      const exchange = await app.inject({ method: "POST", url: "/api/handoffs/exchange", payload: { ticket: "test-ticket" } });
      expect(exchange.statusCode).toBe(200);
      const session = exchange.json<{ localId: string }>().localId;
      const reopened = await app.inject({ method: "POST", url: `/api/handoffs/${session}/projects` });
      expect(reopened.json()).toEqual({ projectId: project.id, reused: true });
      const linked = await app.inject({ method: "GET", url: `/api/projects/${project.id}` });
      expect(linked.json<Project>().integration).toMatchObject({ sourceId: "file-id", sourcePath: "/match.mp4" });
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "output-id", name: "match-slow-2.mp4", path: "/fs-root/match-slow-2.mp4" }), { status: 201 }));
      const published = await app.inject({ method: "POST", url: `/api/handoffs/${session}/projects/${project.id}/publish`, payload: { outputName: "match-slow.mp4" } });
      expect(published.statusCode).toBe(200);
      expect(published.json()).toEqual({ id: "output-id", name: "match-slow-2.mp4", path: "/fs-root/match-slow-2.mp4" });
      expect(new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get("name")).toBe("match-slow.mp4");
      const rejected = await app.inject({ method: "POST", url: `/api/handoffs/${session}/projects/${project.id}/publish`, payload: { outputName: "../clip.mp4" } });
      expect(rejected.statusCode).toBe(400);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock?.mockRestore();
      await saveProject(project);
      await app.close();
    }
  });

  it("can exclude original audio while retaining the crowd mix", async () => {
    project.audio.crowdMuted = true;
    project.audio.useOriginalAudio = true;
    const withOriginal = await renderProject(project, { kind: "preview" });
    const withOriginalVolume = await maxAudioVolume(projectFile(project.id, withOriginal.filename));
    project.audio.useOriginalAudio = false;
    const withoutOriginal = await renderProject(project, { kind: "preview" });
    const withoutOriginalVolume = await maxAudioVolume(projectFile(project.id, withoutOriginal.filename));
    expect(withOriginalVolume - withoutOriginalVolume).toBeGreaterThan(20);
  }, 30_000);

  it("renders a sharp crowd accent at the retimed playhead and returns to the crowd bed", async () => {
    await runProcess(ffmpegPath, ["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1", "-c:a", "flac", projectFile(project.id, "custom-crowd.flac")]);
    let id = 0;
    const accented: Project = { ...project, audio: { ...project.audio, useOriginalAudio: false, crowdSource: "custom", crowdMuted: false, crowdGainDb: -40,
      crowdGainPoints: addCrowdAccent([], -40, 40, project.source.frameCount, project.source.fps, "pop", -3, () => `pop-${++id}`),
    } };
    const map = compileHighlightTimeline(accented.source.frameCount, accented.source.fps, accented.sections, accented.highlightRange);
    const artifact = await renderProject(accented, { kind: "preview" });
    const file = projectFile(project.id, artifact.filename);
    const seconds = (frame: number) => map.outputPositionBySourceFrame[frame - accented.highlightRange!.startFrame]! / 30;
    const before = await meanAudioVolume(file, seconds(38) + 0.03, 0.08);
    const peak = await meanAudioVolume(file, seconds(42) + 0.03, 0.08);
    const after = await meanAudioVolume(file, seconds(60) + 0.03, 0.08);
    expect(peak - before).toBeGreaterThan(25);
    expect(peak - after).toBeGreaterThan(25);
  }, 30_000);

  it("applies source-frame crowd automation to the retimed output", async () => {
    project.audio.useOriginalAudio = false;
    project.audio.crowdMuted = false;
    project.audio.crowdGainPoints = [
      { id: "quiet", frame: project.highlightRange!.startFrame, gainDb: -45 },
      { id: "loud", frame: project.highlightRange!.endFrameExclusive - 1, gainDb: -5 },
    ];
    const artifact = await renderProject(project, { kind: "preview" });
    const file = projectFile(project.id, artifact.filename);
    const early = await meanAudioVolume(file, 0.5, 0.5);
    const late = await meanAudioVolume(file, artifact.durationSeconds - 0.8, 0.5);
    expect(late - early).toBeGreaterThan(12);
  }, 30_000);
});
