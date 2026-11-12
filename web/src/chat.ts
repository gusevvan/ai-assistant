import type { OpenCode } from "@opencode/sdk";
import type { EventHub } from "./event-hub.js";
import { errorMessage } from "./logger.js";

export type ChatEvent =
  | { type: "message_start"; assistantMessageID: string }
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_start"; id?: string; input?: unknown; executed?: unknown }
  | { type: "tool_end"; id?: string }
  | { type: "tool_error"; id?: string; error?: unknown }
  | { type: "error"; message: string; details?: unknown }
  | { type: "done"; assistantMessageID?: string };

export interface PromptResult {
  readonly answer: string;
  readonly assistantMessageID?: string;
}

interface RunPromptOptions {
  readonly host: OpenCode.Interface;
  readonly hub: EventHub;
  readonly sessionID: string;
  readonly text: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: ChatEvent) => void;
}

/**
 * Send one prompt and translate raw OpenCode events into a small, stable
 * event vocabulary for HTTP clients.
 *
 * The listener is registered *before* the prompt is sent, so no deltas can be
 * lost between admission and the first token.
 */
export async function runPrompt(options: RunPromptOptions): Promise<PromptResult> {
  const { host, hub, sessionID, text, timeoutMs, signal, onEvent } = options;

  let answer = "";
  let assistantMessageID: string | undefined;
  let started = false;
  let settled = false;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  return new Promise<PromptResult>((resolve, reject) => {
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    };

    const finish = (result: PromptResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const emit = (event: ChatEvent) => {
      if (settled) return;
      try {
        onEvent(event);
      } catch {
        // The HTTP client may have disconnected. The abort signal handles
        // cancellation; a failed write must not break event processing.
      }
    };

    onAbort = () => {
      if (settled) return;
      void host.session.interrupt({ sessionID }).catch(() => undefined);
      finish({ answer, assistantMessageID });
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    timer = setTimeout(() => {
      if (settled) return;
      void host.session.interrupt({ sessionID }).catch(() => undefined);
      emit({ type: "error", message: "Generation timed out" });
      finish({ answer, assistantMessageID });
    }, timeoutMs);
    timer.unref?.();

    unsubscribe = hub.subscribe(sessionID, (event) => {
      if (settled) return;

      switch (event.type) {
        case "session.execution.started":
          started = true;
          break;

        case "session.text.started": {
          started = true;
          const id = stringField(event.data, "assistantMessageID");
          if (id) {
            const isFirst = assistantMessageID === undefined;
            assistantMessageID = id;
            if (isFirst) emit({ type: "message_start", assistantMessageID: id });
          }
          break;
        }

        case "session.text.delta": {
          started = true;
          const delta = stringField(event.data, "delta");
          if (!delta) break;
          answer += delta;
          emit({ type: "delta", text: delta });
          break;
        }

        case "session.reasoning.delta": {
          started = true;
          const delta = stringField(event.data, "delta");
          if (delta) emit({ type: "reasoning", text: delta });
          break;
        }

        case "session.tool.called": {
          started = true;
          emit({
            type: "tool_start",
            ...(stringField(event.data, "id") ? { id: stringField(event.data, "id") } : {}),
            ...(event.data?.input !== undefined ? { input: event.data.input } : {}),
            ...(event.data?.executed !== undefined ? { executed: event.data.executed } : {}),
          });
          break;
        }

        case "session.tool.success":
          emit({
            type: "tool_end",
            ...(stringField(event.data, "id") ? { id: stringField(event.data, "id") } : {}),
          });
          break;

        case "session.tool.failed":
          emit({
            type: "tool_error",
            ...(stringField(event.data, "id") ? { id: stringField(event.data, "id") } : {}),
            ...(event.data?.error !== undefined ? { error: event.data.error } : {}),
          });
          break;

        case "session.execution.failed": {
          const details = event.data?.error;
          emit({
            type: "error",
            message: structuredMessage(details) ?? "Generation failed",
            ...(details !== undefined ? { details } : {}),
          });
          finish({ answer, assistantMessageID });
          break;
        }

        case "session.execution.succeeded":
        case "session.execution.interrupted":
          // A prompt run is finished when its execution succeeds or is
          // interrupted. `session.idle` usually follows, but it is a
          // session-level event and can be delayed or skipped, so it must not
          // be the only completion signal.
          if (started) {
            emit({
              type: "done",
              ...(assistantMessageID ? { assistantMessageID } : {}),
            });
            finish({ answer, assistantMessageID });
          }
          break;

        case "session.idle":
          if (started) {
            emit({
              type: "done",
              ...(assistantMessageID ? { assistantMessageID } : {}),
            });
            finish({ answer, assistantMessageID });
          }
          break;
      }
    });

    host.session.prompt({ sessionID, text }).catch((error) => {
      emit({ type: "error", message: errorMessage(error) });
      fail(error);
    });
  });
}

function stringField(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === "string" ? value : undefined;
}

function structuredMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}
