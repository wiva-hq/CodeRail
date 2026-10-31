# Copyright 2026 Wiva, Inc.
# SPDX-License-Identifier: Apache-2.0
# The CodeRail server in one container: the web app, the API and every computer's hub. Plain HTTP on 8080; put
# HTTPS in front (see compose.yaml). Everything it keeps is in /data.

# ---- Build: the web app, and the server bundled into one file --------------------------------------------
# (On the builder's own platform: what it makes is the same for every one, so a multi-platform image needs no emulation.)
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4 AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY protocol/package.json protocol/
COPY server/package.json server/
COPY web/package.json web/
COPY bridge/package.json bridge/
RUN bun install --frozen-lockfile --network-concurrency 16 --filter '@coderail/server' --filter '@coderail/web' --filter '@coderail/protocol'
COPY tsconfig.base.json ./
COPY protocol protocol
COPY server server
COPY web web
RUN cd web && bun run build
RUN bun build server/src/main.ts --target=bun --minify --outfile /out/server.js

# ---- Run ---------------------------------------------------------------------------------------------------
FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY --from=build /out/server.js /app/server.js
COPY --from=build /src/web/dist /app/web
ENV PORT=8080 DATA_DIR=/data WEB_DIR=/app/web NODE_ENV=production
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/me').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "/app/server.js"]
