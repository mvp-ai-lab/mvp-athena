import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ClientConfig {
  apiUrl?: string;
  token?: string;
}

export function loadConfig(): ClientConfig {
  try {
    const path = process.env.ATHENA_CONFIG_PATH ?? join(homedir(), ".config", "mvp-athena", "config.json");
    return JSON.parse(readFileSync(path, "utf8")) as ClientConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}
