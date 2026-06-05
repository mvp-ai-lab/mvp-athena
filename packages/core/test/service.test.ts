import { beforeEach, describe, expect, it } from "vitest";
import {
  ConflictError,
  ForbiddenError,
  InMemoryGitProvider,
  InMemoryKnowledgeStore,
  KnowledgeService,
  serializeMarkdown,
  type RequestContext,
  type User
} from "../src/index.js";

const owner: User = {
  id: "owner",
  githubLogin: "alice",
  githubEmail: "alice@example.com",
  displayName: "Alice"
};

const viewer: User = {
  id: "viewer",
  githubLogin: "bob",
  githubEmail: "bob@example.com",
  displayName: "Bob"
};

const outsider: User = {
  id: "outsider",
  githubLogin: "eve",
  githubEmail: "eve@example.com",
  displayName: "Eve"
};

function ctx(actor: User): RequestContext {
  return { actor, source: "api" };
}

describe("KnowledgeService", () => {
  let service: KnowledgeService;

  beforeEach(() => {
    const store = new InMemoryKnowledgeStore({
      users: [owner, viewer, outsider],
      spaces: [
        { id: "team", name: "Team", rootPath: "spaces/team" },
        { id: "private", name: "Private", rootPath: "spaces/private" }
      ],
      memberships: [
        { userId: owner.id, spaceId: "team", role: "owner" },
        { userId: viewer.id, spaceId: "team", role: "viewer" },
        { userId: owner.id, spaceId: "private", role: "owner" }
      ]
    });
    const git = new InMemoryGitProvider([
      {
        path: "spaces/team/docs/runbook.md",
        encoding: "utf8",
        content: serializeMarkdown({
          title: "Runbook",
          owners: ["alice"],
          tags: ["ops"],
          body: "Restart production carefully."
        })
      },
      {
        path: "spaces/private/docs/strategy.md",
        encoding: "utf8",
        content: serializeMarkdown({
          title: "Strategy",
          owners: ["alice"],
          tags: ["private"],
          body: "Secret roadmap."
        })
      }
    ]);
    service = new KnowledgeService({ store, git });
  });

  it("allows a viewer to read but not write", async () => {
    await expect(service.readDoc(ctx(viewer), "team", "runbook.md")).resolves.toMatchObject({
      frontmatter: { title: "Runbook" }
    });

    await expect(
      service.updateDoc(ctx(viewer), { spaceId: "team", path: "runbook.md", body: "nope" })
    ).rejects.toThrow(ForbiddenError);
  });

  it("blocks outsiders before document access", async () => {
    await expect(service.readDoc(ctx(outsider), "team", "runbook.md")).rejects.toThrow(ForbiddenError);
  });

  it("creates, updates, and audits a document", async () => {
    const created = await service.createDoc(ctx(owner), {
      spaceId: "team",
      path: "onboarding.md",
      title: "Onboarding",
      body: "Welcome."
    });
    const updated = await service.updateDoc(ctx(owner), {
      spaceId: "team",
      path: "onboarding.md",
      body: "Welcome to Athena.",
      expectedSha: created.objectSha
    });
    const history = await service.getDocHistory(ctx(owner), "team", "onboarding.md");
    const audit = await service.listAuditLogs(ctx(owner), "team");

    expect(updated.commitSha).toMatch(/^commit_/);
    expect(history).toHaveLength(2);
    expect(audit.map((entry) => entry.action)).toContain("doc.create");
    expect(audit.map((entry) => entry.action)).toContain("doc.update");
  });

  it("prevents create from overwriting an existing document", async () => {
    await expect(
      service.createDoc(ctx(owner), {
        spaceId: "team",
        path: "runbook.md",
        title: "Duplicate",
        body: "No"
      })
    ).rejects.toThrow(ConflictError);
  });

  it("detects expected SHA conflicts", async () => {
    await expect(
      service.updateDoc(ctx(owner), {
        spaceId: "team",
        path: "runbook.md",
        body: "change",
        expectedSha: "wrong"
      })
    ).rejects.toThrow(ConflictError);
  });

  it("filters search results to spaces visible to the user", async () => {
    const viewerResults = await service.searchKnowledge(ctx(viewer), "roadmap");
    const ownerResults = await service.searchKnowledge(ctx(owner), "roadmap");

    expect(viewerResults).toHaveLength(0);
    expect(ownerResults).toHaveLength(1);
    expect(ownerResults[0]?.spaceId).toBe("private");
  });

  it("uploads assets under the space assets prefix", async () => {
    const result = await service.uploadAsset(ctx(owner), {
      spaceId: "team",
      path: "diagrams/flow.png",
      contentBase64: Buffer.from("fake-image").toString("base64")
    });

    expect(result.repoPath).toBe("spaces/team/assets/diagrams/flow.png");
  });
});
