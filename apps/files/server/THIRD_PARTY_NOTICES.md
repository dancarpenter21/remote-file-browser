# Third-party notices

The backend container includes FFmpeg 8.1.2, built from the unmodified source archive at:

https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz

Archive SHA-256: `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`

FFmpeg is licensed primarily under LGPL-2.1-or-later. Enabling GPL components and libraries makes the bundled build GPL-licensed. The exact configure command is recorded by the Dockerfile and installed in `/usr/share/doc/remote-file-browser/ffmpeg-configure.txt`. `--enable-nonfree` is not used.

The source archive, FFmpeg license files, this notice, and build recipe are retained in the runtime image beneath `/usr/share/src` and `/usr/share/doc/remote-file-browser`. External codec libraries retain their distribution licenses and copyright files under `/usr/share/doc`.

This notice is informational and is not legal advice.
