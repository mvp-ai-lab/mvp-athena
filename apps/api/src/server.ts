import fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AthenaError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
  type KnowledgeService,
  type RequestContext
} from "@mvp-athena/core";
import type { AuthService } from "./auth.js";

export interface ServerOptions {
  service: KnowledgeService;
  authService?: AuthService;
  webhookSecret?: string;
  bodyLimitBytes?: number;
  createContext(request: FastifyRequest, source: RequestContext["source"]): Promise<RequestContext> | RequestContext;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = fastify({ logger: true, bodyLimit: options.bodyLimitBytes ?? 10 * 1024 * 1024 });
  const { service } = options;
  const authLimiter = createRateLimiter(60_000, 120);

  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const rawBody = typeof body === "string" ? body : body.toString("utf8");
    (request as FastifyRequest & { rawBody?: string }).rawBody = rawBody;
    try {
      done(null, rawBody ? JSON.parse(rawBody) : {});
    } catch (error) {
      done(error as Error);
    }
  });

  function createContext(request: FastifyRequest, source: RequestContext["source"] = "api") {
    return options.createContext(request, source);
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AthenaError) {
      void reply.status(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    if (isFastifyValidationError(error)) {
      void reply.status(400).send({ error: "validation_error", message: error.message });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({ error: "internal_error", message: "Internal server error" });
  });

  app.get("/healthz", { schema: { response: { 200: objectSchema({ ok: { type: "boolean" } }) } } }, async () => ({ ok: true }));

  app.post("/auth/github/device", async (request) => {
    authLimiter.check(request.ip);
    if (!options.authService) {
      throw new ServiceUnavailableError("Auth service is not configured");
    }
    return options.authService.startGitHubDeviceFlow();
  });

  app.post("/auth/github/device/poll", {
    schema: {
      body: objectSchema({
        deviceCode: nonEmptyStringSchema,
        tokenName: optionalStringSchema
      })
    }
  }, async (request) => {
    authLimiter.check(request.ip);
    if (!options.authService) {
      throw new ServiceUnavailableError("Auth service is not configured");
    }
    const body = request.body as { deviceCode: string; tokenName?: string };
    return options.authService.pollGitHubDeviceFlow(body.deviceCode, body.tokenName);
  });

  app.get("/auth/me", async (request) => {
    const ctx = await createContext(request);
    return ctx.actor;
  });

  app.get("/auth/tokens", async (request) => {
    if (!options.authService) {
      throw new ServiceUnavailableError("Auth service is not configured");
    }
    const ctx = await createContext(request);
    return options.authService.listTokens(ctx.actor);
  });

  app.delete("/auth/tokens/current", async (request, reply) => {
    if (!options.authService) {
      throw new ServiceUnavailableError("Auth service is not configured");
    }
    const ctx = await createContext(request);
    await options.authService.revokeToken(ctx.actor, requireBearerToken(request));
    return reply.status(204).send();
  });

  app.get("/spaces", async (request) => service.listSpaces(await createContext(request)));

  app.get("/spaces/:spaceId/docs", { schema: { params: spaceParamsSchema } }, async (request) => {
    const { spaceId } = request.params as { spaceId: string };
    return service.listDocs(await createContext(request), spaceId);
  });

  app.get("/spaces/:spaceId/docs/*", { schema: { params: wildcardPathParamsSchema } }, async (request) => {
    const { spaceId, "*": path } = request.params as { spaceId: string; "*": string };
    return service.readDoc(await createContext(request), spaceId, path);
  });

  app.post("/spaces/:spaceId/docs", {
    schema: {
      params: spaceParamsSchema,
      body: objectSchema({
        path: nonEmptyStringSchema,
        title: nonEmptyStringSchema,
        body: stringSchema,
        owners: stringArraySchema,
        tags: stringArraySchema,
        visibility: optionalStringSchema
      })
    }
  }, async (request) => {
    const { spaceId } = request.params as { spaceId: string };
    const body = request.body as {
      path: string;
      title: string;
      body: string;
      owners?: string[];
      tags?: string[];
      visibility?: string;
    };
    return service.createDoc(await createContext(request), { spaceId, ...body });
  });

  app.patch("/spaces/:spaceId/docs/*", {
    schema: {
      params: wildcardPathParamsSchema,
      body: objectSchema({
        raw: optionalStringSchema,
        body: optionalStringSchema,
        expectedSha: optionalStringSchema
      })
    }
  }, async (request) => {
    const { spaceId, "*": path } = request.params as { spaceId: string; "*": string };
    const body = request.body as { raw?: string; body?: string; expectedSha?: string };
    return service.updateDoc(await createContext(request), { spaceId, path, ...body });
  });

  app.delete("/spaces/:spaceId/docs/*", {
    schema: {
      params: wildcardPathParamsSchema,
      querystring: objectSchema({ expectedSha: optionalStringSchema })
    }
  }, async (request) => {
    const { spaceId, "*": path } = request.params as { spaceId: string; "*": string };
    const query = request.query as { expectedSha?: string };
    return service.deleteDoc(await createContext(request), spaceId, path, query.expectedSha);
  });

  app.post("/spaces/:spaceId/move-doc/*", {
    schema: {
      params: wildcardPathParamsSchema,
      body: objectSchema({
        toPath: nonEmptyStringSchema,
        expectedSha: optionalStringSchema
      })
    }
  }, async (request) => {
    const { spaceId, "*": fromPath } = request.params as { spaceId: string; "*": string };
    const body = request.body as { toPath: string; expectedSha?: string };
    return service.moveDoc(await createContext(request), {
      spaceId,
      fromPath,
      toPath: body.toPath,
      expectedSha: body.expectedSha
    });
  });

  app.post("/spaces/:spaceId/assets", {
    schema: {
      params: spaceParamsSchema,
      body: objectSchema({
        path: nonEmptyStringSchema,
        contentBase64: nonEmptyStringSchema,
        expectedSha: optionalStringSchema
      })
    }
  }, async (request) => {
    const { spaceId } = request.params as { spaceId: string };
    const body = request.body as { path: string; contentBase64: string; expectedSha?: string };
    return service.uploadAsset(await createContext(request), { spaceId, ...body });
  });

  app.get("/spaces/:spaceId/search", {
    schema: {
      params: spaceParamsSchema,
      querystring: objectSchema({ q: optionalStringSchema })
    }
  }, async (request) => {
    const { spaceId } = request.params as { spaceId: string };
    const { q } = request.query as { q?: string };
    return service.searchKnowledge(await createContext(request), q ?? "", spaceId);
  });

  app.get("/search", { schema: { querystring: objectSchema({ q: optionalStringSchema }) } }, async (request) => {
    const { q } = request.query as { q?: string };
    return service.searchKnowledge(await createContext(request), q ?? "");
  });

  app.get("/spaces/:spaceId/summary", { schema: { params: spaceParamsSchema } }, async (request) => {
    const { spaceId } = request.params as { spaceId: string };
    return service.summarizeSpace(await createContext(request), spaceId);
  });

  app.get("/spaces/:spaceId/history/*", { schema: { params: wildcardPathParamsSchema } }, async (request) => {
    const { spaceId, "*": path } = request.params as { spaceId: string; "*": string };
    return service.getDocHistory(await createContext(request), spaceId, path);
  });

  app.post("/spaces/:spaceId/propose-edit/*", {
    schema: {
      params: wildcardPathParamsSchema,
      body: objectSchema({
        raw: optionalStringSchema,
        body: optionalStringSchema,
        expectedSha: optionalStringSchema
      })
    }
  }, async (request) => {
    const { spaceId, "*": path } = request.params as { spaceId: string; "*": string };
    const body = request.body as { raw?: string; body?: string; expectedSha?: string };
    return service.proposeEdit(await createContext(request), { spaceId, path, ...body });
  });

  app.get("/spaces/:spaceId/audit", { schema: { params: spaceParamsSchema } }, async (request) => {
    const { spaceId } = request.params as { spaceId: string };
    return service.listAuditLogs(await createContext(request), spaceId);
  });

  app.post("/spaces/:spaceId/reindex", { schema: { params: spaceParamsSchema } }, async (request) => {
    const { spaceId } = request.params as { spaceId: string };
    return service.reindexSpace(await createContext(request), spaceId);
  });

  app.post("/github/webhook", async (request, reply) => {
    verifyGitHubWebhook(request, options.webhookSecret);
    request.log.info({ event: request.headers["x-github-event"], delivery: request.headers["x-github-delivery"] }, "Received GitHub webhook");
    return reply.status(202).send({ accepted: true });
  });

  return app;
}

