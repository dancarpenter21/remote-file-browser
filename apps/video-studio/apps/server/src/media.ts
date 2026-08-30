import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildSetPtsFrameExpression,
  compileTimeline,
  effectiveHighlightRange,
  fpsString,
  frameToSeconds,
  localizeSectionsForHighlight,
  type Project,
  type Rational,
  type SlowSection,
  type SourceMetadata,
} from "@vfx/shared";
import { bundledCrowdPath } from "./paths.js";
import { ffmpegPath, ffprobePath } from "./binaries.js";
import { runProcess } from "./process.js";
import { projectFile } from "./storage.js";

interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  field_order?: string;
  color_transfer?: string;
  duration?: string;
  nb_frames?: string;
}

interface ProbeResult {
  streams?: ProbeStream[];
  format?: { duration?: string };
}

function parseRational(value?: string): Rational {
  const [rawNum, rawDen] = (value ?? "").split("/");
  const num = Number(rawNum);
  const den = Number(rawDen);
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) throw new Error("The video does not report a usable frame rate.");
  return { num, den };
}

async function probe(file: string, countFrames = false): Promise<ProbeResult> {
  const args = ["-v", "error"];
  if (countFrames) args.push("-count_frames");
  args.push("-show_streams", "-show_format", "-of", "json", file);
  const { stdout } = await runProcess(ffprobePath, args);
  return JSON.parse(stdout.toString()) as ProbeResult;
}

export async function inspectSource(file: string, originalName: string, storedName: string, sha256: string): Promise<SourceMetadata> {
  const result = await probe(file);
  const video = result.streams?.find((stream) => stream.codec_type === "video");
  if (!video?.width || !video.height) throw new Error("The selected file has no readable video stream.");
  const durationSeconds = Number(video.duration ?? result.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("The video duration is missing or invalid.");
  if (video.width > 1920 || video.height > 1080) throw new Error("V1 supports videos up to 1920×1080.");
  if (durationSeconds > 1800.001) throw new Error("V1 supports videos up to 30 minutes.");
  if (["smpte2084", "arib-std-b67"].includes(video.color_transfer ?? "")) throw new Error("HDR video is not supported in v1; convert it to SDR before importing.");
  const fps = parseRational(video.avg_frame_rate);
  const nominal = parseRational(video.r_frame_rate ?? video.avg_frame_rate);
  const averageValue = fps.num / fps.den;
  if (averageValue < 1 || averageValue > 120) throw new Error("V1 supports nominal frame rates from 1 to 120 fps.");
  const interlaced = Boolean(video.field_order && !["progressive", "unknown"].includes(video.field_order));
  const variableFrameRate = Math.abs(fps.num / fps.den - nominal.num / nominal.den) > 0.001;
  const frameCount = Math.round(durationSeconds * averageValue);
  if (frameCount < 2) throw new Error("The video must contain at least two frames.");
  return {
    originalName,
    storedName,
    sha256,
    width: video.width,
    height: video.height,
    durationSeconds,
    fps,
    frameCount,
    hasAudio: Boolean(result.streams?.some((stream) => stream.codec_type === "audio")),
    interlaced,
    variableFrameRate,
  };
}

function normalizationFilter(project: Project, scaleProxy: boolean): string {
  const filters: string[] = [];
  if (project.source.interlaced) filters.push("bwdif=mode=send_frame:parity=auto:deint=interlaced");
  filters.push(`fps=fps=${fpsString(project.source.fps)}:round=near:start_time=0`);
  if (scaleProxy) filters.push("scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2");
  filters.push("setsar=1");
  return filters.join(",");
}

export async function prepareProjectMedia(project: Project, signal?: AbortSignal): Promise<{ frameCount: number; durationSeconds: number; proxyFilename: string; waveformFilename?: string }> {
  const source = projectFile(project.id, project.source.storedName);
  const proxyFilename = "proxy.mp4";
  const proxyPartial = projectFile(project.id, `${proxyFilename}.partial.mp4`);
  const proxy = projectFile(project.id, proxyFilename);
  await rm(proxyPartial, { force: true });
  const roundedFps = Math.max(1, Math.round(project.source.fps.num / project.source.fps.den));
  const args = [
    "-hide_banner", "-y", "-i", source,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", normalizationFilter(project, true),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-g", String(roundedFps), "-keyint_min", String(roundedFps), "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", proxyPartial,
  ];
  await runProcess(ffmpegPath, args, { signal });
  await rename(proxyPartial, proxy);
  const proxyProbe = await probe(proxy, true);
  const video = proxyProbe.streams?.find((stream) => stream.codec_type === "video");
  const frameCount = Number(video?.nb_frames) || Math.max(1, Math.round(project.source.durationSeconds * project.source.fps.num / project.source.fps.den));
  if (frameCount < 2) throw new Error("The normalized video must contain at least two frames.");
  const durationSeconds = frameToSeconds(frameCount, project.source.fps);
  let waveformFilename: string | undefined;
  if (project.source.hasAudio) {
    waveformFilename = "waveform.png";
    const waveform = projectFile(project.id, waveformFilename);
    await runProcess(ffmpegPath, [
      "-hide_banner", "-y", "-i", source, "-filter_complex",
      "[0:a:0]aformat=channel_layouts=mono,showwavespic=s=1800x160:colors=4f8cff|78d6c6:draw=full[v]",
      "-map", "[v]", "-frames:v", "1", waveform,
    ], { signal });
  }
  await chmod(source, 0o400);
  return { frameCount, durationSeconds, proxyFilename, waveformFilename };
}

export async function extractFrame(project: Project, frame: number): Promise<Buffer> {
  if (!project.proxyFilename) throw new Error("Proxy media is not ready.");
  const clamped = Math.max(0, Math.min(project.source.frameCount - 1, frame));
  const seconds = frameToSeconds(clamped, project.source.fps) + 0.25 * project.source.fps.den / project.source.fps.num;
  const { stdout } = await runProcess(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-ss", seconds.toFixed(9), "-i", projectFile(project.id, project.proxyFilename),
    "-frames:v", "1", "-q:v", "2", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
  ]);
  return stdout;
}

