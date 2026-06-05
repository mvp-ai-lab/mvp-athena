#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AthenaApiClient } from "./api-client.js";

const client = new AthenaApiClient();
const server = new McpServer({
  name: "mvp-athena",
  version: "0.1.0"
});

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

server.tool("list_spaces", "List spaces visible to the current user", {}, async () => {
  return textResult(await client.request("GET", "/spaces"));
});

server.tool(
  "search_knowledge",
  "Search Markdown knowledge documents visible to the current user",
  {
    query: z.string(),
    spaceId: z.string().optional()
  },
  async ({ query, spaceId }) => {
    const path = spaceId
      ? `/spaces/${encodeURIComponent(spaceId)}/search?q=${encodeURIComponent(query)}`
      : `/search?q=${encodeURIComponent(query)}`;
    return textResult(await client.request("GET", path));
  }
);

server.tool(
  "read_doc",
  "Read a Markdown document",
  {
    spaceId: z.string(),
    path: z.string()
  },
  async ({ spaceId, path }) => {
    return textResult(await client.request("GET", `/spaces/${encodeURIComponent(spaceId)}/docs/${path}`));
  }
);

server.tool(
  "create_doc",
  "Create a Markdown document",
  {
    spaceId: z.string(),
    path: z.string(),
    title: z.string(),
    body: z.string(),
    tags: z.array(z.string()).optional(),
    owners: z.array(z.string()).optional(),
    visibility: z.string().optional()
  },
  async (input) => {
    const { spaceId, ...body } = input;
    return textResult(await client.request("POST", `/spaces/${encodeURIComponent(spaceId)}/docs`, body));
  }
);

server.tool(
  "update_doc",
  "Update a Markdown document body or full raw Markdown",
  {
    spaceId: z.string(),
    path: z.string(),
    body: z.string().optional(),
    raw: z.string().optional(),
    expectedSha: z.string().optional()
  },
  async ({ spaceId, path, ...body }) => {
    return textResult(await client.request("PATCH", `/spaces/${encodeURIComponent(spaceId)}/docs/${path}`, body));
  }
);

server.tool(
  "delete_doc",
  "Delete a Markdown document",
  {
    spaceId: z.string(),
    path: z.string(),
    expectedSha: z.string().optional()
  },
  async ({ spaceId, path, expectedSha }) => {
    const query = expectedSha ? `?expectedSha=${encodeURIComponent(expectedSha)}` : "";
    return textResult(await client.request("DELETE", `/spaces/${encodeURIComponent(spaceId)}/docs/${path}${query}`));
  }
);

server.tool(
  "upload_asset",
  "Upload a base64 encoded asset into a space assets directory",
  {
    spaceId: z.string(),
    path: z.string(),
    contentBase64: z.string(),
    expectedSha: z.string().optional()
  },
  async ({ spaceId, ...body }) => {
    return textResult(await client.request("POST", `/spaces/${encodeURIComponent(spaceId)}/assets`, body));
  }
);

server.tool(
  "move_doc",
  "Move a Markdown document to a new path",
  {
    spaceId: z.string(),
    fromPath: z.string(),
    toPath: z.string(),
    expectedSha: z.string().optional()
  },
  async ({ spaceId, fromPath, toPath, expectedSha }) => {
    return textResult(
      await client.request("POST", `/spaces/${encodeURIComponent(spaceId)}/move-doc/${fromPath}`, { toPath, expectedSha })
    );
  }
);

server.tool(
  "get_doc_history",
  "Read Git commit history for a document",
  {
    spaceId: z.string(),
    path: z.string()
  },
  async ({ spaceId, path }) => {
    return textResult(await client.request("GET", `/spaces/${encodeURIComponent(spaceId)}/history/${path}`));
  }
);

server.tool(
  "summarize_space",
  "Summarize document count, titles, and tags for a space",
  {
    spaceId: z.string()
  },
  async ({ spaceId }) => {
    return textResult(await client.request("GET", `/spaces/${encodeURIComponent(spaceId)}/summary`));
  }
);

server.tool(
  "propose_edit",
  "Return a proposed edit payload without committing it",
  {
    spaceId: z.string(),
    path: z.string(),
    body: z.string().optional(),
    raw: z.string().optional()
  },
  async ({ spaceId, path, ...body }) => {
    return textResult(await client.request("POST", `/spaces/${encodeURIComponent(spaceId)}/propose-edit/${path}`, body));
  }
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
