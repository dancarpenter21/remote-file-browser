FROM node:24-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci && chown -R node:node /app

FROM dependencies AS development

COPY --chown=node:node . .
ENV NODE_ENV=development \
    VFX_EDITOR_HOST=0.0.0.0 \
    VFX_EDITOR_PORT=4317 \
    VFX_EDITOR_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 5173 4317
CMD ["npm", "run", "dev"]

FROM dependencies AS build

COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS production-dependencies

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS production

WORKDIR /app
ENV NODE_ENV=production \
    VFX_EDITOR_HOST=0.0.0.0 \
    VFX_EDITOR_PORT=4317 \
    VFX_EDITOR_DATA_DIR=/data
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/src apps/server/src
COPY packages/shared/src packages/shared/src
COPY assets assets
COPY --from=build /app/dist dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4317
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4317/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["npm", "start"]
