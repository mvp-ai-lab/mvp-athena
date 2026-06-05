import { createHash, randomBytes } from "node:crypto";
import type { KnowledgeStore, Role, User } from "@mvp-athena/core";
import { ValidationError } from "@mvp-athena/core";

const deviceGrantType = "urn:ietf:params:oauth:grant-type:device_code";

export interface AuthServiceOptions {
  store: KnowledgeStore;
  githubClientId?: string;
  githubClientSecret?: string;
  githubOAuthBaseUrl?: string;
  githubApiBaseUrl?: string;
  signupSpaceId?: string;
  signupRole?: Role;
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
  private readonly githubOAuthBaseUrl: string;
  private readonly githubApiBaseUrl: string;

  constructor(private readonly options: AuthServiceOptions) {
    this.githubOAuthBaseUrl = options.githubOAuthBaseUrl ?? "https://github.com";
    this.githubApiBaseUrl = options.githubApiBaseUrl ?? "https://api.github.com";
  }

  async startGitHubDeviceFlow(): Promise<DeviceFlowStart> {
    const clientId = this.requireClientId();
    const response = await this.githubRequest<GitHubDeviceResponse>(`${this.githubOAuthBaseUrl}/login/device/code`, {
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
    if (this.options.githubClientSecret) {
      params.set("client_secret", this.options.githubClientSecret);
    }

    const tokenResponse = await this.githubRequest<GitHubTokenResponse>(`${this.githubOAuthBaseUrl}/login/oauth/access_token`, {
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
    await this.options.store.upsertUser(user);
    if (this.options.signupSpaceId && this.options.signupRole) {
      await this.options.store.upsertMembership({
        userId: user.id,
        spaceId: this.options.signupSpaceId,
        role: this.options.signupRole
      });
    }

    const token = createPlainToken();
    await this.options.store.createApiToken({
      tokenHash: hashToken(token),
      userId: user.id,
      name: tokenName,
      createdAt: new Date().toISOString()
    });

    return { status: "authorized", token, user };
  }

  private async githubUser(accessToken: string): Promise<User> {
    const user = await this.githubApiRequest<GitHubUserResponse>("/user", accessToken);
    const emails = await this.githubApiRequest<GitHubEmailResponse[]>("/user/emails", accessToken);
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
      throw new Error(`GitHub OAuth failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  private requireClientId(): string {
    if (!this.options.githubClientId) {
      throw new Error("GITHUB_OAUTH_CLIENT_ID is required for GitHub OAuth login");
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
