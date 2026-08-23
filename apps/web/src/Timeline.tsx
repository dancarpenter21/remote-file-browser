import { useEffect, useMemo, useRef, useState } from "react";
import { formatFrameTime, type Rational, type SlowSection } from "@vfx/shared";

interface Props {
  projectId: string;
  frameCount: number;
  fps: Rational;
  currentFrame: number;
  sections: SlowSection[];
  waveformUrl?: string;
  disabled?: boolean;
  onSeek: (frame: number) => void;
  onSectionsChange: (sections: SlowSection[]) => void;
  onSectionsCommit: (sections: SlowSection[]) => void;
}

type Drag = { sectionId: string; edge: "start" | "end" | "rampIn" | "rampOut" };

export function Timeline(props: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<Drag>();
  const ordered = useMemo(() => [...props.sections].sort((a, b) => a.startFrame - b.startFrame), [props.sections]);

  function eventFrame(clientX: number): number {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return Math.max(0, Math.min(props.frameCount - 1, Math.round(((clientX - rect.left) / rect.width) * props.frameCount)));
  }

  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => {
      const frame = eventFrame(event.clientX);
      const next = ordered.map((section) => {
        if (section.id !== drag.sectionId) return section;
        const previous = ordered[ordered.indexOf(section) - 1];
        const following = ordered[ordered.indexOf(section) + 1];
        if (drag.edge === "start") {
          const startFrame = Math.max(previous?.endFrameExclusive ?? 0, Math.min(frame, section.endFrameExclusive - 2));
          const length = section.endFrameExclusive - startFrame;
          return { ...section, startFrame, rampInFrames: Math.min(section.rampInFrames, length - section.rampOutFrames) };
        }
        if (drag.edge === "end") {
          const endFrameExclusive = Math.min(following?.startFrame ?? props.frameCount, Math.max(frame + 1, section.startFrame + 2));
          const length = endFrameExclusive - section.startFrame;
          return { ...section, endFrameExclusive, rampOutFrames: Math.min(section.rampOutFrames, length - section.rampInFrames) };
        }
        const length = section.endFrameExclusive - section.startFrame;
        if (drag.edge === "rampIn") {
          const rampInFrames = Math.max(0, Math.min(frame - section.startFrame, length - section.rampOutFrames));
          return { ...section, rampInFrames };
        }
        const rampOutFrames = Math.max(0, Math.min(section.endFrameExclusive - frame, length - section.rampInFrames));
        return { ...section, rampOutFrames };
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

  return (
    <section className="timeline-shell" aria-label="Source timeline">
      <div className="timeline-toolbar">
        <span>{formatFrameTime(props.currentFrame, props.fps)}</span>
        <span className="frame-label">Frame {props.currentFrame.toLocaleString()} / {(props.frameCount - 1).toLocaleString()}</span>
        <label>Zoom <input aria-label="Timeline zoom" type="range" min="1" max="12" step="1" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
      </div>
      <div className="timeline-scroll">
        <div
          ref={trackRef}
          className="timeline-track"
          style={{ width: `${zoom * 100}%`, backgroundImage: props.waveformUrl ? `linear-gradient(90deg, rgba(13,16,22,.3), rgba(13,16,22,.3)), url(${props.waveformUrl})` : undefined }}
          onPointerDown={(event) => {
            if (!props.disabled && event.target === event.currentTarget) props.onSeek(eventFrame(event.clientX));
          }}
        >
          {ordered.map((section, index) => {
            const left = section.startFrame / props.frameCount * 100;
            const width = (section.endFrameExclusive - section.startFrame) / props.frameCount * 100;
            const rampIn = section.rampInFrames / (section.endFrameExclusive - section.startFrame) * 100;
            const rampOut = section.rampOutFrames / (section.endFrameExclusive - section.startFrame) * 100;
            return (
              <div className={`timeline-section speed-${String(section.speed).replace(".", "-")}`} key={section.id} style={{ left: `${left}%`, width: `${width}%` }}>
                <span className="section-caption">{index + 1} · {section.speed}×</span>
                <button className="edge-handle start" aria-label={`Move start of section ${index + 1}`} onPointerDown={(event) => { event.stopPropagation(); setDrag({ sectionId: section.id, edge: "start" }); }} />
                <button className="ramp-handle in" aria-label={`Adjust ramp in for section ${index + 1}`} style={{ left: `${rampIn}%` }} onPointerDown={(event) => { event.stopPropagation(); setDrag({ sectionId: section.id, edge: "rampIn" }); }} />
                <button className="ramp-handle out" aria-label={`Adjust ramp out for section ${index + 1}`} style={{ right: `${rampOut}%` }} onPointerDown={(event) => { event.stopPropagation(); setDrag({ sectionId: section.id, edge: "rampOut" }); }} />
                <button className="edge-handle end" aria-label={`Move end of section ${index + 1}`} onPointerDown={(event) => { event.stopPropagation(); setDrag({ sectionId: section.id, edge: "end" }); }} />
              </div>
            );
          })}
          <div className="playhead" style={{ left: `${props.currentFrame / Math.max(1, props.frameCount - 1) * 100}%` }} />
        </div>
      </div>
    </section>
  );
}
