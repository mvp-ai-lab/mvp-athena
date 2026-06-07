import { ConflictError, NotFoundError } from "./errors.js";
import type {
  ApiToken,
  ApiTokenSummary,
  AuditLogEntry,
  DocumentIndexEntry,
  DocumentListItem,
  GitCommitResult,
  GitHistoryEntry,
  GitMoveInput,
  GitObject,
  GitProvider,
  GitWriteInput,
  KnowledgeStore,
  Role,
  SearchResult,
  Space,
  SpaceMembership,
  User
} from "./types.js";

function makeSha(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class InMemoryKnowledgeStore implements KnowledgeStore {
  private readonly users = new Map<string, User>();
  private readonly apiTokens = new Map<string, ApiToken>();
  private readonly spaces = new Map<string, Space>();
  private readonly memberships = new Map<string, SpaceMembership>();
  private readonly documents = new Map<string, DocumentIndexEntry>();
  private readonly auditLogs: AuditLogEntry[] = [];

  constructor(seed?: { users?: User[]; spaces?: Space[]; memberships?: SpaceMembership[] }) {
    for (const user of seed?.users ?? []) {
      this.users.set(user.id, user);
    }
    for (const space of seed?.spaces ?? []) {
      this.spaces.set(space.id, space);
    }
    for (const membership of seed?.memberships ?? []) {
      this.memberships.set(this.membershipKey(membership.userId, membership.spaceId), membership);
    }
  }

  async getUser(userId: string): Promise<User | null> {
    return this.users.get(userId) ?? null;
  }

  async getUserByApiTokenHash(tokenHash: string): Promise<User | null> {
    const token = this.apiTokens.get(tokenHash);
    if (!token || token.revokedAt || (token.expiresAt && new Date(token.expiresAt) <= new Date())) {
      return null;
    }
    return this.getUser(token.userId);
  }

  async upsertUser(user: User): Promise<void> {
    this.users.set(user.id, user);
  }

  async upsertMembership(membership: SpaceMembership): Promise<void> {
    this.memberships.set(this.membershipKey(membership.userId, membership.spaceId), membership);
  }

  async createApiToken(token: ApiToken): Promise<void> {
    this.apiTokens.set(token.tokenHash, token);
  }

  async markApiTokenUsed(tokenHash: string): Promise<void> {
    const token = this.apiTokens.get(tokenHash);
    if (token) {
      this.apiTokens.set(tokenHash, { ...token, lastUsedAt: new Date().toISOString() });
    }
  }

  async listApiTokensForUser(userId: string): Promise<ApiTokenSummary[]> {
    return [...this.apiTokens.entries()]
      .filter(([, token]) => token.userId === userId)
      .sort(([, left], [, right]) => right.createdAt.localeCompare(left.createdAt))
      .map(([tokenHash, token]) => ({
        id: tokenHash.slice(0, 16),
        name: token.name,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
        expiresAt: token.expiresAt,
        revokedAt: token.revokedAt
      }));
  }

  async revokeApiToken(tokenHash: string, userId: string): Promise<void> {
    const token = this.apiTokens.get(tokenHash);
    if (token?.userId === userId && !token.revokedAt) {
      this.apiTokens.set(tokenHash, { ...token, revokedAt: new Date().toISOString() });
    }
  }

  async revokeApiTokensForUser(userId: string): Promise<void> {
    for (const [tokenHash, token] of this.apiTokens.entries()) {
      if (token.userId === userId && !token.revokedAt) {
        this.apiTokens.set(tokenHash, { ...token, revokedAt: new Date().toISOString() });
      }
    }
  }

  async listSpacesForUser(userId: string): Promise<Array<Space & { role: Role }>> {
    return [...this.memberships.values()]
      .filter((membership) => membership.userId === userId)
      .map((membership) => {
        const space = this.spaces.get(membership.spaceId);
        return space ? { ...space, role: membership.role } : null;
      })
      .filter((space): space is Space & { role: Role } => Boolean(space));
  }

  async getSpace(spaceId: string): Promise<Space | null> {
    return this.spaces.get(spaceId) ?? null;
  }

  async getMembership(userId: string, spaceId: string): Promise<SpaceMembership | null> {
    return this.memberships.get(this.membershipKey(userId, spaceId)) ?? null;
  }

  async upsertDocumentIndex(entry: DocumentIndexEntry): Promise<void> {
    this.documents.set(this.documentKey(entry.spaceId, entry.path), entry);
  }

  async deleteDocumentIndex(spaceId: string, path: string): Promise<void> {
    this.documents.delete(this.documentKey(spaceId, path));
  }

  async listDocumentIndex(spaceId: string): Promise<DocumentListItem[]> {
    return [...this.documents.values()]
      .filter((entry) => entry.spaceId === spaceId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.path.localeCompare(right.path))
      .map(({ content: _content, ...entry }) => entry);
  }

  async searchDocumentIndex(spaceIds: string[], query: string): Promise<SearchResult[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }
    return [...this.documents.values()]
      .filter((entry) => spaceIds.includes(entry.spaceId))
      .map((entry) => {
        const haystack = `${entry.title}\n${entry.tags.join(" ")}\n${entry.content}`.toLowerCase();
        const index = haystack.indexOf(normalizedQuery);
        if (index < 0) {
          return null;
        }
        const snippetStart = Math.max(0, index - 80);
        return {
          spaceId: entry.spaceId,
          path: entry.path,
          title: entry.title,
          snippet: entry.content.slice(snippetStart, snippetStart + 180).replace(/\s+/g, " ").trim(),
          score: 1 / (1 + index),
          tags: entry.tags
        };
      })
      .filter((result): result is SearchResult => Boolean(result))
      .sort((left, right) => right.score - left.score);
  }

  async appendAuditLog(entry: AuditLogEntry): Promise<void> {
    this.auditLogs.push(entry);
  }

  async listAuditLogs(spaceId: string): Promise<AuditLogEntry[]> {
    return this.auditLogs.filter((entry) => entry.spaceId === spaceId);
  }

  upsertSpace(space: Space): void {
    this.spaces.set(space.id, space);
  }

  setMembership(membership: SpaceMembership): void {
    this.memberships.set(this.membershipKey(membership.userId, membership.spaceId), membership);
  }

  private membershipKey(userId: string, spaceId: string): string {
    return `${userId}:${spaceId}`;
  }

  private documentKey(spaceId: string, path: string): string {
    return `${spaceId}:${path}`;
  }
}

