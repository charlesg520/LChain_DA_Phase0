# HQ console: builds the UI, then runs the small Node server that serves it and
# bridges the browser to HQ (the HQ API token stays in this container).
FROM node:22-alpine AS build
WORKDIR /web
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY ui/package.json ui/
RUN pnpm install --frozen-lockfile
COPY server server
COPY ui ui
RUN pnpm -r typecheck && pnpm --filter ui build \
 && pnpm --filter server deploy --prod --legacy /out/server

FROM node:22-alpine
ENV NODE_ENV=production HQ_WEB_MODE=live PORT=3000 HOST=0.0.0.0 UI_DIST=/app/ui WEB_DATA_DIR=/data/web
WORKDIR /app/server
COPY --from=build /out/server ./
COPY --from=build /web/ui/dist /app/ui
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "src/index.js"]
