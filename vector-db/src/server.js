#!/usr/bin/env node
/**
 * Small search service in front of Qdrant.
 *
 * It implements the contract the web service expects:
 *
 *   GET  /healthz
 *   POST /search  { "query": "...", "limit": 5, "collection": "knowledge" }
 *                 -> { "results": [{ "text": "...", "score": 0.87, "metadata": {} }] }
 *
 * On startup it creates the Qdrant collection if needed and seeds it from the
 * Markdown/text files in SEED_DIR. Seeding is skipped when the collection
 * already contains points.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chunkText, embed } from "./embed.js";

const config = {
  port: numberFromEnv("PORT", 8080),
  host: process.env.HOST?.trim() || "0.0.0.0",
  qdrantUrl: (process.env.QDRANT_URL?.trim() || "http://qdrant:6333").replace(/\/+$/, ""),
  qdrantApiKey: process.env.QDRANT_API_KEY?.trim() || undefined,
  collection: process.env.COLLECTION?.trim() || "knowledge",
  dimension: numberFromEnv("VECTOR_DIM", 512),
  seedDir: process.env.SEED_DIR?.trim() || "/app/data",
  seedOnStart: !isFalse(process.env.SEED_ON_START),
  chunkSize: numberFromEnv("CHUNK_SIZE", 700),
  chunkOverlap: numberFromEnv("CHUNK_OVERLAP", 120),
  defaultLimit: numberFromEnv("DEFAULT_LIMIT", 5),
  requestTimeoutMs: numberFromEnv("REQUEST_TIMEOUT_MS", 10_000),
  logLevel: process.env.LOG_LEVEL?.trim() || "info",
};

const state = {
  ready: false,
  points: 0,
  lastError: null,
  startedAt: Date.now(),
};

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    log("error", "Unhandled request error", { error: errorMessage(error) });
    sendJson(response, 500, { error: "internal_error", message: errorMessage(error) });
  });
});

server.listen(config.port, config.host, () => {
  log("info", "Vector search service is listening", {
    host: config.host,
    port: config.port,
    qdrant: config.qdrantUrl,
    collection: config.collection,
  });
});

void initialize();

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/health")) {
    return handleHealth(response);
  }

  if (request.method === "GET" && url.pathname === "/") {
    return sendJson(response, 200, {
      service: "opencode-vector-db",
      collection: config.collection,
      dimension: config.dimension,
      ready: state.ready,
      points: state.points,
    });
  }

  if (request.method === "POST" && url.pathname === "/search") {
    return handleSearch(request, response);
  }

  return sendJson(response, 404, {
    error: "not_found",
    message: `Route ${request.method} ${url.pathname} was not found`,
  });
}

async function handleHealth(response) {
  if (!state.ready) {
    return sendJson(response, 503, {
      status: "starting",
      ready: false,
      error: state.lastError,
      uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
    });
  }

  try {
    await qdrantRequest("/healthz");
    const info = await qdrantRequest(`/collections/${encodeURIComponent(config.collection)}`);
    state.points = info?.result?.points_count ?? state.points;

    return sendJson(response, 200, {
      status: "ok",
      ready: true,
      qdrant: config.qdrantUrl,
      collection: config.collection,
      points: state.points,
      uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
    });
  } catch (error) {
    state.ready = false;
    state.lastError = errorMessage(error);
    return sendJson(response, 503, {
      status: "error",
      ready: false,
      error: state.lastError,
    });
  }
}

async function handleSearch(request, response) {
  if (!state.ready) {
    return sendJson(response, 503, {
      error: "not_ready",
      message: "The vector database is still starting",
    });
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return sendJson(response, 400, { error: "invalid_json", message: errorMessage(error) });
  }

  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query) {
    return sendJson(response, 400, {
      error: "invalid_request",
      message: "Body must contain a non-empty 'query' string",
    });
  }

  const limit = clampLimit(body?.limit);
  const collection =
    typeof body?.collection === "string" && body.collection.trim()
      ? body.collection.trim()
      : config.collection;

  try {
    const result = await qdrantRequest(
      `/collections/${encodeURIComponent(collection)}/points/query`,
      {
        method: "POST",
        body: JSON.stringify({
          query: embed(query, config.dimension),
          limit,
          with_payload: true,
        }),
      },
    );

    const points = result?.result?.points ?? result?.result ?? [];
    const results = [];

    for (const point of Array.isArray(points) ? points : []) {
      const payload = point?.payload;
      if (typeof payload?.text !== "string" || payload.text.trim() === "") continue;
      results.push({
        text: payload.text,
        ...(typeof point.score === "number" ? { score: point.score } : {}),
        ...(isRecord(payload.metadata) ? { metadata: payload.metadata } : {}),
      });
    }

    log("debug", "Search completed", { query, collection, limit, results: results.length });
    return sendJson(response, 200, { results });
  } catch (error) {
    log("warn", "Search failed", { error: errorMessage(error), collection });
    return sendJson(response, 502, {
      error: "search_failed",
      message: errorMessage(error),
    });
  }
}

async function initialize() {
  while (true) {
    try {
      state.ready = false;
      state.lastError = null;

      await qdrantRequest("/healthz");
      await ensureCollection();
      await seedIfEmpty();

      const info = await qdrantRequest(`/collections/${encodeURIComponent(config.collection)}`);
      state.points = info?.result?.points_count ?? 0;
      state.ready = true;

      log("info", "Vector database is ready", {
        collection: config.collection,
        points: state.points,
        dimension: config.dimension,
      });
      return;
    } catch (error) {
      state.ready = false;
      state.lastError = errorMessage(error);
      log("warn", "Vector database initialization failed; retrying in 3s", {
        error: state.lastError,
      });
      await sleep(3_000);
    }
  }
}

async function ensureCollection() {
  try {
    const existing = await qdrantRequest(`/collections/${encodeURIComponent(config.collection)}`);
    const size = existing?.result?.config?.params?.vectors?.size;
    if (typeof size === "number" && size !== config.dimension) {
      throw new Error(
        `Collection '${config.collection}' uses vector size ${size}, but VECTOR_DIM is ${config.dimension}. ` +
          "Delete the Qdrant volume or change VECTOR_DIM.",
      );
    }
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  log("info", "Creating Qdrant collection", {
    collection: config.collection,
    dimension: config.dimension,
  });
  await qdrantRequest(`/collections/${encodeURIComponent(config.collection)}`, {
    method: "PUT",
    body: JSON.stringify({
      vectors: { size: config.dimension, distance: "Cosine" },
    }),
  });
}

async function seedIfEmpty() {
  const info = await qdrantRequest(`/collections/${encodeURIComponent(config.collection)}`);
  const pointsCount = info?.result?.points_count ?? 0;
  if (pointsCount > 0) {
    state.points = pointsCount;
    log("info", "Collection already contains points; skipping seed", {
      collection: config.collection,
      points: pointsCount,
    });
    return;
  }

  if (!config.seedOnStart) {
    log("info", "SEED_ON_START is disabled; collection stays empty");
    return;
  }

  const documents = await readDocuments(config.seedDir);
  if (documents.length === 0) {
    log("warn", "No seed documents found", { seedDir: config.seedDir });
    return;
  }

  const points = [];
  for (const document of documents) {
    const chunks = chunkText(document.text, config.chunkSize, config.chunkOverlap);
    chunks.forEach((text, index) => {
      points.push({
        id: randomUUID(),
        vector: embed(text, config.dimension),
        payload: {
          text,
          metadata: {
            source: document.source,
            chunk: index,
            chunks: chunks.length,
          },
        },
      });
    });
  }

  for (let start = 0; start < points.length; start += 64) {
    const batch = points.slice(start, start + 64);
    await qdrantRequest(
      `/collections/${encodeURIComponent(config.collection)}/points?wait=true`,
      {
        method: "PUT",
        body: JSON.stringify({ points: batch }),
      },
    );
  }

  log("info", "Seeded collection", {
    collection: config.collection,
    documents: documents.length,
    points: points.length,
  });
}

/**
 * @param {string} directory
 * @returns {Promise<Array<{source: string, text: string}>>}
 */
