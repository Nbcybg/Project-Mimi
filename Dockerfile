# Mimi core on a server (VPS / home server). The user folder and settings live outside
# the image: mount them (see docker-compose.yml and docs/hosting.md).
FROM node:24-bookworm-slim AS deps
WORKDIR /app
# Build tools only for better-sqlite3 when no prebuilt binary fits the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/pc-agent/package.json packages/pc-agent/
COPY packages/core/package.json packages/core/
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    MIMI_HOST=0.0.0.0 \
    MIMI_PORT=8787 \
    MIMI_LOCAL_PC_TOOLS=0
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json mimi.json ./
COPY packages ./packages
RUN mkdir -p /app/user /app/backups && chown -R node:node /app
USER node
EXPOSE 8787
VOLUME ["/app/user", "/app/backups"]
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.MIMI_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "packages/core/src/server/main.ts"]
