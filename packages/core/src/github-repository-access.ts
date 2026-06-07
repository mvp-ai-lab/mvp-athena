import { ForbiddenError } from "./errors.js";
import type { Role, User } from "./types.js";
import type { GitHubTokenProvider } from "./github-provider.js";

export type GitHubRepositoryPermission = "admin" | "maintain" | "write" | "triage" | "read" | "push" | "pull" | "none";

export interface GitHubRepositoryAccessOptions {
  owner: string;
  repo: string;
  tokenProvider: GitHubTokenProvider;
  apiBaseUrl?: string;
  cacheTtlMs?: number;
}

interface PermissionResponse {
  permission?: string;
  role_name?: string;
}

export class GitHubRepositoryAccess {
  private readonly apiBaseUrl: string;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, { role: Role | null; expiresAt: number }>();

  constructor(private readonly options: GitHubRepositoryAccessOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
  }

  async requireUserRole(user: User): Promise<Role> {
    const role = await this.userRole(user.githubLogin);
    if (!role) {
      throw new ForbiddenError(`GitHub user ${user.githubLogin} does not have access to ${this.options.owner}/${this.options.repo}`);
    }
    return role;
  }

  async userRole(githubLogin: string): Promise<Role | null> {
    const key = githubLogin.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.role;
    }

    const permission = await this.fetchPermission(githubLogin);
    const role = roleFromGitHubPermission(permission);
    this.cache.set(key, { role, expiresAt: Date.now() + this.cacheTtlMs });
    return role;
  }

  private async fetchPermission(githubLogin: string): Promise<string> {
    const token = await this.options.tokenProvider();
    const response = await fetch(
      `${this.apiBaseUrl}/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(
        this.options.repo
      )}/collaborators/${encodeURIComponent(githubLogin)}/permission`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28"
        }
      }
    );

    if (response.status === 404) {
      return "none";
    }
    if (!response.ok) {
      throw new Error(`GitHub repository permission check failed: ${response.status} ${await response.text()}`);
    }

    const body = (await response.json()) as PermissionResponse;
    return body.permission ?? body.role_name ?? "none";
  }
}

export function roleFromGitHubPermission(permission: string): Role | null {
  switch (permission) {
    case "admin":
      return "owner";
    case "maintain":
    case "write":
    case "push":
      return "editor";
    case "triage":
    case "read":
    case "pull":
      return "viewer";
    default:
      return null;
  }
}
