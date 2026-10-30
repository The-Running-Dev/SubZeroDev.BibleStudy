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

FROM node:24-alpine
ARG BUILD_ID=dev
ENV NODE_ENV=production \
    BUILD_ID=${BUILD_ID} \
    HOST=0.0.0.0 \
    PORT=3000 \
    STATIC_DIR=/app/dist/client \
    MEDIA_DIR=/app/data/media
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY --from=build /app/dist/client ./dist/client
# Mount a volume here so recordings survive a new image.
RUN mkdir -p /app/data/media && chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "src/server/web/main.ts"]
