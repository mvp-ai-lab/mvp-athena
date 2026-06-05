import { InMemoryGitProvider, InMemoryKnowledgeStore, KnowledgeService, serializeMarkdown } from "@mvp-athena/core";
import type { RequestContext, User } from "@mvp-athena/core";

export const devUser: User = {
  id: "dev-user",
  githubLogin: "dev-user",
  githubEmail: "dev-user@example.com",
  displayName: "Dev User"
};

const teamSpace = {
  id: "team",
  name: "Team Knowledge",
  rootPath: "spaces/team",
  description: "Default development space"
};

export function createDevService(): KnowledgeService {
  const store = new InMemoryKnowledgeStore({
    users: [devUser],
    spaces: [teamSpace],
    memberships: [{ userId: devUser.id, spaceId: teamSpace.id, role: "owner" }]
  });
  const git = new InMemoryGitProvider([
    {
      path: "spaces/team/docs/welcome.md",
      encoding: "utf8",
      content: serializeMarkdown({
        title: "Welcome",
        owners: [devUser.githubLogin],
        tags: ["getting-started"],
        body: "This is the starter knowledge document for MVP Athena."
      })
    }
  ]);

  return new KnowledgeService({ store, git });
}

export function createContext(source: RequestContext["source"] = "api"): RequestContext {
  return { actor: devUser, source };
}
