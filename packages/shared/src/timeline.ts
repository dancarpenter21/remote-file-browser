import type { HighlightRange, Rational, SlowSection } from "./types.js";

export interface TimelineMap {
  frameExpansion: number[];
  outputPositionBySourceFrame: number[];
  outputFrameCount: number;
  durationSeconds: number;
}

export function fpsValue(fps: Rational): number {
  return fps.num / fps.den;
}

export function fpsString(fps: Rational): string {
  return `${fps.num}/${fps.den}`;
}

export function frameToSeconds(frame: number, fps: Rational): number {
  return (frame * fps.den) / fps.num;
}

export function formatFrameTime(frame: number, fps: Rational): string {
  const seconds = frameToSeconds(frame, fps);
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const frameWithinSecond = Math.floor((seconds - whole) * fpsValue(fps) + 1e-7);
  return [hours, minutes, secs]
    .map((part) => part.toString().padStart(2, "0"))
    .join(":") + `:${frameWithinSecond.toString().padStart(2, "0")}`;
}

export function defaultRampFrames(rangeLength: number, fps: Rational): number {
  return Math.max(0, Math.min(Math.round(0.5 * fpsValue(fps)), Math.floor(rangeLength / 4)));
}

export function validateSections(sections: SlowSection[], frameCount: number): void {
  const ordered = [...sections].sort((a, b) => a.startFrame - b.startFrame);
  for (let index = 0; index < ordered.length; index += 1) {
    const section = ordered[index]!;
    if (section.startFrame < 0 || section.endFrameExclusive > frameCount) {
      throw new Error("A slow-motion range is outside the source timeline.");
    }
    const length = section.endFrameExclusive - section.startFrame;
    if (length < 2) {
      throw new Error("Slow-motion ranges must contain at least two frames.");
    }
    if (section.rampInFrames + section.rampOutFrames > length) {
      throw new Error("Ramp handles cannot overlap.");
    }
    const previous = ordered[index - 1];
    if (previous && previous.endFrameExclusive > section.startFrame) {
      throw new Error("Slow-motion ranges cannot overlap.");
    }
  }
}

export function effectiveHighlightRange(frameCount: number, range?: HighlightRange): HighlightRange {
  return range ?? { startFrame: 0, endFrameExclusive: frameCount };
}

export function highlightContainsSection(range: HighlightRange, section: SlowSection): boolean {
  return section.startFrame >= range.startFrame && section.endFrameExclusive <= range.endFrameExclusive;
}

export function highlightIntersectsSection(range: HighlightRange, section: SlowSection): boolean {
  return section.startFrame < range.endFrameExclusive && section.endFrameExclusive > range.startFrame;
}

export function validateHighlightRange(range: HighlightRange, frameCount: number, sections: SlowSection[]): void {
  if (range.startFrame < 0 || range.endFrameExclusive > frameCount || range.endFrameExclusive - range.startFrame < 2) {
    throw new Error("The highlight must contain at least two source frames and stay inside the video.");
  }
  if (sections.some((section) => highlightIntersectsSection(range, section) && !highlightContainsSection(range, section))) {
    throw new Error("The highlight boundary cannot cut through a slow-motion section.");
  }
}

export function localizeSectionsForHighlight(range: HighlightRange, sections: SlowSection[]): SlowSection[] {
  return sections
    .filter((section) => highlightContainsSection(range, section))
    .map((section) => ({
      ...section,
      startFrame: section.startFrame - range.startFrame,
      endFrameExclusive: section.endFrameExclusive - range.startFrame,
    }));
}

export function compileHighlightTimeline(frameCount: number, fps: Rational, sections: SlowSection[], range?: HighlightRange): TimelineMap {
  const effectiveRange = effectiveHighlightRange(frameCount, range);
  validateSections(sections, frameCount);
  validateHighlightRange(effectiveRange, frameCount, sections);
  return compileTimeline(
    effectiveRange.endFrameExclusive - effectiveRange.startFrame,
    fps,
    localizeSectionsForHighlight(effectiveRange, sections),
  );
}

function smoothstepPrimitive(u: number): number {
  return u ** 3 - 0.5 * u ** 4;
}

function rampIntervalExpansion(interval: number, rampFrames: number, expansion: number, reverse: boolean): number {
  if (rampFrames <= 0) return expansion;
  const u0 = interval / rampFrames;
  const u1 = (interval + 1) / rampFrames;
  const easedIntegral = smoothstepPrimitive(u1) - smoothstepPrimitive(u0);
  if (reverse) {
    return expansion - (expansion - 1) * rampFrames * easedIntegral;
  }
  return 1 + (expansion - 1) * rampFrames * easedIntegral;
}

