<p align="center">
  <img src="docs/assets/logo.svg" alt="MVP Athena" width="120">
</p>

<p align="center">
  <a href="https://github.com/<owner>/<repo>/actions/workflows/release-clients.yml"><img alt="client release" src="https://img.shields.io/github/actions/workflow/status/<owner>/<repo>/release-clients.yml?branch=main&label=client%20release"></a>
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Node.js%2020-339933">
  <img alt="language" src="https://img.shields.io/badge/language-TypeScript-3178C6">
  <img alt="database" src="https://img.shields.io/badge/database-PostgreSQL%20%2B%20pgvector-4169E1">
  <img alt="transport" src="https://img.shields.io/badge/MCP-stdio-111827">
  <img alt="license" src="https://img.shields.io/badge/license-TBD-lightgrey">
</p>

# MVP Athena

MVP Athena is an agent-first team knowledge system backed by a single GitHub Markdown repository. It gives humans, CLI tools, Codex/MCP agents, and Discord users one permissioned interface for reading and changing team knowledge.

GitHub stores the canonical Markdown files and commit history. PostgreSQL stores users, spaces, memberships, API tokens, and audit logs. Every CLI or agent write is attributed to the GitHub user who logged in.

## Highlights

- GitHub Markdown repository as the source of truth.
- Fastify HTTP API with a shared `KnowledgeService` core.
- GitHub OAuth device login for CLI and MCP users.
- Per-user Athena API tokens stored as SHA-256 hashes.
- Commit authors derived from each user's GitHub profile.
- CLI commands for spaces, search, read, create, update, upload, move, history, and summary.
- MCP stdio server for Codex and other agent clients.
- Optional Discord bot slash commands.
- One-command server deployment with Docker Compose.
- Binary client installer that does not require Node, npm, or pnpm on user machines.

## Architecture

```text
Users and agents
  CLI: mvp-athena
  MCP: mvp-athena-mcp
  Discord bot
        |
        | Bearer token
        v
Server
  apps/api  Fastify API
        |
        v
  packages/core  KnowledgeService
        |
        +--> PostgreSQL: users, spaces, memberships, api_tokens, audit_logs
        +--> GitHub repo: spaces/<space>/docs/*.md, assets, history
        +--> Redis: reserved for indexing/background jobs
```

Entry points must go through `KnowledgeService`; permissions, paths, Markdown parsing, audit logs, and commit authorship are enforced there.

## Server Deployment

Deploy the required server-side services:

```sh
cp .env.server.example .env
$EDITOR .env
docker compose up -d --build
```

Equivalent wrapper:

```sh
pnpm deploy:server
```

This starts:

- `api`: Athena HTTP API on `ATHENA_API_PORT`, default `3000`
- `postgres`: PostgreSQL 16 with pgvector
- `redis`: Redis 7, reserved for indexing/background jobs

Required `.env` values:

```sh
DATABASE_URL=postgres://athena:<password>@postgres:5432/athena

GITHUB_OWNER=<github-owner-or-org>
GITHUB_REPO=<markdown-knowledge-repo>
GITHUB_BRANCH=main
GITHUB_TOKEN=<token-with-repo-contents-read-write-access>

GITHUB_OAUTH_CLIENT_ID=<github-oauth-app-client-id>
GITHUB_OAUTH_CLIENT_SECRET=<github-oauth-app-client-secret>
```

Optional first-login access grant:

```sh
ATHENA_SIGNUP_SPACE_ID=team
ATHENA_SIGNUP_ROLE=editor
```

Optional legacy/bootstrap shared token:

```sh
ATHENA_TOKEN=<shared-bootstrap-token>
ATHENA_DEFAULT_USER_ID=dev-user
```

Normal users should use GitHub OAuth login instead of sharing `ATHENA_TOKEN`.

Check the deployment:

```sh
docker compose ps
curl http://127.0.0.1:3000/healthz
```

Common operations:

```sh
docker compose logs -f api
docker compose up -d --build
docker compose down
```

Enable the optional Discord bot:

```sh
docker compose --profile discord up -d --build
```

Set `DISCORD_TOKEN` and `DISCORD_APPLICATION_ID` before enabling the Discord profile.

## Client Installation

Install prebuilt CLI and MCP binaries. This does not require Node, npm, or pnpm on the user machine:

```sh
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/scripts/install-binary.sh \
  | ATHENA_REPO=<owner>/<repo> sh
```

Install a specific release:

```sh
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/scripts/install-binary.sh \
  | ATHENA_REPO=<owner>/<repo> ATHENA_VERSION=v0.1.0 sh
```

The installer writes:

```text
~/.local/bin/mvp-athena
~/.local/bin/athena
~/.local/bin/mvp-athena-mcp
~/.local/bin/athena-mcp
```

Make sure `~/.local/bin` is on `PATH`.

Fallback source install:

