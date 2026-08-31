# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/files/web/package.json apps/files/web/package.json
RUN npm ci --workspace @remote-workspace/files-web
COPY apps/files/web apps/files/web
RUN npm run build --workspace @remote-workspace/files-web

FROM nginx:1.29-alpine
COPY --from=builder /app/apps/files/web/dist /usr/share/nginx/html
COPY apps/files/web/THIRD_PARTY_NOTICES.md /usr/share/doc/remote-workspace/files-web-third-party-notices.md
COPY apps/files/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY apps/files/web/nginx/15-tls-mode.sh /docker-entrypoint.d/15-tls-mode.envsh
RUN chmod 0755 /docker-entrypoint.d/15-tls-mode.envsh && \
    mkdir -p /var/cache/nginx /var/run && chown -R nginx:nginx /var/cache/nginx /var/run
EXPOSE 8080
