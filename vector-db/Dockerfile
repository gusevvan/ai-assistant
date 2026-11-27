FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    QDRANT_URL=http://qdrant:6333 \
    COLLECTION=knowledge \
    VECTOR_DIM=512 \
    SEED_DIR=/app/data

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY data ./data

USER node
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
