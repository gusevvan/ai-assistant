import test from "node:test";
import assert from "node:assert/strict";

import type { OpenCode } from "@opencode/sdk";

import { runPrompt, type ChatEvent } from "../src/chat.js";
import type { EventHub, HubEvent } from "../src/event-hub.js";

type Emit = (event: HubEvent) => void;

function harness(promptImpl: (emit: Emit) => void) {
  const listeners = new Set<(event: HubEvent) => void>();

  const hub = {
    subscribe(_sessionID: string, listener: (event: HubEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as EventHub;

  const emit: Emit = (event) => {
    for (const listener of [...listeners]) listener(event);
  };

  const prompts: unknown[] = [];
  const interrupts: unknown[] = [];

  const host = {
    session: {
      async prompt(input: unknown) {
        prompts.push(input);
        promptImpl(emit);
      },
      async interrupt(input: unknown) {
        interrupts.push(input);
      },
    },
  } as unknown as OpenCode.Interface;

  return { hub, host, prompts, interrupts };
}

function collect(): { events: ChatEvent[]; onEvent: (event: ChatEvent) => void } {
  const events: ChatEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

test("streams deltas and finishes on execution success", async () => {
  const { events, onEvent } = collect();
  const h = harness((emit) => {
    emit({ type: "session.execution.started", data: { sessionID: "ses_1" } });
    emit({
      type: "session.text.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1" },
    });
    emit({ type: "session.text.delta", data: { sessionID: "ses_1", delta: "Hello" } });
    emit({ type: "session.text.delta", data: { sessionID: "ses_1", delta: " world" } });
    emit({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } });
    // A late session.idle must not produce a second `done`.
    emit({ type: "session.idle", data: { sessionID: "ses_1" } });
  });

  const result = await runPrompt({
    host: h.host,
    hub: h.hub,
    sessionID: "ses_1",
    text: "hi",
    timeoutMs: 1_000,
    onEvent,
  });

  assert.equal(result.answer, "Hello world");
  assert.equal(result.assistantMessageID, "msg_1");
  assert.deepEqual(
    events.map((event) => event.type),
    ["message_start", "delta", "delta", "done"],
  );

  const done = events.at(-1);
  assert.equal(done?.type, "done");
  assert.equal((done as { assistantMessageID?: string }).assistantMessageID, "msg_1");
  assert.equal(h.prompts.length, 1);
});

test("surfaces provider failures as an error event", async () => {
  const { events, onEvent } = collect();
  const h = harness((emit) => {
    emit({ type: "session.execution.started", data: { sessionID: "ses_2" } });
    emit({
      type: "session.execution.failed",
      data: { sessionID: "ses_2", error: { message: "boom" } },
    });
  });

  const result = await runPrompt({
    host: h.host,
    hub: h.hub,
    sessionID: "ses_2",
    text: "hi",
    timeoutMs: 1_000,
    onEvent,
  });

  assert.equal(result.answer, "");
  assert.deepEqual(
    events.map((event) => event.type),
    ["error"],
  );
  assert.equal((events[0] as { message: string }).message, "boom");
});

test("stops without prompting when the request was already aborted", async () => {
  const { events, onEvent } = collect();
  const h = harness(() => {
    throw new Error("prompt must not be called");
  });
  const controller = new AbortController();
  controller.abort();

  const result = await runPrompt({
    host: h.host,
    hub: h.hub,
    sessionID: "ses_3",
    text: "hi",
    timeoutMs: 1_000,
    signal: controller.signal,
    onEvent,
  });

  assert.equal(result.answer, "");
  assert.deepEqual(events, []);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.interrupts.length, 1);
});

test("reports prompt transport errors", async () => {
  const { events, onEvent } = collect();
  const listeners = new Set<(event: HubEvent) => void>();
  const hub = {
    subscribe(_sessionID: string, listener: (event: HubEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as EventHub;
  const host = {
    session: {
      async prompt() {
        throw new Error("network down");
      },
      async interrupt() {},
    },
  } as unknown as OpenCode.Interface;

  await assert.rejects(
    runPrompt({
      host,
      hub,
      sessionID: "ses_4",
      text: "hi",
      timeoutMs: 1_000,
      onEvent,
    }),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal((events[0] as { message: string }).message, "network down");
});
