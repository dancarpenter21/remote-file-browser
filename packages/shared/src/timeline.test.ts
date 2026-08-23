import { describe, expect, it } from "vitest";
import { buildSetPtsFrameExpression, compileTimeline, defaultRampFrames, validateSections } from "./timeline.js";
import type { SlowSection } from "./types.js";

const fps = { num: 30, den: 1 };

function section(overrides: Partial<SlowSection> = {}): SlowSection {
  return {
    id: "section-1",
    startFrame: 30,
    endFrameExclusive: 60,
    speed: 0.5,
    rampInFrames: 0,
    rampOutFrames: 0,
    ...overrides,
  };
}

describe("timeline compiler", () => {
  it("leaves an unedited source unchanged", () => {
    const map = compileTimeline(300, fps, []);
    expect(map.outputFrameCount).toBe(300);
    expect(map.durationSeconds).toBe(10);
  });

  it("expands a constant half-speed range", () => {
    const map = compileTimeline(90, fps, [section()]);
    expect(map.outputFrameCount).toBe(120);
    expect(map.outputPositionBySourceFrame[30]).toBe(30);
    expect(map.outputPositionBySourceFrame[60]).toBe(90);
  });

  it("uses symmetric smooth ramps", () => {
    const map = compileTimeline(90, fps, [section({ rampInFrames: 10, rampOutFrames: 10 })]);
    expect(map.frameExpansion[30]).toBeCloseTo(map.frameExpansion[59]!, 8);
    expect(map.frameExpansion[39]).toBeCloseTo(map.frameExpansion[50]!, 8);
    expect(map.outputFrameCount).toBe(110);
  });

  it("caps default ramps to a quarter of the selection", () => {
    expect(defaultRampFrames(20, fps)).toBe(5);
    expect(defaultRampFrames(120, fps)).toBe(15);
  });

  it("rejects overlap and ramp collisions", () => {
    expect(() => validateSections([section(), section({ id: "two", startFrame: 59, endFrameExclusive: 70 })], 100)).toThrow("overlap");
    expect(() => validateSections([section({ rampInFrames: 20, rampOutFrames: 20 })], 100)).toThrow("Ramp");
  });

  it("generates a bounded FFmpeg PTS expression", () => {
    const expression = buildSetPtsFrameExpression(90, [section({ rampInFrames: 5, rampOutFrames: 5 })]);
    expect(expression).toContain("if(lt(N,30)");
    expect(expression).toContain("N-30");
  });
});
