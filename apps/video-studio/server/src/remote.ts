import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDirectory } from "./paths.js";

export interface RemoteFile {
  reference: string;
  id: string;
  name: string;
  path: string;
  mime: string;
  size: number;
  etag: string;
  integrationKey: string;
}

export interface RemoteCapability {
  sessionId: string;
  appId: string;
  action: "play" | "edit" | "concatenate";
  csrfToken: string;
  expiresAt: string;
  files: RemoteFile[];
  canCreateSibling: boolean;
}

export interface RemoteSession extends RemoteCapability {
  localId: string;
  token: string;
}

const filesApi = (process.env.FILES_API_INTERNAL_URL ?? "http://files-server:8080/api/v1").replace(/\/$/, "");
const sessions = new Map<string, RemoteSession>();

function requireSession(id: string): RemoteSession {
  const session = sessions.get(id);
  if (!session || Date.parse(session.expiresAt) <= Date.now()) {
    sessions.delete(id);
    throw Object.assign(new Error("The Files handoff has expired. Reopen the video from Files."), { statusCode: 410 });
  }
  return session;
}

export async function exchangeRemoteTicket(ticket: string): Promise<RemoteCapability & { localId: string }> {
  const response = await fetch(`${filesApi}/launches/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  const body = await response.json().catch(() => ({ message: response.statusText })) as RemoteCapability & { message?: string };
  if (!response.ok) throw Object.assign(new Error(body.message ?? response.statusText), { statusCode: response.status });
  if (body.appId !== "video-studio" || !["play", "edit", "concatenate"].includes(body.action)) throw new Error("This launch is not a Video Studio request.");
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`rfb_cap_${body.sessionId}=`));
  const token = cookie?.slice(cookie.indexOf("=") + 1, cookie.indexOf(";"));
  if (!token) throw new Error("Files did not return a delegated access token.");
  const localId = randomUUID();
  sessions.set(localId, { ...body, localId, token });
  return { ...body, localId };
}

export function remoteSession(id: string): RemoteSession {
  return requireSession(id);
}

export function remoteFile(session: RemoteSession, reference: string): RemoteFile {
  const file = session.files.find((candidate) => candidate.reference === reference);
  if (!file) throw Object.assign(new Error("That file was not included in this handoff."), { statusCode: 403 });
  return file;
}

export function remoteContentUrl(session: RemoteSession, file: RemoteFile): string {
  return `${filesApi}/delegated/sessions/${encodeURIComponent(session.sessionId)}/files/${encodeURIComponent(file.reference)}/content`;
}

export function remoteMediaInfoUrl(session: RemoteSession, file: RemoteFile): string {
  return `${filesApi}/delegated/sessions/${encodeURIComponent(session.sessionId)}/files/${encodeURIComponent(file.reference)}/media-info`;
}

export async function remoteFetch(session: RemoteSession, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", `rfb_cap_${session.sessionId}=${session.token}`);
  return fetch(url, { ...init, headers });
}

export async function ensureLocalSource(session: RemoteSession, file: RemoteFile): Promise<string> {
  const directory = path.join(dataDirectory, "handoffs", session.localId);
  const target = path.join(directory, `${file.reference}${path.extname(file.name).slice(0, 9) || ".media"}`);
  try {
    if ((await stat(target)).size === file.size) return target;
  } catch { /* Download below. */ }
  await mkdir(directory, { recursive: true });
  const response = await remoteFetch(session, remoteContentUrl(session, file));
  if (!response.ok || !response.body) throw Object.assign(new Error(`Files could not stream ${file.name}.`), { statusCode: response.status });
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(target, { flags: "wx", mode: 0o400 }));
  return target;
}

export async function publishRemoteOutput(session: RemoteSession, source: RemoteFile, file: string, name: string): Promise<{ id: string; name: string }> {
  const form = new FormData();
  form.append("file", await openAsBlob(file), path.basename(file));
  const url = `${filesApi}/delegated/sessions/${encodeURIComponent(session.sessionId)}/outputs?sourceRef=${encodeURIComponent(source.reference)}&name=${encodeURIComponent(name)}`;
  const response = await remoteFetch(session, url, { method: "POST", headers: { "x-app-csrf-token": session.csrfToken }, body: form });
  const result = await response.json().catch(() => ({ message: response.statusText })) as { id?: string; name?: string; message?: string };
  if (!response.ok || !result.id || !result.name) throw Object.assign(new Error(result.message ?? "Files could not save the output."), { statusCode: response.status });
  return { id: result.id, name: result.name };
}

export function localReadStream(file: string) {
  return createReadStream(file);
}
