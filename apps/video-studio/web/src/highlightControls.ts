import { validateHighlightRange, type HighlightRange, type SlowSection } from "@remote-workspace/video-shared";

export function parseFrame(value: string, frameCount: number): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const frame = Number(value);
  return Number.isSafeInteger(frame) && frame >= 0 && frame < frameCount ? frame : undefined;
}

export function validateHighlightDraft(start: string, last: string, frameCount: number, sections: SlowSection[]): { range?: HighlightRange; error?: string } {
  const startFrame = parseFrame(start, frameCount);
  const lastFrame = parseFrame(last, frameCount);
  if (startFrame === undefined || lastFrame === undefined) return { error: `Enter whole frame numbers from 0 to ${(frameCount - 1).toLocaleString()}.` };
  const range = { startFrame, endFrameExclusive: lastFrame + 1 };
  try {
    validateHighlightRange(range, frameCount, sections);
    return { range };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : "Invalid highlight range." };
  }
}

// Every frame occupies [frame, frame + 1); boundaries and playheads share this grid.
export function frameAtPosition(clientX: number, left: number, width: number, range: HighlightRange): number {
  const frame = range.startFrame + Math.round((clientX - left) / Math.max(1, width) * (range.endFrameExclusive - range.startFrame));
  return Math.max(range.startFrame, Math.min(range.endFrameExclusive - 1, frame));
}

export function draggedBoundary(clientX: number, originX: number, originFrame: number, width: number, range: HighlightRange): number {
  return originFrame + Math.round((clientX - originX) / Math.max(1, width) * (range.endFrameExclusive - range.startFrame));
}

export function moveHighlightBoundary(current: HighlightRange, edge: "start" | "end", requested: number, frameCount: number, sections: SlowSection[]): { range: HighlightRange; snapped: boolean } {
  let boundary = edge === "start"
    ? Math.max(0, Math.min(requested, current.endFrameExclusive - 2))
    : Math.min(frameCount, Math.max(requested, current.startFrame + 2));
  const section = sections.find((item) => boundary > item.startFrame && boundary < item.endFrameExclusive);
  if (section) {
    const candidates = [section.startFrame, section.endFrameExclusive]
      .filter((frame) => edge === "start" ? frame <= current.endFrameExclusive - 2 : frame >= current.startFrame + 2)
      .sort((a, b) => Math.abs(a - boundary) - Math.abs(b - boundary));
    boundary = candidates[0] ?? (edge === "start" ? current.startFrame : current.endFrameExclusive);
  }
  const range = edge === "start" ? { ...current, startFrame: boundary } : { ...current, endFrameExclusive: boundary };
  return { range, snapped: Boolean(section) };
}
