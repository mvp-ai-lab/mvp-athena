import { Buffer } from "node:buffer";
import { createSign } from "node:crypto";
import { ConflictError, NotFoundError } from "./errors.js";
import type {
  CommitAuthor,
  GitCommitResult,
  GitHistoryEntry,
  GitMoveInput,
  GitObject,
  GitProvider,
  GitWriteInput
} from "./types.js";

interface GitHubProviderOptions {
  owner: string;
  repo: string;
  tokenProvider: GitHubTokenProvider;
  branch?: string;
  apiBaseUrl?: string;
  committer?: CommitAuthor;
}

export type GitHubTokenProvider = () => Promise<string> | string;

export interface GitHubAppInstallationTokenProviderOptions {
  clientId: string;
  installationId: string;
  privateKey: string;
  apiBaseUrl?: string;
}

interface GitHubContentResponse {
  type: string;
  path: string;
  sha: string;
  content?: string;
  encoding?: string;
}

interface GitHubWriteResponse {
  content?: {
    path: string;
    sha: string;
  };
  commit: {
    sha: string;
  };
}

interface GitHubTreeResponse {
  tree: Array<{
    path?: string;
    type?: string;
    sha?: string;
  }>;
}

interface GitHubCommitResponse {
  sha: string;
  tree?: {
    sha: string;
  };
  commit: {
    message: string;
    author?: {
      name?: string;
      email?: string;
      date?: string;
    };
  };
}

interface GitHubInstallationTokenResponse {
  token: string;
  expires_at: string;
}

interface GitHubRefResponse {
  object: {
    sha: string;
  };
}

interface GitHubTreeCreateResponse {
  sha: string;
}

export class GitHubAppInstallationTokenProvider {
  private readonly apiBaseUrl: string;
  private cachedToken?: { token: string; expiresAt: number };

  constructor(private readonly options: GitHubAppInstallationTokenProviderOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  }

  async token(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - 60_000) {
      return this.cachedToken.token;
    }

    const response = await fetch(
      `${this.apiBaseUrl}/app/installations/${encodeURIComponent(this.options.installationId)}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.createJwt()}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28"
        }
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub App token request failed: ${response.status} ${await response.text()}`);
    }

    const body = (await response.json()) as GitHubInstallationTokenResponse;
    this.cachedToken = {
      token: body.token,
      expiresAt: new Date(body.expires_at).getTime()
    };
    return body.token;
  }

  private createJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
    const payload = base64UrlJson({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: this.options.clientId
    });
    const unsigned = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.options.privateKey, "base64url");
    return `${unsigned}.${signature}`;
  }
}

export class GitHubGitProvider implements GitProvider {
  private readonly branch: string;
  private readonly apiBaseUrl: string;
  private readonly committer: CommitAuthor;
  private readonly tokenProvider: GitHubTokenProvider;

  constructor(private readonly options: GitHubProviderOptions) {
    this.branch = options.branch ?? "main";
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
    this.committer = options.committer ?? { name: "mvp-athena", email: "mvp-athena@example.com" };
    this.tokenProvider = options.tokenProvider;
  }

  async list(prefix: string): Promise<GitObject[]> {
    const tree = await this.request<GitHubTreeResponse>(
      `/repos/${this.options.owner}/${this.options.repo}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`
    );
    const paths = tree.tree
      .filter((entry) => entry.type === "blob" && entry.path?.startsWith(prefix))
      .map((entry) => entry.path)
      .filter((path): path is string => Boolean(path));

    return Promise.all(paths.map((path) => this.readRequired(path)));
  }

