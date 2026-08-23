import { useEffect, useMemo, useRef, useState } from "react";
import { formatFrameTime, fpsValue, highlightContainsSection, highlightIntersectsSection, type HighlightRange, type Rational, type SlowSection } from "@vfx/shared";

interface Props {
  projectId: string;
  frameCount: number;
  fps: Rational;
  currentFrame: number;
  highlightRange: HighlightRange;
  sections: SlowSection[];
  waveformUrl?: string;
  disabled?: boolean;
  onSeek: (frame: number) => void;
  onScrubChange: (scrubbing: boolean) => void;
  onHighlightChange: (range: HighlightRange) => void;
  onHighlightCommit: (range: HighlightRange) => void;
  onSectionsChange: (sections: SlowSection[]) => void;
  onSectionsCommit: (sections: SlowSection[]) => void;
}

type Drag = { sectionId: string; edge: "start" | "end" | "rampIn" | "rampOut" };
type HighlightDrag = "start" | "end";
type HoverPreview = { frame: number; left: number; top: number };

export function Timeline(props: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const pendingPreviewFrameRef = useRef<number | undefined>(undefined);
  const previewSeekTimerRef = useRef<number | undefined>(undefined);
  const lastPreviewSeekRef = useRef(0);
  const [zoom, setZoom] = useState(1);
  const [focused, setFocused] = useState(false);
  const [drag, setDrag] = useState<Drag>();
  const [highlightDrag, setHighlightDrag] = useState<HighlightDrag>();
  const [scrubbing, setScrubbing] = useState(false);
  const [hoverPreview, setHoverPreview] = useState<HoverPreview>();
  const ordered = useMemo(() => [...props.sections].sort((a, b) => a.startFrame - b.startFrame), [props.sections]);
  const seekCallbacksRef = useRef({ onSeek: props.onSeek, onScrubChange: props.onScrubChange });
  seekCallbacksRef.current = { onSeek: props.onSeek, onScrubChange: props.onScrubChange };
  const highlightCallbacksRef = useRef({ onChange: props.onHighlightChange, onCommit: props.onHighlightCommit });
  const highlightRef = useRef(props.highlightRange);
  highlightCallbacksRef.current = { onChange: props.onHighlightChange, onCommit: props.onHighlightCommit };
  highlightRef.current = props.highlightRange;
  const viewRange = useMemo(() => {
    if (!focused) return { startFrame: 0, endFrameExclusive: props.frameCount };
    const length = props.highlightRange.endFrameExclusive - props.highlightRange.startFrame;
    const context = Math.max(1, Math.round(length * 0.05));
    return {
      startFrame: Math.max(0, props.highlightRange.startFrame - context),
      endFrameExclusive: Math.min(props.frameCount, props.highlightRange.endFrameExclusive + context),
    };
  }, [focused, props.frameCount, props.highlightRange]);
  const viewFrameCount = viewRange.endFrameExclusive - viewRange.startFrame;
  const highlightIsFull = props.highlightRange.startFrame === 0 && props.highlightRange.endFrameExclusive === props.frameCount;

  useEffect(() => {
    if (highlightIsFull) setFocused(false);
  }, [highlightIsFull]);

  function framePercent(frame: number): number {
    return (frame - viewRange.startFrame) / Math.max(1, viewFrameCount) * 100;
  }

  function eventFrame(clientX: number): number {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.max(viewRange.startFrame, Math.min(viewRange.endFrameExclusive - 1, viewRange.startFrame + Math.round(ratio * Math.max(0, viewFrameCount - 1))));
  }

  useEffect(() => {
    if (!highlightDrag) return;
    const move = (event: PointerEvent) => {
      const current = highlightRef.current;
      let boundary = eventFrame(event.clientX) + (highlightDrag === "end" ? 1 : 0);
      const containing = props.sections.find((section) => boundary > section.startFrame && boundary < section.endFrameExclusive);
      if (containing) boundary = boundary - containing.startFrame < containing.endFrameExclusive - boundary ? containing.startFrame : containing.endFrameExclusive;
      const next = highlightDrag === "start"
        ? { startFrame: Math.max(0, Math.min(boundary, current.endFrameExclusive - 2)), endFrameExclusive: current.endFrameExclusive }
        : { startFrame: current.startFrame, endFrameExclusive: Math.min(props.frameCount, Math.max(boundary, current.startFrame + 2)) };
      highlightRef.current = next;
      highlightCallbacksRef.current.onChange(next);
    };
    const up = () => {
      highlightCallbacksRef.current.onCommit(highlightRef.current);
      setHighlightDrag(undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [highlightDrag, props.frameCount, props.sections, viewRange]);

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
      props.onSectionsChange(next);
    };
    const up = () => {
      props.onSectionsCommit(props.sections);
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
        <button className="timeline-focus-button" disabled={highlightIsFull} onClick={() => { setFocused((value) => !value); setZoom(1); }}>{focused ? "Show full video" : "Focus highlight"}</button>
        <label>Zoom <input aria-label="Timeline zoom" type="range" min="1" max="12" step="1" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
      </div>
      <div className="timeline-scroll">
        <div
          ref={trackRef}
          className={`timeline-track${scrubbing ? " is-scrubbing" : ""}`}
          style={{ width: `${zoom * 100}%`, backgroundImage: props.waveformUrl ? `linear-gradient(90deg, rgba(13,16,22,.3), rgba(13,16,22,.3)), url(${props.waveformUrl})` : undefined }}
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
            if (event.pointerType === "touch") return;
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
          {ordered.map((section, index) => {
            if (section.endFrameExclusive <= viewRange.startFrame || section.startFrame >= viewRange.endFrameExclusive) return null;
            const left = framePercent(section.startFrame);
            const width = (section.endFrameExclusive - section.startFrame) / viewFrameCount * 100;
            const rampIn = section.rampInFrames / (section.endFrameExclusive - section.startFrame) * 100;
            const rampOut = section.rampOutFrames / (section.endFrameExclusive - section.startFrame) * 100;
            const active = highlightContainsSection(props.highlightRange, section);
            return (
              <div className={`timeline-section speed-${String(section.speed).replace(".", "-")}${active ? "" : " inactive"}`} key={section.id} style={{ left: `${left}%`, width: `${width}%` }}>
                <span className="section-caption">{index + 1} · {section.speed}×</span>
                <button className="edge-handle start" aria-label={`Move start of section ${index + 1}`} onPointerDown={(event) => { event.stopPropagation(); setDrag({ sectionId: section.id, edge: "start" }); }} />
                <button className="ramp-handle in" aria-label={`Adjust ramp in for section ${index + 1}`} style={{ left: `${rampIn}%` }} onPointerDown={(event) => { event.stopPropagation(); setDrag({ sectionId: section.id, edge: "rampIn" }); }} />
                <button className="ramp-handle out" aria-label={`Adjust ramp out for section ${index + 1}`} style={{ right: `${rampOut}%` }} onPointerDown={(event) => { event.stopPropagation(); setDrag({ sectionId: section.id, edge: "rampOut" }); }} />
                <button className="edge-handle end" aria-label={`Move end of section ${index + 1}`} onPointerDown={(event) => { event.stopPropagation(); setDrag({ sectionId: section.id, edge: "end" }); }} />
              </div>
            );
          })}
          {props.highlightRange.startFrame > viewRange.startFrame && <div className="outside-highlight start" style={{ width: `${framePercent(props.highlightRange.startFrame)}%` }} />}
          {props.highlightRange.endFrameExclusive < viewRange.endFrameExclusive && <div className="outside-highlight end" style={{ left: `${framePercent(props.highlightRange.endFrameExclusive)}%` }} />}
          <button className="highlight-handle start" aria-label="Move highlight start" disabled={props.disabled} style={{ left: `${framePercent(props.highlightRange.startFrame)}%` }} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); if (!props.disabled) setHighlightDrag("start"); }} />
          <button className="highlight-handle end" aria-label="Move highlight end" disabled={props.disabled} style={{ left: `${framePercent(props.highlightRange.endFrameExclusive)}%` }} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); if (!props.disabled) setHighlightDrag("end"); }} />
          {props.currentFrame >= viewRange.startFrame && props.currentFrame < viewRange.endFrameExclusive && <div className="playhead" style={{ left: `${framePercent(props.currentFrame)}%` }} />}
        </div>
      </div>
      {hoverPreview && (
        <div className="timeline-frame-preview" style={{ left: hoverPreview.left, top: hoverPreview.top }} aria-hidden="true">
          <video ref={previewVideoRef} src={`/api/projects/${props.projectId}/media/proxy`} muted playsInline preload="metadata" />
          <div><span>{formatFrameTime(hoverPreview.frame, props.fps)}</span><strong>Frame {hoverPreview.frame.toLocaleString()}</strong></div>
        </div>
      )}
    </section>
  );
}
