import type { OpenCode } from "@opencode/sdk";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { runPrompt, type ChatEvent } from "./chat.js";
import type { Config } from "./config.js";
import type { EventHub } from "./event-hub.js";
import { errorMessage, HttpError } from "./logger.js";
import type { RagSource } from "./rag.js";
import type { Runtime } from "./runtime.js";

type Host = OpenCode.Interface;
type Session = Awaited<ReturnType<Host["session"]["get"]>>;

const ModelRef = z.object({
  providerID: z.string().min(1),
  id: z.string().min(1),
  variant: z.string().min(1).optional(),
});

const CreateSessionBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  agent: z.string().min(1).optional(),
  model: ModelRef.optional(),
});

const ListSessionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

const ListMessagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  order: z.enum(["asc", "desc"]).default("asc"),
  cursor: z.string().min(1).optional(),
});

const PromptBody = z.object({
  text: z.string().min(1).max(100_000),
  model: ModelRef.optional(),
  agent: z.string().min(1).optional(),
  stream: z.boolean().optional(),
});

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "connection": "keep-alive",
  "x-accel-buffering": "no",
} as const;

export function registerRoutes(app: FastifyInstance, runtime: Runtime, config: Config): void {
  app.get("/live", async () => ({
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get("/health", async (request, reply) => {
    const query = request.query as { deep?: string } | undefined;
    const force = query?.deep === "1" || query?.deep === "true";
    const report = await runtime.health.check(force);
    return reply.code(report.ready ? 200 : 503).send(report);
  });

  app.get("/api/info", async () => {
    const model = runtime.getDefaultModel();
    return {
      service: "opencode-web-assistant",
      version: process.env.APP_VERSION?.trim() || "0.1.0",
      model: model ? { providerID: model.providerID, id: model.modelID, name: model.name } : null,
      rag: {
        enabled: runtime.vectorStore.enabled,
        collection: config.vectorDbCollection,
      },
      features: {
        streaming: true,
        sessions: true,
      },
    };
  });

  app.get("/api/models", async () => {
    const host = runtime.requireHost();
    const result = await host.model.list(
      { types: ["chat"], location: { directory: config.workspaceDir } },
      { signal: AbortSignal.timeout(config.healthTimeoutMs * 3) },
    );
    return {
      data: result.data.map((model) => ({
        providerID: model.providerID,
        id: model.modelID,
        name: model.name,
        enabled: model.enabled,
      })),
    };
  });

  app.get("/api/agents", async () => {
    const host = runtime.requireHost();
    const result = await host.agent.list(
      { location: { directory: config.workspaceDir } },
      { signal: AbortSignal.timeout(config.healthTimeoutMs * 3) },
    );
    return {
      data: result.data.map((agent) => ({
        name: agent.name,
        description: agent.description,
        mode: agent.mode,
      })),
    };
  });

  app.get("/api/sessions", async (request) => {
    const query = ListSessionsQuery.parse(request.query ?? {});
    const host = runtime.requireHost();
    return host.session.list({
      limit: query.limit,
      order: "desc",
      directory: config.workspaceDir,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  });

  app.post("/api/sessions", async (request) => {
    const body = CreateSessionBody.parse(request.body ?? {});
    const host = runtime.requireHost();
    const defaultModel = runtime.getDefaultModel();

    const model =
      body.model ??
      (defaultModel
        ? { id: defaultModel.modelID, providerID: defaultModel.providerID }
        : undefined);
    const agent = body.agent ?? config.openCodeAgent;

    const session = await host.session.create({
      ...(body.title ? { title: body.title } : {}),
      location: { directory: config.workspaceDir },
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
    });

    return { session };
  });

  app.get("/api/sessions/:sessionID", async (request) => {
    const { sessionID } = request.params as { sessionID: string };
    const host = runtime.requireHost();
    return { session: await getSessionOr404(host, sessionID) };
  });

  app.delete("/api/sessions/:sessionID", async (request) => {
    const { sessionID } = request.params as { sessionID: string };
    const host = runtime.requireHost();
    await getSessionOr404(host, sessionID);
    await host.session.remove({ sessionID });
    return { ok: true };
  });

  app.get("/api/sessions/:sessionID/messages", async (request) => {
    const { sessionID } = request.params as { sessionID: string };
    const query = ListMessagesQuery.parse(request.query ?? {});
    const host = runtime.requireHost();
    await getSessionOr404(host, sessionID);

    return host.message.list({
      sessionID,
      limit: query.limit,
      order: query.order,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  });

  app.post("/api/sessions/:sessionID/interrupt", async (request) => {
    const { sessionID } = request.params as { sessionID: string };
    const host = runtime.requireHost();
    await getSessionOr404(host, sessionID);
    await host.session.interrupt({ sessionID });
    return { ok: true };
  });

  app.post("/api/sessions/:sessionID/messages", async (request, reply) => {
    const { sessionID } = request.params as { sessionID: string };
    const body = PromptBody.parse(request.body ?? {});
    const host = runtime.requireHost();
    const hub = runtime.requireHub();

    await getSessionOr404(host, sessionID);

    if (!runtime.acquireSession(sessionID)) {
      throw new HttpError(
        409,
        "session_busy",
        "A response is already being generated for this session",
      );
    }

    try {
      if (body.model) {
        await host.session.switchModel({ sessionID, model: body.model });
      }
      if (body.agent) {
        await host.session.switchAgent({ sessionID, agent: body.agent });
      }

      const ragSources = await prepareRagContext(runtime, host, sessionID, body.text);
      const promptText =
        ragSources.length > 0
          ? `${runtime.vectorStore.formatForPrompt(ragSources)}\nUser question:\n${body.text}`
          : body.text;

      const wantsJson =
        body.stream === false || (request.headers.accept ?? "").includes("application/json");

      if (wantsJson) {
        return await respondJson(runtime, host, hub, sessionID, promptText, ragSources);
      }

      return await respondSse(reply, runtime, host, hub, sessionID, promptText, ragSources, config);
    } catch (error) {
      runtime.releaseSession(sessionID);
      throw error;
    }
  });
}

async function respondJson(
  runtime: Runtime,
  host: Host,
  hub: EventHub,
  sessionID: string,
  text: string,
  sources: readonly RagSource[],
): Promise<unknown> {
  let lastError: Extract<ChatEvent, { type: "error" }> | undefined;

  try {
    const result = await runPrompt({
      host,
      hub,
      sessionID,
      text,
      timeoutMs: runtime.config.promptTimeoutMs,
      onEvent: (event) => {
        if (event.type === "error") lastError = event;
      },
    });

    if (lastError && result.answer.trim() === "") {
      throw new HttpError(502, "generation_failed", lastError.message);
    }

    return {
      text: result.answer,
      assistantMessageID: result.assistantMessageID ?? null,
      sources,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "generation_failed", errorMessage(error));
  } finally {
    runtime.releaseSession(sessionID);
  }
}

async function respondSse(
  reply: FastifyReply,
  runtime: Runtime,
  host: Host,
  hub: EventHub,
  sessionID: string,
  text: string,
  sources: readonly RagSource[],
  config: Config,
): Promise<void> {
  reply.hijack();
  const response = reply.raw;

  response.writeHead(200, {
    ...SSE_HEADERS,
    ...(config.corsOrigin ? { "access-control-allow-origin": config.corsOrigin } : {}),
  });
  response.flushHeaders?.();

  const abort = new AbortController();
  let closed = false;
  let terminal = false;

  const close = () => {
    if (closed) return;
    closed = true;
    abort.abort();
  };
  response.on("close", close);

  const write = (event: string, data: unknown) => {
    if (closed || response.writableEnded) return;
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const keepalive = setInterval(() => {
    if (!closed && !response.writableEnded) response.write(": ping\n\n");
  }, 15_000);
  keepalive.unref?.();

  if (sources.length > 0) {
    write("rag", {
      sources: sources.map((source) => ({
        text: source.text,
        ...(source.score !== undefined ? { score: source.score } : {}),
        ...(source.metadata ? { metadata: source.metadata } : {}),
      })),
    });
  }

  try {
    await runPrompt({
      host,
      hub,
      sessionID,
      text,
      timeoutMs: config.promptTimeoutMs,
      signal: abort.signal,
      onEvent: (event) => {
        if (event.type === "done" || event.type === "error") terminal = true;
        write(event.type, event);
      },
    });

    if (!terminal) write("done", {});
  } catch (error) {
    if (!terminal) write("error", { message: errorMessage(error) });
  } finally {
    clearInterval(keepalive);
    runtime.releaseSession(sessionID);
    if (!response.writableEnded) response.end();
  }
}

async function prepareRagContext(
  runtime: Runtime,
  host: Host,
  sessionID: string,
  userText: string,
): Promise<RagSource[]> {
  if (!runtime.vectorStore.enabled) return [];
  if (!(await isFirstPrompt(host, sessionID))) return [];

  try {
    return await runtime.vectorStore.search(userText);
  } catch (error) {
    // A vector database outage should not make chat unusable. The /health
    // endpoint already reports the failing dependency.
    runtime.log.warn({ err: error }, "RAG search failed; continuing without context");
    return [];
  }
}

async function isFirstPrompt(
  host: Host,
  sessionID: string,
): Promise<boolean> {
  const messages = await host.message.list({ sessionID, limit: 10 });
  return !messages.data.some((message) => {
    const type = (message as { type?: string }).type;
    return type === "user" || type === "assistant";
  });
}

async function getSessionOr404(
  host: Host,
  sessionID: string,
): Promise<Session> {
  try {
    return await host.session.get({ sessionID });
  } catch (error) {
    const tag = (error as { _tag?: string })?._tag;
    if (tag === "SessionNotFoundError") {
      throw new HttpError(404, "session_not_found", `Session ${sessionID} was not found`);
    }
    throw error;
  }
}
