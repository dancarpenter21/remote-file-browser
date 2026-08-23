import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectSchema, type Project, type SourceMetadata } from "@vfx/shared";
import { projectsDirectory } from "./paths.js";

export function projectDirectory(projectId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new Error("Invalid project id.");
  return path.join(projectsDirectory, projectId);
}

export function projectFile(projectId: string, ...parts: string[]): string {
  const root = projectDirectory(projectId);
  const resolved = path.resolve(root, ...parts);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Invalid project path.");
  return resolved;
}

export async function ensureStorage(): Promise<void> {
  await mkdir(projectsDirectory, { recursive: true });
}

export async function listProjects(): Promise<Project[]> {
  await ensureStorage();
  const entries = await readdir(projectsDirectory, { withFileTypes: true });
  const projects = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    try {
      return await readProject(entry.name);
    } catch {
      return undefined;
    }
  }));
  return projects.filter((project): project is Project => Boolean(project)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readProject(projectId: string): Promise<Project> {
  const raw = await readFile(projectFile(projectId, "project.json"), "utf8");
  return projectSchema.parse(JSON.parse(raw));
}

export async function saveProject(project: Project): Promise<Project> {
  const parsed = projectSchema.parse(project);
  await mkdir(projectDirectory(project.id), { recursive: true });
  const destination = projectFile(project.id, "project.json");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
  return parsed;
}

export async function createProjectRecord(name: string, source: SourceMetadata, integration?: Project["integration"]): Promise<Project> {
  const now = new Date().toISOString();
  const project: Project = {
    schemaVersion: 1,
    id: randomUUID(),
    name: name.slice(0, 120) || "Untitled video",
    createdAt: now,
    updatedAt: now,
    revision: 0,
    status: "importing",
    source,
    highlightRange: { startFrame: 0, endFrameExclusive: source.frameCount },
    sections: [],
    audio: {
      useOriginalAudio: true,
      sourceGainDb: 0,
      crowdGainDb: -24,
      crowdMuted: false,
      crowdSource: "bundled",
    },
    integration,
  };
  await saveProject(project);
  return project;
}

export async function deleteProject(projectId: string): Promise<void> {
  await rm(projectDirectory(projectId), { recursive: true, force: true });
}

export async function cleanupInterruptedArtifacts(projectId: string): Promise<void> {
  const directory = projectDirectory(projectId);
  await rm(path.join(directory, "jobs"), { recursive: true, force: true });
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.includes(".partial"))
    .map((entry) => rm(path.join(directory, entry.name), { force: true })));
}
