const state = {
  sessions: [],
  currentSessionId: null,
  busy: false,
  abort: null,
  info: null,
  healthTimer: null,
};

const els = {
  sessionList: document.getElementById("session-list"),
  newSession: document.getElementById("new-session"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  stop: document.getElementById("stop"),
  chatTitle: document.getElementById("chat-title"),
  chatSubtitle: document.getElementById("chat-subtitle"),
  banner: document.getElementById("banner"),
  health: document.getElementById("health"),
  healthDot: document.getElementById("health-dot"),
  healthText: document.getElementById("health-text"),
  modelLabel: document.getElementById("model-label"),
};

function init() {
  els.newSession.addEventListener("click", () => void createSession());
  els.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage();
  });
  els.input.addEventListener("input", () => autoResize());
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      els.composer.requestSubmit();
    }
  });
  els.stop.addEventListener("click", () => void stopGeneration());
  window.addEventListener("beforeunload", () => state.abort?.abort());

  void boot();
}

async function boot() {
  try {
    await Promise.all([refreshInfo(), refreshHealth()]);
    await refreshSessions();
    if (state.sessions.length === 0) {
      await createSession(false);
    }
  } catch (error) {
    showBanner(`Не удалось загрузить приложение: ${error.message}`);
  }

  state.healthTimer = window.setInterval(() => void refreshHealth(), 5_000);
}

async function refreshInfo() {
  const info = await api("/api/info");
  state.info = info;
  if (info.model) {
    els.modelLabel.textContent = `${info.model.providerID}/${info.model.id}`;
  } else {
    els.modelLabel.textContent = "модель не настроена";
  }
  if (info.rag?.enabled) {
    els.chatSubtitle.textContent = "RAG включён · ответ приходит потоком";
  }
}

async function refreshHealth() {
  try {
    const response = await fetch("/health", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    const checks = data.checks ?? {};
    const failed = Object.entries(checks).filter(([, check]) => check.status === "error");

    els.health.classList.remove("ok", "error");
    if (data.ready) {
      els.health.classList.add("ok");
      els.healthText.textContent = "готов";
      hideBanner();
    } else {
      els.health.classList.add("error");
      els.healthText.textContent = "не готов";
      if (failed.length > 0) {
        showBanner(
          `Сервис ещё не готов: ${failed
            .map(([name, check]) => `${name}${check.message ? ` — ${check.message}` : ""}`)
            .join("; ")}`,
        );
      } else {
        showBanner("Сервис ещё не готов");
      }
    }
  } catch {
    els.health.classList.remove("ok");
    els.health.classList.add("error");
    els.healthText.textContent = "нет связи";
    showBanner("Нет связи с сервисом");
  }
}

async function refreshSessions() {
  const data = await api("/api/sessions?limit=100");
  state.sessions = data.data ?? [];
  renderSessionList();

  if (state.currentSessionId && !state.sessions.some((session) => session.id === state.currentSessionId)) {
    state.currentSessionId = null;
  }

  if (!state.currentSessionId && state.sessions.length > 0) {
    await selectSession(state.sessions[0].id, true);
  }
}

async function createSession(reload = true) {
  const data = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({}),
  });
  state.currentSessionId = data.session.id;

  if (reload) {
    await refreshSessions();
  } else {
    state.sessions.unshift(data.session);
    renderSessionList();
  }

  await selectSession(data.session.id, true);
}

async function selectSession(sessionID, loadMessages = true) {
  state.currentSessionId = sessionID;
  const session = state.sessions.find((item) => item.id === sessionID);
  els.chatTitle.textContent = session?.title || "Новый чат";
  renderSessionList();

  if (loadMessages) {
    try {
      const data = await api(`/api/sessions/${sessionID}/messages?limit=200&order=asc`);
      renderHistory(data.data ?? []);
    } catch (error) {
      showBanner(`Не удалось загрузить историю: ${error.message}`);
    }
  }
}

async function deleteSession(sessionID) {
  if (!window.confirm("Удалить этот чат?")) return;
  try {
    await api(`/api/sessions/${sessionID}`, { method: "DELETE" });
    if (state.currentSessionId === sessionID) state.currentSessionId = null;
    await refreshSessions();
    if (state.sessions.length === 0) await createSession(false);
  } catch (error) {
    showBanner(`Не удалось удалить чат: ${error.message}`);
  }
}

