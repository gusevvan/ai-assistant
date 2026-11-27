import path from "node:path";
import { z } from "zod";

const booleanish = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  return value;
}, z.boolean());

const Environment = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),

  /** Directory that OpenCode treats as the project/workspace root. */
  WORKSPACE_DIR: z.string().min(1).default("/workspace"),
  /** SQLite database used by the embedded OpenCode host. */
  OPENCODE_DB_PATH: z.string().min(1).default("/data/opencode.db"),
  /** Optional raw JSON configuration for OpenCode (opencode.json contents). */
  OPENCODE_CONFIG_JSON: z.string().optional(),
  /** Optional model reference, e.g. `anthropic/claude-sonnet-4-5`. */
  OPENCODE_MODEL: z.string().optional(),
  /** Optional default agent name. */
  OPENCODE_AGENT: z.string().optional(),
  OPENCODE_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** When true, /health is 503 until a default chat model is available. */
  REQUIRE_MODEL: booleanish.default(true),

  /** Vector database (RAG) service. Leave empty to disable RAG. */
  VECTOR_DB_URL: z.string().optional(),
  VECTOR_DB_COLLECTION: z.string().min(1).default("knowledge"),
  VECTOR_DB_API_KEY: z.string().optional(),
  VECTOR_DB_LIMIT: z.coerce.number().int().min(1).max(50).default(5),
  VECTOR_DB_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),

  HEALTH_CACHE_MS: z.coerce.number().int().min(0).default(1_000),
  HEALTH_TIMEOUT_MS: z.coerce.number().int().min(100).default(3_000),
  PROMPT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(10 * 60_000),

  CORS_ORIGIN: z.string().default("*"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly workspaceDir: string;
  readonly openCodeDbPath: string;
  readonly openCodeConfigJson?: string;
  readonly openCodeModel?: string;
  readonly openCodeAgent?: string;
  readonly openCodeLogLevel: "debug" | "info" | "warn" | "error";
  readonly requireModel: boolean;
  readonly vectorDbUrl?: string;
  readonly vectorDbCollection: string;
  readonly vectorDbApiKey?: string;
  readonly vectorDbLimit: number;
  readonly vectorDbTimeoutMs: number;
  readonly healthCacheMs: number;
  readonly healthTimeoutMs: number;
  readonly promptTimeoutMs: number;
  readonly corsOrigin: string;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Environment.parse(env);

  return {
    port: parsed.PORT,
    host: parsed.HOST,
    workspaceDir: path.resolve(parsed.WORKSPACE_DIR),
    openCodeDbPath: path.resolve(parsed.OPENCODE_DB_PATH),
    openCodeConfigJson: emptyToUndefined(parsed.OPENCODE_CONFIG_JSON),
    openCodeModel: emptyToUndefined(parsed.OPENCODE_MODEL),
    openCodeAgent: emptyToUndefined(parsed.OPENCODE_AGENT),
    openCodeLogLevel: parsed.OPENCODE_LOG_LEVEL,
    requireModel: parsed.REQUIRE_MODEL,
    vectorDbUrl: emptyToUndefined(parsed.VECTOR_DB_URL)?.replace(/\/+$/, ""),
    vectorDbCollection: parsed.VECTOR_DB_COLLECTION,
    vectorDbApiKey: emptyToUndefined(parsed.VECTOR_DB_API_KEY),
    vectorDbLimit: parsed.VECTOR_DB_LIMIT,
    vectorDbTimeoutMs: parsed.VECTOR_DB_TIMEOUT_MS,
    healthCacheMs: parsed.HEALTH_CACHE_MS,
    healthTimeoutMs: parsed.HEALTH_TIMEOUT_MS,
    promptTimeoutMs: parsed.PROMPT_TIMEOUT_MS,
    corsOrigin: parsed.CORS_ORIGIN,
    logLevel: parsed.LOG_LEVEL,
  };
}

/**
 * Build the OpenCode configuration passed to the embedded host.
 *
 * A raw OPENCODE_CONFIG_JSON wins, otherwise we generate a minimal config.
 * Provider credentials are still read by OpenCode from the process environment
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, ...).
 */
export function buildOpenCodeConfigContent(config: Config): string {
  if (config.openCodeConfigJson) return config.openCodeConfigJson;

  const content: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
  };
  if (config.openCodeModel) content.model = config.openCodeModel;
  if (config.openCodeAgent) content.default_agent = config.openCodeAgent;

  return JSON.stringify(content);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
