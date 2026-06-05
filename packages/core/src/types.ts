export type Role = "owner" | "editor" | "viewer";
export type Source = "api" | "cli" | "mcp" | "discord" | "webhook";
export type AuditAction =
  | "doc.create"
  | "doc.update"
  | "doc.delete"
  | "doc.move"
  | "asset.upload"
  | "search"
  | "history.read"
  | "summary.read"
  | "edit.propose";

export interface User {
  id: string;
  githubId?: string;
  githubLogin: string;
  githubEmail: string;
  displayName: string;
}

export interface ApiToken {
  tokenHash: string;
  userId: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface Space {
  id: string;
  name: string;
  rootPath: string;
  description?: string;
}

export interface SpaceMembership {
  userId: string;
  spaceId: string;
  role: Role;
}

export interface RequestContext {
  actor: User;
  source: Source;
}

export interface DocumentFrontmatter {
  title: string;
  owners: string[];
  tags: string[];
  visibility: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocument {
  spaceId: string;
  path: string;
  repoPath: string;
  sha: string;
  frontmatter: DocumentFrontmatter;
  body: string;
  raw: string;
  updatedAt: string;
}

export interface DocumentListItem {
  spaceId: string;
  path: string;
  repoPath: string;
  sha: string;
  title: string;
  tags: string[];
  updatedAt: string;
}

export interface SearchResult {
  spaceId: string;
  path: string;
  title: string;
  snippet: string;
  score: number;
  tags: string[];
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface GitObject {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  sha: string;
  updatedAt: string;
}

export interface GitCommitResult {
  commitSha: string;
  objectSha?: string;
  branch: string;
  path: string;
}

export interface GitHistoryEntry {
  commitSha: string;
  path: string;
  author: CommitAuthor;
  message: string;
  createdAt: string;
}

export interface GitWriteInput {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  message: string;
  author: CommitAuthor;
  expectedSha?: string;
}

export interface GitMoveInput {
  fromPath: string;
  toPath: string;
  message: string;
  author: CommitAuthor;
  expectedSha?: string;
}

export interface GitProvider {
  list(prefix: string): Promise<GitObject[]>;
  read(path: string): Promise<GitObject | null>;
  write(input: GitWriteInput): Promise<GitCommitResult>;
  delete(input: Omit<GitWriteInput, "content" | "encoding">): Promise<GitCommitResult>;
  move(input: GitMoveInput): Promise<GitCommitResult>;
  history(path: string): Promise<GitHistoryEntry[]>;
}

export interface AuditLogEntry {
  id: string;
  actorUserId: string;
  spaceId?: string;
  action: AuditAction;
  path?: string;
  commitSha?: string;
  source: Source;
  summary: string;
  createdAt: string;
}

export interface KnowledgeStore {
  getUser(userId: string): Promise<User | null>;
  getUserByApiTokenHash(tokenHash: string): Promise<User | null>;
  upsertUser(user: User): Promise<void>;
  upsertMembership(membership: SpaceMembership): Promise<void>;
  createApiToken(token: ApiToken): Promise<void>;
  markApiTokenUsed(tokenHash: string): Promise<void>;
  listSpacesForUser(userId: string): Promise<Array<Space & { role: Role }>>;
  getSpace(spaceId: string): Promise<Space | null>;
  getMembership(userId: string, spaceId: string): Promise<SpaceMembership | null>;
  appendAuditLog(entry: AuditLogEntry): Promise<void>;
  listAuditLogs(spaceId: string): Promise<AuditLogEntry[]>;
}
