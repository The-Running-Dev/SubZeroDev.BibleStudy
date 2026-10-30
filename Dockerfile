# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.client.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS runtime
# pg_dump and pg_restore for the backup service, matching the stack's PostgreSQL 17.
RUN apk add --no-cache postgresql17-client
ARG BUILD_ID=dev
ENV NODE_ENV=production \
    BUILD_ID=${BUILD_ID} \
    HOST=0.0.0.0 \
    PORT=3000 \
    STATIC_DIR=/app/dist/client \
    MEDIA_DIR=/app/data/media \
    BACKUP_DIR=/app/data/backups
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY --from=build /app/dist/client ./dist/client
# Mount volumes here so recordings and backups survive a new image.
RUN mkdir -p /app/data/media /app/data/backups && chown -R node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/__build-id').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/server/web/main.ts"]
