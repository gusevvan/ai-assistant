# OpenCode SDK и веб-ассистент

OpenCode — агент для работы с кодом. Пакет `@opencode/sdk` позволяет встроить
OpenCode прямо в процесс Node.js. В этом проекте отдельный контейнер OpenCode
не нужен: SDK создаёт host через `OpenCode.create(...)`, хранит сессии в SQLite
и общается с провайдерами моделей.

Создание host:

```ts
const host = await OpenCode.create({
  database: { path: "/data/opencode.db" },
  config: {
    directory: "/workspace",
    content: JSON.stringify({ model: "anthropic/claude-sonnet-4-5" }),
  },
});
```

Отправка сообщения:

```ts
await host.session.prompt({ sessionID, text: "Привет" });
```

История сообщений читается методом `host.message.list({ sessionID, limit })`,
а не `host.session.message.list`.

## Потоковые события

OpenCode публикует события сессии. Веб-сервис подписывается на них один раз на
весь процесс и пересылает клиенту через Server-Sent Events (SSE). Основные
события:

- `session.text.started` — началось сообщение ассистента;
- `session.text.delta` — очередной фрагмент текста;
- `session.reasoning.delta` — рассуждения модели;
- `session.tool.called` — вызов инструмента;
- `session.execution.failed` — ошибка генерации;
- `session.idle` — сессия завершила работу.

SSE удобен для чата: сервер держит одно HTTP-соединение и отправляет события
`event: delta` с JSON-данными. Для SSE важно отключить буферизацию в обратном
прокси: в nginx используется `proxy_buffering off`, а приложение добавляет
заголовок `X-Accel-Buffering: no`.

## Модели и провайдеры

Ключи провайдеров передаются через переменные окружения: `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY` и другие. Модель
задаётся в формате `provider/model`, например
`anthropic/claude-sonnet-4-5`. Если модель не настроена, сервис может работать
в режиме инфраструктурной проверки с `REQUIRE_MODEL=false`, но чат отвечать не
сможет.
