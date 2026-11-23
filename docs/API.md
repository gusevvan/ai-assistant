# API и детали устройства

Дополнение к [README](../README.md): эндпоинты, события SSE, контракт
RAG-сервиса, переменные окружения и разработка без Docker.

Все примеры идут через nginx на `http://localhost:8080`. Для красивого
вывода JSON используется `jq` (не обязателен).

## Эндпоинты

| Метод и путь | Назначение |
| --- | --- |
| `GET /` | чат-интерфейс |
| `GET /health` | readiness: `200` только когда сервис реально готов |
| `GET /live` | liveness: процесс жив (не значит «готов») |
| `GET /api/info` | активная модель и параметры |
| `GET /api/models` | список доступных моделей |
| `POST /api/sessions` | создать сессию |
| `GET /api/sessions` | список сессий |
| `GET /api/sessions/:id/messages` | история сообщений |
| `POST /api/sessions/:id/messages` | отправить сообщение (SSE или JSON) |
| `POST /api/sessions/:id/interrupt` | остановить генерацию |

## Проверки в `/health`

`200` возвращается, только когда все проверки не в состоянии `error`:

| Проверка | Что означает |
| --- | --- |
| `opencode` | встроенный OpenCode host создан и отвечает на API-запрос |
| `database` | SQLite-база OpenCode читается (запрос к сессиям проходит) |
| `events` | подписка на поток событий OpenCode установлена |
| `model` | есть модель по умолчанию (`REQUIRE_MODEL=false` отключает требование) |
| `vectorDb` | search-сервис отвечает, если задан `VECTOR_DB_URL`; иначе `disabled` |

```bash
curl -s http://localhost:8080/health | jq .
```

## Создать сессию

```bash
curl -s -X POST http://localhost:8080/api/sessions \
  -H 'content-type: application/json' \
  -d '{"title":"Первый чат"}' | jq .
```

## Стриминг (SSE)

```bash
SESSION_ID=... # id из ответа выше

curl -N -X POST "http://localhost:8080/api/sessions/$SESSION_ID/messages" \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"text":"Привет! Объясни, что такое Docker."}'
```

События:

| event | data |
| --- | --- |
| `rag` | `{ "sources": [...] }` — контекст, добавленный в первый запрос сессии |
| `message_start` | `{ "assistantMessageID": "..." }` |
| `delta` | `{ "text": "..." }` — очередной кусок ответа |
| `reasoning` | `{ "text": "..." }` — рассуждения модели, если есть |
| `tool_start` / `tool_end` / `tool_error` | вызовы инструментов OpenCode |
| `error` | `{ "message": "..." }` |
| `done` | `{ "assistantMessageID": "..." }` |

Ошибки провайдера (например, исчерпанный лимит) приходят событием `error`
уже после установки SSE-соединения, чтобы клиент всегда получал единый
формат.

## Обычный JSON

С заголовком `Accept: application/json` или телом `{"stream": false}`:

```bash
curl -s -X POST "http://localhost:8080/api/sessions/$SESSION_ID/messages" \
  -H 'content-type: application/json' \
  -H 'accept: application/json' \
  -d '{"text":"Скажи одним предложением, что такое контейнер."}' | jq .
```

## RAG и векторная база

`vector-db` реализует контракт, который ожидает веб-сервис:

```http
GET /healthz
```

```http
POST /search
Content-Type: application/json

{ "query": "вопрос пользователя", "limit": 5, "collection": "knowledge" }
```

```json
{
  "results": [
    { "text": "фрагмент текста", "score": 0.87, "metadata": { "source": "docs.md" } }
  ]
}
```

При старте сервис создаёт коллекцию Qdrant, разбивает документы из `SEED_DIR`
на чанки, считает embeddings и загружает их. Используется детерминированное
хэширование токенов и биграмм — это позволяет работать полностью офлайн, без
внешней embedding-модели. Для учебного проекта этого достаточно; в реальном
сервисе embedding-функцию можно заменить, не меняя контракт.

Веб-сервис вызывает `/search` только при **первом** сообщении в сессии и
добавляет найденные фрагменты в промпт. Если векторная база недоступна, чат
продолжает работать без контекста, а `/health` показывает ошибку зависимости.

Документы для демонстрации лежат в `vector-db/data/` (`docker.md`,
`opencode.md`, `project.md`). Чтобы загрузить свои, смонтируйте каталог и
задайте `SEED_DIR`; загрузка выполняется только когда коллекция пуста.

Проверить поиск из контейнера web:

```bash
docker compose exec web curl -s -X POST http://vector-db:8080/search \
  -H 'content-type: application/json' \
  -d '{"query":"Docker контейнер","limit":2}'
```

## Переменные окружения

Основные (см. [.env.example](../.env.example)):

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `WEB_PORT` | `8080` | порт, который публикует nginx |
| `OPENCODE_MODEL` | `mock/mock-model` | модель в формате `provider/model`; пусто в `.env` = mock |
| `REQUIRE_MODEL` | `true` | требовать модель для `200 /health` |
| `VECTOR_DB_URL` | `http://vector-db:8080` | адрес search-сервиса; пустое значение выключает RAG |
| `VECTOR_DB_COLLECTION` | `knowledge` | коллекция для поиска |
| `VECTOR_DB_LIMIT` | `5` | сколько фрагментов добавлять в промпт |
| `VECTOR_DIM` | `512` | размерность вектора (должна совпадать у seed и запросов) |
| `SEED_ON_START` | `true` | загружать документы в пустую коллекцию |
| `LOG_LEVEL` | `info` | уровень логов приложения |

Ключи провайдеров (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, …) OpenCode читает
из окружения; они передаются через `.env`/compose и не попадают в образ.

Приложение также поддерживает `OPENCODE_AGENT` (агент по умолчанию) и
`OPENCODE_CONFIG_JSON` (полностью свой `opencode.json`) — это удобно при
локальной разработке; в compose конфиг генерируется автоматически и всегда
регистрирует mock-провайдер.

Внутренние адреса (`http://web:8080`, `http://vector-db:8080`,
`http://qdrant:6333`) работают благодаря общей сети Docker Compose.

## Разработка без Docker

```bash
cd web
npm ci
npm run dev
```

Требуется Node.js 26+ (из-за дерева зависимостей `@opencode/sdk`). Для
`vector-db` и `mock-llm` достаточно Node.js 22+, у них нет npm-зависимостей.

Тесты и проверки:

```bash
cd web && npm run typecheck && npm test   # юнит-тесты web
cd vector-db && npm test                  # юнит-тесты embeddings
node scripts/smoke.mjs                    # end-to-end против поднятого стека
```

## Структура репозитория

```
ai-assistant/
├── Dockerfile              # образ web, собирается из корня: docker build .
├── .dockerignore
├── compose.yaml            # nginx + web + vector-db + qdrant + mock-llm
├── .env.example
├── nginx/nginx.conf
├── scripts/smoke.mjs       # end-to-end smoke-тест
├── web/                    # Fastify + OpenCode SDK
│   ├── src/
│   └── public/
├── vector-db/              # Qdrant search service
│   ├── Dockerfile
│   ├── src/
│   └── data/
└── mock-llm/               # OpenAI-compatible mock-провайдер
    ├── Dockerfile
    └── src/
```
