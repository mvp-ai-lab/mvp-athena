import { describe, expect, it } from "vitest";
import { parseMarkdown, serializeMarkdown, updateMarkdownTimestamp, ValidationError } from "../src/index.js";

describe("markdown frontmatter", () => {
  it("serializes and parses the supported frontmatter subset", () => {
    const raw = serializeMarkdown({
      title: "Runbook",
      owners: ["alice"],
      tags: ["ops", "prod"],
      body: "Restart the service."
    });

    const parsed = parseMarkdown(raw);

    expect(parsed.frontmatter.title).toBe("Runbook");
    expect(parsed.frontmatter.owners).toEqual(["alice"]);
    expect(parsed.frontmatter.tags).toEqual(["ops", "prod"]);
    expect(parsed.body).toContain("Restart the service.");
  });

  it("rejects Markdown without frontmatter", () => {
    expect(() => parseMarkdown("# Missing")).toThrow(ValidationError);
  });

  it("updates the updated_at field in raw Markdown", () => {
    const raw = serializeMarkdown({ title: "Doc", body: "hello", updatedAt: "2026-01-01T00:00:00.000Z" });
    const next = updateMarkdownTimestamp(raw, "2026-06-05T00:00:00.000Z");

    expect(next).toContain("updated_at: 2026-06-05T00:00:00.000Z");
  });
});
