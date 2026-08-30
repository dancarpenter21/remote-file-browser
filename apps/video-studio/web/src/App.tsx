import { useEffect, useRef, useState } from "react";
import type { Project } from "@remote-workspace/video-shared";
import { getProject, importProject, listProjects, openRemoteProject, removeProject } from "./api.js";
import { Editor } from "./Editor.js";
import { Player } from "./Player.js";
import { Concatenate } from "./Concatenate.js";
import { exchangeHandoff, ticketFromHash, type Capability } from "./handoff.js";
import { apiUrl, appUrl } from "./urls.js";

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const launch = new URLSearchParams(window.location.search);
  const [activeId, setActiveId] = useState<string | undefined>(() => launch.get("project") ?? undefined);
  const [remoteSessionId, setRemoteSessionId] = useState<string>();
  const [handoff, setHandoff] = useState<Capability>();
  const [handoffLoading, setHandoffLoading] = useState(Boolean(ticketFromHash()));
  const [loading, setLoading] = useState(true);
  const [uploadProgress, setUploadProgress] = useState<number>();
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const active = projects.find((project) => project.id === activeId);

  async function refresh(): Promise<void> {
    try {
      setProjects(await listProjects());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load projects.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const ticket = ticketFromHash();
    if (!ticket) return;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    exchangeHandoff(ticket).then(async capability => {
      if (capability.action === 'edit') {
        const opened = await openRemoteProject(capability.localId);
        setRemoteSessionId(capability.localId);
        await refresh(); setActiveId(opened.projectId);
      } else setHandoff(capability);
    }).catch(cause => setError(cause instanceof Error ? cause.message : 'Could not open the video.')).finally(() => setHandoffLoading(false));
  }, []);
  useEffect(() => {
    if (!projects.some((project) => project.status === "importing")) return;
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => window.clearInterval(timer);
  }, [projects]);

  if (handoffLoading || (launch.get("handoff") === "1" && !activeId && !handoff && !error)) {
    return <main className="library-page"><section className="library-hero"><span className="eyebrow">Remote Workspace</span><h1>Opening Video Studio…</h1><p>Receiving the scoped file handoff from Files.</p></section></main>;
  }

  if (handoff?.action === 'play') return <Player capability={handoff} onEdit={async () => { const opened = await openRemoteProject(handoff.localId); setRemoteSessionId(handoff.localId); await refresh(); setHandoff(undefined); setActiveId(opened.projectId); }} />;
  if (handoff?.action === 'concatenate') return <Concatenate capability={handoff} />;

  if (activeId && (loading || !active || active.status === "importing")) {
    return <main className="library-page"><section className="library-hero"><span className="eyebrow">Video Studio</span><h1>Preparing project…</h1><p>{active?.name ?? "Loading the selected video."}</p></section></main>;
  }

  if (active?.status === "ready") {
    return <Editor initialProject={active} remoteSessionId={remoteSessionId} onBack={() => { history.replaceState(null, "", appUrl()); setActiveId(undefined); setRemoteSessionId(undefined); }} onProjectChange={(updated) => setProjects((all) => all.map((project) => project.id === updated.id ? updated : project))} />;
  }

  return (
    <main className="library-page">
      <header className="library-header"><div><span className="brand-mark">VS</span><span>Video Studio</span></div><button className="accent-button" onClick={() => inputRef.current?.click()} disabled={uploadProgress !== undefined}>Import video</button><input ref={inputRef} hidden type="file" accept="video/*,.mkv,.mov,.m4v" onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; setError(undefined); setUploadProgress(0); try { const project = await importProject(file, setUploadProgress); setProjects((all) => [project, ...all]); setActiveId(project.id); } catch (cause) { setError(cause instanceof Error ? cause.message : "Import failed."); } finally { setUploadProgress(undefined); event.target.value = ""; } }} /></header>
      <section className="library-hero"><span className="eyebrow">Local video workspace</span><h1>Slow the moment.<br /><em>Keep every frame.</em></h1><p>Shape smooth slow-motion sections and layer stadium atmosphere without touching your original file.</p></section>
      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError(undefined)}>×</button></div>}
      {uploadProgress !== undefined && <div className="upload-card"><div><span style={{ width: `${uploadProgress * 100}%` }} /></div><p>Copying source · {Math.round(uploadProgress * 100)}%</p></div>}
      <section className="project-section"><div className="section-heading"><h2>Projects</h2><span>{projects.length}</span></div>
        {loading ? <p className="empty-note">Loading projects…</p> : projects.length === 0 ? <button className="empty-projects" onClick={() => inputRef.current?.click()}><span>＋</span><strong>Import your first video</strong><small>MP4, MOV, MKV, WebM · up to 1080p / 30 minutes</small></button> : <div className="project-grid">{projects.map((project) => <article className="project-card" key={project.id}><button className="project-open" onClick={() => project.status === "ready" && setActiveId(project.id)} disabled={project.status !== "ready"}><div className="project-thumb">{project.proxyFilename ? <video src={`${apiUrl(`/projects/${project.id}/media/proxy`)}#t=0.1`} muted preload="metadata" /> : <span className="processing-ring" />}</div><div><strong>{project.name}</strong><p>{project.status === "importing" ? "Preparing frame-accurate proxy…" : project.status === "error" ? project.error : `${project.source.width}×${project.source.height} · ${project.sections.length} slow section${project.sections.length === 1 ? "" : "s"}`}</p></div></button><button className="delete-button" aria-label={`Delete ${project.name}`} onClick={async () => { if (!window.confirm(`Delete the Video Studio project “${project.name}”? The external source file will not be touched.`)) return; try { await removeProject(project.id); setProjects((all) => all.filter((item) => item.id !== project.id)); } catch (cause) { setError(cause instanceof Error ? cause.message : "Delete failed."); } }}>Delete</button></article>)}</div>}
      </section>
      <footer><span>Processing stays on this machine</span><span>Originals are never modified</span></footer>
    </main>
  );
}
