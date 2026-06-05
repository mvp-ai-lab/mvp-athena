import { describe, expect, it } from "vitest";
import { normalizeDocPath, normalizeRelativePath, toRepoDocPath, ValidationError } from "../src/index.js";

describe("path normalization", () => {
  it("normalizes slash style and trims leading slashes", () => {
    expect(normalizeRelativePath("/foo//bar\\baz.md")).toBe("foo/bar/baz.md");
  });

  it("rejects traversal segments", () => {
    expect(() => normalizeDocPath("../secrets.md")).toThrow(ValidationError);
    expect(() => normalizeDocPath("team/../../secrets.md")).toThrow(ValidationError);
  });

  it("requires Markdown extension for docs", () => {
    expect(() => normalizeDocPath("notes.txt")).toThrow(ValidationError);
  });

  it("builds repository document paths under the space root", () => {
    expect(toRepoDocPath({ id: "team", name: "Team", rootPath: "spaces/team" }, "guide.md")).toBe(
      "spaces/team/docs/guide.md"
    );
  });
});
