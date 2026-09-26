# Playbook: создать модуль

1. Выберите lower-case kebab-case id и выполните `npm run module:create -- --id <id> --title "..."`.
2. Работайте внутри `modules/<id>/`; generator создаёт manifest, assets, route/service/repository, schema, test, README и perf smoke, не перезаписывая существующие файлы.
3. Согласуйте manifest paths и `permission` с id; решите `navigation`, `enabled`, `developmentOnly`.
4. Используйте `ctx.db` в repository, `ctx.scheduler` для существующего расписания и `create({ config, ctx })` в route. Не создавайте pool, HTTP server или queue.
5. PostgreSQL application автоматически обнаружит manifest, передаст context и подключит API/assets через registry. Не регистрируйте модуль вручную в `server-postgres.cjs`.
6. Подключите `/modules/<id>/page.js` и `/modules/<id>/page.css` в page.html. Registry сам добавит navigation.
7. Запустите `npm run verify:module -- <id>` и `--all`; perf smoke не должен зависеть от точного времени wall-clock.
