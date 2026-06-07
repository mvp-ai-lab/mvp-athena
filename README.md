<p align="center">
  <img src="docs/assets/logo.svg" alt="MVP Athena" width="120">
</p>

<p align="center">
  <a href="https://github.com/mvp-ai-lab/mvp-athena/actions/workflows/release-clients.yml"><img alt="client release" src="https://img.shields.io/github/actions/workflow/status/mvp-ai-lab/mvp-athena/release-clients.yml?branch=main&label=client%20release"></a>
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Node.js%2020-339933">
  <img alt="language" src="https://img.shields.io/badge/language-TypeScript-3178C6">
  <img alt="database" src="https://img.shields.io/badge/database-PostgreSQL%20%2B%20pgvector-4169E1">
  <img alt="transport" src="https://img.shields.io/badge/MCP-stdio-111827">
</p>

# MVP Athena

MVP Athena is an agent-first team knowledge system backed by a single GitHub Markdown repository. It gives humans, CLI tools, Codex/MCP agents, and Discord users one permissioned interface for reading and changing team knowledge.

GitHub stores the canonical Markdown files and commit history. PostgreSQL stores users, spaces, memberships, API tokens, and audit logs. Every CLI or agent write is attributed to the GitHub user who logged in.

## Highlights

- GitHub Markdown repository as the source of truth.
- Fastify HTTP API with a shared `KnowledgeService` core.
- GitHub App device login for CLI and MCP users.
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
  CLI: athena
  MCP: athena-mcp
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
```

Entry points must go through `KnowledgeService`; permissions, paths, Markdown parsing, audit logs, and commit authorship are enforced there.

## Server Deployment

Deploy the required server-side services on a host you control:

```sh
cp .env.example .env
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

Required database values:

```sh
DATABASE_URL=postgres://athena:<password>@postgres:5432/athena
POSTGRES_PASSWORD=<password>
```

Required GitHub repository values:

```sh
GITHUB_OWNER=<github-owner-or-org>
GITHUB_REPO=<markdown-knowledge-repo>
GITHUB_BRANCH=main
```

### GitHub Authentication

Athena needs two GitHub capabilities:

- User login: identifies the person using CLI/MCP and records their GitHub identity.
- Repository writes: commits Markdown changes to the knowledge repository.
- Repository access checks: rejects users who cannot access the private knowledge repository.

Production setup uses one GitHub App for both capabilities. Create a GitHub App, install it on the knowledge repository, and grant repository `Contents: Read and write` plus `Metadata: Read-only`. Enable device flow for the app so CLI and MCP users can log in through GitHub.

Configure the server with:

```sh
GITHUB_APP_CLIENT_ID=<github-app-client-id>
GITHUB_APP_INSTALLATION_ID=<github-app-installation-id>
GITHUB_APP_PRIVATE_KEY_HOST_PATH=/secure/path/on/host/github-app.pem
```

`docker-compose.yml` mounts `GITHUB_APP_PRIVATE_KEY_HOST_PATH` as a Docker secret and exposes it to the API container at `/run/secrets/github-app.pem`. For non-Compose deployments, set `GITHUB_APP_PRIVATE_KEY_PATH` inside the API runtime to the mounted private key path.

Do not use personal access tokens for repository writes. Athena signs GitHub App JWTs and exchanges them for short-lived installation tokens at runtime.

GitHub repository permission is the outer security boundary:

| GitHub repository permission | Athena maximum role |
| --- | --- |
| `read` or `triage` | `viewer` |
| `write` or `maintain` | `editor` |
| `admin` | `owner` |
| no repository access | login and API requests are rejected |

Athena checks repository access before issuing a user token and again on API requests. If a user loses repository access, their existing Athena tokens are revoked on the next request.

Optional first-login access grant:

```sh
ATHENA_SIGNUP_SPACE_ID=team
ATHENA_SIGNUP_ROLE=
```

When `ATHENA_SIGNUP_ROLE` is empty, Athena mirrors the user's GitHub repository permission. When it is set, it is a maximum auto-granted role; it cannot grant more access than the user has on GitHub.

Users authenticate with GitHub device login and receive per-user Athena API tokens. The server stores only SHA-256 token hashes.
Tokens expire after `ATHENA_API_TOKEN_TTL_DAYS`, default `30`.

