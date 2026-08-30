import envPaths from "env-paths";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaults = envPaths("video-studio");
const repositoryRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

export const dataDirectory = path.resolve(process.env.VIDEO_STUDIO_DATA_DIR ?? process.env.VFX_EDITOR_DATA_DIR ?? defaults.data);
export const projectsDirectory = path.join(dataDirectory, "projects");
export const bundledCrowdPath = path.join(repositoryRoot, "assets/audio/stadium-crowd-loop.mp3");
export const webDistDirectory = path.join(repositoryRoot, "dist/web");
