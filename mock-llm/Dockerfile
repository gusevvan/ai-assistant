FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=19000 \
    HOST=0.0.0.0

WORKDIR /app
COPY package.json ./
COPY src ./src

USER node
EXPOSE 19000

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:19000/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
