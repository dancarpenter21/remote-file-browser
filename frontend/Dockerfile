# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM nginx:1.29-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY THIRD_PARTY_NOTICES.md /usr/share/doc/remote-file-browser/frontend-third-party-notices.md
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY nginx/15-tls-mode.sh /docker-entrypoint.d/15-tls-mode.envsh
RUN chmod 0755 /docker-entrypoint.d/15-tls-mode.envsh && \
    mkdir -p /var/cache/nginx /var/run && chown -R nginx:nginx /var/cache/nginx /var/run
EXPOSE 8080 8443
