# Local secrets

This directory is intentionally ignored except for this file. Never commit generated secret files.

```sh
openssl rand -base64 24 > secrets/admin_password
openssl rand -base64 32 > secrets/provenance_db_password
```

Bearer-token automation additionally uses `secrets/provenance_api_token`. TLS certificate and key files stay at the absolute host paths configured by `INGRESS_TLS_CERT_PATH` and `INGRESS_TLS_KEY_PATH`; do not copy private keys into this repository.
