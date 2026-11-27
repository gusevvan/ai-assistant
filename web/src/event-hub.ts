import type { OpenCode } from "@opencode/sdk";
import type { Logger } from "./logger.js";

/**
 * The subset of OpenCode events the browser cares about. `server.connected` is
 * always delivered by the client even when a filter is supplied.
 */
const EVENT_TYPES = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.status",
  "session.idle",
] as const;

export interface HubEvent {
  readonly type: string;
  readonly data?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export type Listener = (event: HubEvent) => void;

/**
 * One live OpenCode event subscription for the whole process.
 *
 * Subscribing per HTTP request would race with `session.prompt()`: the prompt
 * can start emitting deltas before the request-local subscription is consumed.
 * Here the connection is established once at startup and HTTP handlers only
 * register in-memory listeners for their session.
 */
export class EventHub {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly connectedWaiters = new Set<() => void>();
  private abortController?: AbortController;
  private loopPromise?: Promise<void>;
  private connected = false;
  private stopped = false;
  private lastError?: string;
  private lastEventAt?: number;

  constructor(
    private readonly host: OpenCode.Interface,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (this.loopPromise) return;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abortController?.abort();
    for (const waiter of this.connectedWaiters) waiter();
    this.connectedWaiters.clear();
    await this.loopPromise?.catch(() => undefined);
  }

  isConnected(): boolean {
    return this.connected;
  }

  getLastError(): string | undefined {
    return this.lastError;
  }

  getLastEventAt(): number | undefined {
    return this.lastEventAt;
  }

  waitConnected(timeoutMs: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connectedWaiters.delete(waiter);
        resolve(value);
      };
      const waiter = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.connectedWaiters.add(waiter);
    });
  }

  subscribe(sessionID: string, listener: Listener): () => void {
    let listeners = this.listeners.get(sessionID);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(sessionID, listeners);
    }
    listeners.add(listener);

    return () => {
      const current = this.listeners.get(sessionID);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(sessionID);
    };
  }

  private async loop(): Promise<void> {
    let backoffMs = 500;

    while (!this.stopped) {
      this.abortController = new AbortController();

      try {
        const stream = this.host.events.subscribe({
          types: EVENT_TYPES,
          signal: this.abortController.signal,
        });

        for await (const event of stream) {
          if (this.stopped) break;
          this.connected = true;
          this.lastEventAt = Date.now();
          this.lastError = undefined;
          backoffMs = 500;

          if (event.type === "server.connected") {
            this.notifyConnected();
            continue;
          }

          this.dispatch(event as unknown as HubEvent);
        }
      } catch (error) {
        if (!this.stopped) {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.log.warn({ err: error }, "OpenCode event stream failed; reconnecting");
        }
      } finally {
        this.connected = false;
        this.abortController = undefined;
      }

      if (this.stopped) break;
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 5_000);
    }
  }

  private dispatch(event: HubEvent): void {
    const sessionID = event.data?.sessionID;
    if (typeof sessionID !== "string") return;

    this.log.debug({ type: event.type, sessionID }, "OpenCode event");

    const listeners = this.listeners.get(sessionID);
    if (!listeners) return;

    // Copy: a listener may unsubscribe itself while we iterate.
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.log.error({ err: error, eventType: event.type }, "Event listener threw");
      }
    }
  }

  private notifyConnected(): void {
    for (const waiter of [...this.connectedWaiters]) waiter();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
