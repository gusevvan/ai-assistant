# syntax=docker/dockerfile:1
#
# Образ главного приложения (web). Собирается из КОРНЯ репозитория:
#
#   docker build -t ai-assistant .
#
# Тот же образ использует сервис `web` в compose.yaml.
# Три стадии: deps (все зависимости) -> build (компиляция TS) -> runtime
# (только prod-зависимости и готовый dist, без исходников и dev-пакетов).

# --- 1. Зависимости --------------------------------------------------------
# package*.json копируются ДО исходников: пока код меняется, а зависимости нет,
# слой с npm ci берётся из кэша и сборка занимает секунды.
FROM node:26-bookworm-slim AS deps
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci

# --- 2. Сборка -------------------------------------------------------------
FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY web/package.json web/tsconfig.json ./
COPY web/src ./src
RUN npm run build

# --- 3. Runtime ------------------------------------------------------------
FROM node:26-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    WORKSPACE_DIR=/workspace \
    OPENCODE_DB_PATH=/data/opencode.db

# curl нужен для HEALTHCHECK; bash/git/ripgrep использует встроенный OpenCode.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      ripgrep \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci --omit=dev \
 && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY web/public ./public

# Не root: процесс и его файлы принадлежат отдельному пользователю.
RUN groupadd --gid 10001 app \
 && useradd --uid 10001 --gid 10001 --create-home app \
 && mkdir -p /workspace /data \
 && chown app:app /workspace /data

USER app
EXPOSE 8080

# /health — readiness: 200 только когда OpenCode, база и модель готовы.
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=12 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

CMD ["node", "dist/server.js"]
