import type { Project, ProjectPatch, RenderJob, RenderKind } from "@vfx/shared";
import { apiUrl } from "./urls.js";

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(body.error ?? response.statusText);
  }
  return response.json() as Promise<T>;
}

export async function listProjects(): Promise<Project[]> {
  return responseJson(await fetch(apiUrl("/projects")));
}

export async function getProject(id: string): Promise<Project> {
  return responseJson(await fetch(apiUrl(`/projects/${id}`)));
}

export function importProject(file: File, onProgress: (progress: number) => void): Promise<Project> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", apiUrl("/projects"));
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onerror = () => reject(new Error("Upload failed."));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve(request.response as Project);
      else reject(new Error((request.response as { error?: string })?.error ?? "Import failed."));
    };
    const form = new FormData();
    form.append("file", file);
    request.send(form);
  });
}

export async function patchProject(id: string, patch: ProjectPatch): Promise<Project> {
  return responseJson(await fetch(apiUrl(`/projects/${id}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
}

export async function removeProject(id: string): Promise<void> {
  const response = await fetch(apiUrl(`/projects/${id}`), { method: "DELETE" });
  if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "Delete failed.");
}

export async function uploadCrowd(id: string, file: File): Promise<Project> {
  const form = new FormData();
  form.append("file", file);
  return responseJson(await fetch(apiUrl(`/projects/${id}/crowd`), { method: "POST", body: form }));
}

export async function createRender(id: string, kind: RenderKind, expectedRevision: number): Promise<RenderJob> {
  return responseJson(await fetch(apiUrl(`/projects/${id}/renders`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, expectedRevision }),
  }));
}

export async function cancelRender(id: string): Promise<RenderJob> {
  return responseJson(await fetch(apiUrl(`/jobs/${id}`), { method: "DELETE" }));
}
