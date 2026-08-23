import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileHighlightTimeline, defaultRampFrames, type Project } from "@vfx/shared";

const testRoot = await mkdtemp(path.join(tmpdir(), "vfx-editor-test-"));
process.env.VFX_EDITOR_DATA_DIR = path.join(testRoot, "data");

const { ffmpegPath, ffprobePath } = await import("./binaries.js");
const { runProcess } = await import("./process.js");
const { inspectSource, prepareProjectMedia, renderProject } = await import("./media.js");
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
    project = await createProjectRecord("Integration fixture", source);
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

  it("never mutates the external source", async () => {
    expect(await sha256(externalSource)).toBe(originalHash);
    expect((await stat(externalSource)).mtimeMs).toBe(originalMtime);
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
});
