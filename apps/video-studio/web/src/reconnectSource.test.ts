import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeHandoff, type Capability } from "./handoff.js";
import { rememberProjectHandoff } from "./projectHandoff.js";
import { reconnectSource } from "./reconnectSource.js";

vi.mock("./handoff.js", () => ({ exchangeHandoff: vi.fn() }));
vi.mock("./projectHandoff.js", () => ({ rememberProjectHandoff: vi.fn() }));

const project = { id: "project", integration: { provider: "remote-workspace-files" as const, key: "a".repeat(64), sourceId: "original-file-id" } };
const capability: Capability = {
  localId: "fresh-session", sessionId: "files-session", appId: "video-studio", action: "edit", csrfToken: "delegated-csrf", canCreateSibling: true,
  files: [{ reference: "source", id: "original-file-id", name: "source.mp4", path: "/source.mp4", mime: "video/mp4", size: 1, etag: "version", integrationKey: project.integration.key }],
};
const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("reconnecting the source for publishing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { origin: "https://workspace.example" } });
    vi.mocked(exchangeHandoff).mockResolvedValue(capability);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renews through the existing Files login and stores only the new local handoff", async () => {
    fetchMock.mockResolvedValueOnce(json({ authenticated: true, csrfToken: "files-csrf" }));
    fetchMock.mockResolvedValueOnce(json({ launchUrl: "/apps/video/#ticket=fresh-ticket" }));
    expect(await reconnectSource(project)).toBe("fresh-session");
    expect(fetchMock.mock.calls[1]).toEqual(["/api/v1/launches", {
      method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": "files-csrf" },
      body: JSON.stringify({ appId: "video-studio", action: "edit", fileIds: ["original-file-id"] }),
    }]);
    expect(exchangeHandoff).toHaveBeenCalledWith("fresh-ticket");
    expect(rememberProjectHandoff).toHaveBeenCalledWith("project", "fresh-session");
  });

  it("requires a current Files login before requesting a new capability", async () => {
    fetchMock.mockResolvedValueOnce(json({ authenticated: false }));
    await expect(reconnectSource(project)).rejects.toThrow("Sign in to Files");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(exchangeHandoff).not.toHaveBeenCalled();
  });

  it("does not guess the source of an older project", async () => {
    await expect(reconnectSource({ id: project.id, integration: { provider: project.integration.provider, key: project.integration.key } })).rejects.toThrow("once to link");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["changed-source", "read-only", "wrong-action"])("rejects an unusable capability: %s", async (reason) => {
    fetchMock.mockResolvedValueOnce(json({ authenticated: true, csrfToken: "files-csrf" }));
    fetchMock.mockResolvedValueOnce(json({ launchUrl: "/apps/video/#ticket=ticket" }));
    vi.mocked(exchangeHandoff).mockResolvedValue({ ...capability,
      action: reason === "wrong-action" ? "play" : "edit",
      canCreateSibling: reason !== "read-only",
      files: reason === "changed-source" ? [{ ...capability.files[0]!, integrationKey: "b".repeat(64) }] : capability.files,
    });
    await expect(reconnectSource(project)).rejects.toThrow("source video has changed");
    expect(rememberProjectHandoff).not.toHaveBeenCalled();
  });

  it("reports Files launch failures without exchanging or publishing", async () => {
    fetchMock.mockResolvedValueOnce(json({ authenticated: true, csrfToken: "files-csrf" }));
    fetchMock.mockResolvedValueOnce(json({ message: "The original file was removed" }, 404));
    await expect(reconnectSource(project)).rejects.toThrow("original file was removed");
    expect(exchangeHandoff).not.toHaveBeenCalled();
  });
});
