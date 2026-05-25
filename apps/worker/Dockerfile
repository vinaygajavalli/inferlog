FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json ./
COPY apps/worker ./apps/worker
RUN pnpm install --filter @inferlog/worker... --no-frozen-lockfile
RUN pnpm --filter @inferlog/worker build

FROM node:20-slim AS run
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
