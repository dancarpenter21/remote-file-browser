import { describe, expect, it } from "vitest";
import { buildSetPtsFrameExpression, compileHighlightTimeline, compileTimeline, crowdGainAtFrame, defaultRampFrames, effectiveHighlightRange, localizeSectionsForHighlight, validateCrowdGainPoints, validateHighlightRange, validateSections } from "./timeline.js";
import { audioSettingsSchema, type SlowSection } from "./types.js";

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

  it("defaults highlights to the complete source", () => {
    expect(effectiveHighlightRange(90)).toEqual({ startFrame: 0, endFrameExclusive: 90 });
    expect(audioSettingsSchema.parse({ sourceGainDb: 0, crowdGainDb: -24, crowdMuted: false, crowdSource: "bundled" }).useOriginalAudio).toBe(true);
    expect(audioSettingsSchema.parse({ sourceGainDb: 0, crowdGainDb: -24, crowdMuted: false, crowdSource: "bundled" }).crowdGainPoints).toEqual([]);
  });

  it("interpolates crowd gain in dB and holds the endpoint levels", () => {
    const points = [{ id: "quiet", frame: 20, gainDb: -30 }, { id: "loud", frame: 40, gainDb: -10 }];
    expect(crowdGainAtFrame(points, -24, 0)).toBe(-30);
    expect(crowdGainAtFrame(points, -24, 30)).toBe(-20);
    expect(crowdGainAtFrame(points, -24, 60)).toBe(-10);
    expect(crowdGainAtFrame([], -24, 30)).toBe(-24);
  });

  it("rejects duplicate and out-of-range crowd points", () => {
    expect(() => validateCrowdGainPoints([{ id: "a", frame: 10, gainDb: -20 }, { id: "b", frame: 10, gainDb: -10 }], 90)).toThrow("one");
    expect(() => validateCrowdGainPoints([{ id: "a", frame: 90, gainDb: -20 }], 90)).toThrow("outside");
  });

  it("compiles only contained slow sections into highlight-local frames", () => {
    const range = { startFrame: 20, endFrameExclusive: 70 };
    const inside = section({ startFrame: 30, endFrameExclusive: 40 });
    const outside = section({ id: "outside", startFrame: 75, endFrameExclusive: 85 });
    expect(localizeSectionsForHighlight(range, [inside, outside])).toEqual([
      { ...inside, startFrame: 10, endFrameExclusive: 20 },
    ]);
    expect(compileHighlightTimeline(100, fps, [inside, outside], range).outputFrameCount).toBe(60);
  });

  it("rejects a highlight boundary through a slow section", () => {
    expect(() => validateHighlightRange({ startFrame: 40, endFrameExclusive: 80 }, 100, [section()])).toThrow("cannot cut");
    expect(() => validateHighlightRange({ startFrame: 30, endFrameExclusive: 31 }, 100, [])).toThrow("at least two");
  });
});
