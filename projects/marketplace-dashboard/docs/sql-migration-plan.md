# План полного переноса Пульта в PostgreSQL

## Цель и границы

Цель — сделать локальный PostgreSQL единственным постоянным рабочим хранилищем Пульта. После завершения cutover приложение не читает и не создаёт рабочие JSON, SQLite, файлы документов или архивные gzip. На файловой системе остаются только код и статика, временные файлы с гарантированной очисткой, PID locks, резервные копии и bootstrap с localhost, портом, именем БД и ролью приложения.

PostgreSQL выбран владельцем, но план не означает, что сервер уже установлен или данные уже перенесены. Для локальной установки под текущим неадминистративным токеном может потребоваться повышение прав Windows.

Capacity gate остаётся обязательным: оцениваются данные, индексы, WAL, `bytea` BLOB, темп роста сжатого дедуплицированного архива, свободный диск и время backup/restore. Фактические объёмы и темпы роста остаются в частной инвентаризации и не публикуются.

Текущий статус на 22 сентября 2026 года: локальный PostgreSQL создан и запущен отдельно от работающего Пульта; подготовлена пустая БД и отдельные ограниченные роли. Импортёры и репозитории прошли настоящие PostgreSQL-тесты на синтетических данных. Реальный `pg_dump`/`pg_restore` рабочих данных, импорт фактических данных, runtime wiring и cutover не выполнялись и не считаются проверенными. До их завершения этот документ описывает целевое состояние, а не достигнутый результат.

Публичные документы, логи и отчёты не должны содержать реальные store ID, суммы, секреты или инвентаризацию `.private`. Примеры используют только вымышленные значения.

## Архитектура хранения

Одна база PostgreSQL содержит схему `pult` с рабочими доменными данными, append-only журналом команд, checkpoints и результатами replay. Журнал находится в той же БД: изменение домена и строка `pult.commands` фиксируются одной транзакцией. Разделение на две PostgreSQL-базы потребовало бы two-phase commit и не используется.

Запись подтверждается клиенту только после durable commit доменных строк и команды. От потери хоста защищают проверенные резервные копии и WAL, вынесенные за пределы единственного хоста; ещё одна БД на том же диске такой защиты не даёт.

Для идентификаторов используются PostgreSQL `uuid` или стабильные `text`/`varchar` ключи. Моменты времени хранятся как `timestamptz` и передаются в UTC; календарный бизнес-день хранится как `date` и вычисляется в зоне `Europe/Moscow`. SHA-256 хранится как 32-байтовый `bytea`. Изменяемые агрегаты получают `revision bigint NOT NULL`; CAS выполняется через `UPDATE ... WHERE revision=$expected` с увеличением revision.

Числовой тип выбирается только после precision audit каждого поля. Источники SQLite `REAL` и JavaScript могут содержать значимые доли меньше копейки: миграция не округляет их до `decimal(19,2)`. Импорт сохраняет исходное представление/значение и доказательный payload, а сверка отчётов подтверждает эквивалентность. После аудита поле получает достаточный `decimal(p,s)`, целочисленный тип либо документированное floating-point представление.

JSON допустим в PostgreSQL `jsonb` как типизированный payload или исходное доказательство. Он не является файловым master. Документы и уже сжатые архивные снимки хранятся в `bytea` вместе с размером, MIME/type, SHA-256 и временем получения. Одинаковые BLOB дедуплицируются по SHA-256.

PostgreSQL слушает только localhost. `pg_hba.conf` разрешает локальные подключения по SCRAM-SHA-256; trust и публичный listen запрещены. Роль `pult_app` не имеет SUPERUSER, CREATEDB, CREATEROLE или владения схемой и получает только нужные DML/sequence privileges. DDL и импорт выполняют отдельные роли `pult_migrator` и `pult_importer`; интерактивная/admin роль не используется приложением.

## Служебные таблицы