```sh
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/scripts/install-clients.sh \
  | ATHENA_REPO_URL=https://github.com/<owner>/<repo>.git sh
```

## User Login

Log in with GitHub OAuth device flow:

```sh
mvp-athena login --api-url https://athena.example.com
```

The CLI prints a GitHub verification URL and code, then stores the issued Athena token in:

```text
~/.config/mvp-athena/config.json
```

Check status:

```sh
mvp-athena login --status
```

The server stores only a hash of the Athena token. Each request resolves to a concrete user, and commits use that user's GitHub identity:

```text
author.name  = user.displayName or user.githubLogin
author.email = user.githubEmail
```

## CLI Usage

```sh
mvp-athena spaces
mvp-athena search starter
mvp-athena read team welcome.md
mvp-athena read team welcome.md --raw
mvp-athena create team runbook.md --title Runbook --body "Restart carefully."
mvp-athena update team runbook.md --body "Updated procedure."
mvp-athena upload team diagrams/flow.png ./flow.png
mvp-athena move team runbook.md ops/runbook.md
mvp-athena history team ops/runbook.md
mvp-athena summary team
```

`read` defaults to the Markdown body. Use `--raw` to include frontmatter.

## Codex MCP

The MCP server uses stdio transport. Codex should start it locally and point it at the deployed API. After `mvp-athena login`, the MCP server can read the same local config token.

Add it to Codex:

```sh
codex mcp add mvp-athena -- mvp-athena-mcp
```

Equivalent `config.toml`:

```toml
[mcp_servers.mvp-athena]
command = "mvp-athena-mcp"
```

Explicit environment configuration is also supported:

```sh
codex mcp add mvp-athena \
  --env ATHENA_API_URL=https://athena.example.com \
  --env ATHENA_TOKEN=<user-token> \
  -- mvp-athena-mcp
```

## API

Authentication:

- `POST /auth/github/device`
- `POST /auth/github/device/poll`
- `GET /auth/me`

Knowledge:

- `GET /spaces`
- `GET /spaces/:spaceId/docs`
- `GET /spaces/:spaceId/docs/*`
- `POST /spaces/:spaceId/docs`
- `PATCH /spaces/:spaceId/docs/*`
- `DELETE /spaces/:spaceId/docs/*`
- `POST /spaces/:spaceId/assets`
- `POST /spaces/:spaceId/move-doc/*`
- `GET /spaces/:spaceId/history/*`
- `GET /spaces/:spaceId/search`
- `GET /spaces/:spaceId/summary`
- `POST /spaces/:spaceId/propose-edit/*`
- `GET /spaces/:spaceId/audit`
- `POST /github/webhook`

## Repository Layout

```text
apps/
  api/          Fastify API
  cli/          mvp-athena command
  mcp-server/   stdio MCP server for agents
  discord-bot/  optional Discord slash commands
packages/
  core/         KnowledgeService, permissions, Markdown, providers, stores
docs/
  schema.sql    PostgreSQL schema
  seed.sql      local seed data
scripts/
  install-binary.sh
  install-clients.sh
  build-binaries.mjs
```

GitHub knowledge repository layout:

```text
spaces/
  <space_id>/
    docs/
      example.md
    assets/
      image.png
```

Markdown documents use frontmatter:

```yaml
---
title: Example
owners:
  - alice
tags:
  - onboarding
visibility: internal
created_at: 2026-06-05T00:00:00.000Z
updated_at: 2026-06-05T00:00:00.000Z
---
```

## Local Development

```sh
pnpm install
pnpm build
pnpm test
ATHENA_STORAGE_MODE=memory pnpm dev:api
```

In another shell:

```sh
node apps/cli/dist/index.js spaces
node apps/cli/dist/index.js read team welcome.md
node apps/cli/dist/index.js search starter
```

Run with production-style storage locally:

```sh
docker compose up -d postgres redis
psql "$DATABASE_URL" -f docs/schema.sql
psql "$DATABASE_URL" -f docs/seed.sql
ATHENA_STORAGE_MODE=postgres pnpm start:api
```

## Client Releases

Build local binaries:

```sh
pnpm build:binaries
```

Publishing a `v*` tag runs `.github/workflows/release-clients.yml`, which builds release tarballs for:

- `linux-x64`
- `darwin-x64`
- `darwin-arm64`

```sh
git tag v0.1.0
git push origin v0.1.0
```

## Current Limits

- GitHub App installation token exchange is not automated yet; configure `GITHUB_TOKEN` or `GITHUB_INSTALLATION_TOKEN`.
- GitHub webhook signatures are accepted but not yet verified or queued.
- Redis/BullMQ indexing jobs are reserved but not implemented.
- Search currently scans GitHub Markdown instead of using `documents` plus pgvector.
- Binary asset upload uses GitHub Contents API; a Git LFS worker is still needed for large assets.
