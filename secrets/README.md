# Local secrets

This directory is intentionally ignored except for this file.

Create `admin_password` containing at least 12 characters. For HTTPS deployments, also create `tls.crt` and `tls.key`. The optional provenance submission API uses `provenance_api_token` containing at least 32 characters; see the root README for the Compose override. Never commit those files.

The WSL HTTP development example does not use the TLS files, but the administrator password is still required.
