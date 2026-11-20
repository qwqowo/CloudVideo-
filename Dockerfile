# Stage 1: Build Frontend (React + Vite)
FROM node:22-bookworm-slim AS web-builder
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: Build Backend (TypeScript -> ESM)
FROM node:22-bookworm-slim AS server-builder
WORKDIR /build/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# Stage 3: Production Runtime (Node 22 + FFmpeg)
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV DOWNLOAD_DIR=/downloads
ENV DATA_DIR=/app/data
ENV WEB_DIST_DIR=/app/public

COPY server/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=server-builder /build/server/dist ./dist
COPY --from=web-builder /build/web/dist ./public

RUN mkdir -p /app/data /downloads

EXPOSE 3000

CMD ["node", "dist/index.js"]
