import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { crowdGainAtFrame, formatFrameTime, fpsValue, highlightContainsSection, highlightIntersectsSection, type CrowdGainPoint, type HighlightRange, type Rational, type SlowSection } from "@remote-workspace/video-shared";
import { draggedBoundary, frameAtPosition, moveHighlightBoundary } from "./highlightControls.js";
import { apiUrl } from "./urls.js";

interface Props {
  projectId: string;
  frameCount: number;
  fps: Rational;
  currentFrame: number;
  highlightRange: HighlightRange;
  draftStartFrame?: number;
  draftLastFrame?: number;
  sections: SlowSection[];
  selectedSectionId?: string;
  onSelectSection: (id: string) => void;
  crowdGainPoints: CrowdGainPoint[];
  crowdGainDb: number;
  waveformUrl?: string;
  disabled?: boolean;
  onSeek: (frame: number) => void;
  onScrubChange: (scrubbing: boolean) => void;
  onHighlightChange: (range: HighlightRange) => void;
  onHighlightCommit: (range: HighlightRange) => void;
  onSectionsChange: (sections: SlowSection[]) => void;
  onSectionsCommit: (sections: SlowSection[]) => void;
  onCrowdGainPointsChange: (points: CrowdGainPoint[]) => void;
  onCrowdGainPointsCommit: (points: CrowdGainPoint[]) => void;
  onAddCrowdGainPoint: (frame: number, gainDb?: number) => void;
}

type Drag = { sectionId: string; edge: "start" | "end" | "rampIn" | "rampOut" };
type HighlightDrag = { edge: "start" | "end"; range: HighlightRange; original: HighlightRange; originX: number; originFrame: number; width: number; previewFrame: number };
type HoverPreview = { frame: number; left: number; top: number };

