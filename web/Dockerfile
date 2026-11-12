# syntax=docker/dockerfile:1

FROM node:26-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    WORKSPACE_DIR=/workspace \
    OPENCODE_DB_PATH=/data/opencode.db

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      ripgrep \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY public ./public

RUN groupadd --gid 10001 app \
 && useradd --uid 10001 --gid 10001 --create-home app \
 && mkdir -p /workspace /data \
 && chown app:app /workspace /data

USER app
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=12 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

CMD ["node", "dist/server.js"]
