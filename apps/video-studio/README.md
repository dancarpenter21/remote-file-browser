# Video Studio

Video Studio is the workspace video application. It imports a capability-scoped source from Files into app-owned project storage, provides frame-accurate slow-motion and stadium-ambience editing, and publishes completed exports beside the source without overwriting existing files.

Delegated playback uses Files' persistent HLS cache, so opening the same source in Files and Video Studio reuses one browser-compatible conversion. The editor's 720p project proxy remains app-owned and separate because it serves timeline editing rather than ordinary playback.

It is deployed by the repository's root `compose.yaml`, not as a separate stack. Production is authenticated and routed at `/apps/video/`; development is proxied through Files at `http://localhost:5173/apps/video/`. The server has no production host port.

Requirements for host-side work are Linux x64, Node.js 24+, and enough space for the imported source, 720p proxy, previews, and exports. FFmpeg and FFprobe are pinned npm dependencies and startup verifies the required filters and encoder.

From the repository root:

```sh
npm ci
npm run dev:video
npm run test -w @remote-workspace/video-server
npm run test -w @remote-workspace/video-web
npm run test -w @remote-workspace/video-shared
npm run typecheck
```

Production projects persist in the `vfx-editor-prod-data` Docker volume; the legacy name is retained so existing installations upgrade without losing projects. Removing a project in the UI removes only its app-owned directory. Avoid `docker compose down --volumes` unless project deletion is intended.

`VIDEO_STUDIO_ALLOWED_ORIGINS` accepts exact comma-separated origins and defaults in Compose to `https://RWS_HOSTNAME`. The old `VFX_EDITOR_ALLOWED_ORIGINS` name remains a compatibility alias.
