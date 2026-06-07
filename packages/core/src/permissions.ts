import { ForbiddenError, NotFoundError } from "./errors.js";
import type { KnowledgeStore, RequestContext, Role, Space } from "./types.js";

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

export function roleAllows(role: Role, required: "read" | "write" | "admin"): boolean {
  return required === "read" ? canRead(role) : required === "write" ? canWrite(role) : canAdmin(role);
}

export function minRole(left: Role, right: Role): Role {
  return roleRank[left] <= roleRank[right] ? left : right;
}

export function requireRepositoryRole(ctx: RequestContext, required: "read" | "write" | "admin"): void {
  if (!ctx.repositoryRole) {
    return;
  }
  if (!roleAllows(ctx.repositoryRole, required)) {
    throw new ForbiddenError(`GitHub repository role ${ctx.repositoryRole} cannot ${required}`);
  }
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

  if (!roleAllows(membership.role, required)) {
    throw new ForbiddenError(`Role ${membership.role} cannot ${required} in space ${spaceId}`);
  }

  return { space, role: membership.role };
}
