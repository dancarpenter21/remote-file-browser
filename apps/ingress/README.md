# Ingress component

The root `compose.yaml` owns the Remote Workspace Traefik ingress and restricted Docker socket proxy. This directory contains only the file-provider TLS configuration mounted by that stack.

Configure `INGRESS_BIND_ADDRESS`, `INGRESS_TLS_CERT_PATH`, and `INGRESS_TLS_KEY_PATH` in the root `.env`, then operate ingress with the complete production stack:

```sh
docker compose --profile prod config --quiet
docker compose --profile prod up -d --build
docker compose --profile prod logs -f ingress
```

The certificate must cover `RWS_HOSTNAME` and be trusted by clients. Traefik is the only service that publishes ports 80 and 443. Its Docker API network is internal and must not be joined by application containers.
