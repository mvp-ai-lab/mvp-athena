import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface ClientConfig {
  apiUrl?: string;
  token?: string;
  user?: {
    id: string;
    githubLogin: string;
    githubEmail: string;
    displayName: string;
  };
}

export function configPath(): string {
  return process.env.ATHENA_CONFIG_PATH ?? join(homedir(), ".config", "mvp-athena", "config.json");
}

export async function loadConfig(): Promise<ClientConfig> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as ClientConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function saveConfig(config: ClientConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