| Таблица | Назначение и ключи |
| --- | --- |
| `schema_versions` | Версии схемы и checksum применённой миграции. |
| `migration_runs` | Один запуск импорта: источник, начало/конец, статус, checkpoint и сводка без частных данных. |
| `migration_items` | Идемпотентность: unique `(source_kind, source_key, content_hash)`; статус, ошибка-код и число строк. |
| `commands` / `applied_commands` | Unique `command_id`, sequence, payload, commit marker, версия команды и результат применения. Минимально — `pult.commands` в рабочей БД. |
| `blobs` | Unique `sha256`; bytes, length, content_type, compression, created_at. |
| `settings` | Типизированные несекретные настройки по unique `(scope, owner_key, name)` и `revision bigint`. |

`commands` получает монотонный `bigint` sequence, unique `command_id`, тип команды, целевой aggregate key, ожидаемую/новую revision, `jsonb` payload и committed timestamp. `checkpoints`, `journal_blobs` и `replay_results` находятся в той же схеме. Секретные значения журналируются только как ciphertext; BLOB сохраняются по hash.

Каждая изменяющая команда после cutover одной PostgreSQL-транзакцией записывает доменные изменения и `pult.commands`. Ответ об успехе запрещён до durable commit журнала. `command_id` делает retry идемпотентным; результат ранее применённой команды возвращается без повторного изменения.

## Доменные таблицы

### Магазины, подключения и текущие снимки

- `stores`: стабильный внутренний ID, market, display name, client ID, timestamps, sync state и `revision bigint`.
- `connection_secrets`: owner/type/version, DPAPI ciphertext `bytea`, `protection_scope='CurrentUser'`, идентификатор Windows-профиля/контекста и timestamps. Сюда попадают только поля, которые исходники действительно сохраняют как ciphertext, например подтверждённые credentials из `stores.json`, `truestats.json`, `pult-atlas-credential.json` и `b2b-agent/connection.dpapi`.
- `connection_links`: несекретные связи аккаунтов и магазинов, включая поля `truestats-wb-link.json`, которые по проверке исходников являются обычными ссылками. Файл нельзя целиком классифицировать как ciphertext без field-level проверки.
- `connector_states`: состояние синхронизации и курсоры из `pult-atlas-sync-state.json`, TrueStats, Ozon funnel и аналогичных источников; unique `(connector, owner_key)`.
- `products`, `product_identifiers`, `product_prices` и `product_costs`: карточки, marketplace IDs/SKU/артикулы и временные версии цен/себестоимости; уникальность ограничена market/store/source ID.
- `orders` и `order_lines`: marketplace order/posting ID, store, scheme, status, ordered/updated timestamps, product, units и суммы; unique source order/line key исключает повтор синхронизации.
- `finance_operations`, `finance_operation_products` и `finance_fees`: операции, товары и комиссии/логистика с исходными идентификаторами и датами.
- `inventory_current`: текущий остаток на store/product/warehouse/source с observed_at и revision. История хранится отдельно в `stock_rows`.
- `source_payloads`: доказательные payload из `data-*`, `insights-*`, `wb-orders-*`, `costs-*`, `prices-*`, funnel и buyer segments; unique `(source_kind, store_id, logical_period, content_hash)`, timestamps, completeness и `jsonb` payload. Они поддерживают аудит/повтор нормализации, но основные запросы orders/products/stocks/facts идут по полноценным таблицам и индексам.
- `report_cache`: только восстанавливаемые результаты с dependency hash и expiry. `ledger-*` и `order-category-catalog-*` импортируются лишь при необходимости прогрева; источником истины остаются нормализованные таблицы.

Основные индексы: products по `(store_id, source_product_id)` и SKU; orders по `(store_id, ordered_at)`, status и source ID; lines по `(order_id, product_id)`; finance operations по `(store_id, operation_date)`; current stock по `(store_id, product_id, warehouse_id)`. Частичные и BRIN-индексы допускаются после `EXPLAIN (ANALYZE, BUFFERS)` на обезличенной копии, а не заранее.

