import { useEffect, useRef, useState } from "react";
import {
  compileHighlightTimeline,
  crowdGainAtFrame,
  addCrowdAccent,
  crowdAccentPresets,
  defaultRampFrames,
  defaultOutputFilename,
  outputFilenameSchema,
  effectiveHighlightRange,
  formatFrameTime,
  fpsValue,
  highlightContainsSection,
  type AudioSettings,
  type CrowdGainPoint,
  type Project,
  type RenderJob,
  type SlowSection,
} from "@remote-workspace/video-shared";
import { ApiError, cancelRender, createRender, getProject, patchProject, publishRemoteExport, uploadCrowd, type PublishedRemoteExport } from "./api.js";
import { createSectionId } from "./sectionId.js";
import { parseFrame, validateHighlightDraft } from "./highlightControls.js";
import { Timeline } from "./Timeline.js";
import { parseSpeedDraft } from "./speedControls.js";
import { reconnectSource } from "./reconnectSource.js";
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
  const [selectedSectionId, setSelectedSectionId] = useState<string>();
  const [inspectorTab, setInspectorTab] = useState<"section" | "audio" | "export">("section");
  const [speedDrafts, setSpeedDrafts] = useState<Record<string, string>>({});
  const [audio, setAudio] = useState(initialProject.audio);
  const [highlightRange, setHighlightRange] = useState(() => effectiveHighlightRange(initialProject.source.frameCount, initialProject.highlightRange));
  const [currentFrame, setCurrentFrame] = useState(0);
  const [highlightStart, setHighlightStart] = useState(() => String(highlightRange.startFrame));
  const [highlightLast, setHighlightLast] = useState(() => String(highlightRange.endFrameExclusive - 1));
  const [markIn, setMarkIn] = useState<number>();
  const [markOut, setMarkOut] = useState<number>();
  const [playing, setPlaying] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [playbackVolume, setPlaybackVolume] = useState(1);
  const [fitVideo, setFitVideo] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [job, setJob] = useState<RenderJob>();
  const [publishingExport, setPublishingExport] = useState(false);
  const [connectedSessionId, setConnectedSessionId] = useState(remoteSessionId);
  const [exportSaveError, setExportSaveError] = useState<string>();
  const [publishedExport, setPublishedExport] = useState<PublishedRemoteExport>();
  const [outputName, setOutputName] = useState(() => defaultOutputFilename(initialProject.name));
  const exportNameRef = useRef(outputName);
  const [saveBesideSource, setSaveBesideSource] = useState(Boolean(initialProject.integration));
  const saveAfterExportRef = useRef(saveBesideSource);
  const videoRef = useRef<HTMLVideoElement>(null);
  const crowdRef = useRef<HTMLAudioElement>(null);
  const [accentPeakDb, setAccentPeakDb] = useState(-3);
  const projectRef = useRef(project);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const saveSequenceRef = useRef(0);
  const pendingSavesRef = useRef(0);
  projectRef.current = project;

  const timeline = compileHighlightTimeline(project.source.frameCount, project.source.fps, sections, highlightRange);
  const activeSectionCount = sections.filter((section) => highlightContainsSection(highlightRange, section)).length;
  const invalidSpeedDraft = sections.some((section) => speedDrafts[section.id] !== undefined && parseSpeedDraft(speedDrafts[section.id]!) === undefined);
  const selectedSection = sections.find((section) => section.id === selectedSectionId);
  const parsedOutputName = outputFilenameSchema.safeParse(outputName);
  const outputNameError = parsedOutputName.success ? undefined : parsedOutputName.error.issues[0]?.message;
  const previewFresh = project.preview?.revision === project.revision;
  const hasCompleteSlowMarks = markIn !== undefined && markOut !== undefined;
  const hasPartialSlowMarks = (markIn === undefined) !== (markOut === undefined);

  useEffect(() => {
    setOutputName(defaultOutputFilename(initialProject.name));
    setSaveBesideSource(Boolean(initialProject.integration));
    setPublishedExport(undefined);
    setSelectedSectionId(undefined);
    setInspectorTab("section");
    setSpeedDrafts({});
    setProject(initialProject);
    setSections(initialProject.sections);
    setAudio(initialProject.audio);
    setHighlightRange(effectiveHighlightRange(initialProject.source.frameCount, initialProject.highlightRange));
    const range = effectiveHighlightRange(initialProject.source.frameCount, initialProject.highlightRange);
    setHighlightStart(String(range.startFrame));
    setHighlightLast(String(range.endFrameExclusive - 1));
    setMarkIn(undefined);
    setMarkOut(undefined);
    setFitVideo(true);
  }, [initialProject.id]);

  useEffect(() => {
    setConnectedSessionId(remoteSessionId);
    setExportSaveError(undefined);
  }, [remoteSessionId, initialProject.id]);

  // Only persisted boundary changes replace drafts; unrelated audio/section saves preserve them.
  useEffect(() => {
    const range = effectiveHighlightRange(project.source.frameCount, project.highlightRange);
    setHighlightStart(String(range.startFrame));
    setHighlightLast(String(range.endFrameExclusive - 1));
  }, [project.id, project.highlightRange?.startFrame, project.highlightRange?.endFrameExclusive, project.source.frameCount]);

  const highlightDraft = validateHighlightDraft(highlightStart, highlightLast, project.source.frameCount, sections);
  const draftStartFrame = parseFrame(highlightStart, project.source.frameCount);
  const draftLastFrame = parseFrame(highlightLast, project.source.frameCount);
  const highlightUnchanged = highlightDraft.range?.startFrame === highlightRange.startFrame && highlightDraft.range?.endFrameExclusive === highlightRange.endFrameExclusive;

  function seekFrame(frame: number): void {
    videoRef.current?.pause();
    crowdRef.current?.pause();
    setPlaying(false);
    setCurrentFrame(frame);
  }

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
          if (update.kind === "export" && saveAfterExportRef.current) {
            await saveExportBesideSource(exportNameRef.current);
          }
        }
      }
    };
    events.onerror = () => events.close();
    return () => events.close();
  }, [job?.id]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && (event.target.closest("input, select, textarea, button") || event.target.isContentEditable)) return;
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
    const video = videoRef.current;
    const crowd = crowdRef.current;
    const sourceScale = audio.useOriginalAudio ? Math.min(1, 10 ** (audio.sourceGainDb / 20)) : 0;
    if (video) video.volume = playbackVolume * sourceScale;
    if (crowd) {
      const gainDb = crowdGainAtFrame(audio.crowdGainPoints, audio.crowdGainDb, currentFrame);
      crowd.volume = audio.crowdMuted ? 0 : Math.min(1, playbackVolume * 10 ** (gainDb / 20));
    }
  }, [audio, currentFrame, playbackVolume]);

  useEffect(() => {
    if (!playing) return;
    let request: number;
    const tick = () => {
      const video = videoRef.current;
      if (video) setCurrentFrame(Math.min(project.source.frameCount - 1, Math.floor(video.currentTime * fpsValue(project.source.fps))));
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [playing, project.source.frameCount, project.source.fps]);

  function stepFrame(amount: -1 | 1): void {
    videoRef.current?.pause();
    setPlaying(false);
    setCurrentFrame((frame) => Math.max(0, Math.min(project.source.frameCount - 1, frame + amount)));
  }

  async function commit(nextSections = sections, nextAudio = audio, nextHighlight = highlightRange): Promise<boolean> {
    const sequence = ++saveSequenceRef.current;
    pendingSavesRef.current += 1;
    setSaving(true);
    setError(undefined);
    let succeeded = false;
    let savingHighlight = false;
    const operation = saveChainRef.current.then(async () => {
      const currentProject = projectRef.current;
      const persisted = effectiveHighlightRange(currentProject.source.frameCount, currentProject.highlightRange);
      savingHighlight = persisted.startFrame !== nextHighlight.startFrame || persisted.endFrameExclusive !== nextHighlight.endFrameExclusive;
      const updated = await patchProject(currentProject.id, {
        expectedRevision: currentProject.revision,
        sections: nextSections,
        audio: nextAudio,
        highlightRange: nextHighlight,
      });
      projectRef.current = updated;
      if (sequence === saveSequenceRef.current) {
        setProject(updated);
        setSections(updated.sections);
        setAudio(updated.audio);
        setHighlightRange(effectiveHighlightRange(updated.source.frameCount, updated.highlightRange));
        onProjectChange(updated);
      }
      succeeded = true;
    }).catch(async (cause) => {
      setError(cause instanceof Error ? cause.message : "Could not save edits.");
      const refreshed = await getProject(projectRef.current.id);
      projectRef.current = refreshed;
      if (sequence === saveSequenceRef.current) {
        setProject(refreshed);
        setSections(refreshed.sections);
        setAudio(refreshed.audio);
        const range = effectiveHighlightRange(refreshed.source.frameCount, refreshed.highlightRange);
        setHighlightRange(range);
        if (savingHighlight) {
          setHighlightStart(String(range.startFrame));
          setHighlightLast(String(range.endFrameExclusive - 1));
        }
      }
    }).finally(() => {
      pendingSavesRef.current -= 1;
      if (pendingSavesRef.current === 0) setSaving(false);
    });
    saveChainRef.current = operation.then(() => undefined);
    await operation;
    return succeeded;
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
    selectSection(sectionId);
    if (await commit(next, audio)) {
      setMarkIn(undefined);
      setMarkOut(undefined);
    }
  }

  function applyHighlight(): void {
    if (!highlightDraft.range || saving || highlightUnchanged) return;
    setHighlightRange(highlightDraft.range);
    void commit(sections, audio, highlightDraft.range);
  }

  function updateSection(id: string, patch: Partial<SlowSection>, save = true): void {
    const next = sections.map((section) => section.id === id ? { ...section, ...patch } : section);
    setSections(next);
    if (save) void commit(next, audio);
  }

  function selectSection(id: string): void {
    if (id !== selectedSectionId && selectedSection) applySpeedDraft(selectedSection);
    setSelectedSectionId(id || undefined);
    setInspectorTab("section");
  }

  function clearSpeedDraft(id: string): void {
    setSpeedDrafts((drafts) => {
      const next = { ...drafts };
      delete next[id];
      return next;
    });
  }

  function applySpeedDraft(section: SlowSection): void {
    const draft = speedDrafts[section.id];
    if (draft === undefined) return;
    const speed = parseSpeedDraft(draft);
    if (speed === undefined) return;
    clearSpeedDraft(section.id);
    if (speed !== section.speed) updateSection(section.id, { speed });
  }

  async function saveExportBesideSource(name = outputName): Promise<void> {
    const parsed = outputFilenameSchema.safeParse(name);
    if (!parsed.success || publishingExport) return;
    setExportSaveError(undefined);
    setPublishedExport(undefined);
    setPublishingExport(true);
    try {
      let sessionId = connectedSessionId;
      if (!sessionId) {
        sessionId = await reconnectSource(projectRef.current);
        setConnectedSessionId(sessionId);
      }
      let result: PublishedRemoteExport;
      try {
        result = await publishRemoteExport(sessionId, project.id, parsed.data);
      } catch (cause) {
        if (!(cause instanceof ApiError) || ![401, 410].includes(cause.status)) throw cause;
        sessionId = await reconnectSource(projectRef.current);
        setConnectedSessionId(sessionId);
        result = await publishRemoteExport(sessionId, project.id, parsed.data);
      }
      setPublishedExport(result);
    } catch (cause) {
      setExportSaveError(`${cause instanceof Error ? cause.message : "Could not save beside the source."} Saving beside the source was not confirmed. Your rendered export is still available to download; retry saving without rendering again.`);
    } finally {
      setPublishingExport(false);
    }
  }

  async function startRender(kind: "preview" | "export"): Promise<void> {
    if (invalidSpeedDraft || (kind === "export" && !parsedOutputName.success)) return;
    if (kind === "export" && parsedOutputName.success) {
      exportNameRef.current = parsedOutputName.data;
      saveAfterExportRef.current = saveBesideSource;
    }
    try {
      setError(undefined);
      await saveChainRef.current;
      if (kind === "export") setPublishedExport(undefined);
      setJob(await createRender(projectRef.current.id, kind, projectRef.current.revision));
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
        <section className="viewer-panel" aria-label="Source viewer">
          <div className="viewer-heading"><span>Source playback</span><span>Use a draft preview to review timing</span></div>
          <div className="viewer">
            <video
              className={fitVideo ? undefined : "actual-size"}
              ref={videoRef}
              src={apiUrl(`/projects/${project.id}/media/proxy`)}
              onPlay={() => {
                setPlaying(true);
                const crowd = crowdRef.current;
                if (crowd) {
                  if (Number.isFinite(crowd.duration) && crowd.duration > 0) crowd.currentTime = videoRef.current!.currentTime % crowd.duration;
                  void crowd.play().catch(() => undefined);
                }
              }}
              onPause={() => { setPlaying(false); crowdRef.current?.pause(); }}
              onTimeUpdate={(event) => playing && setCurrentFrame(Math.min(project.source.frameCount - 1, Math.floor(event.currentTarget.currentTime * fpsValue(project.source.fps))))}
            />
            <audio ref={crowdRef} src={apiUrl(`/projects/${project.id}/media/crowd`)} loop preload="auto" aria-hidden="true" />
            {!playing && !scrubbing && <img className={`exact-frame${fitVideo ? '' : ' actual-size'}`} src={apiUrl(`/projects/${project.id}/frames/${currentFrame}`)} alt={`Exact source frame ${currentFrame}`} />}
          </div>
          <div className="transport">
            <button className="frame-button" aria-label="Previous frame" title="Previous frame" onClick={() => stepFrame(-1)}><FrameStepIcon direction="previous" /></button>
            <button className="play-button" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause" : "Play"} onClick={() => videoRef.current?.paused ? void videoRef.current.play() : videoRef.current?.pause()}><PlayPauseIcon playing={playing} /></button>
            <button className="frame-button" aria-label="Next frame" title="Next frame" onClick={() => stepFrame(1)}><FrameStepIcon direction="next" /></button>
            <span className="transport-time">{formatFrameTime(currentFrame, project.source.fps)}</span>
            <output className="transport-frame" aria-label={`Current frame ${currentFrame}`}>Frame {currentFrame.toLocaleString()}</output>
            <button className="video-size-toggle" aria-pressed={!fitVideo} title={fitVideo ? "Show at actual pixel size when it fits" : "Fit video to the viewer"} onClick={() => setFitVideo(value => !value)}>{fitVideo ? "1:1" : "Fit"}</button>
            <label className="playback-volume" title="Preview volume">
              <svg aria-hidden="true" viewBox="0 0 24 24"><path className="volume-body" d="M4 9v6h4l5 4V5L8 9H4z" /><path className="volume-waves" d="M16.2 8.2a5.4 5.4 0 0 1 0 7.6m2.4-10a8.8 8.8 0 0 1 0 12.4" /></svg>
              <input aria-label="Preview volume" type="range" min="0" max="1" step="0.05" value={playbackVolume} onChange={(event) => setPlaybackVolume(Number(event.target.value))} />
              <output>{Math.round(playbackVolume * 100)}%</output>
            </label>
          </div>
        </section>

        <aside className="inspector" aria-label="Editing settings">
          <div className="inspector-tabs" role="tablist" aria-label="Editing settings" onKeyDown={(event) => {
            const tabs = ["section", "audio", "export"] as const;
            const index = tabs.indexOf(inspectorTab);
            const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : undefined;
            if (next === undefined) return;
            event.preventDefault();
            setInspectorTab(tabs[next]!);
            document.getElementById(`inspector-tab-${tabs[next]}`)?.focus();
          }}>
            {(["section", "audio", "export"] as const).map((tab) => <button key={tab} id={`inspector-tab-${tab}`} role="tab" aria-selected={inspectorTab === tab} aria-controls={`inspector-panel-${tab}`} tabIndex={inspectorTab === tab ? 0 : -1} onClick={() => setInspectorTab(tab)}>{tab === "section" ? "Section" : tab === "audio" ? "Audio" : "Export"}{tab === "section" && invalidSpeedDraft ? " · !" : ""}</button>)}
          </div>
          <section className="panel-section" role="tabpanel" id="inspector-panel-section" aria-labelledby="inspector-tab-section" hidden={inspectorTab !== "section"}>
            <div className="section-heading"><div><span className="eyebrow">Fine tuning</span><h2>Slow sections</h2></div><span>{sections.length}</span></div>
            {sections.length === 0 && <p className="empty-note">Set In and Out marks on the timeline, then add a section.</p>}
            <label className="section-selector">Selected section<select aria-label="Selected section" value={selectedSection?.id ?? ""} onChange={(event) => selectSection(event.target.value)}><option value="">Choose a section</option>{sections.map((section, index) => <option key={section.id} value={section.id}>Section {index + 1} · {section.speed}×{speedDrafts[section.id] !== undefined && parseSpeedDraft(speedDrafts[section.id]!) === undefined ? " · Invalid speed" : ""}</option>)}</select></label>
            {sections.length > 0 && !selectedSection && <p className="empty-note">Select a section on the timeline to adjust speed, boundaries, and ramps.</p>}
            {sections.filter((section) => section.id === selectedSectionId).map((section) => {
              const index = sections.findIndex((item) => item.id === section.id);
              const length = section.endFrameExclusive - section.startFrame;
              const active = highlightContainsSection(highlightRange, section);
              return <article className={`section-card${active ? "" : " inactive"}`} key={section.id}>
                <div className="section-card-title"><strong>Section {index + 1}{active ? "" : " · Outside highlight"}</strong><button aria-label={`Delete section ${index + 1}`} onClick={() => { const next = sections.filter((item) => item.id !== section.id); setSections(next); setSelectedSectionId(undefined); clearSpeedDraft(section.id); void commit(next, audio); }}>Remove</button></div>
                <label>Playback speed (×)<input type="number" inputMode="decimal" min="0.01" max="1" step="any" value={speedDrafts[section.id] ?? String(section.speed)} aria-invalid={speedDrafts[section.id] !== undefined && parseSpeedDraft(speedDrafts[section.id]!) === undefined} aria-describedby={speedDrafts[section.id] !== undefined && parseSpeedDraft(speedDrafts[section.id]!) === undefined ? "speed-help speed-error" : "speed-help"} onChange={(event) => setSpeedDrafts((drafts) => ({ ...drafts, [section.id]: event.target.value }))} onBlur={() => applySpeedDraft(section)} onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                  if (event.key === "Escape") { event.preventDefault(); clearSpeedDraft(section.id); }
                }} /></label>
                <p id="speed-help" className="control-help">0.01–1× · 0.3 means 30% speed. Enter or leave the field to save; Escape resets.</p>
                {speedDrafts[section.id] !== undefined && parseSpeedDraft(speedDrafts[section.id]!) === undefined && <p id="speed-error" className="inline-error" role="alert">Enter a speed from 0.01 to 1.</p>}
                <div className="field-pair"><label>Start frame<input type="number" min="0" max={section.endFrameExclusive - 2} value={section.startFrame} onChange={(event) => updateSection(section.id, { startFrame: Number(event.target.value) }, false)} onBlur={() => void commit(sections, audio)} /></label><label>End frame<input type="number" min={section.startFrame + 2} max={project.source.frameCount} value={section.endFrameExclusive} onChange={(event) => updateSection(section.id, { endFrameExclusive: Number(event.target.value) }, false)} onBlur={() => void commit(sections, audio)} /></label></div>
                <label>Ramp in · {section.rampInFrames}f<input type="range" min="0" max={length - section.rampOutFrames} value={section.rampInFrames} onChange={(event) => updateSection(section.id, { rampInFrames: Number(event.target.value) }, false)} onPointerUp={() => void commit(sections, audio)} /></label>
                <label>Ramp out · {section.rampOutFrames}f<input type="range" min="0" max={length - section.rampInFrames} value={section.rampOutFrames} onChange={(event) => updateSection(section.id, { rampOutFrames: Number(event.target.value) }, false)} onPointerUp={() => void commit(sections, audio)} /></label>
              </article>;
            })}
          </section>

          <section className="panel-section" role="tabpanel" id="inspector-panel-audio" aria-labelledby="inspector-tab-audio" hidden={inspectorTab !== "audio"}>
            <span className="eyebrow">Sound</span><h2>Stadium mix</h2>
            <label className="check-row"><input type="checkbox" checked={audio.useOriginalAudio} disabled={!project.source.hasAudio} onChange={(event) => { const next = { ...audio, useOriginalAudio: event.target.checked }; setAudio(next); void commit(sections, next); }} /> Use original audio</label>
            <Gain label="Source" value={audio.sourceGainDb} min={-60} max={6} disabled={!project.source.hasAudio || !audio.useOriginalAudio} onChange={(value) => setAudio({ ...audio, sourceGainDb: value })} onCommit={() => void commit(sections, audio)} />
            <Gain label={audio.crowdGainPoints.length > 0 ? "Crowd · automated" : "Crowd"} value={audio.crowdGainDb} min={-60} max={0} disabled={audio.crowdMuted || audio.crowdGainPoints.length > 0} onChange={(value) => setAudio({ ...audio, crowdGainDb: value })} onCommit={() => void commit(sections, audio)} />
            <div className="crowd-accents">
              <h3>Crowd accents at playhead</h3>
              <p className="automation-note">One-frame attack, then a quick release to the existing level. Replaces volume points inside the accent.</p>
              <label>Accent peak · {accentPeakDb} dB<input aria-label="Crowd accent peak" type="range" min="-60" max="0" value={accentPeakDb} onChange={event => setAccentPeakDb(Number(event.target.value))} /></label>
              <div className="crowd-accent-buttons">{(Object.keys(crowdAccentPresets) as Array<keyof typeof crowdAccentPresets>).map(preset => <button key={preset} disabled={saving || audio.crowdMuted} onClick={() => {
                const points = addCrowdAccent(audio.crowdGainPoints, audio.crowdGainDb, currentFrame, project.source.frameCount, project.source.fps, preset, accentPeakDb, createSectionId);
                const next = { ...audio, crowdGainPoints: points };
                setAudio(next); void commit(sections, next);
              }}>{crowdAccentPresets[preset].label}</button>)}</div>
              <p className="asset-note">Shapes the loaded crowd audio. Upload a recording with shouts or shrieks for those sounds. Drag the timeline points to adjust timing and volume.</p>
            </div>
            <p className="automation-note">Crowd envelope · {audio.crowdGainPoints.length} {audio.crowdGainPoints.length === 1 ? "point" : "points"}{audio.crowdGainPoints.length > 0 ? " · remove all points to restore the flat level" : ""}</p>
            {audio.crowdGainPoints.map((point, index) => <CrowdPointEditor key={point.id} point={point} index={index} frameCount={project.source.frameCount} disabled={saving} onChange={(patch) => {
              const points = audio.crowdGainPoints.map((item) => item.id === point.id ? { ...item, ...patch } : item).sort((a, b) => a.frame - b.frame);
              setAudio({ ...audio, crowdGainPoints: points });
            }} onCommit={() => void commit(sections, audio)} onRemove={() => {
              const next = { ...audio, crowdGainPoints: audio.crowdGainPoints.filter((item) => item.id !== point.id) };
              setAudio(next);
              void commit(sections, next);
            }} />)}
            <label className="check-row"><input type="checkbox" checked={audio.crowdMuted} onChange={(event) => { const next = { ...audio, crowdMuted: event.target.checked }; setAudio(next); void commit(sections, next); }} /> Mute crowd</label>
            <label className="file-button">Use custom ambience<input type="file" accept="audio/*" onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; try { await saveChainRef.current; const updated = await uploadCrowd(projectRef.current.id, file); projectRef.current = updated; setProject(updated); setAudio(updated.audio); crowdRef.current?.load(); onProjectChange(updated); } catch (cause) { setError(cause instanceof Error ? cause.message : "Upload failed."); } }} /></label>
            <p className="asset-note">{audio.crowdSource === "bundled" ? "Neutral CC0 arena crowd wash" : "Custom project ambience"}</p>
          </section>

          <section className="panel-section output-panel" role="tabpanel" id="inspector-panel-export" aria-labelledby="inspector-tab-export" hidden={inspectorTab !== "export"}>
            <span className="eyebrow">Highlight output</span><h2>{timeline.durationSeconds.toFixed(2)} seconds</h2>
            <label className="output-filename">Output filename<input type="text" value={outputName} spellCheck={false} aria-invalid={Boolean(outputNameError)} aria-describedby={outputNameError ? "output-filename-help output-filename-error" : "output-filename-help"} disabled={publishingExport || Boolean(job && ["queued", "running"].includes(job.status))} onChange={(event) => setOutputName(event.target.value)} /></label>
            <p id="output-filename-help">{project.integration ? "Saves beside the source. Existing files are kept; a number is added if the name is taken." : "Choose the filename for your MP4 download."}</p>
            {outputNameError && <p id="output-filename-error" className="inline-error" role="alert">{outputNameError}</p>}
            {project.integration && <>
              <label className="check-row"><input type="checkbox" checked={saveBesideSource} disabled={publishingExport || Boolean(job && ["queued", "running"].includes(job.status))} onChange={(event) => setSaveBesideSource(event.target.checked)} /> Save beside source after export</label>
              {!connectedSessionId && !project.integration.sourceId && <p className="control-help">To reconnect the source, open the original video from Files → Edit in Video Studio. Your existing export will be kept.</p>}
            </>}
            <p>Draft preview · repeated frames</p><p>Final export · motion interpolation</p>
            {invalidSpeedDraft && <p className="inline-error" role="alert">Fix the invalid speed in Section settings before rendering.</p>}
            <p>{timeline.outputFrameCount.toLocaleString()} frames at {fpsValue(project.source.fps).toFixed(3)} fps</p>
            <p>Source frames {highlightRange.startFrame.toLocaleString()}–{(highlightRange.endFrameExclusive - 1).toLocaleString()}</p>
            {job && ["queued", "running"].includes(job.status) && <div className="job-progress"><div><span style={{ width: `${Math.round(job.progress * 100)}%` }} /></div><p>{job.kind === "preview" ? "Building preview" : "Rendering final"} · {Math.round(job.progress * 100)}%</p><button onClick={() => void cancelRender(job.id)}>Cancel</button></div>}
            {job?.status === "failed" && <p className="inline-error">{job.error}</p>}
            <div className="render-actions"><button onClick={() => void startRender("preview")} disabled={invalidSpeedDraft || publishingExport || Boolean(job && ["queued", "running"].includes(job.status))}>Build preview</button><button className="accent-button" onClick={() => void startRender("export")} disabled={Boolean(outputNameError) || invalidSpeedDraft || publishingExport || Boolean(job && ["queued", "running"].includes(job.status))}>{publishingExport ? "Saving beside source…" : "Export MP4"}</button></div>
            {project.preview && <div className={previewFresh ? "artifact" : "artifact stale"}><span>{previewFresh ? "Preview ready" : "Preview is stale"}</span>{previewFresh && <a href={apiUrl(`/projects/${project.id}/media/preview`)} target="_blank" rel="noreferrer">Open</a>}</div>}
            {project.export && <div className={project.export.revision === project.revision ? "artifact" : "artifact stale"}><span>{publishedExport ? `Saved as ${publishedExport.name}` : publishingExport ? "Copying beside source…" : project.export.revision === project.revision ? "Export ready" : "Older export"}</span><a aria-disabled={Boolean(outputNameError)} href={parsedOutputName.success ? `${apiUrl(`/projects/${project.id}/media/export`)}?name=${encodeURIComponent(parsedOutputName.data)}` : undefined}>Download</a></div>}
            {exportSaveError && <p className="inline-error" role="alert">{exportSaveError}</p>}
            {publishedExport && <p className="save-location" role="status">Saved beside source: {publishedExport.path ?? publishedExport.name}</p>}
            {project.export && project.integration && <button className="save-source-button" disabled={Boolean(outputNameError) || publishingExport || Boolean(job && ["queued", "running"].includes(job.status))} onClick={() => void saveExportBesideSource()}>{publishingExport ? "Saving beside source…" : "Save beside source"}</button>}
          </section>
        </aside>
        <section className="timeline-panel" aria-label="Timeline editing">
          <Timeline
            key={project.id}
            projectId={project.id}
            frameCount={project.source.frameCount}
            fps={project.source.fps}
            currentFrame={currentFrame}
            highlightRange={highlightRange}
            draftStartFrame={draftStartFrame}
            draftLastFrame={draftLastFrame}
            sections={sections}
            selectedSectionId={selectedSectionId}
            onSelectSection={selectSection}
            crowdGainPoints={audio.crowdGainPoints}
            crowdGainDb={audio.crowdGainDb}
            waveformUrl={project.waveformFilename ? apiUrl(`/projects/${project.id}/media/waveform`) : undefined}
            disabled={saving}
            onSeek={seekFrame}
            onScrubChange={setScrubbing}
            onHighlightChange={setHighlightRange}
            onHighlightCommit={(next) => {
              setHighlightStart(String(next.startFrame));
              setHighlightLast(String(next.endFrameExclusive - 1));
              void commit(sections, audio, next);
            }}
            onSectionsChange={setSections}
            onSectionsCommit={(next) => void commit(next, audio)}
            onCrowdGainPointsChange={(points) => setAudio({ ...audio, crowdGainPoints: points })}
            onCrowdGainPointsCommit={(points) => { const next = { ...audio, crowdGainPoints: points }; setAudio(next); void commit(sections, next); }}
            onAddCrowdGainPoint={(frame, gainDb) => {
              if (audio.crowdGainPoints.some((point) => point.frame === frame)) return;
              const next = { ...audio, crowdGainPoints: [...audio.crowdGainPoints, { id: createSectionId(), frame, gainDb: gainDb ?? crowdGainAtFrame(audio.crowdGainPoints, audio.crowdGainDb, frame) }].sort((a, b) => a.frame - b.frame) };
              setAudio(next);
              void commit(sections, next);
            }}
          />
          <div className="timeline-heading"><div><span className="eyebrow">Timeline</span><h2>Shape your highlight</h2></div><output aria-label="Estimated output duration">Estimated output · {timeline.durationSeconds.toFixed(2)} s</output></div>
          <div className="edit-workflow">
            <section className="workflow-step highlight-step">
              <header><span className="step-number">1</span><div><h2>Choose the highlight</h2><p>Set the part of the source video that will be exported.</p></div></header>
              <div className="highlight-fields">
                <HighlightBoundary label="Start frame" value={highlightStart} frameCount={project.source.frameCount} disabled={saving} invalid={Boolean(highlightDraft.error)} onChange={setHighlightStart} onSeek={seekFrame} onApply={applyHighlight} onSet={() => setHighlightStart(String(currentFrame))} />
                <HighlightBoundary label="Last frame" value={highlightLast} frameCount={project.source.frameCount} disabled={saving} invalid={Boolean(highlightDraft.error)} onChange={setHighlightLast} onSeek={seekFrame} onApply={applyHighlight} onSet={() => setHighlightLast(String(currentFrame))} />
              </div>
              <p className="active-range">Last frame is included. Frames start at 0. Type a frame or use ←/→ (Shift: 10 frames); Enter applies both fields.</p>
              {highlightDraft.error && <p id="highlight-draft-error" className="inline-error" role="alert">{highlightDraft.error}</p>}
              <div className="workflow-actions">
                <button className="primary-action" onClick={applyHighlight} disabled={saving || !highlightDraft.range || highlightUnchanged}>Apply highlight</button>
                <button onClick={() => { const next = { startFrame: 0, endFrameExclusive: project.source.frameCount }; setHighlightStart("0"); setHighlightLast(String(project.source.frameCount - 1)); setHighlightRange(next); void commit(sections, audio, next); }} disabled={saving || (highlightUnchanged && highlightRange.startFrame === 0 && highlightRange.endFrameExclusive === project.source.frameCount)}>Use full video</button>
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

