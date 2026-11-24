# OpenCode Web Assistant

[![ci](https://github.com/gusevvan/ai-assistant/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gusevvan/ai-assistant/actions/workflows/ci.yml)

Веб-ИИ-ассистент с RAG на встроенном [OpenCode SDK](https://opencode.ai/docs/build/sdk).
Учебный проект: пять сервисов в Docker Compose:

```
браузер :8080 → nginx → web (OpenCode) → vector-db → qdrant
                          └→ mock-llm (модель по умолчанию, без ключей)
```

## Быстрый старт

Нужен только Docker с Compose v2 (`docker compose version`).

```bash
git clone https://github.com/gusevvan/ai-assistant.git
cd ai-assistant
docker compose up -d --build
```

Первая сборка занимает несколько минут. Когда все контейнеры станут
`healthy`, откройте **<http://localhost:8080>** и напишите сообщение в чат.

По умолчанию отвечает локальная **mock-модель** — детерминированный
OpenAI-совместимый провайдер в контейнере `mock-llm`. Благодаря этому весь
путь «чат → OpenCode → провайдер → SSE → nginx» работает без API-ключей и
внешних LLM-сервисов. Как подключить настоящую модель — [ниже](#реальная-модель).

## Как проверить

```bash
# Readiness: 200 + JSON, когда приложение реально готово
curl -i http://localhost:8080/health

# Все контейнеры healthy
docker compose ps
```

`/health` — это **readiness**, а не «контейнер запущен»: `200` возвращается
только когда проверены OpenCode, его SQLite-база, поток событий, модель по
умолчанию и векторная база. Пока идёт инициализация, сервис честно отвечает
`503` и показывает в JSON, какая проверка не прошла. `/live` — простой
liveness. Healthcheck nginx проксирует `/health`, поэтому внешний порт
открывается только после готовности всей цепочки
`qdrant → vector-db → web → nginx`.

Ещё проверки: открыть UI (`/`), отправить сообщение в чат, посмотреть
логи `docker compose logs -f web`. Полный smoke-тест: `node scripts/smoke.mjs`.

## Реальная модель

```bash
cp .env.example .env
# впишите ключ и модель, например:
#   GEMINI_API_KEY=ваш_ключ
#   OPENCODE_MODEL=google/gemini-3.8-flash
docker compose up -d
```

Бесплатные варианты (с лимитами запросов):

| Провайдер | Где взять ключ | Пример модели |
| --- | --- | --- |
| Google Gemini | <https://aistudio.google.com/api-keys> | `google/gemini-3.8-flash` |
| OpenRouter | <https://openrouter.ai/keys> | `openrouter/google/gemma-4-31b-it:free` |
| Groq | <https://console.groq.com/keys> | `groq/llama-3.3-70b-versatile` |

Ключи передаются через `.env` и не попадают в образ. Если провайдер отвечает
`429` — лимит, подождите или смените модель. Вернуть mock: очистите
`OPENCODE_MODEL` в `.env` и снова `docker compose up -d`.

## Сервисы

| Сервис | Образ | Назначение |
| --- | --- | --- |
| `nginx` | `nginx:1.27-alpine` | публикует `WEB_PORT` (по умолчанию `8080`), проксирует на `web`, не буферизует SSE |
| `web` | сборка `./web` | HTTP API, SSE, чат-интерфейс, встроенный OpenCode |
| `vector-db` | сборка `./vector-db` | поиск по документам для RAG поверх Qdrant |
| `qdrant` | `qdrant/qdrant:v1.15.0` | векторная база, данные в томе |
| `mock-llm` | сборка `./mock-llm` | локальная модель по умолчанию, без ключей |

Сервисы общаются по именам внутри общей сети Compose
(`http://web:8080`, `http://vector-db:8080`, `http://qdrant:6333`).
Данные SQLite и Qdrant живут в именованных томах и переживают перезапуски;
`docker compose down -v` удаляет их.

## CI

[GitHub Actions](.github/workflows/ci.yml) на каждый push: typecheck и
юнит-тесты → сборка всех Docker-образов → smoke-тест полного стека
(readiness, UI, поиск, стриминг SSE с RAG). Зелёный прогон виден во вкладке
Actions и в бейдже выше.

## Полезные команды

```bash
docker compose logs -f web        # логи приложения
docker compose up -d --build      # пересобрать после изменений
docker compose down               # остановить (данные сохранятся)
docker compose down -v            # остановить и удалить данные
```

## Подробнее

[docs/API.md](docs/API.md) — REST API, события SSE, контракт RAG-сервиса,
все переменные окружения и разработка без Docker.
