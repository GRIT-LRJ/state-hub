import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Binding, OccurrenceEventInput, StateClaimInput } from "@state-hub/protocol";
import { claimInputSchema, occurrenceInputSchema } from "@state-hub/protocol";
import { authenticateProducer, generateToken, registerProducer, safeTokenEqual } from "./auth.js";
import type { DriverRegistry } from "./drivers.js";
import type { DeliveryDispatcher } from "./dispatcher.js";
import type { HubEventBus } from "./events.js";
import { HubError, type PublishedConfig, type SnapshotClaim, type StateHubService } from "./service.js";
import { PluginDependencyError, PluginInstallError, PluginRepository } from "./plugin-repository.js";
import type { PluginRuntime } from "./plugin-runtime.js";

interface ServerOptions {
  service: StateHubService;
  events: HubEventBus;
  drivers: DriverRegistry;
  dispatcher: DeliveryDispatcher;
  adminToken: string;
  plugins?: PluginRepository;
  pluginRuntime?: PluginRuntime;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function producerIdFrom(request: FastifyRequest): string {
  return (request.params as { producerId: string }).producerId;
}

const idParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["producerId", "scopeId", "signalId"],
  properties: {
    producerId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    scopeId: { type: "string", minLength: 1, maxLength: 200 },
    signalId: { type: "string", minLength: 1, maxLength: 128 },
  },
} as const;