const stringSchema = { type: "string" } as const;
const nonEmptyStringSchema = { type: "string", minLength: 1 } as const;
const optionalStringSchema = { type: "string" } as const;
const stringArraySchema = { type: "array", items: stringSchema } as const;

const spaceParamsSchema = objectSchema({ spaceId: nonEmptyStringSchema });
const wildcardPathParamsSchema = objectSchema({ spaceId: nonEmptyStringSchema, "*": nonEmptyStringSchema });

function objectSchema(properties: Record<string, unknown>, required?: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: required ?? Object.entries(properties)
      .filter(([, schema]) => !isOptionalSchema(schema))
      .map(([key]) => key)
  };
}

function isOptionalSchema(schema: unknown): boolean {
  return schema === optionalStringSchema || schema === stringArraySchema;
}

function requireBearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing bearer token");
  }
  return authorization.slice("Bearer ".length);
}

function verifyGitHubWebhook(request: FastifyRequest, secret: string | undefined): void {
  if (!secret) {
    throw new ValidationError("GITHUB_WEBHOOK_SECRET is required for GitHub webhooks");
  }
  const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody;
  if (rawBody === undefined) {
    throw new ValidationError("Webhook raw body is unavailable");
  }
  const signature = request.headers["x-hub-signature-256"];
  if (typeof signature !== "string" || !signature.startsWith("sha256=")) {
    throw new UnauthorizedError("Missing GitHub webhook signature");
  }
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  if (!constantTimeEqual(signature, expected)) {
    throw new UnauthorizedError("Invalid GitHub webhook signature");
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function createRateLimiter(windowMs: number, maxRequests: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    check(key: string): void {
      const now = Date.now();
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return;
      }
      bucket.count += 1;
      if (bucket.count > maxRequests) {
        throw new TooManyRequestsError("Too many authentication requests");
      }
    }
  };
}

function isFastifyValidationError(error: unknown): error is Error & { statusCode: number } {
  return error instanceof Error && "statusCode" in error && (error as { statusCode?: number }).statusCode === 400;
}
