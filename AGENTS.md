# Repository guidance

Keep the root `README.md` launch instructions synchronized with the repository.

Any change to Compose files, profiles, service names, published ports, application routes, required secrets, environment templates, workspace scripts, or runtime prerequisites must update the relevant setup, production, development, automation, and shutdown commands in `README.md` in the same change.

Before finishing such a change, validate every documented Compose configuration:

```sh
docker compose --profile prod config --quiet
docker compose --profile dev config --quiet
docker compose -f compose.yaml -f compose.automation.yaml --profile prod config --quiet
```

Do not document deleted overlays, sibling deployments, or direct service launch paths as the canonical deployment. The root Compose project is canonical.
