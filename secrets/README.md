# Local secrets

This directory is intentionally ignored except for this file.

Create `admin_password` containing the administrator password and `provenance_db_password` containing a separate random database password. For HTTPS deployments, also create `tls.crt` and `tls.key`. Never commit those files.

Generate the database password with `openssl rand -base64 32 > secrets/provenance_db_password`. Optional automation clients use a different `provenance_api_token` secret.

The WSL HTTP development example does not use the TLS files, but the administrator password is still required.
