# Пульт: новые модули

Перед новой функцией прочитайте [MODULE_CONTRACT.md](MODULE_CONTRACT.md) и подходящий файл из [.codex/playbooks](.codex/playbooks). Большую функцию начните с короткой спецификации по [specs/_module-template.md](specs/_module-template.md), если в задаче нет достаточного ТЗ.

- Один запрос на разработку = одна ветка = один Git worktree. Не редактируйте работающий runtime или чужой dirty checkout.
- Создавайте новый модуль через `npm run module:create -- <id>`, используйте существующие `ctx.db`, scheduler, UI primitives и источники данных. Не создавайте отдельный pool, сервер или загрузку Ozon/WB в пользовательском HTTP-запросе.
- Перед завершением выполните `npm run verify:module -- <id>` и относящиеся к изменению тесты. Перед публикацией серьёзной функции выполните полный `node scripts/check.cjs` из корня VAGRAM.
- Регрессия производительности — ошибка. Не допускайте N+1, огромных payload и блокировки UI фоновыми задачами; фиксируйте причину и повторяйте smoke после исправления.
- Работающий PostgreSQL-Пульт использует `scripts/start-pult-postgres.cjs`. Для dev-проверки см. [docs/runtime-isolation.md](docs/runtime-isolation.md); production порт 4317 и общую базу не используйте без явного сценария.
