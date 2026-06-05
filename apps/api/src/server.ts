import fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { AthenaError, type KnowledgeService, type RequestContext } from "@mvp-athena/core";
import type { AuthService } from "./auth.js";

export interface ServerOptions {
  service: KnowledgeService;
  authService?: AuthService;
  createContext(request: FastifyRequest, source: RequestContext["source"]): Promise<RequestContext> | RequestContext;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = fastify({ logger: true });
  const { service } = options;

  function createContext(request: FastifyRequest, source: RequestContext["source"] = "api") {
    return options.createContext(request, source);
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AthenaError) {
      void reply.status(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({ error: "internal_error", message: "Internal server error" });
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/auth/github/device", async () => {
    if (!options.authService) {
      throw new Error("Auth service is not configured");
    }
    return options.authService.startGitHubDeviceFlow();
  });

  app.post("/auth/github/device/poll", async (request) => {
    if (!options.authService) {
      throw new Error("Auth service is not configured");
    }
    const body = request.body as { deviceCode?: string; tokenName?: string };
    return options.authService.pollGitHubDeviceFlow(body.deviceCode ?? "", body.tokenName);
  });

  app.get("/auth/me", async (request) => {
    const ctx = await createContext(request);
    return ctx.actor;
  });

  app.get("/spaces", async (request) => service.listSpaces(await createContext(request)));

  app.get("/spaces/:spaceId/docs", async (request) => {
    const { spaceId } = request.params as { spaceId: string };
    return service.listDocs(await createContext(request), spaceId);
  });

  app.get("/spaces/:spaceId/docs/*", async (request) => {
    const { spaceId, "*": path } = request.params as { spaceId: string; "*": string };
    return service.readDoc(await createContext(request), spaceId, path);
  });

  app.post("/spaces/:spaceId/docs", async (request) => {
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

  app.patch("/spaces/:spaceId/docs/*", async (request) => {
    const { spaceId, "*": path } = request.params as { spaceId: string; "*": string };
    const body = request.body as { raw?: string; body?: string; expectedSha?: string };
    return service.updateDoc(await createContext(request), { spaceId, path, ...body });
  });

  app.delete("/spaces/:spaceId/docs/*", async (request) => {
    const { spaceId, "*": path } = request.params as { spaceId: string; "*": string };
    const query = request.query as { expectedSha?: string };
    return service.deleteDoc(await createContext(request), spaceId, path, query.expectedSha);
  });

  app.post("/spaces/:spaceId/move-doc/*", async (request) => {
    const { spaceId, "*": fromPath } = request.params as { spaceId: string; "*": string };
    const body = request.body as { toPath: string; expectedSha?: string };
    return service.moveDoc(await createContext(request), {
      spaceId,
      fromPath,
      toPath: body.toPath,
      expectedSha: body.expectedSha
    });
  });

  app.post("/spaces/:spaceId/assets", async (request) => {
    const { spaceId } = request.params as { spaceId: string };
    const body = request.body as { path: string; contentBase64: string; expectedSha?: string };
    return service.uploadAsset(await createContext(request), { spaceId, ...body });
  });

  app.get("/spaces/:spaceId/search", async (request) => {
    const { spaceId } = request.params as { spaceId: string };
    const { q } = request.query as { q?: string };
    return service.searchKnowledge(await createContext(request), q ?? "", spaceId);
  });

  app.get("/search", async (request) => {
    const { q } = request.query as { q?: string };
    return service.searchKnowledge(await createContext(request), q ?? "");
  });

  app.get("/spaces/:spaceId/summary", async (request) => {
    const { spaceId } = request.params as { spaceId: string };
    return service.summarizeSpace(await createContext(request), spaceId);
  });

  app.get("/spaces/:spaceId/history/*", async (request) => {
    const { spaceId, "*": path } = request.params as { spaceId: string; "*": string };
    return service.getDocHistory(await createContext(request), spaceId, path);
  });

  app.post("/spaces/:spaceId/propose-edit/*", async (request) => {
    const { spaceId, "*": path } = request.params as { spaceId: string; "*": string };
    const body = request.body as { raw?: string; body?: string; expectedSha?: string };
    return service.proposeEdit(await createContext(request), { spaceId, path, ...body });
  });

  app.get("/spaces/:spaceId/audit", async (request) => {
    const { spaceId } = request.params as { spaceId: string };
    return service.listAuditLogs(await createContext(request), spaceId);
  });

  app.post("/github/webhook", async (request, reply) => {
    request.log.info({ headers: request.headers }, "Received GitHub webhook");
    return reply.status(202).send({ accepted: true });
  });

  return app;
}
