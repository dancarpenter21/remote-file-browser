import { verifyMediaCapabilities } from "./binaries.js";
import { buildServer } from "./server.js";

const host = process.env.VIDEO_STUDIO_HOST ?? process.env.VFX_EDITOR_HOST ?? "127.0.0.1";
const port = Number(process.env.VIDEO_STUDIO_PORT ?? process.env.VFX_EDITOR_PORT ?? 4317);

try {
  const version = await verifyMediaCapabilities();
  const server = await buildServer();
  await server.listen({ host, port });
  server.log.info(`${version}; Video Studio available at http://${host}:${port}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
