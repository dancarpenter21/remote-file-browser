# syntax=docker/dockerfile:1.7
FROM debian:trixie-slim AS ffmpeg-builder
ARG FFMPEG_VERSION=8.1.2
ARG FFMPEG_SHA256=464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl nasm pkg-config xz-utils \
    libaom-dev libass-dev libdav1d-dev libfreetype-dev libfribidi-dev \
    libmp3lame-dev libopenjp2-7-dev libopus-dev libvorbis-dev libvpx-dev \
    libwebp-dev libx264-dev libx265-dev libzimg-dev && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl --fail --location --retry 5 -o ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" && \
    echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - && \
    tar -xf ffmpeg.tar.xz && cp ffmpeg.tar.xz "/tmp/ffmpeg-${FFMPEG_VERSION}.tar.xz"
WORKDIR /build/ffmpeg-${FFMPEG_VERSION}
RUN CONFIGURE_FLAGS="--prefix=/opt/ffmpeg --disable-debug --disable-doc --enable-gpl --enable-version3 --enable-shared --disable-static --enable-libaom --enable-libass --enable-libdav1d --enable-libfreetype --enable-libfribidi --enable-libmp3lame --enable-libopenjpeg --enable-libopus --enable-libvorbis --enable-libvpx --enable-libwebp --enable-libx264 --enable-libx265 --enable-libzimg" && \
    printf '%s\n' "$CONFIGURE_FLAGS" > /tmp/ffmpeg-configure.txt && \
    ./configure $CONFIGURE_FLAGS && make -j"$(nproc)" && make install

FROM rust:1.97-trixie AS rust-builder
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release --locked || cargo build --release

FROM debian:trixie-slim AS runtime
ARG FFMPEG_VERSION=8.1.2
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libaom-dev libass-dev libdav1d-dev libfreetype-dev \
    libfribidi-dev libmp3lame-dev libopenjp2-7-dev libopus-dev libvorbis-dev \
    libvpx-dev libwebp-dev libx264-dev libx265-dev libzimg-dev && \
    rm -rf /var/lib/apt/lists/* && mkdir -p /usr/share/doc/remote-file-browser /usr/share/src
COPY --from=ffmpeg-builder /opt/ffmpeg /opt/ffmpeg
COPY --from=ffmpeg-builder /tmp/ffmpeg-configure.txt /usr/share/doc/remote-file-browser/ffmpeg-configure.txt
COPY --from=ffmpeg-builder /tmp/ffmpeg-${FFMPEG_VERSION}.tar.xz /usr/share/src/
COPY THIRD_PARTY_NOTICES.md /usr/share/doc/remote-file-browser/
COPY --from=rust-builder /src/target/release/remote-file-browser /usr/local/bin/remote-file-browser
RUN printf '#!/bin/sh\ncurl -fsS http://127.0.0.1:8080/healthz >/dev/null\n' > /usr/local/bin/rfb-healthcheck && chmod 0755 /usr/local/bin/rfb-healthcheck
ENV PATH="/opt/ffmpeg/bin:${PATH}" LD_LIBRARY_PATH="/opt/ffmpeg/lib"
WORKDIR /fs-root
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/remote-file-browser"]