export function createServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, trustProxy: false });
  const plugins = options.plugins ?? new PluginRepository(options.service.db);
  app.addContentTypeParser("application/vnd.statehub.plugin", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
  const rate = new Map<string, { window: number; count: number }>();
  let pluginMutationTail = Promise.resolve();
  const mutatePlugin = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = pluginMutationTail;
    let release: () => void = () => undefined;
    pluginMutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); }
    finally { release(); }
  };

  let configMutationTail = Promise.resolve();
  const mutateConfig = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = configMutationTail;
    let release: () => void = () => undefined;
    configMutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); }
    finally { release(); }
  };

  const producerPolicy = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.headers.origin) {
      await reply.code(403).send({ error: { code: "BROWSER_ORIGIN_FORBIDDEN", message: "Producer API is not a browser API" } });
      return;
    }
    const producerId = producerIdFrom(request);
    const key = `${producerId}:${Math.floor(Date.now() / 1_000)}`;
    const bucket = rate.get(key) ?? { window: Date.now(), count: 0 };
    bucket.count += 1;
    rate.set(key, bucket);
    if (bucket.count > 250) {
      await reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Producer rate limit exceeded" } });
      return;
    }
    if (rate.size > 1_000) {
      const cutoff = Date.now() - 5_000;
      for (const [bucketKey, value] of rate) if (value.window < cutoff) rate.delete(bucketKey);
    }
  };

  const producerReadAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await producerPolicy(request, reply);
    if (reply.sent) return;
    const token = bearerToken(request);
    if (!token || !authenticateProducer(options.service.db, producerIdFrom(request), token)) {
      await reply.code(401).send({ error: { code: "UNAUTHORIZED_PRODUCER", message: "Invalid producer token" } });
    }
  };

  const adminAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const origin = request.headers.origin;
    if (origin && origin !== "tauri://localhost" && origin !== "http://tauri.localhost" && origin !== "https://tauri.localhost") {
      await reply.code(403).send({ error: { code: "ORIGIN_FORBIDDEN", message: "Admin API only accepts the Tauri origin" } });
      return;
    }
    const token = bearerToken(request);
    if (!token || !safeTokenEqual(token, options.adminToken)) {
      await reply.code(401).send({ error: { code: "UNAUTHORIZED_ADMIN", message: "Invalid private admin session" } });
    }
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof PluginDependencyError) {
      void reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, dependencies: error.dependencies },
      });
      return;
    }
    if (error instanceof PluginInstallError) {
      void reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof HubError) {
      void reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return;
    }
    if ((error as { validation?: unknown }).validation) {
      void reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: error instanceof Error ? error.message : "Invalid request" },
      });
      return;
    }
    void reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });

  app.get("/health/live", async () => ({ status: "ok", revision: options.service.db.currentRevision() }));

  app.put(
    "/api/v1/producers/:producerId/scopes/:scopeId/claims/:signalId",
    { preHandler: producerPolicy, schema: { params: idParamsSchema, body: claimInputSchema } },
    async (request, reply) => {
      const params = request.params as { producerId: string; scopeId: string; signalId: string };
      const result = options.service.upsertClaim(
        params.producerId,
        bearerToken(request),
        params.scopeId,
        params.signalId,
        request.body as StateClaimInput,
        request.headers["idempotency-key"] as string | undefined,
      );
      return await reply.code(202).send(result);
    },
  );

  app.post(
    "/api/v1/producers/:producerId/scopes/:scopeId/claims/:signalId(^.+)::clear",
    { preHandler: producerPolicy, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const params = request.params as { producerId: string; scopeId: string; signalId: string };
      return await reply.code(202).send(
        options.service.clearClaim(
          params.producerId,
          bearerToken(request),
          params.scopeId,
          params.signalId,
          request.headers["idempotency-key"] as string | undefined,
        ),
      );
    },
  );

  app.post(
    "/api/v1/producers/:producerId/events",
    {
      preHandler: producerPolicy,
      schema: {
        params: {
          type: "object",
          required: ["producerId"],
          properties: { producerId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" } },
        },
        body: occurrenceInputSchema,
      },
    },
    async (request, reply) => {
      const producerId = producerIdFrom(request);
      return await reply.code(202).send(
        options.service.emitEvent(
          producerId,
          bearerToken(request),
          request.body as OccurrenceEventInput,
          request.headers["idempotency-key"] as string | undefined,
        ),
      );
    },
  );

  app.put(
    "/api/v1/producers/:producerId/snapshot",
    {
      preHandler: producerPolicy,
      schema: {
        params: {
          type: "object",
          required: ["producerId"],
          properties: { producerId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["claims"],
          properties: {
            claims: {
              type: "array",
              maxItems: 500,
              items: {
                ...claimInputSchema,
                required: ["scopeId", "signalId", "value"],
                properties: {
                  ...claimInputSchema.properties,
                  scopeId: { type: "string", minLength: 1, maxLength: 200 },
                  signalId: { type: "string", minLength: 1, maxLength: 128 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { claims: SnapshotClaim[] };
      return await reply.code(202).send(
        options.service.replaceSnapshot(
          producerIdFrom(request),
          bearerToken(request),
          body.claims,
          request.headers["idempotency-key"] as string | undefined,
        ),
      );
    },
  );

  app.get(
    "/api/v1/producers/:producerId/commands/:commandId",
    { preHandler: producerReadAuth },
    async (request, reply) => {
      const params = request.params as { producerId: string; commandId: string };
      const result = options.service.getCommand(params.producerId, params.commandId);
      return result
        ? await reply.send(result)
        : await reply.code(404).send({ error: { code: "COMMAND_NOT_FOUND", message: "Command not found" } });
    },
  );

  app.get("/api/v1/admin/snapshot", { preHandler: adminAuth }, async () => options.service.snapshot());

  app.get("/api/v1/admin/bindings", { preHandler: adminAuth }, async () => ({ bindings: options.service.listBindings() }));

  app.get("/api/v1/admin/catalog", { preHandler: adminAuth }, async () => plugins.catalog());

  app.get("/api/v1/admin/plugins", { preHandler: adminAuth }, async () => ({ plugins: plugins.installed() }));
  app.get("/api/v1/admin/plugins/runtime", { preHandler: adminAuth }, async () =>
    ({ plugins: options.pluginRuntime?.statuses() ?? [] }));
  app.get("/api/v1/admin/plugins/:id/dependencies", { preHandler: adminAuth }, async (request) => {
    const { id } = request.params as { id: string };
    return { id, dependencies: plugins.dependencies(id) };
  });

  app.delete("/api/v1/admin/plugins/:id", { preHandler: adminAuth }, async (request) =>
    await mutatePlugin(async () => {
      const { id } = request.params as { id: string };
      const installed = plugins.installed().find((plugin) => plugin.id === id);
      if (!installed) throw new PluginInstallError("PLUGIN_NOT_FOUND", "Plugin package was not found", 404);
      const dependencies = plugins.dependencies(id);
      if (dependencies.driverInstances.length || dependencies.bindings.length ||
        dependencies.producers.length || dependencies.deliveries.length) {
        throw new PluginDependencyError(dependencies);
      }
      await options.pluginRuntime?.stop(id);
      try {
        plugins.uninstall(id);
      } catch (error) {
        if (installed.enabled) await options.pluginRuntime?.start(id);
        throw error;
      }
      options.drivers.invalidate();
      return { id, removed: true };
    }));


  app.post("/api/v1/admin/plugins/:id/disable", { preHandler: adminAuth }, async (request) =>
    await mutatePlugin(async () => {
      const { id } = request.params as { id: string };
      if (!plugins.installed().some((plugin) => plugin.id === id)) {
        throw new PluginInstallError("PLUGIN_NOT_FOUND", "Plugin package was not found", 404);
      }
      await options.pluginRuntime?.stop(id);
      plugins.setEnabled(id, false);
      options.drivers.invalidate();
      return { id, enabled: false };
    }));

  app.post("/api/v1/admin/plugins/:id/enable", { preHandler: adminAuth }, async (request) =>
    await mutatePlugin(async () => {
      const { id } = request.params as { id: string };
      const wasRunning = options.pluginRuntime?.statuses().some((entry) =>
        entry.id === id && entry.status === "running");
      plugins.setEnabled(id, true);
      const runtime = options.pluginRuntime ? await options.pluginRuntime.start(id) : undefined;
      options.drivers.invalidate();
      if (runtime?.status === "running" && !wasRunning) {
        for (const instanceId of plugins.driverInstanceIds(id)) {
          options.dispatcher.recoverCurrentStateful(instanceId);
        }
      }
      return { id, enabled: true, ...(runtime ? { runtime } : {}) };
    }));

  app.get("/api/v1/admin/plugins/trusted-publishers", { preHandler: adminAuth }, async () =>
    ({ publishers: plugins.trustedPublishers() }));

  app.post("/api/v1/admin/plugins/trusted-publishers", { preHandler: adminAuth }, async (request, reply) => {
    const body = request.body as { id?: unknown; publicKeyPem?: unknown } | null;
    if (!body || typeof body.id !== "string" || typeof body.publicKeyPem !== "string") {
      throw new PluginInstallError("INVALID_PUBLISHER", "Publisher ID and Ed25519 public key are required");
    }
    return await reply.code(201).send(plugins.trustPublisher(body.id, body.publicKeyPem));
  });

  app.post("/api/v1/admin/plugins/install", { onRequest: adminAuth, bodyLimit: 128 * 1024 * 1024 },
    async (request, reply) => await mutatePlugin(async () => {
      if (request.headers["content-type"] !== "application/vnd.statehub.plugin" || !Buffer.isBuffer(request.body)) {
        throw new PluginInstallError("INVALID_PLUGIN_UPLOAD", "A binary plugin package is required");
      }
      const installed = plugins.install(request.body);
      const runtime = options.pluginRuntime ? await options.pluginRuntime.start(installed.id) : undefined;
      return await reply.code(201).send({ ...installed, ...(runtime ? { runtime } : {}) });
    }));

  app.post("/api/v1/admin/producers", { preHandler: adminAuth }, async (request, reply) => {
    const body = request.body as { producerId?: string; sourceDefinitionId?: string };
    if (!body.producerId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(body.producerId)) {
      return await reply.code(400).send({ error: { code: "INVALID_PRODUCER_ID", message: "Invalid producer id" } });
    }
    if (
      body.sourceDefinitionId &&
      !plugins.sourceDefinition(body.sourceDefinitionId)
    ) {
      return await reply.code(400).send({ error: { code: "UNKNOWN_SOURCE_DEFINITION", message: "Unknown source definition" } });
    }
    const token = generateToken();
    registerProducer(options.service.db, body.producerId, token, body.sourceDefinitionId);
    return await reply.code(201).send({ producerId: body.producerId, token });
  });

  app.post("/api/v1/admin/outputs/pause", { preHandler: adminAuth }, async (request, reply) => {
    const body = request.body as { paused?: boolean };
    if (typeof body.paused !== "boolean") {
      return await reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "paused must be boolean" } });
    }
    options.service.setPaused(body.paused);
    return await reply.send({ paused: body.paused });
  });

  app.post("/api/v1/admin/acknowledgements", { preHandler: adminAuth }, async (request, reply) => {
    const body = request.body as {
      producerId?: string;
      scopeId?: string;
      signalId?: string;
      claimRevision?: number;
    };
    if (!body.producerId || !body.scopeId || !body.signalId || !Number.isInteger(body.claimRevision)) {
      return await reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Claim identity and revision are required" } });
    }
    options.service.acknowledge(body.producerId, body.scopeId, body.signalId, body.claimRevision as number);
    return await reply.code(204).send();
  });

  app.post("/api/v1/admin/config/drafts", { preHandler: adminAuth }, async (request, reply) => {
    const result = options.service.createConfigDraft(request.body as PublishedConfig);
    return await reply.code(201).send(result);
  });

  app.post("/api/v1/admin/config/drafts/:revision/publish", { preHandler: adminAuth }, async (request, reply) =>
    await mutateConfig(async () => {
      const revision = Number.parseInt((request.params as { revision: string }).revision, 10);
      options.dispatcher.stop();
      try {
        await options.dispatcher.waitForIdle();
        options.service.publishConfig(revision);
        options.drivers.invalidate();
        options.dispatcher.recoverCurrentStateful();
        return await reply.send({ revision, status: "published" });
      } finally {
        options.dispatcher.start();
      }
    }));

  app.post("/api/v1/admin/config/revisions/:revision/rollback", { preHandler: adminAuth }, async (request, reply) => {
    const sourceRevision = Number.parseInt((request.params as { revision: string }).revision, 10);
    const draft = options.service.createRollbackDraft(sourceRevision);
    return await reply.code(201).send({ ...draft, rolledBackFrom: sourceRevision, status: "draft" });
  });

  app.get("/api/v1/admin/config/export", { preHandler: adminAuth }, async (_request, reply) => {
    reply.header("content-disposition", 'attachment; filename="state-hub-config.json"');
    return await reply.send({ schemaVersion: 1, config: options.service.exportConfig(), secretsIncluded: false });
  });

  app.get("/api/v1/admin/diagnostics/preview", { preHandler: adminAuth }, async () =>
    options.service.diagnosticPreview(),
  );

  app.get("/api/v1/admin/diagnostics/export", { preHandler: adminAuth }, async (_request, reply) => {
    reply.header("content-disposition", 'attachment; filename="state-hub-support-bundle.json"');
    return await reply.send(options.service.diagnosticBundle());
  });

  app.get("/api/v1/admin/events", { preHandler: adminAuth }, async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(options.service.snapshot())}\n\n`);
    const unsubscribe = options.events.subscribe((event) => {
      reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    });
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return app;
}
