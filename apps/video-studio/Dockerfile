FROM node:24-bookworm-slim AS dependencies

WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/video-studio/server/package.json apps/video-studio/server/package.json
COPY apps/video-studio/web/package.json apps/video-studio/web/package.json
COPY apps/video-studio/shared/package.json apps/video-studio/shared/package.json
RUN npm ci && chown -R node:node /repo

FROM dependencies AS development

COPY --chown=node:node apps/video-studio apps/video-studio
ENV NODE_ENV=development \
    VIDEO_STUDIO_HOST=0.0.0.0 \
    VIDEO_STUDIO_PORT=4317 \
    VIDEO_STUDIO_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 5173 4317
CMD ["npm", "run", "dev:video"]

FROM dependencies AS build

COPY apps/video-studio apps/video-studio
RUN npm run build --workspace @remote-workspace/video-web && npm run typecheck

FROM node:24-bookworm-slim AS production-dependencies

WORKDIR /repo
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/video-studio/server/package.json apps/video-studio/server/package.json
COPY apps/video-studio/web/package.json apps/video-studio/web/package.json
COPY apps/video-studio/shared/package.json apps/video-studio/shared/package.json
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS production

WORKDIR /repo
ENV NODE_ENV=production \
    VIDEO_STUDIO_HOST=0.0.0.0 \
    VIDEO_STUDIO_PORT=4317 \
    VIDEO_STUDIO_DATA_DIR=/data
COPY --from=production-dependencies /repo/node_modules ./node_modules
COPY package.json ./
COPY apps/video-studio/server/package.json apps/video-studio/server/package.json
COPY apps/video-studio/web/package.json apps/video-studio/web/package.json
COPY apps/video-studio/shared/package.json apps/video-studio/shared/package.json
COPY apps/video-studio/server/src apps/video-studio/server/src
COPY apps/video-studio/shared/src apps/video-studio/shared/src
COPY apps/video-studio/assets apps/video-studio/assets
COPY --from=build /repo/apps/video-studio/dist apps/video-studio/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4317
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4317/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["npm", "run", "start", "--workspace", "@remote-workspace/video-server"]
