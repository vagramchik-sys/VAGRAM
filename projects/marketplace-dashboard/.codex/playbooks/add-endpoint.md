# Playbook: добавить endpoint модуля

1. Используйте путь `/api/modules/<id>` и согласуйте его с manifest `apiNamespace`.
2. Реализуйте handler в `route.cjs`; registry подключит его автоматически.
3. Используйте общий owner-session. Granular permissions отсутствуют, `permission` остаётся metadata.
4. Читайте через `ctx.db` и repository; не открывайте новый pool. Долгую работу передавайте `ctx.scheduler`.
5. Возвращайте `api.schema.json`, безопасные 4xx/5xx без SQL/stack trace.
6. Добавьте module test для успеха, invalid input, missing resource и повторяемости; запустите `npm run verify:module -- <id>`.
