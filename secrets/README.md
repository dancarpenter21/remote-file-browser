# Local secrets

This directory is intentionally ignored except for this file.

Create `admin_password` containing the administrator password and `provenance_db_password` containing a separate random database password. Never commit those files.

Generate the database password with `openssl rand -base64 32 > secrets/provenance_db_password`. Optional automation clients use a different `provenance_api_token` secret.

Production HTTPS is normally terminated by the sibling Traefik ingress project.
The recovery-only `compose.direct.yaml` overlay reads its certificate and key
from the absolute paths configured by `RFB_TLS_CERT_PATH` and
`RFB_TLS_KEY_PATH`; point those variables at the same files used by Traefik
rather than copying private keys into this repository.
