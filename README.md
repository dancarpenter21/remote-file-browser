# VFX Editor

A local-first browser editor for frame-accurate slow-motion sections and stadium ambience. Source files are copied into an application-owned project before processing; the selected original is never opened for writing.

## Requirements

- Linux x64
- Node.js 24+
- Enough free disk space for the imported source, a 720p proxy, previews, and exports

FFmpeg and FFprobe are installed as pinned platform-specific npm dependencies. Startup checks the actual binaries for every required filter and encoder.

## Run

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. Production mode uses `npm run build && npm start` and serves `http://127.0.0.1:4317`.

## Tests

```bash
npm test
npm run typecheck
npm run build
```

Project media is stored under the platform application-data directory, normally `~/.local/share/vfx-editor-nodejs` on Linux. Removing a project from the UI removes only that application-owned project directory.

## Docker

The Compose deployment has independent `dev` and `prod` profiles. Both use the bundled Linux x64 FFmpeg and FFprobe builds, so the services explicitly target `linux/amd64` (Docker Desktop can emulate this platform on Arm hosts).

### Development profile

The development image runs the API and Vite development server together with source bind-mounted for hot reload. It is available only from the Docker host at `http://127.0.0.1:5173`.

```bash
docker compose --profile dev up --build
```

Development projects are persisted in the `vfx-editor-dev-data` volume. Dependencies are kept in `vfx-editor-dev-node-modules`, separate from host `node_modules`.

### Production profile

Production builds the web bundle in a separate image stage, runs the server as the unprivileged `node` user on a read-only root filesystem, and persists projects in `vfx-editor-prod-data`.

Set the exact public HTTPS origin before starting it:

```bash
cp .env.example .env
# Edit VFX_EDITOR_ALLOWED_ORIGINS in .env
docker compose --profile prod up -d --build
docker compose --profile prod ps
```

The production service intentionally publishes no host port. Attach an authenticated TLS reverse proxy to the external Docker network named `vfx-editor` and route its public origin to `prod:4317`. Configure the proxy to:

- preserve streaming responses and disable buffering for `/api/jobs/*/events`;
- allow the required upload size (the application accepts sources up to 40 GB);
- retain byte-range request and response headers for media seeking and downloads;
- use long request timeouts for uploads, while render jobs continue asynchronously;
- proxy Vite WebSocket upgrades as well if the development profile is ever routed through it.

The app itself has no user authentication. Do not expose the production service without authentication at the reverse proxy. Multiple public origins can be supplied as a comma-separated `VFX_EDITOR_ALLOWED_ORIGINS` value. Production startup fails if this setting is empty or malformed.

### Lifecycle and storage

Stop a profile without deleting its projects:

```bash
docker compose --profile dev down
docker compose --profile prod down
```

Named volumes survive container rebuilds and ordinary `down` operations. Avoid `docker compose down --volumes` unless both development and production media should be permanently removed. Back up `vfx-editor-prod-data` before Docker host migrations or destructive maintenance.
