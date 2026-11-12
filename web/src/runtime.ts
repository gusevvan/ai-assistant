import { mkdir } from "node:fs/promises";
import path from "node:path";
import { OpenCode } from "@opencode/sdk";
import { buildOpenCodeConfigContent, type Config } from "./config.js";
import { EventHub } from "./event-hub.js";
import { HealthService, type DefaultModelInfo } from "./health.js";
import { HttpError, type Logger } from "./logger.js";
import { VectorStore } from "./rag.js";

export class Runtime {
  private host?: OpenCode.Interface;
  private hub?: EventHub;
  private defaultModel: DefaultModelInfo | null = null;
  private readonly busySessions = new Set<string>();
  private stopping = false;
  private bootstrapPromise?: Promise<void>;

  readonly vectorStore: VectorStore;
  readonly health: HealthService;

  constructor(
    readonly config: Config,
    readonly log: Logger,
  ) {
    this.vectorStore = new VectorStore(config, log);
    this.health = new HealthService({
      config,
      getHost: () => this.host,
      getHub: () => this.hub,
      getDefaultModel: () => this.defaultModel,
      vectorStore: this.vectorStore,
    });
  }

  start(): void {
    if (this.bootstrapPromise) return;
    this.bootstrapPromise = this.bootstrap();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.hub?.stop();
    await this.host?.close().catch((error) => this.log.error({ err: error }, "Failed to close OpenCode host"));
    this.host = undefined;
    this.hub = undefined;
  }

  getHost(): OpenCode.Interface | undefined {
    return this.host;
  }

  getHub(): EventHub | undefined {
    return this.hub;
  }

  getDefaultModel(): DefaultModelInfo | null {
    return this.defaultModel;
  }

  requireHost(): OpenCode.Interface {
    if (!this.host) {
      throw new HttpError(503, "not_ready", "OpenCode host is not ready yet");
    }
    return this.host;
  }

  requireHub(): EventHub {
    const hub = this.hub;
    if (!hub) {
      throw new HttpError(503, "not_ready", "OpenCode event stream is not ready yet");
    }
    if (!hub.isConnected()) {
      throw new HttpError(503, "events_unavailable", "OpenCode event stream is not connected");
    }
    return hub;
  }

  acquireSession(sessionID: string): boolean {
    if (this.busySessions.has(sessionID)) return false;
    this.busySessions.add(sessionID);
    return true;
  }

  releaseSession(sessionID: string): void {
    this.busySessions.delete(sessionID);
  }

  private async bootstrap(): Promise<void> {
    while (!this.stopping) {
      this.health.markStarting();
      let host: OpenCode.Interface | undefined;

      try {
        await Promise.all([
          mkdir(this.config.workspaceDir, { recursive: true }),
          mkdir(path.dirname(this.config.openCodeDbPath), { recursive: true }),
        ]);

        host = await OpenCode.create({
          database: { path: this.config.openCodeDbPath },
          config: {
            directory: this.config.workspaceDir,
            content: buildOpenCodeConfigContent(this.config),
          },
          log: {
            level: this.config.openCodeLogLevel,
            emit: (entry) => {
              this.log.debug(
                { attributes: entry.attributes, cause: entry.cause, source: "opencode" },
                entry.message,
              );
            },
          },
        });

        if (this.stopping) {
          await host.close();
          return;
        }

        const defaultModel = await host.model.default(
          { location: { directory: this.config.workspaceDir } },
          { signal: AbortSignal.timeout(this.config.healthTimeoutMs * 3) },
        );

        this.defaultModel = defaultModel.data
          ? {
              modelID: defaultModel.data.modelID,
              providerID: defaultModel.data.providerID,
              name: defaultModel.data.name,
            }
          : null;

        if (this.config.requireModel && !this.defaultModel) {
          throw new Error(
            "No default chat model is available. Set a provider API key (for example ANTHROPIC_API_KEY) " +
              "and optionally OPENCODE_MODEL, or set REQUIRE_MODEL=false to allow the service to start without one.",
          );
        }

        const hub = new EventHub(host, this.log);
        hub.start();

        this.host = host;
        this.hub = hub;
        this.health.markReady();

        this.log.info(
          {
            workspace: this.config.workspaceDir,
            database: this.config.openCodeDbPath,
            model: this.defaultModel ? `${this.defaultModel.providerID}/${this.defaultModel.modelID}` : null,
            rag: this.vectorStore.enabled ? this.config.vectorDbUrl : "disabled",
          },
          "OpenCode host is ready",
        );

        // Do not block readiness on the event stream: /health reports it
        // separately and turns green as soon as the subscription connects.
        void hub.waitConnected(this.config.healthTimeoutMs * 3).then((connected) => {
          if (!connected) this.log.warn("OpenCode event stream did not connect in time");
        });

        return;
      } catch (error) {
        this.log.error({ err: error }, "OpenCode host bootstrap failed; retrying in 5s");
        this.health.markError(error);
        this.host = undefined;
        this.hub = undefined;
        this.defaultModel = null;
        await host?.close().catch(() => undefined);
        await sleep(5_000);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
