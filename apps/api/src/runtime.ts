import {
  GitHubGitProvider,
  KnowledgeService,
  PostgresKnowledgeStore,
  UnauthorizedError,
  type GitProvider,
  type KnowledgeStore,
  type RequestContext,
  type User
} from "@mvp-athena/core";
import type { FastifyRequest } from "fastify";
import { AuthService, hashToken } from "./auth.js";
import { createContext as createDevContext, createDevService } from "./dev-fixtures.js";

export interface ApiRuntime {
  service: KnowledgeService;
  authService?: AuthService;
  createContext(request: FastifyRequest, source: RequestContext["source"]): Promise<RequestContext> | RequestContext;
}

export function createRuntime(env: NodeJS.ProcessEnv = process.env): ApiRuntime {
  if ((env.ATHENA_STORAGE_MODE ?? "memory") === "memory") {
    return {
      service: createDevService(),
      createContext: (_request, source) => createDevContext(source)
    };
  }

  if (env.ATHENA_STORAGE_MODE !== "postgres") {
    throw new Error(`Unsupported ATHENA_STORAGE_MODE: ${env.ATHENA_STORAGE_MODE}`);
  }

  const store = createPostgresStore(env);
  const git = createGitProvider(env);
  const service = new KnowledgeService({ store, git });
  const authService = createAuthService(env, store);

  return {
    service,
    authService,
    createContext: async (request, source) => {
      const actor = await resolveActor(store, request, {
        legacyToken: env.ATHENA_TOKEN,
        legacyDefaultUserId: env.ATHENA_DEFAULT_USER_ID,
        trustUserHeader: env.ATHENA_TRUSTED_USER_HEADER === "true"
      });
      return { actor, source };
    }
  };
}

function createPostgresStore(env: NodeJS.ProcessEnv): KnowledgeStore {
  return new PostgresKnowledgeStore({
    connectionString: requireEnv(env, "DATABASE_URL")
  });
}

function createGitProvider(env: NodeJS.ProcessEnv): GitProvider {
  return new GitHubGitProvider({
    owner: requireEnv(env, "GITHUB_OWNER"),
    repo: requireEnv(env, "GITHUB_REPO"),
    token: env.GITHUB_TOKEN ?? env.GITHUB_INSTALLATION_TOKEN ?? requireEnv(env, "GITHUB_TOKEN"),
    branch: env.GITHUB_BRANCH,
    apiBaseUrl: env.GITHUB_API_BASE_URL
  });
}

function createAuthService(env: NodeJS.ProcessEnv, store: KnowledgeStore): AuthService {
  return new AuthService({
    store,
    githubClientId: env.GITHUB_OAUTH_CLIENT_ID,
    githubClientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
    githubOAuthBaseUrl: env.GITHUB_OAUTH_BASE_URL,
    githubApiBaseUrl: env.GITHUB_API_BASE_URL,
    signupSpaceId: env.ATHENA_SIGNUP_SPACE_ID,
    signupRole: parseRole(env.ATHENA_SIGNUP_ROLE)
  });
}

async function resolveActor(
  store: KnowledgeStore,
  request: FastifyRequest,
  options: {
    legacyToken?: string;
    legacyDefaultUserId?: string;
    trustUserHeader: boolean;
  }
): Promise<User> {
  const bearerToken = getBearerToken(request);
  if (!bearerToken) {
    throw new UnauthorizedError("Missing bearer token");
  }

  const tokenUser = await store.getUserByApiTokenHash(hashToken(bearerToken));
  if (tokenUser) {
    await store.markApiTokenUsed(hashToken(bearerToken));
    return tokenUser;
  }

  if (options.legacyToken && bearerToken === options.legacyToken && options.legacyDefaultUserId) {
    const headerUserId = request.headers["x-athena-user-id"];
    const userId = options.trustUserHeader && typeof headerUserId === "string" ? headerUserId : options.legacyDefaultUserId;
    const actor = await store.getUser(userId);
    if (!actor) {
      throw new UnauthorizedError(`Actor user is not configured: ${userId}`);
    }
    return actor;
  }

  throw new UnauthorizedError("Invalid bearer token");
}

function getBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  return authorization.slice("Bearer ".length);
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
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