export function expansionForFrame(frame: number, section: SlowSection): number {
  const local = frame - section.startFrame;
  const length = section.endFrameExclusive - section.startFrame;
  const expansion = 1 / section.speed;
  if (local < 0 || local >= length) return 1;
  if (local < section.rampInFrames) {
    return rampIntervalExpansion(local, section.rampInFrames, expansion, false);
  }
  const rampOutStart = length - section.rampOutFrames;
  if (local >= rampOutStart && section.rampOutFrames > 0) {
    return rampIntervalExpansion(local - rampOutStart, section.rampOutFrames, expansion, true);
  }
  return expansion;
}

export function compileTimeline(frameCount: number, fps: Rational, sections: SlowSection[]): TimelineMap {
  validateSections(sections, frameCount);
  const ordered = [...sections].sort((a, b) => a.startFrame - b.startFrame);
  const frameExpansion = new Array<number>(frameCount).fill(1);
  let sectionIndex = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    while (ordered[sectionIndex] && frame >= ordered[sectionIndex]!.endFrameExclusive) sectionIndex += 1;
    const section = ordered[sectionIndex];
    if (section && frame >= section.startFrame) frameExpansion[frame] = expansionForFrame(frame, section);
  }
  const outputPositionBySourceFrame = new Array<number>(frameCount + 1).fill(0);
  for (let frame = 0; frame < frameCount; frame += 1) {
    outputPositionBySourceFrame[frame + 1] = outputPositionBySourceFrame[frame]! + frameExpansion[frame]!;
  }
  const outputFrameCount = Math.max(1, Math.round(outputPositionBySourceFrame[frameCount]!));
  return {
    frameExpansion,
    outputPositionBySourceFrame,
    outputFrameCount,
    durationSeconds: frameToSeconds(outputFrameCount, fps),
  };
}

function number(value: number): string {
  return Number(value.toFixed(12)).toString();
}

/** Builds an FFmpeg expression returning remapped output-frame position for source frame N. */
export function buildSetPtsFrameExpression(frameCount: number, sections: SlowSection[]): string {
  validateSections(sections, frameCount);
  const ordered = [...sections].sort((a, b) => a.startFrame - b.startFrame);
  let sourceCursor = 0;
  let outputCursor = 0;
  const pieces: Array<{ end: number; expression: string }> = [];
  for (const section of ordered) {
    if (section.startFrame > sourceCursor) {
      pieces.push({ end: section.startFrame, expression: `${number(outputCursor)}+(N-${sourceCursor})` });
      outputCursor += section.startFrame - sourceCursor;
    }
    const expansion = 1 / section.speed;
    if (section.rampInFrames > 0) {
      const r = section.rampInFrames;
      const u = `(N-${section.startFrame})/${r}`;
      pieces.push({
        end: section.startFrame + r,
        expression: `${number(outputCursor)}+${r}*(${u}+${number(expansion - 1)}*(${u}*${u}*${u}-0.5*${u}*${u}*${u}*${u}))`,
      });
      outputCursor += r * (1 + expansion) / 2;
    }
    const plateauStart = section.startFrame + section.rampInFrames;
    const plateauEnd = section.endFrameExclusive - section.rampOutFrames;
    if (plateauEnd > plateauStart) {
      pieces.push({ end: plateauEnd, expression: `${number(outputCursor)}+(N-${plateauStart})*${number(expansion)}` });
      outputCursor += (plateauEnd - plateauStart) * expansion;
    }
    if (section.rampOutFrames > 0) {
      const r = section.rampOutFrames;
      const u = `(N-${plateauEnd})/${r}`;
      pieces.push({
        end: section.endFrameExclusive,
        expression: `${number(outputCursor)}+${r}*(${number(expansion)}*${u}-${number(expansion - 1)}*(${u}*${u}*${u}-0.5*${u}*${u}*${u}*${u}))`,
      });
      outputCursor += r * (1 + expansion) / 2;
    }
    sourceCursor = section.endFrameExclusive;
  }
  pieces.push({ end: frameCount + 1, expression: `${number(outputCursor)}+(N-${sourceCursor})` });
  return pieces.reduceRight((next, piece) => `if(lt(N\,${piece.end})\,${piece.expression}\,${next})`, `${number(outputCursor + frameCount - sourceCursor)}+(N-${frameCount})`);
}
