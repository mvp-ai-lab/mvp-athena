import { ConflictError, NotFoundError } from "./errors.js";
import { parseMarkdown, serializeMarkdown, updateMarkdownTimestamp } from "./markdown.js";
import { requireSpaceRole } from "./permissions.js";
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
    return this.options.store.listSpacesForUser(ctx.actor.id);
  }

  async listDocs(ctx: RequestContext, spaceId: string): Promise<DocumentListItem[]> {
    const { space } = await requireSpaceRole(this.options.store, ctx.actor.id, spaceId, "read");
    const objects = await this.options.git.list(spaceDocsPrefix(space));
    return objects
      .filter((object) => object.path.endsWith(".md") && object.encoding === "utf8")
      .map((object) => {
        const parsed = parseMarkdown(object.content);
        return {
          spaceId,
          path: fromRepoDocPath(space, object.path),
          repoPath: object.path,
          sha: object.sha,
          title: parsed.frontmatter.title,
          tags: parsed.frontmatter.tags,
          updatedAt: parsed.frontmatter.updatedAt
        };
      });
  }

  async readDoc(ctx: RequestContext, spaceId: string, path: string): Promise<KnowledgeDocument> {
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
    await this.audit(ctx, "doc.create", input.spaceId, input.path, result.commitSha, `Created ${input.path}`);
    return { ...result, repoPath };
  }

  async updateDoc(ctx: RequestContext, input: UpdateDocInput) {
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
    await this.audit(ctx, "doc.update", input.spaceId, input.path, result.commitSha, `Updated ${input.path}`);
    return { ...result, repoPath };
  }

  async deleteDoc(ctx: RequestContext, spaceId: string, path: string, expectedSha?: string) {
    const { space } = await requireSpaceRole(this.options.store, ctx.actor.id, spaceId, "write");
    const repoPath = toRepoDocPath(space, path);
    const result = await this.options.git.delete({
      path: repoPath,
      message: `Delete ${repoPath}`,
      author: this.commitAuthor(ctx),
      expectedSha
    });
    await this.audit(ctx, "doc.delete", spaceId, path, result.commitSha, `Deleted ${path}`);
    return { ...result, repoPath };
  }

  async uploadAsset(ctx: RequestContext, input: UploadAssetInput) {
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
    const { space } = await requireSpaceRole(this.options.store, ctx.actor.id, spaceId, "read");
    const repoPath = toRepoDocPath(space, path);
    await this.audit(ctx, "history.read", spaceId, path, undefined, `Read history for ${path}`);
    return this.options.git.history(repoPath);
  }

  async searchKnowledge(ctx: RequestContext, query: string, spaceId?: string): Promise<SearchResult[]> {
    const spaces = spaceId
      ? [(await requireSpaceRole(this.options.store, ctx.actor.id, spaceId, "read")).space]
      : await this.options.store.listSpacesForUser(ctx.actor.id);

    const normalizedQuery = query.trim().toLowerCase();
    const results: SearchResult[] = [];
    for (const space of spaces) {
      const objects = await this.options.git.list(spaceDocsPrefix(space));
      for (const object of objects) {
        if (!object.path.endsWith(".md") || object.encoding !== "utf8") {
          continue;
        }
        const parsed = parseMarkdown(object.content);
        const haystack = `${parsed.frontmatter.title}\n${parsed.frontmatter.tags.join(" ")}\n${parsed.body}`.toLowerCase();
        if (!normalizedQuery || !haystack.includes(normalizedQuery)) {
          continue;
        }
        const index = haystack.indexOf(normalizedQuery);
        const snippetStart = Math.max(0, index - 80);
        const snippet = parsed.body.slice(snippetStart, snippetStart + 180).replace(/\s+/g, " ").trim();
        results.push({
          spaceId: space.id,
          path: fromRepoDocPath(space, object.path),
          title: parsed.frontmatter.title,
          snippet,
          score: normalizedQuery ? 1 / (1 + index) : 0,
          tags: parsed.frontmatter.tags
        });
      }
    }
    await this.audit(ctx, "search", spaceId, undefined, undefined, `Searched knowledge for "${query}"`);
    return results.sort((a, b) => b.score - a.score);
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
    await requireSpaceRole(this.options.store, ctx.actor.id, spaceId, "admin");
    return this.options.store.listAuditLogs(spaceId);
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
}
