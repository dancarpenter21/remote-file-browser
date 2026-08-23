import { verifyMediaCapabilities } from "./binaries.js";
import { buildServer } from "./server.js";

const host = process.env.VFX_EDITOR_HOST ?? "127.0.0.1";
const port = Number(process.env.VFX_EDITOR_PORT ?? 4317);

try {
  const version = await verifyMediaCapabilities();
  const server = await buildServer();
  await server.listen({ host, port });
  server.log.info(`${version}; editor available at http://${host}:${port}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