function escapeFilterPath(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

function buildTempoCommands(frameCount: number, fps: Rational, sections: SlowSection[]): string {
  const timeline = compileTimeline(frameCount, fps, sections);
  const commands: string[] = [];
  let previous = Number.NaN;
  for (let frame = 0; frame < timeline.frameExpansion.length; frame += 1) {
    const factor = Math.cbrt(1 / timeline.frameExpansion[frame]!);
    if (!Number.isFinite(previous) || Math.abs(factor - previous) > 1e-6) {
      const time = frameToSeconds(frame, fps).toFixed(9);
      const value = factor.toFixed(9);
      for (const name of ["tempo1", "tempo2", "tempo3"]) commands.push(`${time} atempo@${name} tempo ${value};`);
      previous = factor;
    }
  }
  const end = frameToSeconds(frameCount, fps).toFixed(9);
  for (const name of ["tempo1", "tempo2", "tempo3"]) commands.push(`${end} atempo@${name} tempo 1;`);
  return `${commands.join("\n")}\n`;
}

export interface RenderOptions {
  kind: "preview" | "export";
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

export async function renderProject(project: Project, options: RenderOptions): Promise<{ filename: string; durationSeconds: number }> {
  const highlight = effectiveHighlightRange(project.source.frameCount, project.highlightRange);
  const highlightFrameCount = highlight.endFrameExclusive - highlight.startFrame;
  const activeSections = localizeSectionsForHighlight(highlight, project.sections);
  const timeline = compileTimeline(highlightFrameCount, project.source.fps, activeSections);
  const jobDirectory = projectFile(project.id, "jobs");
  await mkdir(jobDirectory, { recursive: true });
  const token = `${options.kind}-${Date.now()}`;
  const commandFile = path.join(jobDirectory, `${token}-tempo.txt`);
  const filterFile = path.join(jobDirectory, `${token}-filters.txt`);
  const filename = options.kind === "preview" ? `preview-r${project.revision}.mp4` : `export-r${project.revision}.mp4`;
  const output = projectFile(project.id, filename);
  const partial = projectFile(project.id, `${filename}.partial.mp4`);
  await writeFile(commandFile, buildTempoCommands(highlightFrameCount, project.source.fps, activeSections));
  const sourceInput = options.kind === "preview" && project.proxyFilename
    ? projectFile(project.id, project.proxyFilename)
    : projectFile(project.id, project.source.storedName);
  const crowdInput = project.audio.crowdSource === "custom" ? projectFile(project.id, "custom-crowd.flac") : bundledCrowdPath;
  const ptsFrameExpression = buildSetPtsFrameExpression(highlightFrameCount, activeSections);
  const fps = fpsString(project.source.fps);
  const ptsExpression = `(${ptsFrameExpression})*${project.source.fps.den}/(${project.source.fps.num}*TB)`;
  const videoPrefix = options.kind === "preview" ? "" : `${normalizationFilter(project, false)},`;
  const interpolation = options.kind === "preview"
    ? `fps=fps=${fps}:round=near`
    : `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=fdiff:scd_threshold=10`;
  const highlightStartSeconds = frameToSeconds(highlight.startFrame, project.source.fps);
  const highlightEndSeconds = frameToSeconds(highlight.endFrameExclusive, project.source.fps);
  const sourceAudio = project.source.hasAudio && project.audio.useOriginalAudio
    ? `[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=start=${highlightStartSeconds.toFixed(9)}:end=${highlightEndSeconds.toFixed(9)},asetpts=PTS-STARTPTS,asendcmd=f='${escapeFilterPath(commandFile)}',atempo@tempo1=1,atempo@tempo2=1,atempo@tempo3=1,apad,atrim=duration=${timeline.durationSeconds.toFixed(9)},volume=${project.audio.sourceGainDb}dB[sourceaudio];`
    : `anullsrc=r=48000:cl=stereo,atrim=duration=${timeline.durationSeconds.toFixed(9)}[sourceaudio];`;
  const crowdGain = project.audio.crowdMuted ? -60 : project.audio.crowdGainDb;
  const filter = [
    `[0:v:0]${videoPrefix}trim=start_frame=${highlight.startFrame}:end_frame=${highlight.endFrameExclusive},setpts=N/(${fps}*TB),tpad=stop_mode=clone:stop_duration=${(2 * project.source.fps.den / project.source.fps.num).toFixed(12)},setpts='${ptsExpression}',${interpolation},tpad=stop_mode=clone:stop_duration=${(project.source.fps.den / project.source.fps.num).toFixed(12)},trim=end_frame=${timeline.outputFrameCount},setpts=N/(${fps}*TB),fps=fps=${fps}:round=near[video];`,
    sourceAudio,
    `[1:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${timeline.durationSeconds.toFixed(9)},afade=t=in:d=0.25,afade=t=out:st=${Math.max(0, timeline.durationSeconds - 0.25).toFixed(9)}:d=0.25,volume=${crowdGain}dB[crowd];`,
    `[sourceaudio][crowd]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=disabled[audio]`,
  ].join("\n");
  await writeFile(filterFile, filter);
  await rm(partial, { force: true });
  let progressBuffer = "";
  const args = [
    "-hide_banner", "-y", "-i", sourceInput, "-stream_loop", "-1", "-i", crowdInput,
    "-filter_complex_script", filterFile, "-map", "[video]", "-map", "[audio]",
    "-c:v", "libx264", "-preset", options.kind === "preview" ? "veryfast" : "medium",
    "-crf", options.kind === "preview" ? "23" : "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", options.kind === "preview" ? "128k" : "192k", "-ar", "48000", "-ac", "2",
    "-r", fps, "-fps_mode", "cfr", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", partial,
  ];
  try {
    await runProcess(ffmpegPath, args, {
      signal: options.signal,
      onStdout(chunk) {
        progressBuffer += chunk;
        const lines = progressBuffer.split("\n");
        progressBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const [key, value] = line.split("=");
          if (key === "out_time_us") options.onProgress?.(Math.min(0.99, Number(value) / 1_000_000 / timeline.durationSeconds));
        }
      },
    });
    await rename(partial, output);
    options.onProgress?.(1);
    return { filename, durationSeconds: timeline.durationSeconds };
  } finally {
    await Promise.all([rm(commandFile, { force: true }), rm(filterFile, { force: true }), rm(partial, { force: true })]);
  }
}

export async function normalizeCustomCrowd(project: Project, input: string): Promise<void> {
  const output = projectFile(project.id, "custom-crowd.flac");
  const partial = projectFile(project.id, "custom-crowd.partial.flac");
  const info = await probe(input);
  const duration = Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration < 3) throw new Error("Custom ambience must be at least three seconds long.");
  const crossfade = Math.min(1.5, duration / 4);
  const bodyEnd = duration - crossfade;
  const graph = `[0:a]asplit=3[body][head][tail];[body]atrim=${crossfade}:${bodyEnd},asetpts=PTS-STARTPTS[main];[head]atrim=0:${crossfade},asetpts=PTS-STARTPTS[h];[tail]atrim=${bodyEnd}:${duration},asetpts=PTS-STARTPTS[t];[t][h]acrossfade=d=${crossfade}:c1=tri:c2=tri[seam];[main][seam]concat=n=2:v=0:a=1,aresample=48000,aformat=channel_layouts=stereo[out]`;
  await runProcess(ffmpegPath, ["-hide_banner", "-y", "-i", input, "-filter_complex", graph, "-map", "[out]", "-c:a", "flac", partial]);
  await rename(partial, output);
}

export async function readMediaFile(project: Project, kind: "proxy" | "waveform" | "preview" | "export"): Promise<string> {
  const filename = kind === "proxy" ? project.proxyFilename : kind === "waveform" ? project.waveformFilename : project[kind]?.filename;
  if (!filename) throw new Error(`${kind} is not available.`);
  await readFile(projectFile(project.id, filename));
  return projectFile(project.id, filename);
}
