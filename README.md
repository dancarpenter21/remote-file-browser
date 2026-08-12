# Remote File Browser

A Dockerized, single-administrator file manager for a remote Linux server. It uses a Rust backend and a React frontend, keeps filesystem operations rooted beneath `/fs-root`, provides recoverable deletion, and bundles FFmpeg for previews and browser-compatible playback.

## Quick start

1. Copy `.env.example` to `.env` and set `RFB_ROOT_PATH`, `RFB_UID`, and `RFB_GID` to the existing directory and numeric identity that should own file operations.
2. Create `secrets/admin_password` containing a password of at least 12 characters.
3. Place a certificate and key at `secrets/tls.crt` and `secrets/tls.key`.
4. Run `docker compose up --build -d`, then open the server over HTTPS.

Only the frontend is published. The backend is reachable solely on the Compose network. HTTP mode is available for isolated development by setting `RFB_TLS_MODE=http` and `RFB_SECURE_COOKIES=false`; never use it across an untrusted network.

The application owns `.trash` and `.cache/remote-file-browser` inside the mounted root. Files deleted from ordinary folders are moved into `.trash`; permanent deletion is available only from the Trash view.

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