export function Timeline(props: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const pendingPreviewFrameRef = useRef<number | undefined>(undefined);
  const previewSeekTimerRef = useRef<number | undefined>(undefined);
  const lastPreviewSeekRef = useRef(0);
  const [zoom, setZoom] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 1, left: 0 });
  const pendingAnchorRef = useRef<{ frame: number; pixel: number } | undefined>(undefined);
  const [dragNotice, setDragNotice] = useState("");
  const [focused, setFocused] = useState(false);
  const [drag, setDrag] = useState<Drag>();
  const [highlightDrag, setHighlightDrag] = useState<HighlightDrag>();
  const [scrubbing, setScrubbing] = useState(false);
  const [hoverPreview, setHoverPreview] = useState<HoverPreview>();
  const [gainDragId, setGainDragId] = useState<string>();
  const gainLaneRef = useRef<HTMLDivElement>(null);
  const gainPointsRef = useRef(props.crowdGainPoints);
  gainPointsRef.current = props.crowdGainPoints;
  const ordered = useMemo(() => [...props.sections].sort((a, b) => a.startFrame - b.startFrame), [props.sections]);
  const sectionsRef = useRef(props.sections);
  sectionsRef.current = props.sections;
  const seekCallbacksRef = useRef({ onSeek: props.onSeek, onScrubChange: props.onScrubChange });
  seekCallbacksRef.current = { onSeek: props.onSeek, onScrubChange: props.onScrubChange };
  const highlightCallbacksRef = useRef({ onChange: props.onHighlightChange, onCommit: props.onHighlightCommit });
  const highlightRef = useRef(props.highlightRange);
  highlightCallbacksRef.current = { onChange: props.onHighlightChange, onCommit: props.onHighlightCommit };
  highlightRef.current = props.highlightRange;
  const focusRange = useMemo(() => {
    if (!focused) return { startFrame: 0, endFrameExclusive: props.frameCount };
    const length = props.highlightRange.endFrameExclusive - props.highlightRange.startFrame;
    const context = Math.max(1, Math.round(length * 0.05));
    return {
      startFrame: Math.max(0, props.highlightRange.startFrame - context),
      endFrameExclusive: Math.min(props.frameCount, props.highlightRange.endFrameExclusive + context),
    };
  }, [focused, props.frameCount, props.highlightRange]);
  const viewRange = highlightDrag?.range ?? focusRange;
  const viewFrameCount = viewRange.endFrameExclusive - viewRange.startFrame;
  const maxZoom = Math.max(1, viewFrameCount * 8 / viewport.width);
  const zoomFactor = Math.pow(maxZoom, zoom / 100);
  const trackWidth = highlightDrag?.width ?? Math.max(viewport.width, viewport.width * zoomFactor);
  const pixelsPerFrame = trackWidth / viewFrameCount;

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const update = () => setViewport({ width: Math.max(1, scroll.clientWidth), left: scroll.scrollLeft });
    const observer = new ResizeObserver(update);
    observer.observe(scroll);
    update();
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    const scroll = scrollRef.current;
    if (anchor && scroll) {
      scroll.scrollLeft = (anchor.frame - viewRange.startFrame) * pixelsPerFrame - anchor.pixel;
      setViewport({ width: Math.max(1, scroll.clientWidth), left: scroll.scrollLeft });
      pendingAnchorRef.current = undefined;
    }
  }, [zoom, focused, viewRange.startFrame, viewRange.endFrameExclusive, pixelsPerFrame]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const wheel = (event: WheelEvent) => {
      // Leave horizontal gestures available for panning the zoomed timeline.
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.deltaY === 0) return;
      event.preventDefault();
      if (highlightDrag || drag || scrubbing || gainDragId || maxZoom <= 1) return;
      const track = trackRef.current;
      if (!track) return;
      const scrollRect = scroll.getBoundingClientRect();
      const trackRect = track.getBoundingClientRect();
      const pixel = Math.max(0, Math.min(scroll.clientWidth, event.clientX - scrollRect.left));
      pendingAnchorRef.current = {
        frame: viewRange.startFrame + (event.clientX - trackRect.left) / trackRect.width * (viewRange.endFrameExclusive - viewRange.startFrame),
        pixel,
      };
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? scroll.clientHeight : 1;
      const delta = Math.max(-120, Math.min(120, event.deltaY * unit)) * 0.2 / Math.log(maxZoom);
      setZoom((previous) => Math.max(0, Math.min(100, previous - delta)));
      setHoverPreview(undefined);
    };
    // React's delegated wheel handlers are passive, so use a native listener
    // to suppress page scrolling while zooming the timeline.
    scroll.addEventListener("wheel", wheel, { passive: false });
    return () => scroll.removeEventListener("wheel", wheel);
  }, [viewRange.startFrame, viewRange.endFrameExclusive, highlightDrag, drag, scrubbing, gainDragId, maxZoom]);

  function resetZoom(): void {
    pendingAnchorRef.current = undefined;
    setFocused(false);
    setZoom(0);
    setHoverPreview(undefined);
    const scroll = scrollRef.current;
    if (scroll) {
      scroll.scrollLeft = 0;
      setViewport({ width: Math.max(1, scroll.clientWidth), left: 0 });
    }
  }

  function changeZoom(next: number): void {
    const pixel = (props.currentFrame - viewRange.startFrame) * pixelsPerFrame - viewport.left;
    pendingAnchorRef.current = pixel >= 0 && pixel <= viewport.width
      ? { frame: props.currentFrame, pixel }
      : { frame: viewRange.startFrame + (viewport.left + viewport.width / 2) / pixelsPerFrame, pixel: viewport.width / 2 };
    setZoom(next);
  }

  function zoomToBoundary(frame: number): void {
    pendingAnchorRef.current = { frame, pixel: viewport.width / 2 };
    setFocused(false);
    setZoom(100);
    props.onSeek(frame);
    // Also center when the zoom is already at its maximum.
    if (!focused && zoom === 100 && scrollRef.current) {
      scrollRef.current.scrollLeft = (frame - viewRange.startFrame) * pixelsPerFrame - viewport.width / 2;
      pendingAnchorRef.current = undefined;
      setViewport({ width: viewport.width, left: scrollRef.current.scrollLeft });
    }
  }

  const tickStep = pixelsPerFrame >= 8 ? 1 : Math.max(1, Math.ceil(90 / pixelsPerFrame / fpsValue(props.fps))) * fpsValue(props.fps);
  const firstVisible = viewRange.startFrame + viewport.left / pixelsPerFrame;
  const lastVisible = Math.min(viewRange.endFrameExclusive - 1, firstVisible + viewport.width / pixelsPerFrame);
  const ticks: number[] = [];
  for (let tick = Math.ceil(firstVisible / tickStep) * tickStep; tick <= lastVisible; tick += tickStep) ticks.push(Math.round(tick));
  const highlightIsFull = props.highlightRange.startFrame === 0 && props.highlightRange.endFrameExclusive === props.frameCount;

  useEffect(() => {
    if (highlightIsFull && !highlightDrag) setFocused(false);
  }, [highlightIsFull, highlightDrag]);

  function framePercent(frame: number): number {
    return (frame - viewRange.startFrame) / Math.max(1, viewFrameCount) * 100;
  }

  function eventFrame(clientX: number): number {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return frameAtPosition(clientX, rect.left, rect.width, viewRange);
  }

  function beginHighlightDrag(event: ReactPointerEvent<HTMLButtonElement>, edge: "start" | "end"): void {
    event.preventDefault();
    event.stopPropagation();
    if (props.disabled || event.button !== 0 || !trackRef.current) return;
    const original = { ...props.highlightRange };
    const originFrame = edge === "start" ? original.startFrame : original.endFrameExclusive;
    setHighlightDrag({ edge, range: { ...viewRange }, original, originX: event.clientX, originFrame, width: trackRef.current.getBoundingClientRect().width, previewFrame: props.currentFrame });
    setHoverPreview(undefined);
    setDragNotice(`${edge === "start" ? "Start" : "Last"} frame ${edge === "start" ? originFrame : originFrame - 1}`);
    props.onSeek(edge === "start" ? originFrame : originFrame - 1);
  }

  function stepBoundary(event: ReactKeyboardEvent<HTMLButtonElement>, edge: "start" | "end"): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    if (props.disabled || highlightDrag) return;
    const current = highlightRef.current;
    const boundary = edge === "start" ? current.startFrame : current.endFrameExclusive;
    const { range, snapped } = moveHighlightBoundary(current, edge, boundary + (event.key === "ArrowLeft" ? -1 : 1), props.frameCount, props.sections);
    const frame = edge === "start" ? range.startFrame : range.endFrameExclusive - 1;
    props.onSeek(frame);
    setDragNotice(`${edge === "start" ? "Start" : "Last"} frame ${frame.toLocaleString()}${snapped ? " · Snapped to slow-section boundary" : ""}`);
    if (range.startFrame === current.startFrame && range.endFrameExclusive === current.endFrameExclusive) return;
    highlightRef.current = range;
    props.onHighlightChange(range);
    props.onHighlightCommit(range);
  }

  useEffect(() => {
    if (!highlightDrag) return;
    const move = (event: PointerEvent) => {
      const current = highlightRef.current;
      const boundary = draggedBoundary(event.clientX, highlightDrag.originX, highlightDrag.originFrame, highlightDrag.width, highlightDrag.range);
      const { range: next, snapped } = moveHighlightBoundary(current, highlightDrag.edge, boundary, props.frameCount, props.sections);
      const frame = highlightDrag.edge === "start" ? next.startFrame : next.endFrameExclusive - 1;
      highlightRef.current = next;
      highlightCallbacksRef.current.onChange(next);
      seekCallbacksRef.current.onSeek(frame);
      setDragNotice(`${highlightDrag.edge === "start" ? "Start" : "Last"} frame ${frame.toLocaleString()}${snapped ? " · Snapped to slow-section boundary" : ""}`);
    };
    const up = (event: PointerEvent) => {
      move(event);
      highlightCallbacksRef.current.onCommit(highlightRef.current);
      setHighlightDrag(undefined);
    };
    const cancel = () => {
      highlightRef.current = highlightDrag.original;
      highlightCallbacksRef.current.onChange(highlightDrag.original);
      seekCallbacksRef.current.onSeek(highlightDrag.previewFrame);
      setHighlightDrag(undefined);
      setDragNotice("Boundary edit cancelled.");
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); cancel(); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", keydown);
    };
  }, [highlightDrag, props.frameCount, props.sections]);

  function queuePreviewSeek(frame: number): void {
    pendingPreviewFrameRef.current = frame;
    if (previewSeekTimerRef.current !== undefined) return;
    const delay = Math.max(0, 80 - (performance.now() - lastPreviewSeekRef.current));
    previewSeekTimerRef.current = window.setTimeout(() => {
      const pendingFrame = pendingPreviewFrameRef.current;
      if (pendingFrame !== undefined && previewVideoRef.current) {
        previewVideoRef.current.currentTime = pendingFrame / fpsValue(props.fps);
      }
      lastPreviewSeekRef.current = performance.now();
      previewSeekTimerRef.current = undefined;
    }, delay);
  }

  useEffect(() => () => {
    if (previewSeekTimerRef.current !== undefined) window.clearTimeout(previewSeekTimerRef.current);
  }, []);

  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => {
      const frame = eventFrame(event.clientX);
      const next = ordered.map((section) => {
        if (section.id !== drag.sectionId) return section;
        const previous = ordered[ordered.indexOf(section) - 1];
        const following = ordered[ordered.indexOf(section) + 1];
        let candidate: SlowSection;
        if (drag.edge === "start") {
          const startFrame = Math.max(previous?.endFrameExclusive ?? 0, Math.min(frame, section.endFrameExclusive - 2));
          const length = section.endFrameExclusive - startFrame;
          candidate = { ...section, startFrame, rampInFrames: Math.min(section.rampInFrames, length - section.rampOutFrames) };
        } else if (drag.edge === "end") {
          const endFrameExclusive = Math.min(following?.startFrame ?? props.frameCount, Math.max(frame + 1, section.startFrame + 2));
          const length = endFrameExclusive - section.startFrame;
          candidate = { ...section, endFrameExclusive, rampOutFrames: Math.min(section.rampOutFrames, length - section.rampInFrames) };
        } else if (drag.edge === "rampIn") {
          const length = section.endFrameExclusive - section.startFrame;
          const rampInFrames = Math.max(0, Math.min(frame - section.startFrame, length - section.rampOutFrames));
          candidate = { ...section, rampInFrames };
        } else {
          const length = section.endFrameExclusive - section.startFrame;
          const rampOutFrames = Math.max(0, Math.min(section.endFrameExclusive - frame, length - section.rampInFrames));
          candidate = { ...section, rampOutFrames };
        }
        return highlightIntersectsSection(props.highlightRange, candidate) && !highlightContainsSection(props.highlightRange, candidate) ? section : candidate;
      });
      sectionsRef.current = next;
      props.onSectionsChange(next);
    };
    const up = () => {
      props.onSectionsCommit(sectionsRef.current);
      setDrag(undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, ordered, props]);

  useEffect(() => {
    if (!gainDragId) return;
    const move = (event: PointerEvent) => {
      const lane = gainLaneRef.current;
      if (!lane) return;
      const rect = lane.getBoundingClientRect();
      const gainDb = Math.round(Math.max(-60, Math.min(0, -60 * (event.clientY - rect.top) / rect.height)));
      const requestedFrame = eventFrame(event.clientX);
      const occupied = new Set(gainPointsRef.current.filter((point) => point.id !== gainDragId).map((point) => point.frame));
      const current = gainPointsRef.current.find((point) => point.id === gainDragId)!;
      const frame = occupied.has(requestedFrame) ? current.frame : requestedFrame;
      const next = gainPointsRef.current.map((point) => point.id === gainDragId ? { ...point, frame, gainDb } : point).sort((a, b) => a.frame - b.frame);
      gainPointsRef.current = next;
      props.onCrowdGainPointsChange(next);
    };
    const up = () => {
      props.onCrowdGainPointsCommit(gainPointsRef.current);
      setGainDragId(undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [gainDragId, props]);

  useEffect(() => {
    if (!scrubbing) return;
    let pendingClientX: number | undefined;
    let animationFrame: number | undefined;

    const flush = () => {
      animationFrame = undefined;
      if (pendingClientX !== undefined) seekCallbacksRef.current.onSeek(eventFrame(pendingClientX));
      pendingClientX = undefined;
    };
    const move = (event: PointerEvent) => {
      pendingClientX = event.clientX;
      if (animationFrame === undefined) animationFrame = window.requestAnimationFrame(flush);
    };
    const up = (event: PointerEvent) => {
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
      seekCallbacksRef.current.onSeek(eventFrame(event.clientX));
      seekCallbacksRef.current.onScrubChange(false);
      setScrubbing(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
    };
  }, [scrubbing, props.frameCount, viewRange]);

  return (
    <section className="timeline-shell" aria-label="Source timeline">
      <div className="timeline-toolbar">
        <span>{formatFrameTime(props.currentFrame, props.fps)}</span>
        <span className="frame-label">Frame {props.currentFrame.toLocaleString()} / {(props.frameCount - 1).toLocaleString()}</span>
        <button className="timeline-focus-button" disabled={Boolean(highlightDrag || drag || scrubbing || gainDragId)} onClick={resetZoom}>Reset zoom</button>
        <button className="timeline-focus-button" disabled={highlightIsFull || Boolean(highlightDrag)} onClick={() => { pendingAnchorRef.current = { frame: props.highlightRange.startFrame, pixel: 0 }; setFocused((value) => !value); setZoom(0); }}>{focused ? "Show full video" : "Focus highlight"}</button>
        <button className="timeline-focus-button" disabled={props.disabled || props.crowdGainPoints.some((point) => point.frame === props.currentFrame)} onClick={() => props.onAddCrowdGainPoint(props.currentFrame)}>Add crowd point</button>
        <button className="timeline-focus-button" disabled={props.draftStartFrame === undefined || Boolean(highlightDrag)} onClick={() => props.draftStartFrame !== undefined && zoomToBoundary(props.draftStartFrame)}>Zoom to start</button>
        <button className="timeline-focus-button" disabled={props.draftLastFrame === undefined || Boolean(highlightDrag)} onClick={() => props.draftLastFrame !== undefined && zoomToBoundary(props.draftLastFrame)}>Zoom to end</button>
        <label>Zoom <input aria-label="Timeline zoom" type="range" min="0" max="100" step="1" value={zoom} disabled={Boolean(highlightDrag || drag || scrubbing || gainDragId)} onChange={(event) => changeZoom(Number(event.target.value))} /></label>
      </div>
      <output className="timeline-drag-notice" aria-live="polite">{dragNotice || "Wheel to zoom at the pointer. Shift+wheel to scroll. Drag a boundary to preview; Escape cancels."}</output>
      <div ref={scrollRef} className="timeline-scroll" onScroll={(event) => setViewport({ width: Math.max(1, event.currentTarget.clientWidth), left: event.currentTarget.scrollLeft })}>
        <div
          ref={trackRef}
          className={`timeline-track${scrubbing ? " is-scrubbing" : ""}`}
          style={{ width: `${trackWidth}px`, backgroundImage: props.waveformUrl ? `linear-gradient(90deg, rgba(13,16,22,.3), rgba(13,16,22,.3)), url(${props.waveformUrl})` : undefined }}
          onPointerDown={(event) => {
            if (!props.disabled && event.button === 0) {
              event.preventDefault();
              const frame = eventFrame(event.clientX);
              props.onSeek(frame);
              props.onScrubChange(true);
              setScrubbing(true);
            }
          }}
          onPointerMove={(event) => {
            if (event.pointerType === "touch" || highlightDrag) return;
            const track = trackRef.current;
            if (!track) return;
            const frame = eventFrame(event.clientX);
            const rect = track.getBoundingClientRect();
            const previewWidth = 176;
            const previewHeight = 126;
            const left = Math.max(previewWidth / 2 + 8, Math.min(window.innerWidth - previewWidth / 2 - 8, event.clientX));
            const top = rect.top >= previewHeight + 8 ? rect.top - previewHeight - 8 : rect.bottom + 8;
            setHoverPreview({ frame, left, top });
            queuePreviewSeek(frame);
          }}
          onPointerLeave={() => setHoverPreview(undefined)}
        >
          <div className="timeline-ruler" aria-hidden="true">{ticks.map((frame) => <span key={frame} style={{ left: `${framePercent(frame)}%` }}>{pixelsPerFrame >= 8 ? (frame % Math.ceil(64 / pixelsPerFrame) === 0 ? frame.toLocaleString() : "") : formatFrameTime(frame, props.fps)}</span>)}</div>
          {ordered.map((section, index) => {
            if (section.endFrameExclusive <= viewRange.startFrame || section.startFrame >= viewRange.endFrameExclusive) return null;
            const left = framePercent(section.startFrame);
            const width = (section.endFrameExclusive - section.startFrame) / viewFrameCount * 100;
            const rampIn = section.rampInFrames / (section.endFrameExclusive - section.startFrame) * 100;
            const rampOut = section.rampOutFrames / (section.endFrameExclusive - section.startFrame) * 100;
            const active = highlightContainsSection(props.highlightRange, section);
            return (
              <div className={`timeline-section${props.selectedSectionId === section.id ? " selected" : ""}${active ? "" : " inactive"}`} onPointerDownCapture={() => props.onSelectSection(section.id)} key={section.id} style={{ left: `${left}%`, width: `${width}%` }}>
                <button className="section-caption" aria-label={`Select section ${index + 1}`} aria-pressed={props.selectedSectionId === section.id} onPointerDown={(event) => event.stopPropagation()} onClick={() => props.onSelectSection(section.id)}>{index + 1} · {section.speed}×</button>
                <button className="edge-handle start" aria-label={`Move start of section ${index + 1}`} disabled={props.disabled} onPointerDown={(event) => { event.stopPropagation(); if (!props.disabled) setDrag({ sectionId: section.id, edge: "start" }); }} />
                <button className="ramp-handle in" aria-label={`Adjust ramp in for section ${index + 1}`} disabled={props.disabled} style={{ left: `${rampIn}%` }} onPointerDown={(event) => { event.stopPropagation(); if (!props.disabled) setDrag({ sectionId: section.id, edge: "rampIn" }); }} />
                <button className="ramp-handle out" aria-label={`Adjust ramp out for section ${index + 1}`} disabled={props.disabled} style={{ right: `${rampOut}%` }} onPointerDown={(event) => { event.stopPropagation(); if (!props.disabled) setDrag({ sectionId: section.id, edge: "rampOut" }); }} />
                <button className="edge-handle end" aria-label={`Move end of section ${index + 1}`} disabled={props.disabled} onPointerDown={(event) => { event.stopPropagation(); if (!props.disabled) setDrag({ sectionId: section.id, edge: "end" }); }} />
              </div>
            );
          })}
          {props.highlightRange.startFrame > viewRange.startFrame && <div className="outside-highlight start" style={{ width: `${framePercent(props.highlightRange.startFrame)}%` }} />}
          {props.highlightRange.endFrameExclusive < viewRange.endFrameExclusive && <div className="outside-highlight end" style={{ left: `${framePercent(props.highlightRange.endFrameExclusive)}%` }} />}
          <button className="highlight-handle start" aria-label="Move highlight start" title="Drag to preview start; Left/Right adjusts by one frame" disabled={props.disabled} style={{ left: `${framePercent(props.highlightRange.startFrame)}%` }} onPointerDown={(event) => beginHighlightDrag(event, "start")} onKeyDown={(event) => stepBoundary(event, "start")} />
          <button className="highlight-handle end" aria-label="Move highlight end" title="Drag to preview last frame; Left/Right adjusts by one frame" disabled={props.disabled} style={{ left: `${framePercent(props.highlightRange.endFrameExclusive)}%` }} onPointerDown={(event) => beginHighlightDrag(event, "end")} onKeyDown={(event) => stepBoundary(event, "end")} />
          {props.currentFrame >= viewRange.startFrame && props.currentFrame < viewRange.endFrameExclusive && <div className="playhead" style={{ left: `${framePercent(props.currentFrame)}%` }} />}
          <div ref={gainLaneRef} className="crowd-gain-lane" title="Double-click to add a volume point; drag points to shape crowd audio" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={event => {
            event.stopPropagation();
            if (props.disabled || (event.target as HTMLElement).closest('button')) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const frame = Math.max(0, Math.min(props.frameCount - 1, Math.round(viewRange.startFrame + (event.clientX - rect.left) / rect.width * viewFrameCount)));
            const gainDb = Math.round(Math.max(-60, Math.min(0, -60 * (event.clientY - rect.top) / rect.height)));
            props.onAddCrowdGainPoint(frame, gainDb);
          }}>
            <span className="crowd-gain-label">CROWD</span>
            <svg aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 60"><polyline points={[{ frame: viewRange.startFrame, gainDb: crowdGainAtFrame(props.crowdGainPoints, props.crowdGainDb, viewRange.startFrame) }, ...props.crowdGainPoints.filter(point => point.frame > viewRange.startFrame && point.frame < viewRange.endFrameExclusive), { frame: viewRange.endFrameExclusive, gainDb: crowdGainAtFrame(props.crowdGainPoints, props.crowdGainDb, viewRange.endFrameExclusive) }].map(point => `${framePercent(point.frame)},${-point.gainDb}`).join(" ")} /></svg>
            {props.crowdGainPoints.map((point, index) => point.frame >= viewRange.startFrame && point.frame < viewRange.endFrameExclusive ? <button key={point.id} className="crowd-gain-point" aria-label={`Adjust crowd volume point ${index + 1}`} title={`${point.gainDb} dB at frame ${point.frame}`} disabled={props.disabled} style={{ left: `${framePercent(point.frame)}%`, top: `${(-point.gainDb / 60) * 100}%` }} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); if (!props.disabled) setGainDragId(point.id); }} /> : null)}
          </div>
        </div>
      </div>
      {hoverPreview && (
        <div className="timeline-frame-preview" style={{ left: hoverPreview.left, top: hoverPreview.top }} aria-hidden="true">
          <video ref={previewVideoRef} src={apiUrl(`/projects/${props.projectId}/media/proxy`)} muted playsInline preload="metadata" />
          <div><span>{formatFrameTime(hoverPreview.frame, props.fps)}</span><strong>Frame {hoverPreview.frame.toLocaleString()}</strong></div>
        </div>
      )}
    </section>
  );
}
