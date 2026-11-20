import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { ZodError } from "zod";
import { loadConfig } from "./config.js";
import { HttpError, errorMessage } from "./logger.js";
import { registerRoutes } from "./routes.js";
import { Runtime } from "./runtime.js";

const config = loadConfig();
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

const app = Fastify({
  logger: {
    level: config.logLevel,
  },
  bodyLimit: 1_000_000,
});

const runtime = new Runtime(config, app.log);

await app.register(cors, {
  origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",").map((value) => value.trim()),
});

await app.register(fastifyStatic, {
  root: publicDir,
  prefix: "/",
  index: ["index.html"],
});

registerRoutes(app, runtime, config);

app.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: "validation_error",
      message: "Invalid request",
      issues: error.issues,
    });
  }

  if (error instanceof HttpError) {
    return reply.code(error.statusCode).send({
      error: error.code,
      message: error.message,
    });
  }

  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    return reply.code(statusCode).send({
      error: "request_error",
      message: errorMessage(error),
    });
  }

  request.log.error({ err: error }, "Unhandled request error");
  return reply.code(500).send({
    error: "internal_error",
    message: "Internal server error",
  });
});

app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith("/api/") || request.url === "/health" || request.url === "/live") {
    return reply.code(404).send({
      error: "not_found",
      message: `Route ${request.method} ${request.url} was not found`,
    });
  }
  return reply.sendFile("index.html");
});

await app.listen({ port: config.port, host: config.host });
app.log.info({ host: config.host, port: config.port }, "HTTP server is listening");

// Start the embedded OpenCode host only after the HTTP listener is up: /health
// can then answer 503 honestly while the SDK and its dependencies initialize.
runtime.start();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Shutting down");

  const force = setTimeout(() => {
    app.log.error("Graceful shutdown timed out; exiting");
    process.exit(1);
  }, 15_000);
  force.unref?.();

  try {
    await app.close();
  } catch (error) {
    app.log.error({ err: error }, "Error while closing HTTP server");
  }

  try {
    await runtime.stop();
  } catch (error) {
    app.log.error({ err: error }, "Error while stopping OpenCode runtime");
  }

  clearTimeout(force);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: reason }, "Unhandled promise rejection");
});
