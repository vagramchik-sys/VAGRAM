# Playbook: миграция данных модуля

1. Опишите таблицы, schema, версию и обратную совместимость PostgreSQL. `ctx.db` используется приложением, но миграция не выполняется при импорте route.
2. Используйте существующий PostgreSQL migration/deployment workflow; не создавайте SQLite-файл или собственную базу в `modules/<id>/`.
3. Сделайте миграцию идемпотентной и совместимой с service/repository. Runtime data и secrets не коммитятся.
4. Добавьте module tests для пустой/старой схемы, повторного запуска и ошибок; perf smoke использует детерминированный fixture без time gate.
5. Выполните `npm run verify:module -- <id>` и отдельную проверку миграции по runtime workflow.
