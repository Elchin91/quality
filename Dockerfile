FROM node:24.20.0-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server --omit=dev --engine-strict --no-audit --no-fund \
    && node -e "const Database = require('./server/node_modules/better-sqlite3'); new Database(':memory:').close()"
COPY server/native/ ./server/native/
COPY server/scripts/build-private-storage-native.mjs ./server/scripts/
RUN npm run build:native --prefix server \
    && chmod 755 server/native/build server/native/build/private_storage_posix.node

FROM node:24.20.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/var/lib/agentscore-storage/data CHAT_SOURCE_BACKEND=mysql
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 700 -o node -g node /var/lib/agentscore-storage/data
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/native/build ./server/native/build
COPY server/package.json ./server/
COPY server/dist/ ./server/dist/
COPY dist/ ./dist/
COPY scripts/backup_data.py ./scripts/
RUN chmod -R a+rX /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r => { if (!r.ok) process.exit(1); return r.json(); }).then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"
CMD ["node", "server/dist/index.js"]
