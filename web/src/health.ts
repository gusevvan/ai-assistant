import type { OpenCode } from "@opencode/sdk";
import type { Config } from "./config.js";
import type { EventHub } from "./event-hub.js";
import type { HealthCheck, HealthReport } from "./health-types.js";
import { errorMessage } from "./logger.js";
import type { VectorStore } from "./rag.js";

export interface DefaultModelInfo {
  readonly modelID: string;
  readonly providerID: string;
  readonly name?: string;
}

interface HealthDependencies {
  readonly config: Config;
  readonly getHost: () => OpenCode.Interface | undefined;
  readonly getHub: () => EventHub | undefined;
  readonly getDefaultModel: () => DefaultModelInfo | null;
  readonly vectorStore: VectorStore;
}

const SERVICE_NAME = "opencode-web-assistant" as const;

export class HealthService {
  private phase: "starting" | "ready" | "error" = "starting";
  private bootstrapError?: string;
  private lastReport?: HealthReport;
  private lastCheckAt = 0;
  private inFlight?: Promise<HealthReport>;
  private readonly startedAt = Date.now();
  private readonly version = process.env.APP_VERSION?.trim() || "0.1.0";

  constructor(private readonly deps: HealthDependencies) {}

  markStarting(): void {
    this.phase = "starting";
    this.bootstrapError = undefined;
    this.invalidate();
  }

  markReady(): void {
    this.phase = "ready";
    this.bootstrapError = undefined;
    this.invalidate();
  }

  markError(error: unknown): void {
    this.phase = "error";
    this.bootstrapError = errorMessage(error);
    this.invalidate();
  }

  async check(force = false): Promise<HealthReport> {
    const now = Date.now();
    if (!force && this.lastReport && now - this.lastCheckAt < this.deps.config.healthCacheMs) {
      return this.lastReport;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.buildReport()
      .then((report) => {
        this.lastReport = report;
        this.lastCheckAt = Date.now();
        return report;
      })
      .finally(() => {
        this.inFlight = undefined;
      });

    return this.inFlight;
  }

  private async buildReport(): Promise<HealthReport> {
    const checks: Record<string, HealthCheck> = {};
    const host = this.deps.getHost();

    if (!host) {
      checks.opencode = {
        status: "error",
        message:
          this.phase === "starting"
            ? "OpenCode host is starting"
            : this.bootstrapError || "OpenCode host is not available",
      };
      return this.report(false, checks);
    }

    const timeout = this.deps.config.healthTimeoutMs;
    const abort = () => AbortSignal.timeout(timeout);

    const [opencode, database] = await Promise.all([
      timed(() => host.server.info({ signal: abort() }), timeout),
      timed(() => host.session.list({ limit: 1 }, { signal: abort() }), timeout),
    ]);

    checks.opencode = opencode;
    checks.database = database;

    const hub = this.deps.getHub();
    if (!hub) {
      checks.events = { status: "error", message: "Event hub is not started" };
    } else if (!hub.isConnected()) {
      checks.events = {
        status: "error",
        message: hub.getLastError() || "OpenCode event stream is not connected",
      };
    } else {
      const lastEventAt = hub.getLastEventAt();
      checks.events = {
        status: "ok",
        ...(lastEventAt ? { details: { lastEventAt: new Date(lastEventAt).toISOString() } } : {}),
      };
    }

    const defaultModel = this.deps.getDefaultModel();
    if (!this.deps.config.requireModel) {
      checks.model = defaultModel
        ? { status: "ok", details: modelDetails(defaultModel) }
        : { status: "disabled", message: "REQUIRE_MODEL=false and no default model is configured" };
    } else if (defaultModel) {
      checks.model = { status: "ok", details: modelDetails(defaultModel) };
    } else {
      checks.model = {
        status: "error",
        message: "No default chat model is available. Configure a provider API key and OPENCODE_MODEL.",
      };
    }

    checks.vectorDb = await this.deps.vectorStore.health();

    const ready = Object.values(checks).every((check) => check.status !== "error");
    return this.report(ready, checks);
  }

  private report(ready: boolean, checks: Record<string, HealthCheck>): HealthReport {
    return {
      status: ready ? "ok" : "error",
      ready,
      service: SERVICE_NAME,
      version: this.version,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      checks,
    };
  }

  private invalidate(): void {
    this.lastReport = undefined;
    this.lastCheckAt = 0;
  }
}

async function timed(operation: () => Promise<unknown>, timeoutMs: number): Promise<HealthCheck> {
  const started = performance.now();
  try {
    await operation();
    return { status: "ok", latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      status: "error",
      latencyMs: Math.round(performance.now() - started),
      message: errorMessage(error),
      details: { timeoutMs },
    };
  }
}

function modelDetails(model: DefaultModelInfo): Record<string, unknown> {
  return {
    modelID: model.modelID,
    providerID: model.providerID,
    ...(model.name ? { name: model.name } : {}),
  };
}
