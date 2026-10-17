import { crowdGainAtFrame, fpsValue } from "./timeline.js";
import type { CrowdGainPoint, Rational } from "./types.js";

export const crowdAccentPresets = {
  pop: { label: "Sharp pop", holdSeconds: 0.12, releaseSeconds: 0.35 },
  swell: { label: "Short burst", holdSeconds: 0.35, releaseSeconds: 0.8 },
  cheer: { label: "Long cheer", holdSeconds: 1.2, releaseSeconds: 1.5 },
} as const;
export type CrowdAccentPreset = keyof typeof crowdAccentPresets;

/** Add a one-frame attack at the playhead and rejoin the existing envelope. */
export function addCrowdAccent(points: CrowdGainPoint[], fallbackGainDb: number, frame: number, frameCount: number, fps: Rational, preset: CrowdAccentPreset, peakGainDb: number, createId: () => string): CrowdGainPoint[] {
  const start = Math.max(0, Math.min(frameCount - 1, Math.round(frame)));
  const settings = crowdAccentPresets[preset];
  const hold = Math.min(frameCount - 1, start + Math.max(1, Math.round(settings.holdSeconds * fpsValue(fps))));
  const end = Math.min(frameCount - 1, hold + Math.max(1, Math.round(settings.releaseSeconds * fpsValue(fps))));
  const before = Math.max(0, start - 1);
  const values = new Map<number, number>();
  // Preserve the envelope outside the accent, including its previous flat ends.
  for (const anchor of [0, before, end, frameCount - 1]) values.set(anchor, crowdGainAtFrame(points, fallbackGainDb, anchor));
  values.set(start, Math.max(-60, Math.min(0, peakGainDb)));
  if (hold > start && hold < end) values.set(hold, Math.max(-60, Math.min(0, peakGainDb)));
  const retained = points.filter(point => point.frame < before || point.frame > end);
  for (const [anchor, gainDb] of values) {
    if (retained.some(point => point.frame === anchor)) continue;
    retained.push({ id: points.find(point => point.frame === anchor)?.id ?? createId(), frame: anchor, gainDb });
  }
  return retained.sort((a, b) => a.frame - b.frame);
}
