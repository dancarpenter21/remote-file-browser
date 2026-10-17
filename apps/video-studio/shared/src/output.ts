import { z } from "zod";

export const outputFilenameSchema = z.string().trim()
  .regex(/^[^/\\\x00-\x1f\x7f<>:"|?*]+\.mp4$/i, "Choose an .mp4 filename without path separators or special filename characters.")
  .refine((name) => new TextEncoder().encode(name).length <= 220, "Keep the filename under 220 bytes.");

export function defaultOutputFilename(projectName: string): string {
  return `${projectName.replaceAll(/[^a-z0-9_-]+/gi, "-").slice(0, 180) || "video"}-edited.mp4`;
}
