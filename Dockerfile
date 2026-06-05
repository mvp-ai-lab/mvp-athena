# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/discord-bot/package.json apps/discord-bot/package.json
COPY apps/mcp-server/package.json apps/mcp-server/package.json
COPY packages/core/package.json packages/core/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app

FROM runtime AS api
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]

FROM runtime AS discord-bot
CMD ["node", "apps/discord-bot/dist/index.js"]
