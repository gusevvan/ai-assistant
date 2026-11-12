#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible chat-completions server for offline tests.
 *
 * It lets the whole chat path (OpenCode -> provider -> SSE -> nginx) be tested
 * without a real API key or internet access. It is enabled only through
 * compose.mock.yaml:
 *
 *   docker compose -f compose.yaml -f compose.mock.yaml up --build
 *
 * The answer is deterministic: it echoes a short prefix of the last user
 * message, so tests can verify that the prompt (including RAG context) reached
 * the provider.
 */

import { createServer } from "node:http";

const config = {
  port: Number(process.env.PORT ?? 19000),
  host: process.env.HOST?.trim() || "0.0.0.0",
  model: process.env.MOCK_MODEL?.trim() || "mock-model",
  chunkDelayMs: Number(process.env.MOCK_CHUNK_DELAY_MS ?? 15),
};

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ level: "error", message, error: message }));
    if (!response.headersSent) {
      sendJson(response, 500, { error: { message, type: "mock_error" } });
    } else {
      response.end();
    }
  });
});

server.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      level: "info",
      service: "mock-llm",
      message: "Mock provider is listening",
      port: config.port,
    }),
  );
});

async function handle(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/v1/models")) {
    return sendJson(response, 200, {
      object: "list",
      data: [
        {
          id: config.model,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "mock",
        },
      ],
    });
  }

  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    const body = await readJson(request);
    return handleChatCompletion(body, response);
  }

  return sendJson(response, 404, {
    error: { message: `Route ${request.method} ${url.pathname} was not found`, type: "not_found" },
  });
}

async function handleChatCompletion(body, response) {
  const model = typeof body?.model === "string" ? body.model : config.model;
  const prompt = lastUserText(body?.messages);
  const answer = buildAnswer(prompt);
  const id = `chatcmpl-mock-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  if (body?.stream === true) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    writeChunk(response, {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    });

    // Split into small pieces so the client observes real incremental deltas.
    for (let start = 0; start < answer.length; start += 12) {
      writeChunk(response, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          { index: 0, delta: { content: answer.slice(start, start + 12) }, finish_reason: null },
        ],
      });
      await sleep(config.chunkDelayMs);
    }

    writeChunk(response, {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: estimateTokens(prompt),
        completion_tokens: estimateTokens(answer),
        total_tokens: estimateTokens(prompt) + estimateTokens(answer),
      },
    });

    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }

  return sendJson(response, 200, {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: answer },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: estimateTokens(prompt),
      completion_tokens: estimateTokens(answer),
      total_tokens: estimateTokens(prompt) + estimateTokens(answer),
    },
  });
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {unknown} chunk
 */
function writeChunk(response, chunk) {
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function buildAnswer(prompt) {
  const compact = prompt.replace(/\s+/g, " ").trim();
  const preview = compact.length > 120 ? `${compact.slice(0, 120)}...` : compact;
  const hasContext = compact.includes("--- CONTEXT ---");

  return [
    "Это ответ mock-модели для проверки сквозного стриминга.",
    hasContext
      ? "Контекст из векторной базы получен и передан в промпт."
      : "Контекст из векторной базы в этот запрос не передавался.",
    preview ? `Начало запроса: ${preview}` : "Запрос был пустым.",
  ].join(" ");
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join(" ");
    }
  }
  return "";
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
