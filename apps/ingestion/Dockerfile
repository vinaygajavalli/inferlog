# Built from the repo root context (see docker-compose).
FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json ./
COPY apps/ingestion ./apps/ingestion
RUN pnpm install --filter @inferlog/ingestion... --no-frozen-lockfile
RUN pnpm --filter @inferlog/ingestion build

FROM node:20-slim AS run
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/ingestion
EXPOSE 4000
CMD ["node", "dist/server.js"]
