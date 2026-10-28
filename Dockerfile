# Mimi core on a server (VPS / home server / Railway). The user folder and settings live
# outside the image: mount them (see docker-compose.yml and docs/hosting.md).
# Node 26: its permission model also keeps the code sandbox (workflows/sandbox.ts) off the network.
FROM node:26-bookworm-slim AS deps
WORKDIR /app
# Build tools only for better-sqlite3 when no prebuilt binary fits the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/pc-agent/package.json packages/pc-agent/
COPY packages/core/package.json packages/core/
RUN npm ci --omit=dev

FROM node:26-bookworm-slim
ENV NODE_ENV=production \
    MIMI_HOST=0.0.0.0 \
    MIMI_PORT=8787 \
    MIMI_LOCAL_PC_TOOLS=0 \
    MIMI_USER=/app/user \
    MIMI_BACKUP_DIR=/app/backups
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json mimi.json ./
COPY packages ./packages
COPY scripts/docker-entrypoint.sh /usr/local/bin/mimi-entrypoint
RUN chmod 755 /usr/local/bin/mimi-entrypoint && mkdir -p /app/user /app/backups && chown -R node:node /app/user /app/backups
# Starts as root only to fix the ownership of mounted folders, then runs as "node"
# (scripts/docker-entrypoint.sh). Mount the folders with -v / compose volumes / a Railway
# volume; Railway does not use Dockerfile VOLUME lines, so there are none here.
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||process.env.MIMI_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["mimi-entrypoint"]
CMD ["node", "packages/core/src/server/main.ts"]
