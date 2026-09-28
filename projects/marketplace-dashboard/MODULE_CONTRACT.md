# Контракт модуля Developer Platform v1

Модуль — каталог `modules/<id>/`, автоматически обнаруживаемый PostgreSQL runtime. Ручная регистрация в `server-postgres.cjs`, legacy `server.cjs` и копирование страницы в `dist/` для нового модуля не нужны.

## Структура

```text
modules/<id>/{module.config.cjs,page.html,page.js,page.css,route.cjs,service.cjs,repository.cjs,api.schema.json,README.md,perf-smoke.cjs}
modules/<id>/test/module.test.cjs
```

`<id>` — lower-case kebab-case. Manifest содержит только `id`, `title`, `route` (`/modules/<id>`), `apiNamespace` (`/api/modules/<id>`), `permission` (`<id>.read`), `navigation`, `enabled`, `developmentOnly`.

## Runtime

`storage/postgres-application.cjs` создаёт registry из `modules/`, передаёт контекст и подключает API/assets в `server-postgres.cjs`. Модуль получает `ctx.db` (read pool PostgreSQL), `ctx.scheduler`, `ctx.marketplaces`, `ctx.metrics` и ограниченный `ctx.logger`. Он не создаёт собственный pool, HTTP server, scheduler или worker.

Runtime стартует через `scripts/start-pult-postgres.cjs`; готовность PostgreSQL проверяется до запросов. `PULT_DEV_MODULES=1` включает development-only модули, `PULT_MODULES_DISABLED` отключает id.

## Правила реализации

- UI обращается только к локальному API Пульта; Ozon/WB загружает существующий фоновый контур. Для новых фоновых работ используйте общий scheduler и защищайтесь от дублей.
- Переиспользуйте существующие service/repository и PostgreSQL migration flow. Не создавайте pool на модуль и не держите соединение во время внешнего HTTP.
- Выбирайте агрегаты и ограниченный payload под экран, не передавайте ненужные RAW-массивы. N+1 и ухудшение измеренного performance baseline считаются ошибкой.
- Для дат используйте принятую бизнес-зону Europe/Moscow; не смешивайте её с локальной зоной браузера.
- Каждый модуль имеет API contract, функциональный тест, performance smoke и состояния loading, empty, error. Проверяйте количество SQL-запросов и размер ответа; ориентир для интерактивного API — p95 до 300 мс, для первого KPI — до 1 с после прогрева, без потери корректности.

## Доступ и API

Module API проходят общий owner-session. Статические assets доступны только для включённых модулей по той же локальной схеме, что и остальная статика Пульта; сами по себе они не содержат секретов. Полноценного granular permission enforcement нет: `permission` — registry metadata, а не отдельные роли.

`route.cjs` экспортирует `create({ config, ctx })`, возвращающий `{ handle(request, response, url) }`. Repository/service используют `ctx.db`; API namespace должен совпадать с manifest. Ответы соответствуют `api.schema.json`, ошибки не раскрывают SQL, ключи или stack trace.

## UI и assets

Registry отдаёт `/modules/navigation.js`, динамически добавляющий активные модули в `.sidebar nav` и `.seller-navigation`, и обслуживает `/modules/<id>`, `page.js`, `page.css`. `page.html` ссылается на эти URL. Для новой страницы доступны `/module-ui.css` и `/module-ui.js` с `PageHeader`, состояниями loading/empty/error, KPI и простой таблицей; основные экраны продолжают использовать существующие `seller-shell.css`, `navigation.js` и `page-layout.js`. Не копируйте registry/nav и не вводите свой дизайн без причины.

Новые страницы используют общие цветовые токены, отступы, типографику, плотность таблиц и карточки с радиусом 12–16 px из `module-ui.css`. Фильтры, диапазоны дат, выбор магазина, графики, модальные окна и пагинацию сначала ищите в существующем UI; добавляйте в общий kit только доказанно повторяемые элементы.

## Проверка

```powershell
npm run module:create -- --id sales-forecast
npm run verify:module -- sales-forecast
npm run verify:module -- --all
```

Verify проверяет обязательные файлы, manifest, assets, `node --check`, module test и perf smoke. Smoke должен быть повторяемым и не иметь flaky time gate, зависящего от загруженности машины или точного wall-clock значения.
