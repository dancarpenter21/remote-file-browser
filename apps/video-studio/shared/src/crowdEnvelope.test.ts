import { describe, expect, it } from "vitest";
import { addCrowdAccent } from "./crowdEnvelope.js";
import { crowdGainAtFrame, validateCrowdGainPoints } from "./timeline.js";
import { crowdGainPointSchema } from "./types.js";

const fps = { num: 30, den: 1 };
let id = 0;
const createId = () => `accent-${++id}`;

describe("crowd accents", () => {
  it("attacks in one frame and returns to a flat bed without changing either end", () => {
    const points = addCrowdAccent([], -30, 60, 300, fps, "pop", -3, createId);
    expect(crowdGainAtFrame(points, -30, 0)).toBe(-30);
    expect(crowdGainAtFrame(points, -30, 59)).toBe(-30);
    expect(crowdGainAtFrame(points, -30, 60)).toBe(-3);
    expect(crowdGainAtFrame(points, -30, 64)).toBe(-3);
    expect(crowdGainAtFrame(points, -30, 70)).toBeLessThan(-3);
    expect(crowdGainAtFrame(points, -30, 75)).toBe(-30);
    expect(crowdGainAtFrame(points, -30, 299)).toBe(-30);
  });

  it("replaces points inside the accent and preserves an existing envelope outside", () => {
    const original = [{ id: "a", frame: 0, gainDb: -40 }, { id: "b", frame: 62, gainDb: -20 }, { id: "c", frame: 100, gainDb: -10 }];
    const points = addCrowdAccent(original, -30, 60, 300, fps, "pop", -2, createId);
    expect(points.some(point => point.id === "b")).toBe(false);
    for (const frame of [0, 30, 59, 75, 90, 100, 299]) expect(crowdGainAtFrame(points, -30, frame)).toBeCloseTo(crowdGainAtFrame(original, -30, frame));
    expect(points.find(point => point.id === "c")).toEqual(original[2]);
  });

  it.each([0, 1, 298, 299])("keeps boundary accents valid at frame %s", frame => {
    const points = addCrowdAccent([], -30, frame, 300, fps, "cheer", -3, createId);
    expect(() => validateCrowdGainPoints(points, 300)).not.toThrow();
    points.forEach(point => expect(crowdGainPointSchema.safeParse(point).success).toBe(true));
    expect(crowdGainAtFrame(points, -30, frame)).toBe(-3);
  });

  it("allows repeated accents without duplicate IDs or frames", () => {
    const first = addCrowdAccent([], -30, 60, 300, fps, "cheer", -3, createId);
    const second = addCrowdAccent(first, -30, 65, 300, fps, "pop", -1, createId);
    expect(() => validateCrowdGainPoints(second, 300)).not.toThrow();
    expect(crowdGainAtFrame(second, -30, 65)).toBe(-1);
  });
});
