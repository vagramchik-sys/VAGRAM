# Playbook: оптимизировать endpoint модуля

1. Зафиксируйте API, параметры, размер ответа, источник задержки и корректность на локальном fixture.
2. Устраните повторные чтения и лишние поля через repository/service; проверьте PostgreSQL plan и индексы через `ctx.db`.
3. Учитывайте общий API admission queue и request metrics `server-postgres.cjs`; не добавляйте собственный limiter без причины.
4. Для scheduler/upstream сохраняйте pagination, Retry-After и duplicate-run protection; для cache документируйте freshness/invalidation.
5. Обновите perf smoke: проверяйте результат и счётчик операций/стабильный бюджет на fixture, без жёсткого flaky wall-clock threshold.
6. Запустите `npm run verify:module -- <id>` и сравните ответы до/после.
