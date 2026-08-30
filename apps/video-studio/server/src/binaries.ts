import { createRequire } from "node:module";
import { runProcess } from "./process.js";

const require = createRequire(import.meta.url);
const ffmpegModule = require("ffmpeg-static") as string | null;
const ffprobeModule = require("@derhuerst/ffprobe-static") as string | { path: string };

export const ffmpegPath = process.env.FFMPEG_PATH ?? ffmpegModule ?? "ffmpeg";
export const ffprobePath = process.env.FFPROBE_PATH ?? (typeof ffprobeModule === "string" ? ffprobeModule : ffprobeModule.path);

export async function verifyMediaCapabilities(): Promise<string> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(`V1 supports Linux x64; detected ${process.platform} ${process.arch}.`);
  }
  const [{ stdout: version }, { stdout: filters }, { stdout: encoders }] = await Promise.all([
    runProcess(ffmpegPath, ["-version"]),
    runProcess(ffmpegPath, ["-hide_banner", "-filters"]),
    runProcess(ffmpegPath, ["-hide_banner", "-encoders"]),
  ]);
  const filterText = filters.toString();
  const encoderText = encoders.toString();
  for (const filter of ["minterpolate", "bwdif", "atempo", "asendcmd", "amix", "alimiter"]) {
    if (!filterText.includes(filter)) throw new Error(`Bundled FFmpeg is missing required filter: ${filter}.`);
  }
  for (const encoder of ["libx264", "aac"]) {
    if (!encoderText.includes(encoder)) throw new Error(`Bundled FFmpeg is missing required encoder: ${encoder}.`);
  }
  return version.toString().split("\n")[0] ?? "FFmpeg ready";
}