export class InMemoryGitProvider implements GitProvider {
  private readonly objects = new Map<string, GitObject>();
  private readonly histories = new Map<string, GitHistoryEntry[]>();

  constructor(seed?: Array<Omit<GitObject, "sha" | "updatedAt"> & { sha?: string; updatedAt?: string }>) {
    for (const object of seed ?? []) {
      this.objects.set(object.path, {
        ...object,
        sha: object.sha ?? makeSha("obj"),
        updatedAt: object.updatedAt ?? new Date().toISOString()
      });
    }
  }

  async list(prefix: string): Promise<GitObject[]> {
    return [...this.objects.values()].filter((object) => object.path.startsWith(prefix));
  }

  async read(path: string): Promise<GitObject | null> {
    return this.objects.get(path) ?? null;
  }

  async write(input: GitWriteInput): Promise<GitCommitResult> {
    const existing = this.objects.get(input.path);
    this.checkExpectedSha(existing, input.expectedSha);

    const nextObject: GitObject = {
      path: input.path,
      content: input.content,
      encoding: input.encoding,
      sha: makeSha("obj"),
      updatedAt: new Date().toISOString()
    };
    this.objects.set(input.path, nextObject);
    return this.recordHistory(input.path, input.message, input.author, nextObject.sha);
  }

  async delete(input: Omit<GitWriteInput, "content" | "encoding">): Promise<GitCommitResult> {
    const existing = this.objects.get(input.path);
    if (!existing) {
      throw new NotFoundError(`Git object not found: ${input.path}`);
    }
    this.checkExpectedSha(existing, input.expectedSha);

    this.objects.delete(input.path);
    return this.recordHistory(input.path, input.message, input.author);
  }

  async move(input: GitMoveInput): Promise<GitCommitResult> {
    const existing = this.objects.get(input.fromPath);
    if (!existing) {
      throw new NotFoundError(`Git object not found: ${input.fromPath}`);
    }
    this.checkExpectedSha(existing, input.expectedSha);
    if (this.objects.has(input.toPath)) {
      throw new ConflictError(`Target path already exists: ${input.toPath}`);
    }

    this.objects.delete(input.fromPath);
    const moved: GitObject = {
      ...existing,
      path: input.toPath,
      sha: makeSha("obj"),
      updatedAt: new Date().toISOString()
    };
    this.objects.set(input.toPath, moved);
    return this.recordHistory(input.toPath, input.message, input.author, moved.sha);
  }

  async history(path: string): Promise<GitHistoryEntry[]> {
    return this.histories.get(path) ?? [];
  }

  private checkExpectedSha(existing: GitObject | undefined, expectedSha: string | undefined): void {
    if (expectedSha && existing?.sha !== expectedSha) {
      throw new ConflictError("Expected SHA does not match current object SHA");
    }
  }

  private recordHistory(
    path: string,
    message: string,
    author: GitHistoryEntry["author"],
    objectSha?: string
  ): GitCommitResult {
    const commitSha = makeSha("commit");
    const entry: GitHistoryEntry = {
      commitSha,
      path,
      author,
      message,
      createdAt: new Date().toISOString()
    };
    const existing = this.histories.get(path) ?? [];
    this.histories.set(path, [entry, ...existing]);
    return {
      commitSha,
      objectSha,
      branch: "main",
      path
    };
  }
}
