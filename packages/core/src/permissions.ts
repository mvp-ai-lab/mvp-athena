import { ForbiddenError, NotFoundError } from "./errors.js";
import type { KnowledgeStore, Role, Space } from "./types.js";

const roleRank: Record<Role, number> = {
  viewer: 1,
  editor: 2,
  owner: 3
};

export function canRead(role: Role): boolean {
  return roleRank[role] >= roleRank.viewer;
}

export function canWrite(role: Role): boolean {
  return roleRank[role] >= roleRank.editor;
}

export function canAdmin(role: Role): boolean {
  return roleRank[role] >= roleRank.owner;
}

export async function requireSpaceRole(
  store: KnowledgeStore,
  userId: string,
  spaceId: string,
  required: "read" | "write" | "admin"
): Promise<{ space: Space; role: Role }> {
  const space = await store.getSpace(spaceId);
  if (!space) {
    throw new NotFoundError(`Space not found: ${spaceId}`);
  }

  const membership = await store.getMembership(userId, spaceId);
  if (!membership) {
    throw new ForbiddenError(`User is not a member of space: ${spaceId}`);
  }

  const allowed =
    required === "read"
      ? canRead(membership.role)
      : required === "write"
        ? canWrite(membership.role)
        : canAdmin(membership.role);

  if (!allowed) {
    throw new ForbiddenError(`Role ${membership.role} cannot ${required} in space ${spaceId}`);
  }

  return { space, role: membership.role };
}
