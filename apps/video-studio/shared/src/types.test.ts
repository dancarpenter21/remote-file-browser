import { describe, expect, it } from "vitest";
import { slowSectionSchema, slowSpeedSchema } from "./types.js";

describe("decimal slow speeds", () => {
  it.each([0.01, 0.125, 0.25, 0.333, 0.5, 0.75, 1])("preserves speed %s in stored sections", (speed) => {
    const section = { id: "slow", startFrame: 2, endFrameExclusive: 8, speed, rampInFrames: 1, rampOutFrames: 1 };
    expect(slowSectionSchema.parse(JSON.parse(JSON.stringify(section)))).toEqual(section);
  });

  it.each(["", "0.5", NaN, Infinity, -Infinity, 0, -0.5, 0.009, 1.001])("rejects invalid speed %s", (speed) => {
    expect(slowSpeedSchema.safeParse(speed).success).toBe(false);
  });
});