function CrowdPointEditor({ point, index, frameCount, disabled, onChange, onCommit, onRemove }: { point: CrowdGainPoint; index: number; frameCount: number; disabled: boolean; onChange: (patch: Partial<CrowdGainPoint>) => void; onCommit: () => void; onRemove: () => void }) {
  return <div className="crowd-point-editor"><span>Point {index + 1}</span><input aria-label={`Crowd point ${index + 1} frame`} type="number" min="0" max={frameCount - 1} value={point.frame} disabled={disabled} onChange={(event) => onChange({ frame: Number(event.target.value) })} onBlur={onCommit} /><input aria-label={`Crowd point ${index + 1} gain`} type="number" min="-60" max="0" value={point.gainDb} disabled={disabled} onChange={(event) => onChange({ gainDb: Number(event.target.value) })} onBlur={onCommit} /><button aria-label={`Remove crowd point ${index + 1}`} disabled={disabled} onClick={onRemove}>×</button></div>;
}

function HighlightBoundary({ label, value, frameCount, disabled, invalid, onChange, onSeek, onApply, onSet }: { label: string; value: string; frameCount: number; disabled: boolean; invalid: boolean; onChange: (value: string) => void; onSeek: (frame: number) => void; onApply: () => void; onSet: () => void }) {
  const frame = parseFrame(value, frameCount);
  function nudge(amount: number): void {
    if (frame === undefined) return;
    const next = Math.max(0, Math.min(frameCount - 1, frame + amount));
    onChange(String(next));
    onSeek(next);
  }
  return <div className="highlight-boundary">
    <label>{label}<input type="text" inputMode="numeric" value={value} disabled={disabled} aria-invalid={invalid} aria-describedby={invalid ? "highlight-draft-error" : undefined} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        nudge((event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        onApply();
      }
    }} /></label>
    <div className="boundary-actions">
      <button aria-label={`${label}: previous frame`} disabled={disabled || frame === undefined || frame === 0} onClick={() => nudge(-1)}>−1</button>
      <button aria-label={`${label}: next frame`} disabled={disabled || frame === undefined || frame === frameCount - 1} onClick={() => nudge(1)}>+1</button>
      <button aria-label={`Go to ${label.toLowerCase()}`} disabled={disabled || frame === undefined} onClick={() => frame !== undefined && onSeek(frame)}>Go to</button>
      <button onClick={onSet} disabled={disabled}>{label === "Start frame" ? "Set start" : "Set end"}</button>
    </div>
  </div>;
}
