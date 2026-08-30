# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS builder
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/text-editor/package.json apps/text-editor/package.json
RUN npm ci --workspace @remote-workspace/text-editor
COPY apps/text-editor apps/text-editor
RUN npm run build --workspace @remote-workspace/text-editor

FROM nginx:1.29-alpine
COPY --from=builder /repo/apps/text-editor/dist /usr/share/nginx/html
COPY apps/text-editor/nginx/default.conf /etc/nginx/conf.d/default.conf
RUN mkdir -p /var/cache/nginx /var/run && chown -R nginx:nginx /var/cache/nginx /var/run
EXPOSE 8080
