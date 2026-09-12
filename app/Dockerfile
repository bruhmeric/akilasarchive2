# akilas archive — app image (lightweight: no build step, ~120MB RAM)
# NOTE: build context is the REPO ROOT (see docker-compose.yml), so COPY
# paths are relative to the repo root, not this file's directory.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY app/package.json app/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
RUN npm cache clean --force

COPY app/src ./src
COPY app/public ./public
COPY scripts ./scripts

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--max-old-space-size=192", "src/server.js"]
