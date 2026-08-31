# Remote Workspace

Remote Workspace is a single-administrator, Dockerized workspace for files on a remote Linux host. The root Compose project runs four browser applications behind one authenticated HTTPS origin:

- **Files** browses and manages the mounted filesystem, Trash, provenance, and terminal sessions.
- **Text Editor** opens text and Markdown in a reusable tabbed window.
- **Image Tools** opens image galleries in a reusable window with zoom, rotation, pixel measurement, and non-destructive markup copies.
- **Video Studio** imports video into isolated project storage for timeline editing and export.

Files is the only service with the `/fs-root` mount. Other apps receive short-lived, single-use capabilities for selected files. Capabilities are session- and version-bound and grant only the reads or output operations declared by the app action.

## Initial setup

Both production and development require an environment file and local administrator and database secrets. Copy a template and edit the mounted path and numeric identity. For production, also set the hostname, ingress bind address, and certificate paths:

```sh
cp .env.example .env
mkdir -p secrets
openssl rand -base64 24 > secrets/admin_password
openssl rand -base64 32 > secrets/provenance_db_password
```

## Production

Validate and start the complete HTTPS stack:

```sh
docker compose --profile prod config --quiet
docker compose --profile prod up -d --build
```

Open `https://$RWS_HOSTNAME`. The root stack owns Traefik, its restricted Docker socket proxy, the application services, and their private networks. The TLS certificate must cover the configured hostname and be trusted by clients. By default, ingress binds only to `127.0.0.1`; set `INGRESS_BIND_ADDRESS` deliberately for remote access.

Stop the stack without deleting application data:

```sh
docker compose --profile prod down
```

Do not add `--volumes` unless provenance records and Video Studio projects may be permanently removed.

## Development

The dev profile runs Files at `http://localhost:5173` and starts all app development servers behind its Vite proxy:

```sh
RWS_SECURE_COOKIES=false docker compose --profile dev up --build
```

One setup container installs the root npm lockfile into a shared named volume before the web services start. Set `RWS_DEV_PORT` to change the host port and `RWS_DEV_POLLING=true` when bind-mounted source events are unreliable.

Host-side development uses Node.js 24+ and Rust:

```sh
npm ci
npm run build
npm test
cargo test --workspace
```

Run individual web apps with `npm run dev:files`, `npm run dev:images`, `npm run dev:text`, or `npm run dev:video`. Files' Vite server supplies the integrated app routes and API proxy.

## Filesystem and security

`FILES_ROOT_PATH` must be an existing path visible to Docker. Compose bind-mounts it at `/fs-root` without creating a missing host directory. The service runs as `FILES_UID:FILES_GID`; Windows-mounted WSL filesystems do not reproduce all POSIX ownership and permission behavior.

The application owns `.trash` and `.cache/remote-file-browser` inside the mounted root. Ordinary deletion moves entries to `.trash`; permanent deletion is available from Trash. Thumbnail cache limits are controlled by `FILES_CACHE_MAX_BYTES` and `FILES_CACHE_MAX_AGE_DAYS`.

The authenticated terminal runs inside the read-only Files server container, not on the Docker host, but it can modify `/fs-root`. Disable it with `FILES_TERMINAL_ENABLED=false` when command execution is unnecessary. Rotate the administrator password by replacing `secrets/admin_password`; new login attempts read the new value without a restart.

## Data and backups

Provenance is stored in PostgreSQL on private networks. Back it up with:

```sh
docker compose exec -T provenance-db pg_dump -U rfb_provenance -d rfb_provenance > provenance.sql
```

Restore into an empty database with:

```sh
docker compose exec -T provenance-db psql -U rfb_provenance -d rfb_provenance < provenance.sql
```

Video Studio projects live in the `vfx-editor-prod-data` volume (the legacy volume name is retained for upgrade compatibility). Back that volume up before host migration or destructive maintenance.

## Automation and API docs

Swagger UI is available at `/api/docs/` and the OpenAPI document at `/api/openapi.json`. To enable bearer-token provenance automation, create `secrets/provenance_api_token` and include the overlay:

```sh
openssl rand -base64 32 > secrets/provenance_api_token
docker compose -f compose.yaml -f compose.automation.yaml --profile prod config --quiet
docker compose -f compose.yaml -f compose.automation.yaml --profile prod up -d --build
```

The automation overlay does not publish an internal service or database port.

## Configuration templates

- `.env.example` is the generic template.
- `.env.linux.example` is a native Linux production starting point.
- `.env.wsl.example` is an HTTP development example for a Windows-mounted directory.

`RFB_*`, `VFX_EDITOR_*`, and `TRAEFIK_*` variable aliases remain accepted for existing deployments, but new configuration should use the `RWS_*`, `FILES_*`, `VIDEO_STUDIO_*`, and `INGRESS_*` names shown in the templates.

The Files server image builds FFmpeg 8.1.2 from verified source for previews. Video Studio uses pinned npm-distributed FFmpeg and FFprobe binaries. Licensing and source notices are kept with each application.
