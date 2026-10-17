import type { Project } from "@remote-workspace/video-shared";
import { exchangeHandoff } from "./handoff.js";
import { rememberProjectHandoff } from "./projectHandoff.js";

export async function reconnectSource(project: Pick<Project, "id" | "integration">): Promise<string> {
  const integration = project.integration;
  if (!integration?.sourceId) throw new Error("Open the original video from Files → Edit in Video Studio once to link this older project to its source.");
  const sessionResponse = await fetch("/api/v1/auth/session");
  const session = await sessionResponse.json() as { authenticated?: boolean; csrfToken?: string };
  if (!sessionResponse.ok || !session.authenticated || !session.csrfToken) throw new Error("Sign in to Files, then retry Save beside source. Your rendered export is kept.");
  const launchResponse = await fetch("/api/v1/launches", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-csrf-token": session.csrfToken },
    body: JSON.stringify({ appId: "video-studio", action: "edit", fileIds: [integration.sourceId] }),
  });
  const launch = await launchResponse.json() as { launchUrl?: string; message?: string };
  if (!launchResponse.ok || !launch.launchUrl) throw new Error(launch.message ?? "Files could not reconnect the source video.");
  const ticket = new URL(launch.launchUrl, window.location.origin).hash.slice(1);
  const token = new URLSearchParams(ticket).get("ticket");
  if (!token) throw new Error("Files did not return a source handoff.");
  const capability = await exchangeHandoff(token);
  if (capability.action !== "edit" || !capability.canCreateSibling || capability.files[0]?.integrationKey !== integration.key) {
    throw new Error("The source video has changed. Reopen the original video from Files before saving beside it.");
  }
  rememberProjectHandoff(project.id, capability.localId);
  return capability.localId;
}
