import type { Config } from "./config.js";
import type { HealthCheck } from "./health-types.js";
import { errorMessage, type Logger } from "./logger.js";

export interface RagSource {
  readonly text: string;
  readonly score?: number;
  readonly metadata?: Record<string, unknown>;
}

interface SearchResponse {
  readonly results?: unknown;
}

/**
 * Client for the vector-database service.
 *
 * Contract expected from the service:
 *   GET  /healthz
 *   POST /search
 *        { "query": "...", "limit": 5, "collection": "knowledge" }
 *        -> { "results": [{ "text": "...", "score": 0.87, "metadata": {} }] }
 *
 * The contract is deliberately small so the search service can be Qdrant, a
 * small wrapper around it, or anything else. Swapping the implementation does
 * not touch the web service.
 */
export class VectorStore {
  constructor(
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  get enabled(): boolean {
    return this.config.vectorDbUrl !== undefined;
  }

  async health(): Promise<HealthCheck> {
    if (!this.enabled) {
      return { status: "disabled", message: "VECTOR_DB_URL is not set" };
    }

    const started = performance.now();
    for (const path of ["/healthz", "/health"]) {
      try {
        const response = await fetch(this.url(path), {
          headers: this.headers(),
          signal: AbortSignal.timeout(this.config.healthTimeoutMs),
        });
        if (response.ok) {
          return {
            status: "ok",
            latencyMs: Math.round(performance.now() - started),
            details: { url: this.config.vectorDbUrl, probe: path },
          };
        }
      } catch {
        // Try the next conventional health path.
      }
    }

    return {
      status: "error",
      latencyMs: Math.round(performance.now() - started),
      message: `Vector database is not reachable at ${this.config.vectorDbUrl}`,
    };
  }

  async search(query: string, limit = this.config.vectorDbLimit): Promise<RagSource[]> {
    if (!this.enabled) return [];

    const response = await fetch(this.url("/search"), {
      method: "POST",
      headers: {
        ...this.headers(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        limit,
        collection: this.config.vectorDbCollection,
      }),
      signal: AbortSignal.timeout(this.config.vectorDbTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Vector search failed: HTTP ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as SearchResponse;
    if (!Array.isArray(body.results)) {
      this.log.warn({ body }, "Vector search returned no results array");
      return [];
    }

    return body.results.flatMap((item): RagSource[] => {
      if (typeof item !== "object" || item === null) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.text !== "string" || record.text.trim() === "") return [];
      return [
        {
          text: record.text,
          ...(typeof record.score === "number" ? { score: record.score } : {}),
          ...(isRecord(record.metadata) ? { metadata: record.metadata } : {}),
        },
      ];
    });
  }

  formatForPrompt(sources: readonly RagSource[]): string {
    if (sources.length === 0) return "";

    const context = sources
      .map((source, index) => {
        const score = source.score === undefined ? "" : ` (score ${source.score.toFixed(3)})`;
        return `[${index + 1}]${score}\n${source.text.trim()}`;
      })
      .join("\n\n");

    return [
      "Use the following knowledge-base context when it is relevant to the user's question.",
      "If the context does not contain the answer, say so instead of inventing facts.",
      "",
      "--- CONTEXT ---",
      context,
      "--- END CONTEXT ---",
      "",
    ].join("\n");
  }

  private url(path: string): string {
    return `${this.config.vectorDbUrl}${path}`;
  }

  private headers(): Record<string, string> {
    if (!this.config.vectorDbApiKey) return {};
    return { authorization: `Bearer ${this.config.vectorDbApiKey}` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function ragError(error: unknown): string {
  return errorMessage(error);
}
