# Local secrets

This directory is intentionally ignored except for this file.

Create `admin_password` containing the administrator password. For HTTPS deployments, also create `tls.crt` and `tls.key`. Never commit those files.

The WSL HTTP development example does not use the TLS files, but the administrator password is still required.
