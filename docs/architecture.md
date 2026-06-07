# MVP Athena Architecture

MVP Athena is an agent-first team knowledge system. A single GitHub repository is the source of truth, and each `space` is represented by a repository directory.

## Repository Layout

```text
spaces/
  <space_id>/
    docs/
      example.md
    assets/
      image.png
```

Markdown documents should include frontmatter:

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

## Runtime Shape

- `apps/api` owns HTTP routes, auth boundaries, GitHub webhook intake, and service wiring.
- `apps/mcp-server` exposes agent tools against the same API/service contract.
- `apps/cli` provides the canonical `mvp-athena` command.
- `apps/discord-bot` maps slash commands into the same knowledge operations.
- `packages/core` contains permission checks, path normalization, Markdown parsing, audit models, and service orchestration.

Entrypoints must not bypass `KnowledgeService`.

## Storage Shape

`KnowledgeService` depends on two storage contracts:

- `KnowledgeStore` stores users, spaces, memberships, API token metadata, document index rows, and audit logs.
- `GitProvider` stores Markdown documents, assets, and document history.

The local development mode wires `InMemoryKnowledgeStore` and `InMemoryGitProvider`.

The production-style mode wires:

- `PostgresKnowledgeStore` for users, spaces, memberships, API token metadata, document index rows, and audit logs.
- `GitHubGitProvider` for Markdown documents, assets, writes, moves, deletes, and history through the GitHub Contents/Commits APIs.

Set `ATHENA_STORAGE_MODE=postgres` in `apps/api` to use this path. The required database schema is in `docs/schema.sql`; a minimal seed is in `docs/seed.sql`.

GitHub Markdown remains the source of truth for document bodies and history. The `documents` table is the query index used by list/search APIs. Writes update it synchronously; existing repositories can be imported with the reindex API.

## Authentication Shape

CLI and MCP users authenticate with GitHub App device flow:

1. The client starts `/auth/github/device`.
2. The API starts GitHub's device authorization flow and returns the user code and verification URL.
3. The client polls `/auth/github/device/poll`.
4. The API exchanges the GitHub device code for a GitHub access token, reads `/user` and `/user/emails`, checks that the user can access the configured GitHub knowledge repository, upserts the Athena `users` row, creates an Athena API token, and stores only its SHA-256 hash in `api_tokens`.
5. Later client requests send `Authorization: Bearer <athena token>`.
6. The API hashes the bearer token, resolves the actor user, checks current GitHub repository access, and passes that actor plus repository role into `KnowledgeService`.

GitHub repository permission is the global authorization ceiling: `read`/`triage` maps to `viewer`, `write`/`maintain` maps to `editor`, and `admin` maps to `owner`. Athena space memberships can reduce access further, but they cannot grant more than the user has on the GitHub repository.

Git commits use the actor's `displayName`/`githubLogin` and `githubEmail`, so each person's agent writes with that person's GitHub author identity.
