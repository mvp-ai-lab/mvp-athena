#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { AthenaApiClient } from "./api-client.js";
import { configPath, loadConfig, saveConfig, type ClientConfig } from "./config.js";

const program = new Command();

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function getClient(): Promise<AthenaApiClient> {
  const config = await loadConfig();
  return new AthenaApiClient(
    process.env.ATHENA_API_URL ?? config.apiUrl ?? "http://127.0.0.1:3000",
    process.env.ATHENA_TOKEN ?? config.token
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

program
  .name("mvp-athena")
  .description("Agent-first team knowledge CLI")
  .version("0.1.0");

program
  .command("login")
  .description("Log in with GitHub App device flow")
  .option("--api-url <url>", "Athena API URL")
  .option("--token-name <name>", "Name for this client token", "cli")
  .option("--status", "Show the configured API endpoint and current token status")
  .action(async (options) => {
    const existing = await loadConfig();
    const apiUrl = options.apiUrl ?? process.env.ATHENA_API_URL ?? existing.apiUrl ?? "http://127.0.0.1:3000";

    if (options.status) {
      printJson({
        apiUrl,
        tokenConfigured: Boolean(process.env.ATHENA_TOKEN ?? existing.token),
        configPath: configPath(),
        user: existing.user
      });
      return;
    }

    const client = new AthenaApiClient(apiUrl);
    const started = await client.post<{
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      verificationUriComplete?: string;
      expiresIn: number;
      interval: number;
    }>("/auth/github/device");

    console.log(`Open: ${started.verificationUriComplete ?? started.verificationUri}`);
    console.log(`Code: ${started.userCode}`);
    console.log("Waiting for GitHub authorization...");

    let interval = started.interval;
    const expiresAt = Date.now() + started.expiresIn * 1000;
    while (Date.now() < expiresAt) {
      await wait(interval * 1000);
      const result = await client.post<{
        status: "pending" | "slow_down" | "authorized";
        interval?: number;
        token?: string;
        user?: ClientConfig["user"];
      }>("/auth/github/device/poll", {
        deviceCode: started.deviceCode,
        tokenName: options.tokenName
      });

      if (result.status === "authorized") {
        if (!result.token || !result.user) {
          throw new Error("Login completed without a token");
        }
        await saveConfig({ ...existing, apiUrl, token: result.token, user: result.user });
        console.log(`Logged in as ${result.user.githubLogin}`);
        console.log(`Config: ${configPath()}`);
        return;
      }
      if (result.status === "slow_down") {
        interval += 5;
      }
    }

    throw new Error("GitHub login timed out");
  });

program.command("spaces").description("List accessible spaces").action(async () => {
  const client = await getClient();
  printJson(await client.get("/spaces"));
});

program.command("search").argument("<query>").option("-s, --space <spaceId>").description("Search knowledge").action(async (query, options) => {
  const client = await getClient();
  const path = options.space
    ? `/spaces/${encodeURIComponent(options.space)}/search?q=${encodeURIComponent(query)}`
    : `/search?q=${encodeURIComponent(query)}`;
  printJson(await client.get(path));
});

program
  .command("read")
  .argument("<space>")
  .argument("<path>")
  .option("--raw", "Print the full Markdown document including frontmatter")
  .description("Read a Markdown document")
  .action(async (space, path, options) => {
    const client = await getClient();
    const doc = await client.get<{ body: string; raw: string }>(`/spaces/${encodeURIComponent(space)}/docs/${encodePath(path)}`);
    console.log(options.raw ? doc.raw : doc.body);
  });

program
  .command("create")
  .argument("<space>")
  .argument("<path>")
  .requiredOption("-t, --title <title>")
  .option("-f, --file <file>")
  .option("-b, --body <body>")
  .option("--tag <tag...>")
  .description("Create a Markdown document")
  .action(async (space, path, options) => {
    const client = await getClient();
    const body = options.file ? await readFile(options.file, "utf8") : (options.body ?? "");
    printJson(await client.post(`/spaces/${encodeURIComponent(space)}/docs`, {
      path,
      title: options.title,
      body,
      tags: options.tag ?? []
    }));
  });

program
  .command("update")
  .argument("<space>")
  .argument("<path>")
  .option("-f, --file <file>")
  .option("-b, --body <body>")
  .option("--raw")
  .option("--sha <expectedSha>")
  .description("Update a Markdown document")
  .action(async (space, path, options) => {
    const client = await getClient();
    const content = options.file ? await readFile(options.file, "utf8") : (options.body ?? "");
    printJson(await client.patch(`/spaces/${encodeURIComponent(space)}/docs/${encodePath(path)}`, {
      ...(options.raw ? { raw: content } : { body: content }),
      expectedSha: options.sha
    }));
  });

program.command("delete").argument("<space>").argument("<path>").option("--sha <expectedSha>").description("Delete a document").action(async (space, path, options) => {
  const client = await getClient();
  const query = options.sha ? `?expectedSha=${encodeURIComponent(options.sha)}` : "";
  printJson(await client.delete(`/spaces/${encodeURIComponent(space)}/docs/${encodePath(path)}${query}`));
});

program.command("upload").argument("<space>").argument("<assetPath>").argument("<file>").description("Upload an asset as Git LFS content").action(async (space, assetPath, file) => {
  const client = await getClient();
  const contentBase64 = (await readFile(file)).toString("base64");
  printJson(await client.post(`/spaces/${encodeURIComponent(space)}/assets`, { path: assetPath, contentBase64 }));
});

program.command("move").argument("<space>").argument("<fromPath>").argument("<toPath>").option("--sha <expectedSha>").description("Move a document").action(async (space, fromPath, toPath, options) => {
  const client = await getClient();
  printJson(await client.post(`/spaces/${encodeURIComponent(space)}/move-doc/${encodePath(fromPath)}`, { toPath, expectedSha: options.sha }));
});

program.command("history").argument("<space>").argument("<path>").description("Read document history").action(async (space, path) => {
  const client = await getClient();
  printJson(await client.get(`/spaces/${encodeURIComponent(space)}/history/${encodePath(path)}`));
});

program.command("summary").argument("<space>").description("Summarize a space index").action(async (space) => {
  const client = await getClient();
  printJson(await client.get(`/spaces/${encodeURIComponent(space)}/summary`));
});

async function main(): Promise<void> {
  await program.parseAsync();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
