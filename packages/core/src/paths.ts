import { ValidationError } from "./errors.js";
import type { Space } from "./types.js";

const unsafeSegment = /(^|\/)\.\.?(\/|$)/;

export function normalizeRelativePath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/").trim();
  if (!normalized || unsafeSegment.test(normalized) || normalized.includes("\0")) {
    throw new ValidationError(`Invalid path: ${input}`);
  }
  return normalized;
}

export function normalizeDocPath(input: string): string {
  const path = normalizeRelativePath(input);
  if (!path.endsWith(".md")) {
    throw new ValidationError("Document paths must end with .md");
  }
  return path;
}

export function normalizeAssetPath(input: string): string {
  return normalizeRelativePath(input);
}

export function spaceDocsPrefix(space: Space): string {
  return `${normalizeRelativePath(space.rootPath)}/docs/`;
}

export function spaceAssetsPrefix(space: Space): string {
  return `${normalizeRelativePath(space.rootPath)}/assets/`;
}

export function toRepoDocPath(space: Space, docPath: string): string {
  return `${spaceDocsPrefix(space)}${normalizeDocPath(docPath)}`;
}

export function toRepoAssetPath(space: Space, assetPath: string): string {
  return `${spaceAssetsPrefix(space)}${normalizeAssetPath(assetPath)}`;
}

export function fromRepoDocPath(space: Space, repoPath: string): string {
  const prefix = spaceDocsPrefix(space);
  if (!repoPath.startsWith(prefix)) {
    throw new ValidationError(`Path is outside docs prefix: ${repoPath}`);
  }
  return normalizeDocPath(repoPath.slice(prefix.length));
}
