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

FROM build AS prod-deps
RUN pnpm deploy --filter @mvp-athena/api --prod /prod/api \
  && pnpm deploy --filter @mvp-athena/discord-bot --prod /prod/discord-bot

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 athena \
  && useradd --system --uid 10001 --gid athena --home-dir /app --shell /usr/sbin/nologin athena

FROM runtime AS api
COPY --from=prod-deps --chown=athena:athena /prod/api /app
USER athena
EXPOSE 3000
CMD ["node", "dist/index.js"]

FROM runtime AS discord-bot
COPY --from=prod-deps --chown=athena:athena /prod/discord-bot /app
USER athena
CMD ["node", "dist/index.js"]
