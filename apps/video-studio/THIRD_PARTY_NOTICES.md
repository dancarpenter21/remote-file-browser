# Third-party notices

## FFmpeg and FFprobe

The pinned npm packages `ffmpeg-static` and `@derhuerst/ffprobe-static` provide FFmpeg and FFprobe binaries under GPL-3.0-or-later. Their package license, binary-specific license, build README, exact executable version, and source-build references are included in the installed packages and available from:

- https://github.com/eugeneware/ffmpeg-static
- https://ffmpeg.org/legal.html

The application invokes these executables as separate processes and verifies their capabilities on every startup.

## Stadium ambience

“large-crowd-medium-distance-stereo.wav” by Freesound user eguobyte, sound 360703, was dedicated to the public domain under CC0 1.0. The bundled file is a filtered, loop-prepared derivative of the original lossless recording. The source is a diffuse crowd of roughly one thousand people with almost no distinct dialogue, suitable for an auditorium or sports venue.

- Source: https://freesound.org/people/eguobyte/sounds/360703/
- Lossless mirror: https://commons.wikimedia.org/wiki/File:360703_eguobyte_large-crowd-medium-distance-stereo.wav
- CC0: https://creativecommons.org/publicdomain/zero/1.0/
- Exact checksums and transformation details: `assets/audio/stadium-crowd-loop.json`
