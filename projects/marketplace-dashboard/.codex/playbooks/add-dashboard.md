# Playbook: добавить dashboard в модуль

1. Делайте экран в `modules/<id>/page.html`; активный manifest доступен по `/modules/<id>`.
2. Получайте данные через `/api/modules/<id>` и schema. Не отдавайте браузеру `ctx.db`, credentials или `.private`.
3. Переиспользуйте UI-паттерны Пульта (`panel`, `topbar`, `button`, `dialog`, `aria-live`), а логику держите в service/repository.
4. Registry сам добавляет ссылку в `.sidebar nav` и `.seller-navigation`, если `navigation: true`; не меняйте `server-postgres.cjs`.
5. Реализуйте loading, empty, error, success states и валидные фильтры/даты.
6. Проверьте `npm run verify:module -- <id>` и owner-session сценарий.
