import { describe, expect, it } from "vitest";
import { defaultOutputFilename, outputFilenameSchema } from "./output.js";

describe("export filenames", () => {
  it.each(["match-slow.mp4", "Match highlight.MP4", "résumé.mp4"])("accepts %s", (name) => {
    expect(outputFilenameSchema.parse(` ${name} `)).toBe(name);
  });

  it.each(["", ".mp4", "clip.mov", "../clip.mp4", "folder/clip.mp4", "folder\\clip.mp4", "clip\n.mp4", "clip?.mp4", "clip\".mp4", `${"é".repeat(110)}.mp4`])("rejects unsafe or invalid name %j", (name) => {
    expect(outputFilenameSchema.safeParse(name).success).toBe(false);
  });

  it("generates a safe MP4 default separate from the source filename", () => {
    expect(defaultOutputFilename("Match 1")).toBe("Match-1-edited.mp4");
    expect(defaultOutputFilename("")).toBe("video-edited.mp4");
    expect(outputFilenameSchema.safeParse(defaultOutputFilename("a".repeat(1000))).success).toBe(true);
  });
});
