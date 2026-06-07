import {
  GitHubAppInstallationTokenProvider,
  GitHubGitProvider,
  GitHubRepositoryAccess,
  KnowledgeService,
  PostgresKnowledgeStore,
  ForbiddenError,
  minRole,
  UnauthorizedError,
  type GitProvider,
  type GitHubTokenProvider,
  type KnowledgeStore,
  type RequestContext,
  type Role,
  type User
} from "@mvp-athena/core";
import type { FastifyRequest } from "fastify";
import { readFileSync } from "node:fs";
import { AuthService, hashToken } from "./auth.js";
import { createContext as createDevContext, createDevService } from "./dev-fixtures.js";

export interface ApiRuntime {
  service: KnowledgeService;
  authService?: AuthService;
  webhookSecret?: string;
  bodyLimitBytes?: number;
  createContext(request: FastifyRequest, source: RequestContext["source"]): Promise<RequestContext> | RequestContext;
}

export function createRuntime(env: NodeJS.ProcessEnv = process.env): ApiRuntime {
  const storageMode = env.ATHENA_STORAGE_MODE ?? (env.NODE_ENV === "production" ? "postgres" : "memory");
  if (storageMode === "memory") {
    return {
      service: createDevService(),
      createContext: (_request, source) => createDevContext(source)
    };
  }

  if (storageMode !== "postgres") {
    throw new Error(`Unsupported ATHENA_STORAGE_MODE: ${storageMode}`);
  }

  const store = createPostgresStore(env);
  const tokenProvider = createGitHubAppTokenProvider(env);
  const repositoryAccess = createRepositoryAccess(env, tokenProvider);
  const git = createGitProvider(env, tokenProvider);
  const service = new KnowledgeService({ store, git });
  const authService = createAuthService(env, store, repositoryAccess);

  return {
    service,
    authService,
    webhookSecret: optionalEnv(env.GITHUB_WEBHOOK_SECRET),
    bodyLimitBytes: parsePositiveNumber(env.ATHENA_BODY_LIMIT_BYTES, "ATHENA_BODY_LIMIT_BYTES"),
    createContext: async (request, source) => {
      const { actor, tokenHash } = await resolveTokenUser(store, request);
      let repositoryRole: Role;
      try {
        repositoryRole = await repositoryAccess.requireUserRole(actor);
      } catch (error) {
        if (error instanceof ForbiddenError) {
          await store.revokeApiTokensForUser(actor.id);
        }
        throw error;
      }
      await syncSignupMembership(store, actor, repositoryRole, env);
      await store.markApiTokenUsed(tokenHash);
      return { actor, source, repositoryRole };
    }
  };
}

function createPostgresStore(env: NodeJS.ProcessEnv): KnowledgeStore {
  return new PostgresKnowledgeStore({
    connectionString: requireEnv(env, "DATABASE_URL")
  });
}

function createGitProvider(env: NodeJS.ProcessEnv, tokenProvider: GitHubTokenProvider): GitProvider {
  return new GitHubGitProvider({
    owner: requireEnv(env, "GITHUB_OWNER"),
    repo: requireEnv(env, "GITHUB_REPO"),
    tokenProvider,
    branch: env.GITHUB_BRANCH,
    apiBaseUrl: env.GITHUB_API_BASE_URL
  });
}

function createGitHubAppTokenProvider(env: NodeJS.ProcessEnv): () => Promise<string> {
  const provider = new GitHubAppInstallationTokenProvider({
    clientId: requireEnv(env, "GITHUB_APP_CLIENT_ID"),
    installationId: requireEnv(env, "GITHUB_APP_INSTALLATION_ID"),
    privateKey: readFileSync(requireEnv(env, "GITHUB_APP_PRIVATE_KEY_PATH"), "utf8"),
    apiBaseUrl: env.GITHUB_API_BASE_URL
  });
  return () => provider.token();
}

function createRepositoryAccess(env: NodeJS.ProcessEnv, tokenProvider: GitHubTokenProvider): GitHubRepositoryAccess {
  return new GitHubRepositoryAccess({
    owner: requireEnv(env, "GITHUB_OWNER"),
    repo: requireEnv(env, "GITHUB_REPO"),
    tokenProvider,
    apiBaseUrl: env.GITHUB_API_BASE_URL
  });
}

function createAuthService(env: NodeJS.ProcessEnv, store: KnowledgeStore, repositoryAccess: GitHubRepositoryAccess): AuthService {
  return new AuthService({
    store,
    repositoryAccess,
    githubClientId: requireEnv(env, "GITHUB_APP_CLIENT_ID"),
    githubApiBaseUrl: env.GITHUB_API_BASE_URL,
    signupSpaceId: env.ATHENA_SIGNUP_SPACE_ID,
    signupRole: parseRole(env.ATHENA_SIGNUP_ROLE),
    tokenTtlDays: parsePositiveNumber(env.ATHENA_API_TOKEN_TTL_DAYS, "ATHENA_API_TOKEN_TTL_DAYS") ?? 30
  });
}

async function resolveTokenUser(
  store: KnowledgeStore,
  request: FastifyRequest
): Promise<{ actor: User; tokenHash: string }> {
  const bearerToken = getBearerToken(request);
  if (!bearerToken) {
    throw new UnauthorizedError("Missing bearer token");
  }

  const tokenHash = hashToken(bearerToken);
  const tokenUser = await store.getUserByApiTokenHash(tokenHash);
  if (tokenUser) {
    return { actor: tokenUser, tokenHash };
  }

  throw new UnauthorizedError("Invalid bearer token");
}

async function syncSignupMembership(
  store: KnowledgeStore,
  user: User,
  repositoryRole: Role,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const spaceId = optionalEnv(env.ATHENA_SIGNUP_SPACE_ID);
  if (!spaceId) {
    return;
  }

  const configuredRole = parseRole(env.ATHENA_SIGNUP_ROLE);
  const role = configuredRole ? minRole(configuredRole, repositoryRole) : repositoryRole;
  const existing = await store.getMembership(user.id, spaceId);
  if (existing?.role !== role) {
    await store.upsertMembership({ userId: user.id, spaceId, role });
  }
}

function getBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  return authorization.slice("Bearer ".length);
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = optionalEnv(env[name]);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseRole(value: string | undefined): "owner" | "editor" | "viewer" | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "owner" || value === "editor" || value === "viewer") {
    return value;
  }
  throw new Error(`Unsupported ATHENA_SIGNUP_ROLE: ${value}`);
}

function parsePositiveNumber(value: string | undefined, name: string): number | undefined {
  const normalized = optionalEnv(value);
  if (!normalized) {
    return undefined;
  }
  const numberValue = Number(normalized);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return numberValue;
}
