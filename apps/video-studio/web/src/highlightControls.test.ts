import { describe, expect, it } from "vitest";
import { draggedBoundary, frameAtPosition, moveHighlightBoundary, parseFrame, validateHighlightDraft } from "./highlightControls.js";
import type { SlowSection } from "@remote-workspace/video-shared";

const section: SlowSection = { id: "slow", startFrame: 20, endFrameExclusive: 40, speed: 0.5, rampInFrames: 2, rampOutFrames: 2 };

describe("highlight frame entry", () => {
  it("includes the last selected frame and allows the full source or two frames", () => {
    expect(validateHighlightDraft("0", "99", 100, []).range).toEqual({ startFrame: 0, endFrameExclusive: 100 });
    expect(validateHighlightDraft("98", "99", 100, []).range).toEqual({ startFrame: 98, endFrameExclusive: 100 });
  });
  it.each(["", " ", "-1", "1.5", "1e1", "NaN", "100"])("rejects incomplete or invalid input %j", (value) => {
    expect(parseFrame(value, 100)).toBeUndefined();
    expect(validateHighlightDraft(value, "99", 100, []).error).toBeDefined();
  });
  it("rejects reversed and one-frame selections without swapping boundaries", () => {
    expect(validateHighlightDraft("50", "10", 100, []).range).toBeUndefined();
    expect(validateHighlightDraft("50", "50", 100, []).range).toBeUndefined();
  });
  it("rejects cutting a slow section but permits including or excluding it", () => {
    expect(validateHighlightDraft("25", "99", 100, [section]).error).toMatch(/slow-motion/);
    expect(validateHighlightDraft("0", "30", 100, [section]).error).toMatch(/slow-motion/);
    expect(validateHighlightDraft("20", "39", 100, [section]).range).toBeDefined();
    expect(validateHighlightDraft("40", "99", 100, [section]).range).toBeDefined();
  });
});

describe("timeline frame coordinates", () => {
  const range = { startFrame: 100, endFrameExclusive: 200 };
  it("uses the same frame grid for a scrolled track and focused range", () => {
    expect(frameAtPosition(8, -400, 800, range)).toBe(151);
    expect(frameAtPosition(-1000, -400, 800, range)).toBe(100);
    expect(frameAtPosition(400, -400, 800, range)).toBe(199);
  });
  it("preserves the grab offset and frozen scale at full or frame-level zoom", () => {
    expect(draggedBoundary(33, 33, 150, 800, range)).toBe(150);
    expect(draggedBoundary(41, 33, 150, 800, range)).toBe(151);
    expect(draggedBoundary(25, 33, 150, 800, range)).toBe(149);
    expect(draggedBoundary(43, 33, 150, 100, range)).toBe(160);
  });
  it("clamps source bounds and minimum length", () => {
    const current = { startFrame: 0, endFrameExclusive: 100 };
    expect(moveHighlightBoundary(current, "start", -1, 100, []).range.startFrame).toBe(0);
    expect(moveHighlightBoundary(current, "end", 101, 100, []).range.endFrameExclusive).toBe(100);
    expect(moveHighlightBoundary(current, "start", 100, 100, []).range.startFrame).toBe(98);
    expect(moveHighlightBoundary(current, "end", 0, 100, []).range.endFrameExclusive).toBe(2);
  });
  it("snaps to a legal section edge even when the nearest edge would leave one frame", () => {
    const current = { startFrame: 0, endFrameExclusive: 40 };
    const result = moveHighlightBoundary(current, "start", 39, 100, [section]);
    expect(result).toEqual({ range: { startFrame: 20, endFrameExclusive: 40 }, snapped: true });
    expect(validateHighlightDraft(String(result.range.startFrame), "39", 100, [section]).error).toBeUndefined();
    expect(moveHighlightBoundary({ startFrame: 20, endFrameExclusive: 100 }, "end", 21, 100, [section]).range.endFrameExclusive).toBe(40);
  });
});
