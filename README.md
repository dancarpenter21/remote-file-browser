# Remote File Browser

A Dockerized, single-administrator file manager for a remote Linux server. It uses a Rust backend and a React frontend, keeps filesystem operations rooted beneath `/fs-root`, provides recoverable deletion, and bundles FFmpeg for previews and browser-compatible playback.

## Quick start

1. Copy `.env.example` to `.env` and set `RFB_ROOT_PATH`, `RFB_UID`, and `RFB_GID` to the existing directory and numeric identity that should own file operations.
2. Create `secrets/admin_password` containing a password of at least 12 characters.
3. Place a certificate and key at `secrets/tls.crt` and `secrets/tls.key`.
4. Run `docker compose up --build -d`, then open the server over HTTPS.

To rotate the administrator password, replace the contents of `secrets/admin_password`. The new value is used for subsequent login attempts without restarting the stack; existing authenticated sessions remain valid.

Only the frontend is published. The backend is reachable solely on the Compose network. HTTP mode is available for isolated development by setting `RFB_TLS_MODE=http` and `RFB_SECURE_COOKIES=false`; never use it across an untrusted network.

The application owns `.trash` and `.cache/remote-file-browser` inside the mounted root. Files deleted from ordinary folders are moved into `.trash`; permanent deletion is available only from the Trash view.

Media conversions and clip extractions report live FFmpeg progress over an authenticated WebSocket. The media-jobs panel also provides a cache reconciliation action that removes stale derived artifacts while preserving active work. Cache associations follow files moved or renamed through the UI, including moves performed as part of folder merges.

## Integrated terminal

The Terminal control opens a resizable panel beneath the file browser. A new shell starts in the directory currently shown by the browser, remains alive when the panel is hidden, and stops when the panel is closed, the browser disconnects, or the login session ends. The frontend bundles MesloLGS Nerd Font faces so prompts and tools can display Nerd Font glyphs even when the browser machine has no Nerd Font installed; attribution and source hashes are recorded in `frontend/THIRD_PARTY_NOTICES.md`.

The terminal runs inside the backend container as `RFB_UID:RFB_GID`. It can modify the `/fs-root` bind mount and use programs installed in that container, but it is not a shell on the Docker host. The container supplies zsh and launches it as a login shell with `HOME=/fs-root`, allowing a mounted home directory's zsh configuration to load. The existing read-only container filesystem, dropped capabilities, and `no-new-privileges` setting still apply.

Terminal access is enabled by default for the authenticated administrator because this is a single-administrator application. Configure it with:

- `RFB_TERMINAL_ENABLED=false` to remove the UI and disable both terminal endpoints.
- `RFB_TERMINAL_SHELL=/bin/zsh` to select the login shell executable.
- `RFB_TERMINAL_MAX_SESSIONS=4` to cap concurrent PTYs across browser sessions.

An enabled terminal grants arbitrary command execution within the backend container to anyone who can authenticate. Keep the application behind HTTPS, use a strong administrator password, and disable the terminal when interactive command execution is not required.

## API documentation and provenance automation

The complete OpenAPI document is available at `/api/openapi.json`, with interactive Swagger documentation at `/api/docs/`. Documentation is public, but each operation still enforces the authentication shown in its Swagger security section.

An external agent can append a provenance URL to a file by configuring a dedicated bearer token. Create an untracked secret containing at least 32 characters:

```sh
openssl rand -base64 32 > secrets/provenance_api_token
```

Add a Compose override such as `compose.provenance.yaml`:

```yaml
services:
  backend:
    environment:
      RFB_PROVENANCE_API_TOKEN_FILE: /run/secrets/provenance_api_token
    secrets:
      - provenance_api_token

secrets:
  provenance_api_token:
    file: ./secrets/provenance_api_token
```

Start Compose with both files, then submit a path relative to the mounted root. A leading slash is allowed, but `~`, `/fs-root`, and host absolute paths are not:

```sh
docker compose -f compose.yaml -f compose.provenance.yaml up --build -d
curl --fail-with-body \
  -H "Authorization: Bearer $(tr -d '\n' < secrets/provenance_api_token)" \
  -H 'Content-Type: application/json' \
  -d '{"path":".wdb/WWVV/Megan Avalon vs Kala.mp4","url":"https://example.com/source"}' \
  https://localhost/api/v1/fs/provenance
```

The operation appends uniquely and returns the file's complete provenance URL list. Connected browser sessions receive the change immediately. Use HTTPS whenever the request crosses an untrusted network. If the token is not configured, the automation endpoint returns `503 provenance_api_disabled`; browser provenance editing remains available.

## Choosing a mounted filesystem

`RFB_ROOT_PATH` may point to any directory visible from the Linux/WSL shell. Compose mounts that exact directory at `/fs-root` and will fail instead of silently creating a missing source path.

Tracked templates cover the common cases:

- `.env.linux.example` targets a native Linux home directory with HTTPS defaults.
- `.env.wsl.example` targets a directory under `/mnt/c/Users/...` and uses high, HTTP-only development ports.
- `.env.example` is the generic starting point.

Keep the copied, machine-specific files untracked. For example:

```sh
cp .env.wsl.example .env.wsl
# Edit RFB_ROOT_PATH and identity values.
docker compose --env-file .env.wsl up --build
```

For a Linux home directory, use `cp .env.linux.example .env` and run ordinary `docker compose up --build`. WSL-mounted Windows filesystems do not reproduce every POSIX permission and ownership behavior, so permission testing should also be run against a native Linux directory.

## Development

For a containerized frontend with Vite hot reload, start the `dev` profile and
target its development service explicitly:

```sh
RFB_SECURE_COOKIES=false docker compose --profile dev up frontend-dev
```

Open `http://localhost:5173` (or replace `localhost` with the server hostname).
The frontend source directory is bind-mounted, while dependencies are kept in a
named Docker volume. The existing backend image is reused and Vite proxies
`/api` to it. Stop the profile with:

```sh
docker compose --profile dev down
```

Set `RFB_DEV_PORT` to change the published port. If file changes are not
detected, set `RFB_DEV_POLLING=true`; the WSL template enables this by default.

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
