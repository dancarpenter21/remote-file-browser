# syntax=docker/dockerfile:1.7
FROM rust:1.97-bookworm AS builder
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY migrations ./migrations
COPY src ./src
RUN cargo build --release --locked || cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* && useradd --system --uid 10001 --home /nonexistent provenance
COPY --from=builder /src/target/release/rfb-provenance-api /usr/local/bin/rfb-provenance-api
USER provenance
EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/rfb-provenance-api"]