DPAPI ciphertext переносится в SQL без расшифровки и без изменения байтов. Он остаётся привязан к `ProtectedDataScope.CurrentUser` и тому же Windows-пользователю приложения. Смена только БД не требует secret manager. Перенос приложения под другую учётную запись — отдельная операция с явным локальным decrypt/re-protect или внешним secret manager; она не входит в эту миграцию.

### История рынка

- `market_ingestions`: source file/key, content hash, captured_at, source_kind; unique `(source_key, content_hash)`.
- `market_snapshots`: FK ingestion, source_kind, market, store, day, source_actual_at, closed flag и partial reason; unique `(ingestion_id, source_kind, store_id, day)`.
- `market_facts`: FK snapshot, product, observed_at, units, revenue, sold/returned units, realized, ads и unknown-unit count; индекс `(snapshot_id, product_id)`.
- `market_order_events`: FK snapshot, product, occurred_at и amount.
- `product_names` и `product_aliases`: PK `(market, store_id, product_id/alias)`, source_actual_at; upsert принимает только не более старое значение.

Отчёт сохраняет текущую семантику: выбирает самый свежий подтверждённый закрытый снимок на source/market/store/day, включает подтверждённый пустой день как ноль и исключает открытые/частичные дни.

### Архив версий

- `archive_versions`: source key, content hash, captured_at, source mtime/bytes, archive bytes, FK на gzip BLOB и facts status; PK `(source_key, content_hash)`.
- `archive_latest`: один current hash/stamp на source key.
- `archive_state`: last scan/error и служебные курсоры.

Gzip из `history/snapshots` переносится без изменения байтов в `blobs`. `archive_versions.content_hash` — SHA-256 распакованного исходного JSON; BLOB имеет отдельный SHA-256 сжатых gzip-байтов. Проверяются оба hash, размер, контролируемый gunzip/JSON parse и совпадение hash распакованного результата с `content_hash`; сравнивать gzip hash с source hash нельзя. `pending` facts остаются повторяемой очередью и не теряются при смене источника.

### История остатков

- `stock_imports`: import hash, imported_at, manifest JSON и issues JSON.
- `stock_rows`: детерминированный row hash, день/время наблюдения, source, store/SKU, склад/кластер, количества, quality и details `jsonb`.
- `stock_origins`: PK `(row_id, import_id, source_key, source_row)` для полной provenance.

Повтор import hash возвращает duplicate/no-op; одинаковая строка дедуплицируется, но новое происхождение сохраняется. Непрочитанный SQL backup рассматривается как отдельный кандидат-источник и импортируется только после изолированного restore, инвентаризации схем и явного выбора authoritative-наборов.

### Финансы и документы

- `finance_loans` и `finance_payments`: текущие бизнес-поля, source note, timestamps и `revision bigint`; уникальность договора и платежа повторяет действующие правила.
- `contract_documents`: документ metadata, FK `blob_id`, original filename, format, size, hash, created_at и review status.
- `contract_drafts` и `contract_draft_fields`: извлечённые значения, confidence, page/excerpt и warnings. Оригинал и metadata фиксируются одной транзакцией.

PDF, DOCX, PNG и JPG из `loan-contracts` хранятся в `bytea`. Unique hash предотвращает повторную загрузку; лимиты отдельного документа и общего объёма проверяются до записи.

### Управляемое бизнес-состояние

- `ideas`, `idea_request_dedup`, `idea_registry_state` — идеи, версия/seed marker и client request idempotency.
- `procurement_requests`, `procurement_request_items`, `supplier_price_lists`, `supplier_price_rows` — заявки и загруженные прайсы с source row и условиями сравнения.
- `supplier_categories`, `supplier_category_products`, `supplier_portals`, `supplier_portal_categories`, `supplier_targets` — категории, назначения товаров, кабинеты и целевые остатки.
- `partners`, `partner_products` — доступ партнёров, active/version/credential version и credential hash; plaintext credential не хранится.
- `commercial_models` — ставки и version.
- `product_type_registry`, `management_state`, `order_category_intraday` — классификация товаров, управленческие настройки и внутридневное состояние.
- `charity_imports`, `charity_records`, `charity_plans`, `company_impact` — благотворительное и impact-состояние с исходной provenance и версиями.

