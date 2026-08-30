# Traefik Ingress

Shared HTTPS ingress for private Docker applications. Traefik is the only
container that publishes ports 80 and 443. Applications opt in with Docker
labels and join the external `traefik-ingress` network.

## Initial setup

The certificate must cover every private hostname routed through this ingress,
and its issuer must already be trusted by client devices.

```sh
cp .env.example .env
# Edit the bind address and absolute certificate paths.
docker network inspect traefik-ingress >/dev/null 2>&1 || \
  docker network create traefik-ingress
docker compose config --quiet
docker compose up -d
```

The Docker socket is available only to a read-only API proxy on an internal
network. Traefik cannot issue Docker API writes, but its metadata access is still
host-sensitive and this network must never be joined by another service. The
Traefik dashboard is disabled, and containers are ignored unless they explicitly
set `traefik.enable=true`.

## Application contract

Only an application's public HTTP container should join `traefik-ingress`.
Give router and service objects globally unique, project-prefixed names and set:

```yaml
labels:
  traefik.enable: "true"
  traefik.docker.network: traefik-ingress
  traefik.http.routers.example.rule: Host(`${EXAMPLE_HOSTNAME}`)
  traefik.http.routers.example.entrypoints: websecure
  traefik.http.routers.example.tls: "true"
  traefik.http.routers.example.service: example
  traefik.http.services.example.loadbalancer.server.port: "8080"
networks:
  - default
  - traefik-ingress
```

Do not publish an application host port or put credentials in labels. Avoid the
Traefik buffering middleware for streaming uploads and responses.

## Certificate replacement

Replace the certificate and key atomically at their configured host paths, then
restart Traefik so the file-provider certificate is reloaded:

```sh
docker compose restart traefik
```

## Operations

```sh
docker compose ps
docker compose logs -f traefik
docker compose config --quiet
```

Stopping this project makes every ingress-backed application unavailable but
does not stop the application containers themselves. Do not remove the shared
network while applications are attached to it.
