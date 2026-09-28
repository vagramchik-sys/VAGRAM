# Спецификация модуля: `<id>`

## Manifest

- `id`, `title`: `<значения>`.
- `route`: `/modules/<id>`; `apiNamespace`: `/api/modules/<id>`.
- `permission`: `<id>.read` как metadata; granular permissions нет.
- `navigation`, `enabled`, `developmentOnly`: `<значения и причина>`.
- Задача и границы v1: `<что входит / не входит>`.

## Структура и runtime context

Каталог `modules/<id>/` содержит manifest, `page.html/page.js/page.css`, `route.cjs`, `service.cjs`, `repository.cjs`, `api.schema.json`, README, test и perf smoke.

```text
ctx.db           read pool PostgreSQL
ctx.scheduler    существующий scheduler
ctx.marketplaces провайдеры источников
ctx.metrics      request metrics
ctx.logger       ограниченный безопасный logger
```

Модуль не создаёт собственный pool, scheduler, HTTP server или worker. Доступ — общий owner-session.

## API

| Метод и путь | Назначение | Вход | Выход/ошибка |
|---|---|---|---|
| `GET /api/modules/<id>` | `<чтение>` | `<query>` | `<schema>` / безопасный 4xx/5xx |
| `POST /api/modules/<id>` | `<команда>` | JSON | `<schema>` / безопасный 4xx |

## UI

`page.html` подключает `/modules/<id>/page.css` и `/modules/<id>/page.js`. Registry автоматически публикует активный модуль и navigation link; ручная правка `server-postgres.cjs` не нужна. Опишите loading, empty, error, success states и доступные controls.

## Проверка

- `npm run verify:module -- <id>` и `npm run verify:module -- --all`.
- module test: `<сценарии>`.
- perf smoke: локальный детерминированный fixture, без жёсткого flaky wall-clock gate.
- Ручной путь: PostgreSQL runtime → `/modules/<id>` → module API.