При недостаточно стабильной схеме редкое состояние сначала хранится в отдельной доменной таблице `domain_documents` с `domain`, stable key, schema version, `jsonb` payload, content hash и `revision bigint`. Это переходный SQL-контракт, а не разрешение продолжать файловый JSON.

### B2B-агент

- `b2b_cases`: карточки, CRM entity, входящее сообщение, адресат, status, fingerprints, draft/body, timestamps и `revision bigint`.
- `b2b_message_claims`: unique incoming message ID, owner case и защищённый статус.
- `b2b_events`: append-only события с ограничиваемой политикой retention.
- `b2b_run_state`: last scan/process и настройки выполнения без секретов.
- `connection_secrets`: DPAPI ciphertext Bitrix webhook и 1C token; URL и несекретные параметры — в `settings`.

Статусы `sending`, `uncertain`, `sent`, `answered` сохраняются точно. После сбоя `sending` становится `uncertain`; автоматический повтор внешней отправки запрещён. Журнал повторяет только изменение локального SQL-состояния, а не письмо или CRM-команду.

### Audit, export и резервные артефакты

Экспорты CSV/JSON, Atlas-аудит, диагностические выгрузки, старые копии и SQL `.bak` сначала регистрируются в `migration_artifacts` с типом, hash, размером, происхождением и решением `backup_only`, `candidate_source` или `authoritative`. Сам факт наличия файла не делает его рабочим состоянием. В доменные таблицы попадают только подтверждённые authoritative-наборы; остальные сохраняются как резервные доказательства по retention либо исключаются после проверки.

## Адаптеры приложения

Вводятся явные асинхронные интерфейсы: `StoreRepository`, `SecretRepository`, `SnapshotRepository`, `MarketHistoryRepository`, `StockHistoryRepository`, `FinanceRepository`, `DocumentRepository`, `BusinessStateRepository`, `PartnerRepository`, `B2BRepository`, `ArchiveRepository` и `CommandJournal`.

Все методы возвращают Promise, принимают PostgreSQL client/transaction context и поддерживают expected revision или idempotency key. Запросы параметризованы; соединения берутся из ограниченного pool роли `pult_app`. Операции над несколькими таблицами проходят в `BEGIN`/`COMMIT`; CAS использует `revision bigint`, а `SELECT ... FOR UPDATE` применяется только там, где одной условной записи недостаточно. Retry разрешён только для распознанных transient ошибок и безопасных идемпотентных команд.

Нельзя подменять `fs` monkeypatch-ом, синхронно блокировать event loop вокруг SQL или оставлять JSON теневым master. Сервисы переводятся на `await repository...`; вычисления остаются чистыми функциями. Временно допустим read-only импортёр файлов и SQLite, который запускается только миграцией и удаляется из runtime-path после приёмки.

## Этапы миграции

1. Зафиксировать контракты, natural keys, версии схем, единицы измерения и правила «неизвестно против нуля». Создать схему `pult`, ограничения, индексы, localhost-only SCRAM и отдельные least-privilege роли приложения/миграции.
2. Провести блокирующий capacity gate: data/index/TOAST/WAL estimate, измеренный рост, горизонт хранения, свободный диск, backup window и рабочая нагрузка PostgreSQL.
3. Остановить файловые writers. Создать согласованные SQLite backup, копию всех разрешённых JSON/документов/DPAPI ciphertext и manifest `path/type/size/SHA-256`; не копировать один `.sqlite` без WAL-aware backup.
4. Импортировать в staging по `migration_runs/items`: сначала BLOB и архив, затем histories, текущие snapshots, бизнес-реестры, settings и ciphertext. Каждая партия атомарна и повторяема.
5. Нормализовать staging в целевые таблицы. Повтор запуска с теми же hashes даёт только duplicate/no-op. Ошибка партии не помечает run завершённым.
6. Перевести код на async adapters и проверить его на отдельной восстановленной копии. JSON остаётся только read-only источником миграции, не master и не fallback runtime.
7. На финальном write freeze импортировать delta, записать checkpoint sequence журнала, выполнить `pg_dump`, полную сверку и атомарно сменить bootstrap на PostgreSQL.
8. После cutover PostgreSQL становится единственным writer. Наблюдать ошибки, latency, locks, WAL/размер БД и журнал. Удалить файловые runtime-paths и запретить их создание; резервные копии сохранить по политике retention.

