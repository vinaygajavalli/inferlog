FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable
# copy workspace manifest + the packages web needs (sdk) + web itself
COPY pnpm-workspace.yaml package.json ./
COPY packages/inference-logger ./packages/inference-logger
COPY apps/web ./apps/web
RUN pnpm install --filter @inferlog/web... --no-frozen-lockfile
RUN pnpm --filter @inferlog/logger build
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @inferlog/web build

FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Next standalone output mirrors the monorepo layout under .next/standalone
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
