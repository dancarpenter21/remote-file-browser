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
