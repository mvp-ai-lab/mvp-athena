import { loadConfig } from "./config.js";

export class AthenaApiClient {
  constructor(
    private readonly baseUrl = process.env.ATHENA_API_URL ?? loadConfig().apiUrl ?? "http://127.0.0.1:3000",
    private readonly token = process.env.ATHENA_TOKEN ?? loadConfig().token
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }
}
