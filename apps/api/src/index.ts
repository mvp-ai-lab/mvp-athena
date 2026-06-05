import { createRuntime } from "./runtime.js";
import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const runtime = createRuntime();

const server = buildServer(runtime);

await server.listen({ host, port });