## Проверка и критерии допуска

Для каждой таблицы сравниваются counts, множество natural/primary keys и canonical SHA-256 по строкам, отсортированным по стабильному ключу. Для BLOB сравниваются hash, length, MIME/type и выборочно полный round-trip. Для ciphertext сравниваются байты и metadata; plaintext не выводится и не журналируется.

Проверяются отчёты на заранее выбранных обезличенных срезах: Ozon/WB, закрытый/пустой/частичный день, финансовые возвраты и unknown units, stock provenance, finance debt, supplier/partner assignments и B2B protected statuses. Сравниваются структура, coverage, totals и причины неизвестных значений.

Обязательные проверки PostgreSQL: все FK/UNIQUE/CHECK constraints validated, orphan count=0, invalid indexes=0, `ANALYZE`, повтор всего импорта, конкурентный CAS с ожидаемым conflict, crash между стадиями команды и восстановление `pending/uncertain`. Отдельно проверяются row counts и canonical checksums в исходной, целевой и восстановленной БД.

Cutover допускается только если все партии завершены, расхождения объяснены и утверждены, повторный импорт даёт no-op, PostgreSQL прошёл capacity gate, отдельный restore доказан, rollback rehearsal прошёл, а приложение не обращается к рабочим JSON/SQLite.

## Backup, restore и rollback

Перед checkpoint выполняется `pg_dump` custom format всей БД с зафиксированным command sequence. Dump и manifest с SHA-256 выносятся за пределы отказа единственного хоста. Проверка означает `pg_restore` в отдельную временную БД, повторную валидацию constraints, counts, natural keys, canonical checksums и отчётов; успешного завершения `pg_dump` недостаточно. Для защиты от потери хоста дополнительно настраиваются физическая base backup и архивирование WAL с проверяемым восстановлением до заданной точки времени.

Во время ограниченного миграционного окна rollback обязан поддерживать возврат к старой файловой версии без потери post-cutover writes. Процедура: остановить writers; зафиксировать верхний sequence `pult.commands`; сделать и проверить отдельный durable export post-checkpoint journal и `journal_blobs` до любых restore; взять исходный файловый checkpoint; через reverse adapter идемпотентно применить к временной копии все committed команды после checkpoint, включая BLOB и ciphertext; сверить counts/keys/hashes/reports; атомарно установить обновлённое файловое состояние; сменить bootstrap; возобновить writes. Простое возвращение исходных файлов запрещено, потому что потеряет новые записи.

Если в миграционном окне требуется rollback к PostgreSQL checkpoint, старая копия восстанавливается `pg_restore` под отдельным именем, пока текущая БД с журналом остаётся доступной. Post-checkpoint команды и BLOB replay применяются к восстановленной БД, после сверки меняется bootstrap. In-place restore разрешён только после проверенного внешнего сохранения журнала и WAL, иначе он уничтожит данные для replay.

Команды с внешними эффектами не исполняются повторно. Для них восстанавливается подтверждённое локальное состояние и attempt/result metadata; `uncertain` требует ручной сверки с внешней системой. После успешного rollback создаётся новый checkpoint и согласованный backup.

После финального допуска миграции reverse adapter и автоматический fallback на JSON отключаются: рабочие JSON и SQLite запрещены. Их согласованный исходный snapshot может оставаться только в защищённом наборе резервных копий с manifest, retention и проверенным restore-процессом. Позднейший rollback выполняется средствами PostgreSQL и forward replay журнала, а не возвратом файлового master.
