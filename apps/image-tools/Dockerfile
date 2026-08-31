# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS builder
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/image-tools/package.json apps/image-tools/package.json
RUN npm ci --workspace @remote-workspace/image-tools
COPY apps/image-tools apps/image-tools
RUN npm run build --workspace @remote-workspace/image-tools

FROM nginx:1.29-alpine
COPY --from=builder /repo/apps/image-tools/dist /usr/share/nginx/html
COPY apps/image-tools/nginx/default.conf /etc/nginx/conf.d/default.conf
RUN mkdir -p /var/cache/nginx /var/run && chown -R nginx:nginx /var/cache/nginx /var/run
EXPOSE 8080
