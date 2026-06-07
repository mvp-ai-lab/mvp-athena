import { ConflictError, NotFoundError } from "./errors.js";
import { parseMarkdown, serializeMarkdown, updateMarkdownTimestamp } from "./markdown.js";
import { minRole, requireRepositoryRole, requireSpaceRole } from "./permissions.js";
import { fromRepoDocPath, spaceDocsPrefix, toRepoAssetPath, toRepoDocPath } from "./paths.js";
import type {
  AuditAction,
  AuditLogEntry,
  CommitAuthor,
  DocumentListItem,
  GitProvider,
  KnowledgeDocument,
  KnowledgeStore,
  RequestContext,
  SearchResult
} from "./types.js";

export interface KnowledgeServiceOptions {
  store: KnowledgeStore;
  git: GitProvider;
}

export interface CreateDocInput {
  spaceId: string;
  path: string;
  title: string;
  body: string;
  owners?: string[];
  tags?: string[];
  visibility?: string;
}

export interface UpdateDocInput {
  spaceId: string;
  path: string;
  raw?: string;
  body?: string;
  expectedSha?: string;
}

export interface UploadAssetInput {
  spaceId: string;
  path: string;
  contentBase64: string;
  expectedSha?: string;
}

export interface MoveDocInput {
  spaceId: string;
  fromPath: string;
  toPath: string;
  expectedSha?: string;
}

export class KnowledgeService {
  constructor(private readonly options: KnowledgeServiceOptions) {}

  async listSpaces(ctx: RequestContext) {
    requireRepositoryRole(ctx, "read");
    const spaces = await this.options.store.listSpacesForUser(ctx.actor.id);
    if (!ctx.repositoryRole) {
      return spaces;
    }
    const repositoryRole = ctx.repositoryRole;
    return spaces.map((space) => ({ ...space, role: minRole(space.role, repositoryRole) }));
  }

  async listDocs(ctx: RequestContext, spaceId: string): Promise<DocumentListItem[]> {
    requireRepositoryRole(ctx, "read");
    await requireSpaceRole(this.options.store, ctx.actor.id, spaceId, "read");
    return this.options.store.listDocumentIndex(spaceId);
  }

  async readDoc(ctx: RequestContext, spaceId: string, path: string): Promise<KnowledgeDocument> {
    requireRepositoryRole(ctx, "read");
    const { space } = await requireSpaceRole(this.options.store, ctx.actor.id, spaceId, "read");
    const repoPath = toRepoDocPath(space, path);
    const object = await this.options.git.read(repoPath);
    if (!object) {
      throw new NotFoundError(`Document not found: ${path}`);
    }
    const parsed = parseMarkdown(object.content);
    return {
      spaceId,
      path: fromRepoDocPath(space, object.path),
      repoPath,
      sha: object.sha,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      raw: object.content,
      updatedAt: parsed.frontmatter.updatedAt
    };
  }

  async createDoc(ctx: RequestContext, input: CreateDocInput) {
    requireRepositoryRole(ctx, "write");
    const { space } = await requireSpaceRole(this.options.store, ctx.actor.id, input.spaceId, "write");
    const repoPath = toRepoDocPath(space, input.path);
    if (await this.options.git.read(repoPath)) {
      throw new ConflictError(`Document already exists: ${input.path}`);
    }
    const raw = serializeMarkdown({
      title: input.title,
      owners: input.owners ?? [ctx.actor.githubLogin],
      tags: input.tags,
      visibility: input.visibility,
      body: input.body
    });
    const result = await this.options.git.write({
      path: repoPath,
      content: raw,
      encoding: "utf8",
      message: `Create ${repoPath}`,
      author: this.commitAuthor(ctx),
      expectedSha: undefined
    });
    await this.indexDocument(input.spaceId, repoPath, result.objectSha ?? "", raw);
    await this.audit(ctx, "doc.create", input.spaceId, input.path, result.commitSha, `Created ${input.path}`);
    return { ...result, repoPath };
  }

