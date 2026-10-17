# Video Studio

Video Studio is the workspace video application. It imports a capability-scoped source from Files into app-owned project storage, provides frame-accurate slow-motion and source-frame-linked stadium-ambience automation, and publishes completed exports beside the source without overwriting existing files.

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

## Editing slow motion

The project editor places source playback above a full-width timeline. Choose a
highlight, mark a slow-motion range, then select that section on the timeline or
in the Section tab. Audio and Export settings have their own tabs. On smaller
screens, settings appear below the timeline.

Scroll the mouse wheel over the timeline to zoom around the frame under the
pointer: scroll up to zoom in and down to zoom out. Shift+wheel or horizontal
trackpad gestures scroll the zoomed timeline. The zoom slider remains available.

Playback speed accepts decimal multipliers from `0.01` to `1`, including values
such as `0.333` and `0.75`. A value of `0.3` means 30% speed; `0.01` means 1%
speed. Enter or leave the field to save, or press Escape to restore the saved
value. Invalid drafts do not change the timeline and must be corrected before
rendering. New sections start at `0.5×`; existing projects retain their speeds.
Ramps transition into and out of the chosen speed. Estimated output duration
includes those ramps and rounds to the nearest output frame.

**Source playback** shows the original timing through the editing proxy.
**Draft previews** apply the edited timing with repeated frames.
**Final exports** use the original source with motion interpolation. Very low
speeds substantially increase output duration and rendering time. Original audio
uses chained tempo filters to support the full speed range; crowd automation
remains linked to source frames.

The Export tab lets you choose an MP4 output filename. When saving beside a
source opened from Files, existing files are never replaced: a collision adds
`-2`, `-3`, and so on before `.mp4`, and the editor reports the actual saved name.
For imported projects, the chosen name is offered when downloading the export.
The filename is captured when export starts and stays fixed during that render.

For Files-linked projects, **Save beside source after export** is enabled by
default. **Save beside source** also publishes an already rendered export without
rendering again. Download remains available in either mode. The browser tab
remembers a project's Files handoff across refreshes and library navigation.
The rendered export remains in project storage if publishing fails.

Files-linked projects remember their source identifier. Saving reconnects through
the current Files login when the handoff is missing or expired, including after
a Video Studio restart. Older projects need to be opened once from the original
file to record that identifier. Save failures appear in the Export tab; a
successful save shows the path returned by Files, including any numeric suffix.

### Crowd volume accents

In the Sound tab, place the playhead on an impact and choose **Sharp pop**,
**Short burst**, or **Long cheer**. Set **Accent peak** before adding it. Each
preset adds a one-frame attack, holds the peak, then returns to the surrounding
crowd level. Volume points inside the accent are replaced; points outside it
are preserved. Durations use source timing and follow the video's speed changes
in draft previews and exports.

Double-click the crowd lane to add a volume point at a chosen time and level.
Drag points horizontally for timing and vertically for volume, or use their
frame and gain fields in Sound. Saved points apply to both previews and exports.
The presets shape the loaded crowd recording; use **Use custom ambience** to
load audio containing the shouts, shrieks, or cheers you want to emphasize.