  async read(path: string): Promise<GitObject | null> {
    try {
      return await this.readRequired(path);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return null;
      }
      throw error;
    }
  }

  async write(input: GitWriteInput): Promise<GitCommitResult> {
    const content = input.encoding === "base64" ? input.content : Buffer.from(input.content, "utf8").toString("base64");
    const response = await this.request<GitHubWriteResponse>(
      `/repos/${this.options.owner}/${this.options.repo}/contents/${encodePath(input.path)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: input.message,
          content,
          branch: this.branch,
          sha: input.expectedSha,
          author: input.author,
          committer: this.committer
        })
      }
    );
    return {
      commitSha: response.commit.sha,
      objectSha: response.content?.sha,
      branch: this.branch,
      path: input.path
    };
  }

  async delete(input: Omit<GitWriteInput, "content" | "encoding">): Promise<GitCommitResult> {
    const current = input.expectedSha ? { sha: input.expectedSha } : await this.readRequired(input.path);
    const response = await this.request<GitHubWriteResponse>(
      `/repos/${this.options.owner}/${this.options.repo}/contents/${encodePath(input.path)}`,
      {
        method: "DELETE",
        body: JSON.stringify({
          message: input.message,
          sha: current.sha,
          branch: this.branch,
          author: input.author,
          committer: this.committer
        })
      }
    );
    return {
      commitSha: response.commit.sha,
      branch: this.branch,
      path: input.path
    };
  }

  async move(input: GitMoveInput): Promise<GitCommitResult> {
    const current = await this.readRequired(input.fromPath);
    if (input.expectedSha && current.sha !== input.expectedSha) {
      throw new ConflictError("Expected SHA does not match current object SHA");
    }
    const existingTarget = await this.read(input.toPath);
    if (existingTarget) {
      throw new ConflictError(`Target path already exists: ${input.toPath}`);
    }

    const ref = await this.request<GitHubRefResponse>(`/repos/${this.options.owner}/${this.options.repo}/git/ref/heads/${encodeURIComponent(this.branch)}`);
    const baseCommit = await this.request<GitHubCommitResponse>(`/repos/${this.options.owner}/${this.options.repo}/git/commits/${encodeURIComponent(ref.object.sha)}`);
    if (!baseCommit.tree?.sha) {
      throw new Error(`GitHub commit has no tree: ${ref.object.sha}`);
    }

    const tree = await this.request<GitHubTreeCreateResponse>(`/repos/${this.options.owner}/${this.options.repo}/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        base_tree: baseCommit.tree.sha,
        tree: [
          {
            path: input.toPath,
            mode: "100644",
            type: "blob",
            sha: current.sha
          },
          {
            path: input.fromPath,
            mode: "100644",
            type: "blob",
            sha: null
          }
        ]
      })
    });

    const commit = await this.request<GitHubCommitResponse>(`/repos/${this.options.owner}/${this.options.repo}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: input.message,
        tree: tree.sha,
        parents: [ref.object.sha],
        author: input.author,
        committer: this.committer
      })
    });

    await this.request<GitHubRefResponse>(`/repos/${this.options.owner}/${this.options.repo}/git/refs/heads/${encodeURIComponent(this.branch)}`, {
      method: "PATCH",
      body: JSON.stringify({
        sha: commit.sha,
        force: false
      })
    });

    return {
      commitSha: commit.sha,
      objectSha: current.sha,
      branch: this.branch,
      path: input.toPath
    };
  }

  async history(path: string): Promise<GitHistoryEntry[]> {
    const commits = await this.request<GitHubCommitResponse[]>(
      `/repos/${this.options.owner}/${this.options.repo}/commits?sha=${encodeURIComponent(this.branch)}&path=${encodeURIComponent(path)}`
    );
    return commits.map((commit) => ({
      commitSha: commit.sha,
      path,
      author: {
        name: commit.commit.author?.name ?? "unknown",
        email: commit.commit.author?.email ?? "unknown@example.com"
      },
      message: commit.commit.message,
      createdAt: commit.commit.author?.date ?? new Date(0).toISOString()
    }));
  }

  private async readRequired(path: string): Promise<GitObject> {
    const response = await this.request<GitHubContentResponse>(
      `/repos/${this.options.owner}/${this.options.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(this.branch)}`
    );
    if (response.type !== "file" || !response.content || response.encoding !== "base64") {
      throw new NotFoundError(`GitHub content is not a file: ${path}`);
    }
    return {
      path: response.path,
      content: Buffer.from(response.content.replace(/\n/g, ""), "base64").toString("utf8"),
      encoding: "utf8",
      sha: response.sha,
      updatedAt: new Date().toISOString()
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.tokenProvider();
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        ...init.headers
      }
    });

    if (response.status === 404) {
      throw new NotFoundError("GitHub resource not found");
    }
    if (response.status === 409 || response.status === 422) {
      throw new ConflictError(await response.text());
    }
    if (!response.ok) {
      throw new Error(`GitHub API failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
