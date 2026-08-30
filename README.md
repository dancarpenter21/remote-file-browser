# Remote File Browser

A Dockerized, single-administrator file manager for a remote Linux server. It uses a Rust backend and a React frontend, keeps filesystem operations rooted beneath `/fs-root`, provides recoverable deletion, and bundles FFmpeg for previews and browser-compatible playback.

## Launch

### First-time setup

1. Copy the environment template and set `RFB_ROOT_PATH`, `RFB_UID`, `RFB_GID`, and `RFB_HOSTNAME`:

   ```sh
   cp .env.example .env
   ```

2. Create the required secrets:

   ```sh
   mkdir -p secrets
   openssl rand -base64 24 > secrets/admin_password
   openssl rand -base64 32 > secrets/provenance_db_password
   ```

3. For production, start the sibling `../traefik-ingress` project first. Its external `traefik-ingress` Docker network must exist, private DNS must resolve `RFB_HOSTNAME` to the ingress server, and the Traefik certificate must cover that hostname.

### Production launch

Launch the core file browser behind Traefik:

```sh
docker compose -f compose.yaml -f compose.traefik.yaml --profile prod up -d --build
```

To include the standalone Video Player app, add its overlay before the ingress overlay:

```sh
docker compose -f compose.yaml -f compose.apps.yaml -f compose.traefik.yaml --profile prod up -d --build
```

Open `https://$RFB_HOSTNAME`. Stop the selected stack with the same files and profile, replacing `up -d --build` with `down`.

### Development launch

Launch the core browser with Vite hot reload at `http://localhost:5173`:

```sh
RFB_SECURE_COOKIES=false docker compose --profile dev up -d --build frontend-dev
```

Launch it with the standalone Video Player app enabled:

```sh
RFB_SECURE_COOKIES=false docker compose -f compose.yaml -f compose.apps.yaml --profile dev up -d --build frontend-dev
```

Stop development with the matching Compose files, for example:

```sh
docker compose -f compose.yaml -f compose.apps.yaml --profile dev down
```

Set `RFB_DEV_PORT` to change port 5173. Set `RFB_DEV_POLLING=true` if bind-mounted source changes are not detected; the WSL template enables polling by default.

### VFX Editor launch

Start the sibling VFX Editor first, then launch Remote Files with its overlay:

```sh
cd ../vfx-editor
docker compose --profile dev up -d --build
cd ../remote-file-browser
RFB_SECURE_COOKIES=false docker compose -f compose.yaml -f compose.vfx.yaml --profile dev up -d --build frontend-dev
```

Remote Files remains at `http://localhost:5173`; the integrated editor is under `/vfx/`. For production, start the VFX `prod` profile, set `VFX_EDITOR_ALLOWED_ORIGINS` to the exact Remote Files HTTPS origin, and run:

```sh
docker compose -f compose.yaml -f compose.vfx.yaml -f compose.traefik.yaml --profile prod up -d --build
```

The `compose.apps.yaml` and `compose.vfx.yaml` overlays can be included together when both integrations are needed; keep `compose.traefik.yaml` last in production.

### Direct TLS recovery

Use direct TLS only while the shared ingress is stopped because both deployments bind ports 80 and 443. Point the certificate variables at the centralized Traefik certificate files:

```sh
cd ../traefik-ingress
docker compose down
cd ../remote-file-browser
docker compose -f compose.yaml -f compose.direct.yaml --profile prod up -d --build
```

To return to normal operation, stop the direct deployment, restart Traefik, and relaunch Remote Files using the production command above.

To rotate the administrator password, replace the contents of `secrets/admin_password`. The new value is used for subsequent login attempts without restarting the stack; existing authenticated sessions remain valid.

Only the frontend joins the shared ingress network. It serves plain HTTP on that private Docker network while Traefik supplies the HTTPS boundary. The backend, provenance API, and database remain reachable solely on application networks. HTTP mode is available through the isolated `dev` profile with `RFB_SECURE_COOKIES=false`; never publish it across an untrusted network.

The application owns `.trash` and `.cache/remote-file-browser` inside the mounted root. Files deleted from ordinary folders are moved into `.trash`; permanent deletion is available only from the Trash view.

Connected browsers subscribe to live filesystem updates only for directories they have loaded. This keeps changes made by host tools, scripts, and the integrated terminal visible without recursively consuming an inotify watch for every directory beneath the mounted root.

At viewport widths of 800 pixels or less, the frontend automatically switches to a touch-oriented mobile layout. It uses a single-pane file list with one-tap navigation, explicit selection checkboxes, bottom-sheet action menus, and a navigation drawer for Trash, Terminal, media jobs, and account actions. Resizing above the breakpoint restores the existing desktop view without changing its saved view preference.

## Provenance storage

Provenance URLs are stored by a dedicated Rust API in PostgreSQL. The API and database have no published ports: the backend reaches the API over one internal Docker network, and only the API can reach PostgreSQL over a second internal network. The named `provenance-db-data` volume holds the database across container replacement.

On the first database-backed startup, legacy `.cache/remote-file-browser/provenance.json` data is imported transactionally when the database is empty. A successful import renames the file to `provenance.json.migrated`; restore that filename to `provenance.json` before rolling back to an older build. If PostgreSQL already contains records, the legacy file is left untouched.

The browser-facing provenance API remains `/api/v1/fs/provenance`. To enable bearer-token automation, generate `secrets/provenance_api_token` and add `-f compose.automation.yaml` to the Compose command. The internal provenance API is never published by that overlay.

