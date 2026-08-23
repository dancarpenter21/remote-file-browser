import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Project, RenderJob, RenderKind } from "@vfx/shared";
import { renderProject } from "./media.js";
import { readProject, saveProject } from "./storage.js";

type JobListener = (job: RenderJob) => void;

export class RenderQueue {
  private readonly jobs = new Map<string, RenderJob>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly pending: string[] = [];
  private readonly snapshots = new Map<string, Project>();
  private readonly events = new EventEmitter();
  private running = false;

  enqueue(project: Project, kind: RenderKind): RenderJob {
    const job: RenderJob = {
      id: randomUUID(),
      projectId: project.id,
      projectRevision: project.revision,
      kind,
      status: "queued",
      progress: 0,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.snapshots.set(job.id, structuredClone(project));
    this.pending.push(job.id);
    this.emit(job);
    void this.drain();
    return job;
  }

  get(jobId: string): RenderJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : undefined;
  }

  subscribe(jobId: string, listener: JobListener): () => void {
    const event = `job:${jobId}`;
    this.events.on(event, listener);
    const current = this.jobs.get(jobId);
    if (current) queueMicrotask(() => listener({ ...current }));
    return () => this.events.off(event, listener);
  }

  cancel(jobId: string): RenderJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job || ["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    if (job.status === "queued") {
      const index = this.pending.indexOf(jobId);
      if (index >= 0) this.pending.splice(index, 1);
      job.status = "cancelled";
      this.snapshots.delete(jobId);
      this.emit(job);
    } else {
      this.controllers.get(jobId)?.abort();
    }
    return { ...job };
  }

  private emit(job: RenderJob): void {
    this.events.emit(`job:${job.id}`, { ...job });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const jobId = this.pending.shift()!;
        const job = this.jobs.get(jobId);
        const project = this.snapshots.get(jobId);
        if (!job || !project || job.status === "cancelled") continue;
        const controller = new AbortController();
        this.controllers.set(jobId, controller);
        job.status = "running";
        this.emit(job);
        try {
          const artifact = await renderProject(project, {
            kind: job.kind,
            signal: controller.signal,
            onProgress: (progress) => {
              job.progress = progress;
              this.emit(job);
            },
          });
          job.status = "succeeded";
          job.progress = 1;
          job.artifactUrl = `/api/projects/${project.id}/media/${job.kind}`;
          const current = await readProject(project.id);
          const createdAt = new Date().toISOString();
          const artifactRecord = { revision: project.revision, filename: artifact.filename, createdAt, durationSeconds: artifact.durationSeconds };
          if (job.kind === "preview") current.preview = artifactRecord;
          else current.export = artifactRecord;
          current.updatedAt = createdAt;
          await saveProject(current);
        } catch (error) {
          job.status = controller.signal.aborted ? "cancelled" : "failed";
          job.error = error instanceof Error ? error.message : "Unknown render error.";
        } finally {
          this.controllers.delete(jobId);
          this.snapshots.delete(jobId);
          this.emit(job);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