  async updateDoc(ctx: RequestContext, input: UpdateDocInput) {
    requireRepositoryRole(ctx, "write");
    const { space } = await requireSpaceRole(this.options.store, ctx.actor.id, input.spaceId, "write");
    const repoPath = toRepoDocPath(space, input.path);
    const current = await this.options.git.read(repoPath);
    if (!current) {
      throw new NotFoundError(`Document not found: ${input.path}`);
    }

    let nextRaw = input.raw;
    if (!nextRaw) {
      const parsed = parseMarkdown(current.content);
      nextRaw = serializeMarkdown({
        title: parsed.frontmatter.title,
        owners: parsed.frontmatter.owners,
        tags: parsed.frontmatter.tags,
        visibility: parsed.frontmatter.visibility,
        createdAt: parsed.frontmatter.createdAt,
        updatedAt: new Date().toISOString(),
        body: input.body ?? parsed.body
      });
    } else {
      nextRaw = updateMarkdownTimestamp(nextRaw);
      parseMarkdown(nextRaw);
    }

    const result = await this.options.git.write({
      path: repoPath,
      content: nextRaw,
      encoding: "utf8",
      message: `Update ${repoPath}`,
      author: this.commitAuthor(ctx),
      expectedSha: input.expectedSha
    });
    await this.indexDocument(input.spaceId, repoPath, result.objectSha ?? current.sha, nextRaw);
    await this.audit(ctx, "doc.update", input.spaceId, input.path, result.commitSha, `Updated ${input.path}`);
    return { ...result, repoPath };
  }

  async deleteDoc(ctx: RequestContext, spaceId: string, path: string, expectedSha?: string) {
    requireRepositoryRole(ctx, "write");
    const { space } = await requireSpaceRole(this.options.store, ctx.actor.id, spaceId, "write");
    const repoPath = toRepoDocPath(space, path);
    const result = await this.options.git.delete({
      path: repoPath,
      message: `Delete ${repoPath}`,
      author: this.commitAuthor(ctx),
      expectedSha
    });
    await this.options.store.deleteDocumentIndex(spaceId, path);
    await this.audit(ctx, "doc.delete", spaceId, path, result.commitSha, `Deleted ${path}`);
    return { ...result, repoPath };
  }

  async uploadAsset(ctx: RequestContext, input: UploadAssetInput) {
    requireRepositoryRole(ctx, "write");
    const { space } = await requireSpaceRole(this.options.store, ctx.actor.id, input.spaceId, "write");
    const repoPath = toRepoAssetPath(space, input.path);
    const result = await this.options.git.write({
      path: repoPath,
      content: input.contentBase64,
      encoding: "base64",
      message: `Upload asset ${repoPath}`,
      author: this.commitAuthor(ctx),
      expectedSha: input.expectedSha
    });
    await this.audit(ctx, "asset.upload", input.spaceId, input.path, result.commitSha, `Uploaded ${input.path}`);
    return { ...result, repoPath };
  }

  async moveDoc(ctx: RequestContext, input: MoveDocInput) {
    requireRepositoryRole(ctx, "write");
    const { space } = await requireSpaceRole(this.options.store, ctx.actor.id, input.spaceId, "write");
    const fromRepoPath = toRepoDocPath(space, input.fromPath);
    const toRepoPath = toRepoDocPath(space, input.toPath);
    const result = await this.options.git.move({
      fromPath: fromRepoPath,
      toPath: toRepoPath,
      message: `Move ${fromRepoPath} to ${toRepoPath}`,
      author: this.commitAuthor(ctx),
      expectedSha: input.expectedSha
    });
    const moved = await this.options.git.read(toRepoPath);
    if (moved) {
      await this.indexDocument(input.spaceId, toRepoPath, moved.sha, moved.content);
    }
    await this.options.store.deleteDocumentIndex(input.spaceId, input.fromPath);
    await this.audit(
      ctx,
      "doc.move",
      input.spaceId,
      input.toPath,
      result.commitSha,
      `Moved ${input.fromPath} to ${input.toPath}`
    );
    return { ...result, repoPath: toRepoPath };
  }

  async getDocHistory(ctx: RequestContext, spaceId: string, path: string) {
    requireRepositoryRole(ctx, "read");
    const { space } = await requireSpaceRole(this.options.store, ctx.actor.id, spaceId, "read");
    const repoPath = toRepoDocPath(space, path);
    await this.audit(ctx, "history.read", spaceId, path, undefined, `Read history for ${path}`);
    return this.options.git.history(repoPath);
  }

