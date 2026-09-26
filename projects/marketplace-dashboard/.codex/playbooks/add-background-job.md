# Playbook: добавить фоновую работу модуля

1. Используйте существующий `ctx.scheduler`; модуль не создаёт `setInterval`, worker, Windows service или отдельную queue.
2. Опишите cadence, idempotency key, состояние попытки, retry и recovery в scheduler contract.
3. Передавайте scheduler в service явной зависимостью; не блокируйте HTTP handler неопределённо.
4. UI читает последний снимок и статус через module API; открытая вкладка не является scheduler.
5. Тестируйте due/next state, duplicate run, upstream error и recovery. Perf smoke не ждёт реального cadence и не проверяет flaky wall-clock.
6. Запустите `npm run verify:module -- <id>`.
