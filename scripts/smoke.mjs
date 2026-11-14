#!/usr/bin/env node
/**
 * End-to-end smoke test for the running stack.
 *
 * It assumes the whole Compose stack is already up (normally started with the
 * mock provider, so no API key is needed) and verifies the course contract:
 *
 *   - `/health` returns 200 only when the service is ready;
 *   - the UI and `/live` are served through nginx;
 *   - a session can be created, and a prompt streams back over SSE;
 *   - RAG contributed context, and the stream ends with `done`.
 *
 * Usage:
 *   docker compose -f compose.yaml -f compose.mock.yaml up -d --build
 *   node scripts/smoke.mjs
 *
 * Environment:
 *   SMOKE_BASE_URL     base URL (default http://127.0.0.1:8080)
 *   SMOKE_TIMEOUT_MS   how long to wait for readiness (default 180000)
 *   SMOKE_REQUIRE_RAG  set to 0 to allow an empty RAG result (default 1)
 *   SMOKE_PROMPT       prompt to send
 */

const baseUrl = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const startupTimeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);
const requireRag = (process.env.SMOKE_REQUIRE_RAG ?? "1") !== "0";
const prompt =
  process.env.SMOKE_PROMPT ?? "Briefly explain why Docker Compose is useful for a multi-service app.";

const deadline = Date.now() + startupTimeoutMs;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth() {
  let lastError = "no attempt yet";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      if (response.status === 200) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(2_000);
  }

  throw new Error(`/health was not ready within ${startupTimeoutMs} ms (last error: ${lastError})`);
}

async function expectOk(path, accept) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: accept ? { accept } : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) {
    throw new Error(`GET ${path} returned HTTP ${response.status}`);
  }
  return response;
}

async function getJson(path) {
  const response = await expectOk(path, "application/json");
  return await response.json();
}

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`POST ${path} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

function parseEvent(block) {
  let event;
  const dataLines = [];

  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
  }

  if (!event) return undefined;

  const raw = dataLines.join("\n");
  if (!raw) return { event, data: {} };

  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: { raw } };
  }
}

async function streamPrompt(sessionID, text) {
  const response = await fetch(`${baseUrl}/api/sessions/${sessionID}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(120_000),
  });

  if (response.status !== 200) {
    throw new Error(`prompt returned HTTP ${response.status}: ${await response.text()}`);
  }
  if (!response.body) throw new Error("prompt response had no body");

  const decoder = new TextDecoder();
  const events = [];
  const deltas = [];
  let ragSources = [];
  let errorMessage;
  let done = false;
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const parsed = parseEvent(block);
      if (!parsed) continue;

      events.push(parsed.event);
      if (parsed.event === "rag" && Array.isArray(parsed.data.sources)) {
        ragSources = parsed.data.sources;
      } else if (parsed.event === "delta" && typeof parsed.data.text === "string") {
        deltas.push(parsed.data.text);
      } else if (parsed.event === "done") {
        done = true;
      } else if (parsed.event === "error") {
        errorMessage = parsed.data.message ?? "unknown error";
      }
    }

    if (done || errorMessage) break;
  }

  return { events, answer: deltas.join(""), ragSources, done, errorMessage };
}

async function main() {
  console.log(`smoke: base URL ${baseUrl}`);

  const health = await waitForHealth();
  console.log(`smoke: /health ready=${String(health.ready)}`);

  await expectOk("/", "text/html");
  await expectOk("/live", "application/json");
  const models = await getJson("/api/models");
  const modelList = Array.isArray(models) ? models : models.data;
  if (!Array.isArray(modelList) || modelList.length === 0) {
    throw new Error("/api/models returned no models");
  }

  const info = await getJson("/api/info");
  if (!info?.model?.id) throw new Error("/api/info reports no active model");
  console.log(`smoke: model ${info.model.providerID}/${info.model.id}`);

  const created = await postJson("/api/sessions", { title: "smoke test" });
  const sessionID = created?.session?.id;
  if (!sessionID) throw new Error("session was not created");
  console.log(`smoke: session ${sessionID}`);

  const result = await streamPrompt(sessionID, prompt);

  if (result.errorMessage) throw new Error(`stream error: ${result.errorMessage}`);
  if (!result.done) throw new Error("stream ended without a done event");
  if (!result.answer.trim()) throw new Error("assistant returned an empty answer");
  if (requireRag && result.ragSources.length === 0) {
    throw new Error("RAG returned no sources (set SMOKE_REQUIRE_RAG=0 to allow it)");
  }

  console.log(`smoke: events ${[...new Set(result.events)].join(", ")}`);
  console.log(`smoke: rag sources ${result.ragSources.length}`);
  console.log(`smoke: answer ${JSON.stringify(result.answer.slice(0, 120))}`);
  console.log("smoke: OK");
}

main().catch((error) => {
  console.error(`smoke: FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