  async searchKnowledge(ctx: RequestContext, query: string, spaceId?: string): Promise<SearchResult[]> {
    requireRepositoryRole(ctx, "read");
    const spaces = spaceId
      ? [(await requireSpaceRole(this.options.store, ctx.actor.id, spaceId, "read")).space]
      : await this.options.store.listSpacesForUser(ctx.actor.id);

    const results = await this.options.store.searchDocumentIndex(spaces.map((space) => space.id), query);
    await this.audit(ctx, "search", spaceId, undefined, undefined, `Searched knowledge for "${query}"`);
    return results;
  }

  async summarizeSpace(ctx: RequestContext, spaceId: string) {
    const docs = await this.listDocs(ctx, spaceId);
    await this.audit(ctx, "summary.read", spaceId, undefined, undefined, `Summarized ${spaceId}`);
    return {
      spaceId,
      documentCount: docs.length,
      titles: docs.map((doc) => doc.title),
      tags: [...new Set(docs.flatMap((doc) => doc.tags))].sort()
    };
  }

  async proposeEdit(ctx: RequestContext, input: UpdateDocInput) {
    requireRepositoryRole(ctx, "read");
    const current = await this.readDoc(ctx, input.spaceId, input.path);
    await this.audit(ctx, "edit.propose", input.spaceId, input.path, undefined, `Proposed edit for ${input.path}`);
    return {
      path: input.path,
      currentSha: current.sha,
      proposedRaw: input.raw ?? serializeMarkdown({
        title: current.frontmatter.title,
        owners: current.frontmatter.owners,
        tags: current.frontmatter.tags,
        visibility: current.frontmatter.visibility,
        createdAt: current.frontmatter.createdAt,
        updatedAt: new Date().toISOString(),
        body: input.body ?? current.body
      })
    };
  }

  async listAuditLogs(ctx: RequestContext, spaceId: string): Promise<AuditLogEntry[]> {
    requireRepositoryRole(ctx, "admin");
    await requireSpaceRole(this.options.store, ctx.actor.id, spaceId, "admin");
    return this.options.store.listAuditLogs(spaceId);
  }

  async reindexSpace(ctx: RequestContext, spaceId: string): Promise<{ indexed: number }> {
    requireRepositoryRole(ctx, "admin");
    const { space } = await requireSpaceRole(this.options.store, ctx.actor.id, spaceId, "admin");
    const objects = await this.options.git.list(spaceDocsPrefix(space));
    let indexed = 0;
    for (const object of objects) {
      if (object.path.endsWith(".md") && object.encoding === "utf8") {
        await this.indexDocument(spaceId, object.path, object.sha, object.content);
        indexed += 1;
      }
    }
    await this.audit(ctx, "index.rebuild", spaceId, undefined, undefined, `Reindexed ${indexed} documents`);
    return { indexed };
  }

  private commitAuthor(ctx: RequestContext): CommitAuthor {
    return {
      name: ctx.actor.displayName || ctx.actor.githubLogin,
      email: ctx.actor.githubEmail
    };
  }

  private async audit(
    ctx: RequestContext,
    action: AuditAction,
    spaceId: string | undefined,
    path: string | undefined,
    commitSha: string | undefined,
    summary: string
  ): Promise<void> {
    await this.options.store.appendAuditLog({
      id: `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      actorUserId: ctx.actor.id,
      spaceId,
      action,
      path,
      commitSha,
      source: ctx.source,
      summary,
      createdAt: new Date().toISOString()
    });
  }

  private async indexDocument(spaceId: string, repoPath: string, sha: string, raw: string): Promise<void> {
    const space = await this.options.store.getSpace(spaceId);
    if (!space) {
      throw new NotFoundError(`Space not found: ${spaceId}`);
    }
    const parsed = parseMarkdown(raw);
    await this.options.store.upsertDocumentIndex({
      spaceId,
      path: fromRepoDocPath(space, repoPath),
      repoPath,
      sha,
      title: parsed.frontmatter.title,
      tags: parsed.frontmatter.tags,
      updatedAt: parsed.frontmatter.updatedAt,
      content: parsed.body
    });
  }
}
