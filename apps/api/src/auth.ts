import { createHash, randomBytes } from "node:crypto";
import type { ApiTokenSummary, GitHubRepositoryAccess, KnowledgeStore, Role, User } from "@mvp-athena/core";
import { minRole, ValidationError } from "@mvp-athena/core";

const deviceGrantType = "urn:ietf:params:oauth:grant-type:device_code";

export interface AuthServiceOptions {
  store: KnowledgeStore;
  repositoryAccess: GitHubRepositoryAccess;
  githubClientId: string;
  githubApiBaseUrl?: string;
  signupSpaceId?: string;
  signupRole?: Role;
  tokenTtlDays?: number;
}

export interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceFlowPollResult {
  status: "pending" | "slow_down" | "authorized";
  interval?: number;
  token?: string;
  user?: User;
}

interface GitHubDeviceResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

interface GitHubTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: "authorization_pending" | "slow_down" | "expired_token" | "access_denied" | string;
  error_description?: string;
}

interface GitHubUserResponse {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

interface GitHubEmailResponse {
  email: string;
  primary: boolean;
  verified: boolean;
}

export class AuthService {
  private readonly githubApiBaseUrl: string;

  constructor(private readonly options: AuthServiceOptions) {
    this.githubApiBaseUrl = options.githubApiBaseUrl ?? "https://api.github.com";
  }

  async startGitHubDeviceFlow(): Promise<DeviceFlowStart> {
    const clientId = this.requireClientId();
    const response = await this.githubRequest<GitHubDeviceResponse>("https://github.com/login/device/code", {
      method: "POST",
      body: new URLSearchParams({
        client_id: clientId,
        scope: "read:user user:email"
      })
    });
    return {
      deviceCode: response.device_code,
      userCode: response.user_code,
      verificationUri: response.verification_uri,
      verificationUriComplete: response.verification_uri_complete,
      expiresIn: response.expires_in,
      interval: response.interval
    };
  }

  async pollGitHubDeviceFlow(deviceCode: string, tokenName = "cli"): Promise<DeviceFlowPollResult> {
    const clientId = this.requireClientId();
    const params = new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: deviceGrantType
    });

    const tokenResponse = await this.githubRequest<GitHubTokenResponse>("https://github.com/login/oauth/access_token", {
      method: "POST",
      body: params
    });

    if (tokenResponse.error === "authorization_pending") {
      return { status: "pending" };
    }
    if (tokenResponse.error === "slow_down") {
      return { status: "slow_down" };
    }
    if (tokenResponse.error) {
      throw new ValidationError(tokenResponse.error_description ?? tokenResponse.error);
    }
    if (!tokenResponse.access_token) {
      throw new ValidationError("GitHub did not return an access token");
    }

    const user = await this.githubUser(tokenResponse.access_token);
    const repositoryRole = await this.options.repositoryAccess.requireUserRole(user);
    await this.options.store.upsertUser(user);
    if (this.options.signupSpaceId) {
      await this.options.store.upsertMembership({
        userId: user.id,
        spaceId: this.options.signupSpaceId,
        role: this.signupRole(repositoryRole)
      });
    }

    const token = createPlainToken();
    const createdAt = new Date();
    await this.options.store.createApiToken({
      tokenHash: hashToken(token),
      userId: user.id,
      name: tokenName,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.tokenTtlMs()).toISOString()
    });

    return { status: "authorized", token, user };
  }

  async listTokens(user: User): Promise<ApiTokenSummary[]> {
    return this.options.store.listApiTokensForUser(user.id);
  }

  async revokeToken(user: User, token: string): Promise<void> {
    await this.options.store.revokeApiToken(hashToken(token), user.id);
  }

  private signupRole(repositoryRole: Role): Role {
    return this.options.signupRole ? minRole(this.options.signupRole, repositoryRole) : repositoryRole;
  }

  private tokenTtlMs(): number {
    return (this.options.tokenTtlDays ?? 30) * 24 * 60 * 60 * 1000;
  }

  private async githubUser(accessToken: string): Promise<User> {
    const user = await this.githubApiRequest<GitHubUserResponse>("/user", accessToken);
    const emails = await this.githubVerifiedEmails(accessToken);
    const primaryEmail = emails.find((email) => email.primary && email.verified) ?? emails.find((email) => email.verified);
    const email = primaryEmail?.email ?? user.email ?? `${user.id}+${user.login}@users.noreply.github.com`;
    return {
      id: `github-${user.id}`,
      githubId: String(user.id),
      githubLogin: user.login,
      githubEmail: email,
      displayName: user.name ?? user.login
    };
  }

  private async githubApiRequest<T>(path: string, accessToken: string): Promise<T> {
    const response = await fetch(`${this.githubApiBaseUrl}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "x-github-api-version": "2022-11-28"
      }
    });
    if (!response.ok) {
      throw new Error(`GitHub API failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  private async githubVerifiedEmails(accessToken: string): Promise<GitHubEmailResponse[]> {
    try {
      return await this.githubApiRequest<GitHubEmailResponse[]>("/user/emails", accessToken);
    } catch {
      return [];
    }
  }

  private async githubRequest<T>(url: string, init: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        ...init.headers
      }
    });
    if (!response.ok) {
      throw new Error(`GitHub device auth failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  private requireClientId(): string {
    if (!this.options.githubClientId) {
      throw new Error("GITHUB_APP_CLIENT_ID is required for GitHub App device login");
    }
    return this.options.githubClientId;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createPlainToken(): string {
  return `athena_${randomBytes(32).toString("base64url")}`;
}
