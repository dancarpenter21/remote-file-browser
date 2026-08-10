# Local secrets

This directory is intentionally ignored except for this file.

Create `admin_password` containing at least 12 characters. For HTTPS deployments, also create `tls.crt` and `tls.key`. Never commit those files.

The WSL HTTP development example does not use the TLS files, but the administrator password is still required.