function renderSessionList() {
  els.sessionList.innerHTML = "";

  for (const session of state.sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-item";
    if (session.id === state.currentSessionId) button.classList.add("active");
    button.title = session.title || "Новый чат";
    button.addEventListener("click", () => void selectSession(session.id, true));

    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = session.title || "Новый чат";
    button.append(title);

    const remove = document.createElement("span");
    remove.className = "session-delete";
    remove.setAttribute("role", "button");
    remove.setAttribute("aria-label", "Удалить чат");
    remove.textContent = "×";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteSession(session.id);
    });
    button.append(remove);

    els.sessionList.append(button);
  }
}

async function sendMessage() {
  const text = els.input.value.trim();
  if (!text || state.busy) return;

  if (!state.currentSessionId) {
    await createSession(false);
  }

  const sessionID = state.currentSessionId;
  if (!sessionID) return;

  els.input.value = "";
  autoResize();
  hideEmptyState();
  appendUserMessage(text);
  const assistant = appendAssistantMessage();
  scrollToBottom();

  state.busy = true;
  updateBusy();
  const controller = new AbortController();
  state.abort = controller;

  try {
    const response = await fetch(`/api/sessions/${sessionID}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.message || `HTTP ${response.status}`);
    }

    await consumeSse(response, (event, payload) => {
      handleChatEvent(assistant, event, payload);
    });
  } catch (error) {
    if (error.name !== "AbortError") {
      assistant.setError(error.message || "Ошибка генерации");
    }
  } finally {
    state.busy = false;
    state.abort = null;
    updateBusy();
    assistant.finish();
    scrollToBottom();
    void refreshSessions().catch(() => undefined);
  }
}

async function stopGeneration() {
  const sessionID = state.currentSessionId;
  if (!sessionID) return;

  state.abort?.abort();
  try {
    await api(`/api/sessions/${sessionID}/interrupt`, { method: "POST" });
  } catch {
    // The request may already be finished.
  }
}

function handleChatEvent(assistant, event, payload) {
  switch (event) {
    case "message_start":
      assistant.setMessageID(payload?.assistantMessageID);
      break;

    case "delta":
      if (typeof payload?.text === "string") assistant.appendText(payload.text);
      break;

    case "reasoning":
      if (typeof payload?.text === "string") assistant.appendReasoning(payload.text);
      break;

    case "tool_start":
      assistant.addTool(payload?.id || `tool-${Date.now()}`, "вызов", false);
      break;

    case "tool_end":
      assistant.finishTool(payload?.id, true);
      break;

    case "tool_error":
      assistant.finishTool(payload?.id, false);
      break;

    case "rag":
      assistant.setSources(payload?.sources ?? []);
      break;

    case "error":
      assistant.setError(payload?.message || "Ошибка генерации");
      break;

    case "done":
      assistant.setMessageID(payload?.assistantMessageID);
      assistant.finish();
      break;
  }
}

function renderHistory(messages) {
  els.messages.innerHTML = "";
  const visible = messages.filter(
    (message) => message.type === "user" || message.type === "assistant",
  );

  if (visible.length === 0) {
    showEmptyState();
    return;
  }

  for (const message of visible) {
    if (message.type === "user") {
      appendUserMessage(message.text || "");
      continue;
    }

    const assistant = appendAssistantMessage();
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      if (part.type === "text" && typeof part.text === "string") assistant.appendText(part.text);
      if (part.type === "reasoning" && typeof part.text === "string") assistant.appendReasoning(part.text);
      if (part.type === "tool") {
        assistant.addTool(part.id || `tool-${Date.now()}`, part.name || "tool", true);
      }
    }
    if (message.error?.message) assistant.setError(message.error.message);
    assistant.finish();
  }

  scrollToBottom();
}

function appendUserMessage(text) {
  const article = document.createElement("div");
  article.className = "message user";
  article.innerHTML = '<div class="avatar">Вы</div><div class="bubble"><div class="text"></div></div>';
  article.querySelector(".text").textContent = text;
  els.messages.append(article);
  return article;
}

function appendAssistantMessage() {
  const article = document.createElement("div");
  article.className = "message assistant";
  article.innerHTML = `
    <div class="avatar">AI</div>
    <div class="bubble">
      <div class="typing"><i></i><i></i><i></i></div>
      <div class="text"></div>
      <details class="reasoning hidden"><summary>Рассуждения</summary><div class="content"></div></details>
      <details class="sources hidden"><summary>Контекст базы знаний</summary><div class="content"></div></details>
      <div class="meta"></div>
    </div>
  `;
  els.messages.append(article);

  const text = article.querySelector(".text");
  const typing = article.querySelector(".typing");
  const reasoning = article.querySelector("details.reasoning");
  const reasoningContent = reasoning.querySelector(".content");
  const sources = article.querySelector("details.sources");
  const sourcesContent = sources.querySelector(".content");
  const meta = article.querySelector(".meta");
  const tools = new Map();

  return {
    setMessageID(id) {
      if (id) article.dataset.messageID = id;
    },

    appendText(chunk) {
      typing.classList.add("hidden");
      text.textContent += chunk;
      autoScroll();
    },

    appendReasoning(chunk) {
      reasoning.classList.remove("hidden");
      reasoningContent.textContent += chunk;
    },

    addTool(id, label, done) {
      let chip = tools.get(id);
      if (!chip) {
        chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = label;
        chip.title = id;
        meta.append(chip);
        tools.set(id, chip);
      }
      chip.classList.toggle("good", done);
    },

    finishTool(id, ok) {
      if (!id) return;
      const chip = tools.get(id);
      if (!chip) return;
      chip.classList.toggle("good", ok);
      chip.classList.toggle("bad", !ok);
      chip.textContent = ok ? "вызов выполнен" : "вызов не удался";
    },

    setSources(list) {
      if (!Array.isArray(list) || list.length === 0) return;
      sources.classList.remove("hidden");
      sources.querySelector("summary").textContent =
        `Контекст базы знаний · ${list.length} фрагм.`;
      sourcesContent.textContent = list
        .map((source, index) => `[${index + 1}] ${source.text ?? ""}`)
        .join("\n\n");
    },

    setError(message) {
      typing.classList.add("hidden");
      const error = document.createElement("div");
      error.className = "error-text";
      error.textContent = `Ошибка: ${message}`;
      text.append(error);
    },

    finish() {
      typing.classList.add("hidden");
      if (text.textContent.trim() === "" && !text.querySelector(".error-text")) {
        text.textContent = "(пустой ответ)";
      }
      autoScroll();
    },
  };
}

function showEmptyState() {
  els.messages.innerHTML = `
    <div class="empty-state">
      <h2>Чем помочь?</h2>
      <p>Задайте вопрос. Сервис работает на встроенном OpenCode SDK: ответ приходит потоком, а история хранится в сессии.</p>
    </div>
  `;
}

function hideEmptyState() {
  els.messages.querySelector(".empty-state")?.remove();
}

function updateBusy() {
  els.send.disabled = state.busy;
  els.stop.classList.toggle("hidden", !state.busy);
  els.chatSubtitle.textContent = state.busy
    ? "Генерирую ответ…"
    : state.info?.rag?.enabled
      ? "RAG включён · ответ приходит потоком"
      : "Готов принимать сообщения";
}

function autoResize() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 220)}px`;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function autoScroll() {
  const distance = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight;
  if (distance < 160) scrollToBottom();
}

function showBanner(message) {
  els.banner.textContent = message;
  els.banner.classList.remove("hidden");
}

function hideBanner() {
  els.banner.classList.add("hidden");
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["content-type"] = "application/json";

  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    throw new Error(data?.message || `HTTP ${response.status}`);
  }
  return data;
}

async function consumeSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      parseSseChunk(chunk, onEvent);
    }
  }

  if (buffer.trim() !== "") parseSseChunk(buffer, onEvent);
}

function parseSseChunk(chunk, onEvent) {
  let event = "message";
  const data = [];

  for (const rawLine of chunk.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }

  if (data.length === 0) return;

  let payload = {};
  try {
    payload = JSON.parse(data.join("\n"));
  } catch {
    payload = { text: data.join("\n") };
  }
  onEvent(event, payload);
}

init();