Back up provenance with `docker compose exec -T provenance-db pg_dump -U rfb_provenance -d rfb_provenance > provenance.sql`. Restore into an empty database with `docker compose exec -T provenance-db psql -U rfb_provenance -d rfb_provenance < provenance.sql`.

Media conversions and clip extractions report live FFmpeg progress over an authenticated WebSocket. The media-jobs panel also provides a cache reconciliation action that removes stale derived artifacts while preserving active work. Cache associations follow files moved or renamed through the UI, including moves performed as part of folder merges.

## Integrated terminal

The Terminal control opens a resizable panel beneath the file browser. A new shell starts in the directory currently shown by the browser, remains alive when the panel is hidden, and stops when the panel is closed, the browser disconnects, or the login session ends. The frontend bundles MesloLGS Nerd Font faces so prompts and tools can display Nerd Font glyphs even when the browser machine has no Nerd Font installed; attribution and source hashes are recorded in `frontend/THIRD_PARTY_NOTICES.md`.

The terminal runs inside the backend container as `RFB_UID:RFB_GID`. It can modify the `/fs-root` bind mount and use programs installed in that container, but it is not a shell on the Docker host. The container supplies zsh and Vim and launches zsh as a login shell with `HOME=/fs-root`, allowing a mounted home directory's zsh configuration to load. The existing read-only container filesystem, dropped capabilities, and `no-new-privileges` setting still apply.

Terminal access is enabled by default for the authenticated administrator because this is a single-administrator application. Configure it with:

- `RFB_TERMINAL_ENABLED=false` to remove the UI and disable both terminal endpoints.
- `RFB_TERMINAL_SHELL=/bin/zsh` to select the login shell executable.
- `RFB_TERMINAL_MAX_SESSIONS=4` to cap concurrent PTYs across browser sessions.

An enabled terminal grants arbitrary command execution within the backend container to anyone who can authenticate. Keep the application behind HTTPS, use a strong administrator password, and disable the terminal when interactive command execution is not required.

## API documentation

The complete OpenAPI document is available at `/api/openapi.json`, with interactive Swagger documentation at `/api/docs/`. Documentation is public, but each operation still enforces the authentication shown in its Swagger security section.

## Choosing a mounted filesystem

`RFB_ROOT_PATH` may point to any directory visible from the Linux/WSL shell. Compose mounts that exact directory at `/fs-root` and will fail instead of silently creating a missing source path.

Tracked templates cover the common cases:

- `.env.linux.example` targets a native Linux home directory behind Traefik.
- `.env.wsl.example` targets a directory under `/mnt/c/Users/...` and uses high, HTTP-only development ports.
- `.env.example` is the generic starting point.

Keep the copied, machine-specific files untracked. For example:

```sh
cp .env.wsl.example .env.wsl
# Edit RFB_ROOT_PATH and identity values.
docker compose --env-file .env.wsl --profile dev up --build
```

For a Linux home directory, use `cp .env.linux.example .env` and run the Traefik-backed production command from Launch. WSL-mounted Windows filesystems do not reproduce every POSIX permission and ownership behavior, so permission testing should also be run against a native Linux directory.

## Development

Use the development command in [Launch](#development-launch). The frontend source directory is bind-mounted, dependencies are kept in a named Docker volume, the production frontend is excluded, and Vite proxies `/api` to the backend.

### File app platform

Remote Files can dispatch selected files to independently built applications through short-lived, scoped handoffs. The Files backend remains the only service with the `/fs-root` mount: an app receives opaque references for the selected files, ranged read access, and only the write or create-sibling permissions declared for its action. Handoffs are bound to the file etag and the administrator session, are single-use, and are revoked on logout.

The first extracted application is Video Player. It preserves direct playback, automatic HLS fallback, frame stepping, In/Out marks, and frame or segment extraction while running as its own workspace and container. Use the app-enabled command in [Launch](#production-launch) or [Launch](#development-launch). The gateway exposes it at `/apps/video/`; the service has no published host port. Omit `compose.apps.yaml` to retain the embedded player only.

### VFX Editor integration

When the sibling `~/vfx-editor` application is running, Remote Files can expose it at the authenticated `/vfx/` path and add **Edit with VFX Editor** to video context menus. The selected source is streamed between the two backends and copied into VFX-owned storage; unchanged files reopen their existing project. Completed exports are streamed back between the servers and written beside the original as `name-edited.mp4`, using a numeric suffix rather than overwriting an existing export.

Use the VFX commands in [Launch](#vfx-editor-launch). Direct VFX development access uses port 5174, while integrated access uses `http://localhost:5173/vfx/`. In production, VFX remains available only at `/vfx/` under the Remote Files hostname and is protected by the Remote Files login. It has no Traefik labels or independent hostname. Omit `compose.vfx.yaml` to run without VFX Editor.

To run both processes directly on the host instead, use the following commands.

Backend:

```sh
cd backend
RFB_ROOT=/tmp/rfb-root RFB_ADMIN_PASSWORD='development-password' RFB_SECURE_COOKIES=false cargo run
```

Frontend:

```sh
cd frontend
npm install
npm run dev
```

Vite proxies `/api` to the backend at `127.0.0.1:8080`.

## FFmpeg

The backend image compiles FFmpeg 8.1.2 from verified source with native features and common GPL-compatible codec libraries. The build deliberately excludes `--enable-nonfree` and hardware-specific acceleration. See `backend/THIRD_PARTY_NOTICES.md` for licensing and source details.
