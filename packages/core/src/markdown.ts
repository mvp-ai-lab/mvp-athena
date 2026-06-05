import { ValidationError } from "./errors.js";
import type { DocumentFrontmatter } from "./types.js";

const frontmatterPattern = /^---\n([\s\S]*?)\n---\n?/;

function readScalar(value: string): string {
  return value.replace(/^["']|["']$/g, "").trim();
}

function parseYamlSubset(input: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const lines = input.split("\n");
  let currentArrayKey: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      continue;
    }

    const arrayMatch = line.match(/^\s*-\s+(.+)$/);
    if (arrayMatch && currentArrayKey) {
      const existing = result[currentArrayKey];
      result[currentArrayKey] = Array.isArray(existing)
        ? [...existing, readScalar(arrayMatch[1] ?? "")]
        : [readScalar(arrayMatch[1] ?? "")];
      continue;
    }

    const keyValue = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!keyValue) {
      continue;
    }

    const key = keyValue[1] ?? "";
    const value = keyValue[2] ?? "";
    if (value === "") {
      result[key] = [];
      currentArrayKey = key;
      continue;
    }

    currentArrayKey = null;
    if (value.startsWith("[") && value.endsWith("]")) {
      result[key] = value
        .slice(1, -1)
        .split(",")
        .map((item) => readScalar(item))
        .filter(Boolean);
    } else {
      result[key] = readScalar(value);
    }
  }

  return result;
}

function toStringArray(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function parseMarkdown(raw: string): { frontmatter: DocumentFrontmatter; body: string } {
  const match = raw.match(frontmatterPattern);
  if (!match) {
    throw new ValidationError("Markdown document must include frontmatter");
  }

  const parsed = parseYamlSubset(match[1] ?? "");
  const title = typeof parsed.title === "string" ? parsed.title : "";
  if (!title) {
    throw new ValidationError("Markdown frontmatter requires title");
  }

  return {
    frontmatter: {
      title,
      owners: toStringArray(parsed.owners),
      tags: toStringArray(parsed.tags),
      visibility: typeof parsed.visibility === "string" ? parsed.visibility : "internal",
      createdAt: typeof parsed.created_at === "string" ? parsed.created_at : new Date(0).toISOString(),
      updatedAt: typeof parsed.updated_at === "string" ? parsed.updated_at : new Date(0).toISOString()
    },
    body: raw.slice(match[0].length)
  };
}

export function serializeMarkdown(input: {
  title: string;
  owners?: string[];
  tags?: string[];
  visibility?: string;
  body: string;
  createdAt?: string;
  updatedAt?: string;
}): string {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const owners = input.owners ?? [];
  const tags = input.tags ?? [];
  const visibility = input.visibility ?? "internal";

  const arrayBlock = (name: string, values: string[]) =>
    values.length === 0 ? `${name}: []` : `${name}:\n${values.map((value) => `  - ${value}`).join("\n")}`;

  return [
    "---",
    `title: ${input.title}`,
    arrayBlock("owners", owners),
    arrayBlock("tags", tags),
    `visibility: ${visibility}`,
    `created_at: ${createdAt}`,
    `updated_at: ${updatedAt}`,
    "---",
    "",
    input.body.trimEnd(),
    ""
  ].join("\n");
}

export function updateMarkdownTimestamp(raw: string, timestamp = new Date().toISOString()): string {
  const match = raw.match(frontmatterPattern);
  if (!match) {
    return raw;
  }
  const frontmatter = match[1] ?? "";
  const nextFrontmatter = frontmatter.includes("updated_at:")
    ? frontmatter.replace(/^updated_at:\s*.*$/m, `updated_at: ${timestamp}`)
    : `${frontmatter}\nupdated_at: ${timestamp}`;
  return raw.replace(frontmatterPattern, `---\n${nextFrontmatter}\n---\n`);
}
