# OpenCode Web Assistant

Учебный проект: веб-ИИ-ассистент на встроенном
[OpenCode SDK](https://opencode.ai/docs/build/sdk), упакованный в
multi-service Docker Compose.

Внутри четыре сервиса: nginx как единая точка входа, Node.js-приложение с
OpenCode, search-сервис и векторная база Qdrant. Ответы модели передаются
потоком через Server-Sent Events (SSE), поэтому интерфейс работает как чат в
ChatGPT.

```
                    ┌────────────────────────────────────────────┐
  браузер :8080 ───▶│ nginx                                      │
                    │  · publish :8080                           │
                    │  · proxy_buffering off (SSE)               │
                    └───────────────┬────────────────────────────┘
                                    │ http://web:8080
                    ┌───────────────▼────────────────────────────┐
                    │ web (Node.js + Fastify + OpenCode SDK)     │
                    │  · REST API и SSE                          │
                    │  · встроенный OpenCode host                │
                    │  · SQLite в томе opencode-data             │
                    └───────────────┬────────────────────────────┘
                                    │ http://vector-db:8080/search
                    ┌───────────────▼────────────────────────────┐
                    │ vector-db (search-сервис)                  │
                    │  · GET /healthz, POST /search              │
                    │  · создаёт коллекцию и загружает документы │
                    └───────────────┬────────────────────────────┘
                                    │ http://qdrant:6333
                    ┌───────────────▼────────────────────────────┐
                    │ qdrant (векторная база)                    │
                    │  · том qdrant-data                         │
                    └────────────────────────────────────────────┘
```

## Сервисы

| Сервис | Образ | Назначение |
| --- | --- | --- |
| `nginx` | `nginx:1.27-alpine` | публикует `WEB_PORT` (по умолчанию `8080`), проксирует на `web`, не буферизует SSE |
| `web` | сборка `./web` | HTTP API, SSE, чат-интерфейс, встроенный OpenCode |
| `vector-db` | сборка `./vector-db` | контракт `GET /healthz` + `POST /search` поверх Qdrant |
| `qdrant` | `qdrant/qdrant:v1.15.0` | хранение и поиск векторов |

Порядок запуска задан через `depends_on: condition: service_healthy`:
`qdrant → vector-db → web → nginx`. Внешний порт открывается только после
полной готовности цепочки.

## Что умеет

- `POST /api/sessions` — создать сессию;
- `GET /api/sessions` — список сессий;
- `GET /api/sessions/:id/messages` — история сообщений;
- `POST /api/sessions/:id/messages` — отправить сообщение;
  - по умолчанию отвечает `text/event-stream` (стриминг);
  - с `Accept: application/json` или `{"stream": false}` — обычный JSON;
- `POST /api/sessions/:id/interrupt` — остановить генерацию;
- `GET /health` — **readiness**: `200` только когда сервис реально готов;
- `GET /live` — liveness: процесс жив, но это не значит «готов»;
- `GET /` — чат-интерфейс.

## Почему `/health` — это readiness

`GET /health` возвращает `200` только если одновременно выполнены проверки:

| Проверка | Что означает |
| --- | --- |
| `opencode` | встроенный OpenCode host создан и отвечает на API-запрос |
| `database` | SQLite-база OpenCode читается (запрос к сессиям проходит) |
| `events` | подписка на поток событий OpenCode установлена |
| `model` | есть модель по умолчанию (можно отключить через `REQUIRE_MODEL=false`) |
| `vectorDb` | search-сервис отвечает, если задан `VECTOR_DB_URL`; иначе `disabled` |

Пока идёт инициализация, сервис уже слушает порт `8080`, но `/health` честно
отвечает `503` с JSON, в котором видно, какая проверка не прошла. Это
используется в `healthcheck` каждого контейнера и в `depends_on`.

```bash
curl -i http://localhost:8080/health
```

У nginx собственный healthcheck проксирует `/health` в `web`, поэтому nginx
считается здоровым только когда здоров весь путь запроса.

## Запуск с реальной моделью

```bash
cp .env.example .env
# впишите ключ провайдера и модель, например:
#   ANTHROPIC_API_KEY=...
#   OPENCODE_MODEL=anthropic/claude-sonnet-4-5

docker compose up -d --build

# ждём 200 от readiness
until curl -fsS http://localhost:8080/health >/dev/null; do sleep 2; done
curl -s http://localhost:8080/health | jq .
```

Открыть интерфейс: <http://localhost:8080>.

### Бесплатные варианты

Реальную модель можно подключить без оплаты, но с лимитами запросов:

| Провайдер | Ключ | Пример модели | Комментарий |
| --- | --- | --- | --- |
| Google Gemini | <https://aistudio.google.com/api-keys> | `google/gemini-3.8-flash` | бесплатный tier, данные могут использоваться для улучшения продуктов Google |
| OpenRouter | <https://openrouter.ai/keys> | `openrouter/google/gemma-4-31b-it:free` | модели с суффиксом `:free`; лимиты зависят от аккаунта |
| Groq | <https://console.groq.com/keys> | `groq/llama-3.3-70b-versatile` | быстрый бесплатный tier, если доступен для вашего аккаунта |

Пример `.env` для Gemini:

```dotenv
GEMINI_API_KEY=ваш_ключ
OPENCODE_MODEL=google/gemini-3.8-flash
REQUIRE_MODEL=true
```

Затем запускайте **только основной compose**, без mock-override:

```bash
docker compose -f compose.yaml up -d --build
```

Проверить, что модель видна:

```bash
curl -s http://localhost:8080/api/info | jq .
curl -s http://localhost:8080/health | jq '.checks.model'
curl -s http://localhost:8080/api/models | jq '.data[] | .providerID + "/" + .id'
```

Бесплатные лимиты и список моделей меняются. Если провайдер отвечает `429`,
подождите или переключите модель. Полностью бесплатный и приватный вариант —
локальный Ollama, но ему нужны ресурсы машины и отдельная настройка
OpenCode-провайдера.

Ключи провайдеров OpenCode читает из окружения: `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY` и
другие. Они не попадают в образ — передаются через `.env`/compose.

## Запуск без ключа: mock-провайдер

Для проверки всего пути «чат → OpenCode → провайдер → SSE → nginx» без
интернета и API-ключа есть детерминированный OpenAI-совместимый mock:

```bash
docker compose -f compose.yaml -f compose.mock.yaml up -d --build
```

`compose.mock.yaml` добавляет сервис `mock-llm` и переключает `web` на модель
`mock/mock-model`. Mock возвращает текст, в котором видно, был ли передан
контекст из векторной базы.

Проверка стриминга:

```bash
SESSION_ID=$(curl -s -X POST http://localhost:8080/api/sessions \
  -H 'content-type: application/json' \
  -d '{"title":"stream"}' | jq -r .session.id)

curl -N -X POST "http://localhost:8080/api/sessions/$SESSION_ID/messages" \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"text":"Что такое Docker?"}'
```

В ответе должны быть события `rag`, `message_start`, несколько `delta` и
`done`.

## API

### Создать сессию

```bash
curl -s -X POST http://localhost:8080/api/sessions \
  -H 'content-type: application/json' \
  -d '{"title":"Первый чат"}' | jq .
```

### Стриминг (SSE)

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

Ошибки провайдера (например, исчерпанный лимит) приходят событием `error` уже
после установки SSE-соединения, чтобы клиент всегда получал единый формат.

### Обычный JSON

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

## Переменные окружения

Основные (см. `.env.example`):

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `WEB_PORT` | `8080` | порт, который публикует nginx |
| `OPENCODE_MODEL` | — | модель в формате `provider/model` |
| `OPENCODE_AGENT` | — | агент по умолчанию |
| `OPENCODE_CONFIG_JSON` | — | готовый `opencode.json`; заменяет сгенерированный конфиг |
| `REQUIRE_MODEL` | `true` | требовать модель для `200 /health` |
| `VECTOR_DB_URL` | `http://vector-db:8080` | адрес search-сервиса; пустое значение выключает RAG |
| `VECTOR_DB_COLLECTION` | `knowledge` | коллекция для поиска |
| `VECTOR_DB_LIMIT` | `5` | сколько фрагментов добавлять в промпт |
| `VECTOR_DIM` | `512` | размерность вектора (должна совпадать у seed и запросов) |
| `SEED_ON_START` | `true` | загружать документы в пустую коллекцию |
| `LOG_LEVEL` | `info` | уровень логов приложения |

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

## CI

Workflow `.github/workflows/ci.yml`:

1. typecheck и сборка `web`;
2. проверка синтаксиса `vector-db`;
3. сборка Docker-образов `web`, `vector-db`, `mock-llm` и валидация compose;
4. smoke-тест: поднимает весь стек, ждёт `200 /health`, проверяет UI, `/live`,
   поиск в векторной базе, затем поднимает mock-провайдер и проверяет
   end-to-end SSE (`rag`, `delta`, `done`).

## Структура

```
ai-assistant/
├── compose.yaml            # nginx + web + vector-db + qdrant
├── compose.mock.yaml       # override с локальным mock-провайдером
├── .env.example
├── nginx/nginx.conf
├── web/                    # Fastify + OpenCode SDK
│   ├── Dockerfile
│   ├── src/
│   └── public/
├── vector-db/              # Qdrant search service
│   ├── Dockerfile
│   ├── src/
│   └── data/
└── mock-llm/               # OpenAI-compatible mock для тестов
```

## Быстрая проверка проекта

```bash
# 1. Полный стек без ключа
docker compose -f compose.yaml -f compose.mock.yaml up -d --build

# 2. Readiness
until curl -fsS http://localhost:8080/health >/dev/null; do sleep 2; done
curl -s http://localhost:8080/health | jq '.ready, .checks'

# 3. Интерфейс и liveness
curl -fsS -o /dev/null -w 'ui=%{http_code}\n' http://localhost:8080/
curl -fsS -o /dev/null -w 'live=%{http_code}\n' http://localhost:8080/live

# 4. Поиск в векторной базе (из контейнера web)
docker compose exec web curl -s -X POST http://vector-db:8080/search \
  -H 'content-type: application/json' \
  -d '{"query":"Docker контейнер","limit":2}'

# 5. Остановить
docker compose -f compose.yaml -f compose.mock.yaml down -v
```
