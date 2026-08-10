# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

FROM nginx:1.29-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY nginx/15-tls-mode.sh /docker-entrypoint.d/15-tls-mode.sh
RUN chmod 0755 /docker-entrypoint.d/15-tls-mode.sh && \
    mkdir -p /var/cache/nginx /var/run && chown -R nginx:nginx /var/cache/nginx /var/run
EXPOSE 8080 8443