async function readDocuments(directory) {
  const files = await listFiles(directory).catch((error) => {
    log("warn", "Cannot read seed directory", { directory, error: errorMessage(error) });
    return [];
  });

  const documents = [];
  for (const file of files) {
    if (!/\.(md|markdown|txt)$/i.test(file)) continue;
    try {
      const text = await readFile(file, "utf8");
      if (!text.trim()) continue;
      documents.push({ source: path.relative(directory, file), text });
    } catch (error) {
      log("warn", "Cannot read seed document", { file, error: errorMessage(error) });
    }
  }
  return documents;
}

/**
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * @param {string} pathname
 * @param {RequestInit} [options]
 */
async function qdrantRequest(pathname, options = {}) {
  const response = await fetch(`${config.qdrantUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(config.qdrantApiKey ? { "api-key": config.qdrantApiKey } : {}),
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`Qdrant ${options.method ?? "GET"} ${pathname} failed: HTTP ${response.status}`);
    error.status = response.status;
    error.body = text.slice(0, 500);
    throw error;
  }

  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * @param {import("node:http").IncomingMessage} request
 * @returns {Promise<unknown>}
 */
async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request body is too large");
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(response, status, body) {
  if (response.headersSent) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function isNotFound(error) {
  return Boolean(error && typeof error === "object" && error.status === 404);
}

function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return config.defaultLimit;
  return Math.min(50, Math.max(1, Math.trunc(parsed)));
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isFalse(value) {
  if (value === undefined) return false;
  return ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function log(level, message, details = {}) {
  if (level === "debug" && config.logLevel !== "debug") return;
  const record = {
    time: new Date().toISOString(),
    level,
    service: "vector-db",
    message,
    ...details,
  };
  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
