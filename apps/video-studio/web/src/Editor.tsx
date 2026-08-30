import { useEffect, useRef, useState } from "react";
import {
  compileHighlightTimeline,
  defaultRampFrames,
  effectiveHighlightRange,
  formatFrameTime,
  fpsValue,
  highlightContainsSection,
  validateHighlightRange,
  type AudioSettings,
  type Project,
  type RenderJob,
  type SlowSection,
  type SlowSpeed,
} from "@remote-workspace/video-shared";
import { cancelRender, createRender, getProject, patchProject, publishRemoteExport, uploadCrowd, type PublishedRemoteExport } from "./api.js";
import { createSectionId } from "./sectionId.js";
import { Timeline } from "./Timeline.js";
import { apiUrl } from "./urls.js";

interface Props {
  initialProject: Project;
  remoteSessionId?: string;
  onBack: () => void;
  onProjectChange: (project: Project) => void;
}

export function Editor({ initialProject, remoteSessionId, onBack, onProjectChange }: Props) {
  const [project, setProject] = useState(initialProject);
  const [sections, setSections] = useState(initialProject.sections);
  const [audio, setAudio] = useState(initialProject.audio);
  const [highlightRange, setHighlightRange] = useState(() => effectiveHighlightRange(initialProject.source.frameCount, initialProject.highlightRange));
  const [currentFrame, setCurrentFrame] = useState(0);
  const [highlightMarkIn, setHighlightMarkIn] = useState<number>();
  const [highlightMarkOut, setHighlightMarkOut] = useState<number>();
  const [markIn, setMarkIn] = useState<number>();
  const [markOut, setMarkOut] = useState<number>();
  const [playing, setPlaying] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [playbackVolume, setPlaybackVolume] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [job, setJob] = useState<RenderJob>();
  const [publishingExport, setPublishingExport] = useState(false);
  const [publishedExport, setPublishedExport] = useState<PublishedRemoteExport>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const projectRef = useRef(project);
  const savingRef = useRef(false);
  projectRef.current = project;

  const timeline = compileHighlightTimeline(project.source.frameCount, project.source.fps, sections, highlightRange);
  const activeSectionCount = sections.filter((section) => highlightContainsSection(highlightRange, section)).length;
  const previewFresh = project.preview?.revision === project.revision;
  const hasCompleteSlowMarks = markIn !== undefined && markOut !== undefined;
  const hasPartialSlowMarks = (markIn === undefined) !== (markOut === undefined);

  useEffect(() => {
    setProject(initialProject);
    setSections(initialProject.sections);
    setAudio(initialProject.audio);
    setHighlightRange(effectiveHighlightRange(initialProject.source.frameCount, initialProject.highlightRange));
    setHighlightMarkIn(undefined);
    setHighlightMarkOut(undefined);
    setMarkIn(undefined);
    setMarkOut(undefined);
  }, [initialProject]);

  useEffect(() => {
    if (!job) return;
    const events = new EventSource(apiUrl(`/jobs/${job.id}/events`));
    events.onmessage = async (event) => {
      const update = JSON.parse(event.data) as RenderJob;
      setJob(update);
      if (["succeeded", "failed", "cancelled"].includes(update.status)) {
        events.close();
        if (update.status === "succeeded") {
          const refreshed = await getProject(project.id);
          projectRef.current = refreshed;
          setProject(refreshed);
          onProjectChange(refreshed);
          if (update.kind === "export" && remoteSessionId) {
            setPublishingExport(true);
            try {
              setPublishedExport(await publishRemoteExport(remoteSessionId, project.id));
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Could not save the export beside the source video.");
            } finally {
              setPublishingExport(false);
            }
          }
        }
      }
    };
    events.onerror = () => events.close();
    return () => events.close();
  }, [job?.id]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const amount = event.shiftKey ? 10 : 1;
        setCurrentFrame((frame) => Math.max(0, Math.min(project.source.frameCount - 1, frame + (event.key === "ArrowLeft" ? -amount : amount))));
        setPlaying(false);
      } else if (event.key.toLowerCase() === "i") setMarkIn(currentFrame);
      else if (event.key.toLowerCase() === "o") setMarkOut(currentFrame + 1);
      else if (event.key === " ") {
        event.preventDefault();
        videoRef.current?.paused ? void videoRef.current.play() : videoRef.current?.pause();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [currentFrame, project.source.frameCount]);

  useEffect(() => {
    if (!playing && videoRef.current) videoRef.current.currentTime = currentFrame / fpsValue(project.source.fps);
  }, [currentFrame, playing, project.source.fps]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = playbackVolume;
  }, [playbackVolume]);

  function stepFrame(amount: -1 | 1): void {
    videoRef.current?.pause();
    setPlaying(false);
    setCurrentFrame((frame) => Math.max(0, Math.min(project.source.frameCount - 1, frame + amount)));
  }

  async function commit(nextSections = sections, nextAudio = audio, nextHighlight = highlightRange): Promise<boolean> {
    if (savingRef.current) {
      setError("Another edit is still being saved. Try again in a moment.");
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const currentProject = projectRef.current;
      const updated = await patchProject(currentProject.id, {
        expectedRevision: currentProject.revision,
        sections: nextSections,
        audio: nextAudio,
        highlightRange: nextHighlight,
      });
      projectRef.current = updated;
      setProject(updated);
      setSections(updated.sections);
      setAudio(updated.audio);
      setHighlightRange(effectiveHighlightRange(updated.source.frameCount, updated.highlightRange));
      onProjectChange(updated);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save edits.");
      const refreshed = await getProject(projectRef.current.id);
      projectRef.current = refreshed;
      setProject(refreshed);
      setSections(refreshed.sections);
      setAudio(refreshed.audio);
      setHighlightRange(effectiveHighlightRange(refreshed.source.frameCount, refreshed.highlightRange));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function addSection(): Promise<void> {
    const defaultLength = Math.max(2, Math.round(fpsValue(project.source.fps)));
    const defaultStart = Math.min(currentFrame, project.source.frameCount - 2);
    const startFrame = hasCompleteSlowMarks
      ? Math.min(markIn, markOut - 1)
      : defaultStart;
    const endFrameExclusive = hasCompleteSlowMarks
      ? Math.max(markIn + 1, markOut)
      : Math.min(project.source.frameCount, defaultStart + defaultLength);
    if (endFrameExclusive - startFrame < 2) {
      setError("Mark a range containing at least two frames.");
      return;
    }
    if (sections.some((section) => section.startFrame < endFrameExclusive && section.endFrameExclusive > startFrame)) {
      setError("The new range overlaps an existing slow-motion section.");
      return;
    }
    if (startFrame < highlightRange.startFrame || endFrameExclusive > highlightRange.endFrameExclusive) {
      setError("Slow-motion sections must stay inside the active highlight.");
      return;
    }
    const ramp = defaultRampFrames(endFrameExclusive - startFrame, project.source.fps);
    let sectionId: string;
    try {
      sectionId = createSectionId();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the slow-motion section.");
      return;
    }
    const next = [...sections, { id: sectionId, startFrame, endFrameExclusive, speed: 0.5 as const, rampInFrames: ramp, rampOutFrames: ramp }].sort((a, b) => a.startFrame - b.startFrame);
    setSections(next);
    if (await commit(next, audio)) {
      setMarkIn(undefined);
      setMarkOut(undefined);
    }
  }

  function setHighlightFromMarks(): void {
    if (highlightMarkIn === undefined || highlightMarkOut === undefined) {
      setError("Set both In and Out marks before defining the highlight.");
      return;
    }
    const next = { startFrame: Math.min(highlightMarkIn, highlightMarkOut - 1), endFrameExclusive: Math.max(highlightMarkIn + 1, highlightMarkOut) };
    try {
      validateHighlightRange(next, project.source.frameCount, sections);
      setHighlightRange(next);
      setHighlightMarkIn(undefined);
      setHighlightMarkOut(undefined);
      void commit(sections, audio, next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The highlight range is invalid.");
    }
  }

  function updateSection(id: string, patch: Partial<SlowSection>, save = true): void {
    const next = sections.map((section) => section.id === id ? { ...section, ...patch } : section);
    setSections(next);
    if (save) void commit(next, audio);
  }

  async function startRender(kind: "preview" | "export"): Promise<void> {
    try {
      setError(undefined);
      if (kind === "export") setPublishedExport(undefined);
      setJob(await createRender(project.id, kind, project.revision));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start render.");
    }
  }

  return (
    <main className="editor-page">
      <header className="editor-header">
        <button className="icon-button" onClick={onBack} aria-label="Back to projects">←</button>
        <div><span className="eyebrow">Video Studio</span><h1>{project.name}</h1></div>
        <div className="header-meta"><span>{project.source.width}×{project.source.height}</span><span>{(fpsValue(project.source.fps)).toFixed(3)} fps</span><span>{project.source.variableFrameRate ? "VFR normalized" : "CFR"}</span>{saving && <span className="saving">Saving…</span>}</div>
      </header>

      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError(undefined)}>×</button></div>}

      <div className="editor-grid">
        <section className="viewer-panel">
          <div className="viewer">
            <video
              ref={videoRef}
              src={apiUrl(`/projects/${project.id}/media/proxy`)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onTimeUpdate={(event) => playing && setCurrentFrame(Math.min(project.source.frameCount - 1, Math.floor(event.currentTarget.currentTime * fpsValue(project.source.fps))))}
            />
            {!playing && !scrubbing && <img className="exact-frame" src={apiUrl(`/projects/${project.id}/frames/${currentFrame}`)} alt={`Exact source frame ${currentFrame}`} />}
          </div>
          <div className="transport">
            <button className="frame-button" aria-label="Previous frame" title="Previous frame" onClick={() => stepFrame(-1)}><FrameStepIcon direction="previous" /></button>
            <button className="play-button" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause" : "Play"} onClick={() => videoRef.current?.paused ? void videoRef.current.play() : videoRef.current?.pause()}><PlayPauseIcon playing={playing} /></button>
            <button className="frame-button" aria-label="Next frame" title="Next frame" onClick={() => stepFrame(1)}><FrameStepIcon direction="next" /></button>
            <span className="transport-time">{formatFrameTime(currentFrame, project.source.fps)}</span>
            <output className="transport-frame" aria-label={`Current frame ${currentFrame}`}>Frame {currentFrame.toLocaleString()}</output>
            <label className="playback-volume" title="Preview volume">
              <svg aria-hidden="true" viewBox="0 0 24 24"><path className="volume-body" d="M4 9v6h4l5 4V5L8 9H4z" /><path className="volume-waves" d="M16.2 8.2a5.4 5.4 0 0 1 0 7.6m2.4-10a8.8 8.8 0 0 1 0 12.4" /></svg>
              <input aria-label="Preview volume" type="range" min="0" max="1" step="0.05" value={playbackVolume} onChange={(event) => setPlaybackVolume(Number(event.target.value))} />
              <output>{Math.round(playbackVolume * 100)}%</output>
            </label>
          </div>
          <Timeline
            projectId={project.id}
            frameCount={project.source.frameCount}
            fps={project.source.fps}
            currentFrame={currentFrame}
            highlightRange={highlightRange}
            sections={sections}
            waveformUrl={project.waveformFilename ? apiUrl(`/projects/${project.id}/media/waveform`) : undefined}
            disabled={saving}
            onSeek={(frame) => { setPlaying(false); videoRef.current?.pause(); setCurrentFrame(frame); }}
            onScrubChange={setScrubbing}
            onHighlightChange={setHighlightRange}
            onHighlightCommit={(next) => void commit(sections, audio, next)}
            onSectionsChange={setSections}
            onSectionsCommit={(next) => void commit(next, audio)}
          />
          <div className="edit-workflow">
            <section className="workflow-step highlight-step">
              <header><span className="step-number">1</span><div><h2>Choose the highlight</h2><p>Set the part of the source video that will be exported.</p></div></header>
              <div className="workflow-marks">
                <button onClick={() => setHighlightMarkIn(currentFrame)}>Set start</button>
                <output>{highlightMarkIn === undefined ? "Start —" : `Start ${highlightMarkIn.toLocaleString()}`}</output>
                <button onClick={() => setHighlightMarkOut(Math.min(project.source.frameCount, currentFrame + 1))}>Set end</button>
                <output>{highlightMarkOut === undefined ? "End —" : `End ${(highlightMarkOut - 1).toLocaleString()}`}</output>
              </div>
              <div className="workflow-actions">
                <button className="primary-action" onClick={setHighlightFromMarks} disabled={saving || highlightMarkIn === undefined || highlightMarkOut === undefined}>Apply highlight</button>
                <button onClick={() => { const next = { startFrame: 0, endFrameExclusive: project.source.frameCount }; setHighlightRange(next); void commit(sections, audio, next); }} disabled={saving || (highlightRange.startFrame === 0 && highlightRange.endFrameExclusive === project.source.frameCount)}>Use full video</button>
              </div>
              <p className="active-range">Active · Frames {highlightRange.startFrame.toLocaleString()}–{(highlightRange.endFrameExclusive - 1).toLocaleString()}</p>
            </section>
            <section className="workflow-step slow-step">
              <header><span className="step-number">2</span><div><h2>Add slow motion</h2><p>Add one second at the playhead, or set In and Out marks for an exact range.</p></div></header>
              <div className="workflow-marks">
                <button onClick={() => setMarkIn(currentFrame)}>Mark In <kbd>I</kbd></button>
                <output>{markIn === undefined ? "In —" : `In ${markIn.toLocaleString()}`}</output>
                <button onClick={() => setMarkOut(Math.min(project.source.frameCount, currentFrame + 1))}>Mark Out <kbd>O</kbd></button>
                <output>{markOut === undefined ? "Out —" : `Out ${(markOut - 1).toLocaleString()}`}</output>
              </div>
              <div className="workflow-actions"><button className="primary-action" onClick={() => void addSection()} disabled={saving || hasPartialSlowMarks} title={hasPartialSlowMarks ? "Set the other mark to complete the range." : undefined}>{hasCompleteSlowMarks ? "Add marked slow section" : "Add 1-second slow section"}</button></div>
              <p className="active-range">{activeSectionCount} active slow-motion {activeSectionCount === 1 ? "section" : "sections"}</p>
            </section>
          </div>
        </section>

        <aside className="inspector">
          <section className="panel-section">
            <div className="section-heading"><div><span className="eyebrow">Step 2 · Fine tuning</span><h2>Slow sections</h2></div><span>{sections.length}</span></div>
            {sections.length === 0 && <p className="empty-note">Set In and Out marks on the timeline, then add a section.</p>}
            {sections.map((section, index) => {
              const length = section.endFrameExclusive - section.startFrame;
              const active = highlightContainsSection(highlightRange, section);
              return <article className={`section-card${active ? "" : " inactive"}`} key={section.id}>
                <div className="section-card-title"><strong>Section {index + 1}{active ? "" : " · Outside highlight"}</strong><button aria-label={`Delete section ${index + 1}`} onClick={() => { const next = sections.filter((item) => item.id !== section.id); setSections(next); void commit(next, audio); }}>Remove</button></div>
                <label>Speed<select value={section.speed} onChange={(event) => updateSection(section.id, { speed: Number(event.target.value) as SlowSpeed })}><option value="0.5">0.5×</option><option value="0.25">0.25×</option><option value="0.125">0.125×</option></select></label>
                <div className="field-pair"><label>Start frame<input type="number" min="0" max={section.endFrameExclusive - 2} value={section.startFrame} onChange={(event) => updateSection(section.id, { startFrame: Number(event.target.value) }, false)} onBlur={() => void commit(sections, audio)} /></label><label>End frame<input type="number" min={section.startFrame + 2} max={project.source.frameCount} value={section.endFrameExclusive} onChange={(event) => updateSection(section.id, { endFrameExclusive: Number(event.target.value) }, false)} onBlur={() => void commit(sections, audio)} /></label></div>
                <label>Ramp in · {section.rampInFrames}f<input type="range" min="0" max={length - section.rampOutFrames} value={section.rampInFrames} onChange={(event) => updateSection(section.id, { rampInFrames: Number(event.target.value) }, false)} onPointerUp={() => void commit(sections, audio)} /></label>
                <label>Ramp out · {section.rampOutFrames}f<input type="range" min="0" max={length - section.rampInFrames} value={section.rampOutFrames} onChange={(event) => updateSection(section.id, { rampOutFrames: Number(event.target.value) }, false)} onPointerUp={() => void commit(sections, audio)} /></label>
              </article>;
            })}
          </section>

          <section className="panel-section">
            <span className="eyebrow">Sound</span><h2>Stadium mix</h2>
            <label className="check-row"><input type="checkbox" checked={audio.useOriginalAudio} disabled={!project.source.hasAudio} onChange={(event) => { const next = { ...audio, useOriginalAudio: event.target.checked }; setAudio(next); void commit(sections, next); }} /> Use original audio</label>
            <Gain label="Source" value={audio.sourceGainDb} min={-60} max={6} disabled={!project.source.hasAudio || !audio.useOriginalAudio} onChange={(value) => setAudio({ ...audio, sourceGainDb: value })} onCommit={() => void commit(sections, audio)} />
            <Gain label="Crowd" value={audio.crowdGainDb} min={-60} max={0} disabled={audio.crowdMuted} onChange={(value) => setAudio({ ...audio, crowdGainDb: value })} onCommit={() => void commit(sections, audio)} />
            <label className="check-row"><input type="checkbox" checked={audio.crowdMuted} onChange={(event) => { const next = { ...audio, crowdMuted: event.target.checked }; setAudio(next); void commit(sections, next); }} /> Mute crowd</label>
            <label className="file-button">Use custom ambience<input type="file" accept="audio/*" onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; try { const updated = await uploadCrowd(project.id, file); setProject(updated); setAudio(updated.audio); onProjectChange(updated); } catch (cause) { setError(cause instanceof Error ? cause.message : "Upload failed."); } }} /></label>
            <p className="asset-note">{audio.crowdSource === "bundled" ? "Energetic CC0 college football crowd" : "Custom project ambience"}</p>
          </section>

          <section className="panel-section output-panel">
            <span className="eyebrow">Highlight output</span><h2>{timeline.durationSeconds.toFixed(2)} seconds</h2>
            <p>{timeline.outputFrameCount.toLocaleString()} frames at {fpsValue(project.source.fps).toFixed(3)} fps</p>
            <p>Source frames {highlightRange.startFrame.toLocaleString()}–{(highlightRange.endFrameExclusive - 1).toLocaleString()}</p>
            {job && ["queued", "running"].includes(job.status) && <div className="job-progress"><div><span style={{ width: `${Math.round(job.progress * 100)}%` }} /></div><p>{job.kind === "preview" ? "Building preview" : "Rendering final"} · {Math.round(job.progress * 100)}%</p><button onClick={() => void cancelRender(job.id)}>Cancel</button></div>}
            {job?.status === "failed" && <p className="inline-error">{job.error}</p>}
            <div className="render-actions"><button onClick={() => void startRender("preview")} disabled={publishingExport || Boolean(job && ["queued", "running"].includes(job.status))}>Build preview</button><button className="accent-button" onClick={() => void startRender("export")} disabled={publishingExport || Boolean(job && ["queued", "running"].includes(job.status))}>{publishingExport ? "Saving beside source…" : "Export MP4"}</button></div>
            {project.preview && <div className={previewFresh ? "artifact" : "artifact stale"}><span>{previewFresh ? "Preview ready" : "Preview is stale"}</span>{previewFresh && <a href={apiUrl(`/projects/${project.id}/media/preview`)} target="_blank" rel="noreferrer">Open</a>}</div>}
            {project.export && <div className={project.export.revision === project.revision ? "artifact" : "artifact stale"}><span>{publishedExport ? `Saved as ${publishedExport.name}` : publishingExport ? "Copying beside source…" : project.export.revision === project.revision ? "Export ready" : "Older export"}</span>{!remoteSessionId && <a href={apiUrl(`/projects/${project.id}/media/export`)}>Download</a>}</div>}
          </section>
        </aside>
      </div>
    </main>
  );
}

function FrameStepIcon({ direction }: { direction: "previous" | "next" }) {
  const path = direction === "previous"
    ? "M5 4V20M18 4L5 12L18 20"
    : "M19 4V20M6 4L19 12L6 20";
  return <svg className="transport-icon frame-step-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d={path} /></svg>;
}

function PlayPauseIcon({ playing }: { playing: boolean }) {
  return (
    <svg className="transport-icon play-pause-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      {playing
        ? <><rect x="7" y="5" width="3.5" height="14" rx="0.75" /><rect x="13.5" y="5" width="3.5" height="14" rx="0.75" /></>
        : <path d="M7.5 4.5 19.5 12 7.5 19.5Z" />}
    </svg>
  );
}

function Gain({ label, value, min, max, disabled, onChange, onCommit }: { label: string; value: number; min: number; max: number; disabled?: boolean; onChange: (value: number) => void; onCommit: () => void }) {
  return <label className="gain-control"><span>{label}</span><output>{value <= -60 ? "−∞" : `${value} dB`}</output><input type="range" min={min} max={max} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} onPointerUp={onCommit} /></label>;
}