GitHub webhooks require `GITHUB_WEBHOOK_SECRET`; invalid `X-Hub-Signature-256` signatures are rejected.

Check the deployment:

```sh
docker compose ps
curl http://127.0.0.1:3000/healthz
```

Production deployments should bind the API to localhost and put nginx, Caddy, or another reverse proxy in front of it:

```yaml
services:
  api:
    ports:
      - "127.0.0.1:13000:3000"
```

Example nginx proxy:

```nginx
server {
    listen 80;
    server_name athena.example.com;

    location / {
        proxy_pass http://127.0.0.1:13000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then issue a certificate with your preferred ACME client, for example:

```sh
certbot --nginx -d athena.example.com
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

Set `ATHENA_BOT_TOKEN`, `DISCORD_TOKEN`, and `DISCORD_APPLICATION_ID` before enabling the Discord profile.

## Client Installation

Install prebuilt CLI and MCP binaries. This does not require Node, npm, or pnpm on the user machine:

```sh
curl -fsSL https://raw.githubusercontent.com/mvp-ai-lab/mvp-athena/main/install.sh | sh
```

Install a specific release:

```sh
curl -fsSL https://raw.githubusercontent.com/mvp-ai-lab/mvp-athena/main/install.sh \
  | ATHENA_VERSION=v0.1.0 sh
```

The installer writes:

```text
~/.local/bin/athena
~/.local/bin/athena-mcp
```

Make sure `~/.local/bin` is on `PATH`.

## User Login

Log in with GitHub App device flow:

```sh
athena login --api-url https://athena.example.com
```

The CLI prints a GitHub verification URL and code, then stores the issued Athena token in:

```text
~/.config/athena/config.json
```

Check status:

```sh
athena login --status
```

The server stores only a hash of the Athena token. Each request resolves to a concrete user, and commits use that user's GitHub identity:

```text
author.name  = user.displayName or user.githubLogin
author.email = user.githubEmail
```

## CLI Usage

```sh
athena spaces
athena search starter
athena read team welcome.md
athena read team welcome.md --raw
athena create team runbook.md --title Runbook --body "Restart carefully."
athena update team runbook.md --body "Updated procedure."
athena upload team diagrams/flow.png ./flow.png
athena move team runbook.md ops/runbook.md
athena history team ops/runbook.md
athena summary team
```

`read` defaults to the Markdown body. Use `--raw` to include frontmatter.

## Codex MCP

The MCP server uses stdio transport. Codex should start it locally and point it at the deployed API. After `athena login`, the MCP server can read the same local config token.

Add it to Codex:

```sh
codex mcp add athena -- athena-mcp
```

Equivalent `config.toml`:

```toml
[mcp_servers.athena]
command = "athena-mcp"
```

Explicit environment configuration is also supported:

```sh
codex mcp add athena \
  --env ATHENA_API_URL=https://athena.example.com \
  --env ATHENA_TOKEN=<user-token> \
  -- athena-mcp
```

## API

Authentication:

- `POST /auth/github/device`
- `POST /auth/github/device/poll`
- `GET /auth/me`
- `GET /auth/tokens`
- `DELETE /auth/tokens/current`

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
- `POST /spaces/:spaceId/reindex`
- `POST /github/webhook`

## Repository Layout

```text
apps/
  api/          Fastify API
  cli/          athena command
  mcp-server/   stdio MCP server for agents
  discord-bot/  optional Discord slash commands
packages/
  core/         KnowledgeService, permissions, Markdown, providers, stores
docs/
  schema.sql    PostgreSQL schema
  seed.sql      local seed data
install.sh      binary client installer
scripts/
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
docker compose up -d postgres
psql "$DATABASE_URL" -f docs/schema.sql
psql "$DATABASE_URL" -f docs/seed.sql
ATHENA_STORAGE_MODE=postgres pnpm start:api
```

Production Compose applies only `docs/schema.sql`. `docs/seed.sql` is for local development or explicit bootstrap only.

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

- Search uses the `documents` index table. Run `POST /spaces/:spaceId/reindex` after importing an existing GitHub knowledge repository.
- Binary asset upload uses GitHub Contents API; a Git LFS worker is still needed for large assets.
