# Price × Ads Optimizer: контракт Phase 1

Статус: контракт интеграции для PostgreSQL runtime. Основа исследования: `89f06ce82ffd164cc77818d1ee3bf346358919d0`, 24 сентября 2026 года. Все пути ниже относительно `projects/marketplace-dashboard`.

**Phase 1 читает Ozon и сохраняет только локальные настройки, наблюдения и историю. Цена и ставка на Ozon не изменяются.** `OBSERVE` и `RECOMMEND` доступны; `AUTO` запрещён сервером и заблокирован в интерфейсе. `killSwitch` по умолчанию `false` означает, что аварийная блокировка рекомендаций не включена; это не разрешение автоматической записи. Публичные capabilities всегда `priceWrite:false`, `bidWrite:false`, `auto:false`.

## Точки интеграции, подтверждённые кодом

- `scripts/start-pult-postgres.cjs` создаёт runtime/UI/outbound pools и вызывает `storage/postgres-application.cjs`. Это основной путь; `server.cjs` не расширяется.
- `createPostgresApplication()` использует `createLiveComposition()`: текущие товары, остатки, расходы, цены и ledger читаются из `pult_live`, а не из исторических `pult_market.current_snapshots`. Использовать предоставленные live source providers и их revisions.
- `storage/domains/postgres-core.cjs` формирует публичные данные. `dist/dashboard-model.js` уже задаёт `product.key = storeId + ':' + product_id`. `postgres-management.cjs` хранит локальные заявки и явно сообщает `priceWrite:false`; оптимизатор не меняет их статусы и не отправляет эти заявки наружу.
- `storage/windows-dpapi.cjs` экспортирует `protect(value, decrypt=false)`, Windows CurrentUser. Шифрование выполняется до транзакции сохранения. Пароль не попадает в аргументы процесса, ответ API или журнал.
- `postgres-server-composition.cjs` имеет route capabilities, handler groups и `handlerFactories`. Новый обработчик получает существующий `authorize` через factory; проверка capabilities отражает наличие адаптера, а не наличие credentials каждого магазина.
- `server-postgres.cjs` обеспечивает общий write fence. `dist/command-transport.js` добавляет UUID и timestamp ко всем POST; сохраняет в браузере только fingerprint и идентификатор команды.
- `postgres-cadence-producer.cjs` и `postgres-scheduler-runner.cjs` уже дают durable queue, claim, recovery и последовательный обход jobs. Новый `setInterval` не нужен. Scheduler текущего runtime — `postgres-live-scheduler.cjs`.
- Статические файлы автоматически перечисляются из `dist` в `publicFiles()`. Общая навигация — `dist/navigation.js`; connections сейчас подключает `command-transport.js` и `connections.js`.

## DATABASE CONTRACT

Новый модуль `storage/postgres-optimizer-schema.cjs` экспортирует `OPTIMIZER_SCHEMA_SQL` и `ensureOptimizerSchema(queryable)`. Отдельная additive схема `pult_optimizer`; существующие live codecs и таблицы не переделываются. SQL использует параметризацию, явные колонки и `timestamptz`. Все внешние идентификаторы — `text`, не JavaScript Number. Денежные значения — `numeric(20,6)`, счётчики — `bigint`; неизвестные значения — SQL NULL.

Ниже минимальный логический набор. Внутренние имена полей SQL — snake_case, API — camelCase. JSON допустим для небольших settings, blockers, source revisions и снимка решения; кампании, ставки и статистика хранятся колонками.

| Таблица | Колонки и ключи |
| --- | --- |
| `credentials` | `store_id` PK; `client_id_ciphertext`, `client_secret_ciphertext` text; `credential_version` uuid; `revision` bigint; `created_at`, `updated_at`; `last_test_at`, `last_test_status`, `last_error_code` nullable. Только DPAPI ciphertext. |
| `refresh_state` | `store_id` PK; `revision` bigint; `credential_version`; `last_attempt_at`, `last_success_at`, `retry_at`; `status`; `last_error_code`; `last_command_id` uuid. Раздельные `campaigns_observed_at`, `products_observed_at`, `statistics_observed_at` сохраняют фактическую свежесть разделов. |
| `campaigns` | PK `(store_id,campaign_id)`; `name`, `state`, `payment_type`, `strategy`, `currency`; `observed_at`, `source_updated_at`; `active` boolean; `source_revision` bigint. Неизвестная модель сохраняется, но не оптимизируется как CPC. |
| `campaign_products` | PK `(store_id,campaign_id,sku)`; `product_id` nullable; `current_bid`, `competitive_bid`, `minimum_bid` nullable; `bid_unit`; `current_bid_raw`, `competitive_bid_raw`, `minimum_bid_raw` text nullable; `current_bid_raw_unit`, `competitive_bid_raw_unit`, `minimum_bid_raw_unit`; `status`; `observed_at`, `competitive_observed_at`, `minimum_observed_at`; `source_revision`. FK кампании включает store_id. |
| `statistics` | PK `(store_id,campaign_id,sku,stat_date)` для отчёта с подтверждённой детализацией campaign/day; `impressions`, `clicks`, `orders`; `spend`, `revenue`; `currency`, `order_basis`, `complete`; `observed_at`, `source_revision`. Повторная загрузка исправляет день через upsert, не прибавляет его второй раз. |
| `sku_links` | PK `(store_id,sku)`; `product_id` nullable; `status` (`matched`, `unmapped`, `ambiguous`); `source_revision`; `observed_at`. Несколько SKU одного Seller product допустимы, один SKU не может автоматически выбрать один из нескольких продуктов. |
| `settings` | `scope_key` PK (`global` или `store:<id>`); `revision`; `settings` jsonb с валидируемым ограниченным набором полей; `updated_at`. Нет secret, access token или произвольных объектов. |
| `experiments` | `experiment_id` uuid PK; `store_id`, `product_id`, `campaign_id` nullable, `sku` nullable; `dimension` (`PRICE`/`BID`); `status` (`recorded`, `observing`, `completed`, `cancelled`); `before_value`, `after_value`, `baseline_contribution`, `result_contribution`; `period_from`, `period_to`; `started_at`, `observe_until`, `closed_at`; `revision`; `command_id`. Одновременно один активный эксперимент на `(store_id,product_id)`, независимо от campaign. |
| `decisions` | `decision_id` uuid PK; `store_id`, `product_id`, `campaign_id` nullable, `sku` nullable; `input_hash`, `algorithm_version`, `settings_revision`, `source_revisions` jsonb; `state`, `action`, `recommended_price`, `recommended_bid`, `max_profitable_bid`, `confidence`; `reason_codes`, `blockers` jsonb arrays; `human_reason`; `observed_at`. UNIQUE scope + input hash + algorithm/settings version исключает повтор одной оценки; nullable campaign/SKU нормализуются в index expression либо используется NULLS NOT DISTINCT. |
| `commands` | `command_id` uuid PK; `kind`, `store_id` nullable; `intent_hash`; `receipt` jsonb без секретов; `created_at`. Неизменяемый receipt для replay, включая acquisition. |

Если API статистики возвращает только SKU за период, нельзя выдумывать `campaign_id` или делить результат по дням. Для такой реальной формы добавляется отдельная таблица `sku_statistics_periods` с PK `(store_id,sku,period_from,period_to,attribution_model)` и теми же метриками; публичный `scope='sku'`. Она не размножается на каждую кампанию и не суммируется вместе с перекрывающимися периодами. Дневная таблица используется только для реально полученных дневных строк.

Обязательные индексы: `campaign_products(store_id,sku,campaign_id)`; `campaign_products(store_id,product_id)`; `statistics(store_id,sku,stat_date)`; `statistics(store_id,stat_date,campaign_id)`; `decisions(store_id,product_id,observed_at DESC)`; `experiments(store_id,product_id,started_at DESC)` и unique partial index активного эксперимента. `store_id` входит во все бизнес-ключи и joins. Latest rows берутся индексом, а не отдельным запросом на каждый SKU.

Один успешный refresh сохраняет нормализованные строки, revision/head и receipt атомарно. HTTP выполняется до открытия транзакции. Внутри транзакции проверяются credential_version и ожидаемая revision; запоздавший результат старых credentials не публикуется. Ошибка/неполная страница не удаляет прежний полный набор. Неполные разделы имеют свой status и не получают свежую дату как успешные.

Retention: текущие кампании/ставки остаются до следующей полной замены; statistics — 400 дней; повторяющиеся решения не вставляются, изменённые решения — 180 дней. Завершённые эксперименты и command receipts сохраняются минимум год; receipts активных/unknown команд не удаляются. Очистка — ограниченными пачками в обслуживании существующего scheduler, не при GET и не неограниченным DELETE. При отсутствии реализованной очистки явно документируется рост данных; незаметное удаление audit не допускается.

DDL вызывается отдельной миграцией под migrator и при первоначальном provisioning. Runtime role не получает CREATE и не запускает DDL на каждом старте. Для уже установленной БД нужен idempotent upgrade script, а не повторный запуск `provision-pult-postgres.cjs`, который специально отказывает существующей установке. Readiness проверяет таблицы/контракт и сообщает `OPTIMIZER_SCHEMA_MISSING`; отсутствие Performance credentials не блокирует readiness всего Пульта. Все таблицы закрыты для PUBLIC, permissions для app/read profile ограничены нужными операциями; commands не разрешают UPDATE/DELETE.

## BACKEND CONTRACT

| Модуль | Public contract |
| --- | --- |
| `storage/acquisition/ozon-performance-transport.cjs` | `createPerformanceTransport({fetchFn,getCredentials,now,sleep})` → `testConnection(storeId)`, `listCampaigns(storeId)`, `listCampaignProducts(storeId,campaignId)`, `getCompetitiveBids(storeId,campaignId,skus)`, `getMinimumBids(storeId,skus,context)`, `getSkuStatistics(storeId,{from,to,skus})`, `invalidateCredentials(storeId)`. Только allowlist читающих операций и token request. |
| `storage/acquisition/postgres-performance-acquisition.cjs` | `createPerformanceAcquisition({repository,transport,storesRepository,now})` → `refresh({storeId,expectedRevision,commandId})`, `resolve({storeId,expectedRevision,commandId})`. Возвращает `{committed,revision,status,count,errorCodes}` для scheduler, status `done/partial/error`. |
| `storage/postgres-optimizer-repository.cjs` | `createOptimizerRepository({pool,readPool,protect,now})` → credentials `saveCredentials`, `getCredentials` (только для transport), `connectionStatus`, `recordConnectionTest`; acquisition `readRefreshState`, `commitRefresh`, `resolveRefresh`; reads `readAds`, `readSkuAds`, `readHistory`; settings `readSettings`, `saveSettings`; audit `recordDecision`, `recordExperiment`, `transitionExperiment`. Все mutation methods принимают commandId/timestamp и revision при изменении существующей сущности. |
| `storage/domains/postgres-optimizer.cjs` | `createPostgresOptimizer({repository,storesRepository,sourceProviders,optimizer,now})` → `prices(options)`, `ads(options)`, `sku({storeId,productId,campaignId})`, `settings(options)`. Объединяет исходные данные, нормализует ledger, вызывает pure functions. SQL/HTTP в pure optimizer отсутствуют. |
| `storage/domains/postgres-optimizer-routes.cjs` | `createOptimizerRoutes({optimizer,repository,transport,producer,authorize})` → `{handle(req,res,url)}`. Нормализует запросы и публичные ошибки, не возвращает raw upstream error. |
| `optimizer/economics.cjs` | Named exports `calculateContributionEconomics`, `calculateMaxAdSpendPerOrder`, `calculateMaxCpc`. |
| `optimizer/decision.cjs` | Named exports `calculateRecommendedBid`, `calculateRecommendedPrice`, `qualityGate`, `confidence`, `optimizerDecision`, `DEFAULT_SETTINGS`. |

Названия могут быть дополнены внутренними helpers, но фронтенд и pure optimizer не зависят от repository internals. `postgres-application.cjs` создаёт объекты, добавляет acquisition и factory `optimizer-routes`; `postgres-server-composition.cjs` объявляет группу/capability. Старые owner routes и management domain не расширяются общей реорганизацией.

### Ozon transport, credentials и единицы

Performance credentials отличаются от Seller API и относятся к выбранному уже подключённому Ozon store. WB отклоняется. Client ID и Secret защищаются отдельно через существующий DPAPI. UI получает `configured`, `status`, timestamps, безопасный errorCode; ни secret, ни access token, ни ciphertext не возвращаются. После сохранения clientSecret очищается в форме. Проверка credentials выполняется из сохранённого соединения.

OAuth cache находится только в памяти, ключ `(storeId,credentialVersion)`, с expiry/skew и single-flight token request. При 401 token обновляется один раз и повторяется только читающий запрос. 403 не запускает бесконечную переавторизацию. Redirect запрещён, таймауты/размер ответа ограничены. Ошибки redact по allowlist кодов; request/response body, Authorization и credentials не логируются.

Первичный источник: [документация Ozon Performance API](https://docs.ozon.ru/api/performance/) и её [OpenAPI](https://docs.ozon.ru/api/performance/swagger.json). Во время архитектурного исследования публичный fetch документации не прошёл (redirect/access error), поэтому здесь не утверждаются непроверенные response fields или multiplier. Backend агент обязан сверить actual endpoint schemas перед реализацией нормализации и зафиксировать fixtures, источник и дату в tests/docs.

Исходный запрос пользователя задаёт campaign list, `/api/client/campaign/{campaignId}/v2/products`, competitive bids и `/api/client/statistics/products/sku`; нужно также получить реально доступный minimum bid официальным читающим методом. У allowlist проверяется семантика операции, не только HTTP method: некоторые GET у внешних API меняют состояние. Pagination идёт до подтверждённого конца с ограничением страниц, dedup и обнаружением повторённого cursor. Competitive/minimum/statistics SKU группируются по документированным лимитам, не по одному запросу на SKU.

Внутри приложения все деньги — RUB; CPC ставки — `RUB_PER_CLICK`, не проценты и не CPM. В transport каждая ставка преобразуется из документированной единицы конкретного поля отдельно. Если источник использует millionths of RUB, делить на 1,000,000; если RUB — сохранять RUB. Это условие, а не утверждение, что все поля Ozon имеют один scale. Сохранять raw значение и raw unit для аудита. Неизвестные currency/unit/model дают NULL normalized bid и blocker. Округление recommended bid всегда вниз до документированного шага; минимальная ставка никогда не поднимает результат выше profit cap.

429 сохраняет Retry-After (seconds либо HTTP-date) в retry_at; runner освобождает магазин, не ждёт минуты внутри job. 5xx/network имеют ограниченный backoff; retry не меняет receipt уже закоммиченной команды. 401/403/malformed одного магазина не прерывают обход остальных.

### Scheduler, наборные чтения и SKU mapping

Новый kind — `ozon-performance`. Cadence читает `refresh_state`/credentials metadata вместо вымышленного `performance-<id>.json`; revision/receipt получает из repository. `request()` допускает этот kind только для Ozon и использует ту же durable command identity. Dispatcher отдельной веткой вызывает `refresh/resolve`, не `sourceKey()` старых acquisitions. Автоматический refresh — раз в 30 минут после подключения с учётом retry_at; manual refresh только ставит job в очередь. Никаких сетевых запросов на GET страниц.

API читает Seller catalog/costs/ledger один раз на магазин через live providers, загружает рекламные строки одним наборным запросом и строит Map по identity. Не вызывать `publicSnapshot`, `ledgerFor`, HTTP или SQL внутри product.map. Лучше читать только нужные live collections. Кэш ограничен по размеру, содержит источники без секретов и keyed by `(store,sourceRevisions,settingsRevision,period)`; смена revision инвалидирует его. SQL статистики ограничен store/SKU/date, имеет индексы и не агрегирует всю историю при каждом открытии страницы. Пагинация ответа обязательна; для больших каталогов локальные вычисления идут пакетами, а не через тысячи одновременных promises. Число source reads зависит от магазинов/страниц, не от количества SKU. Проверка запросов на каталоге 1 и 1000 SKU должна подтвердить это.

Seller product_id, offer_id и Performance SKU — разные identity. Использовать точное совпадение Performance SKU с Seller `sku`, `skus` и `sources[].sku` внутри store. Строковые цифры не преобразуются в Number. offer_id/название не дают автоматического mapping. Дубликат SKU между разными Seller products → `ambiguous`, отсутствие → `unmapped`; сырая рекламная строка остаётся видна с объяснением, запись/рекомендация по ней заблокирована. Multi-campaign SKU даёт несколько строк `/ads`, одну строку `/prices` и массив кампаний в detail. SKU-wide статистика не дублируется в summary каждой campaign row; scope указан явно.

### Seller prices и финансовые данные

Текущий `costs.cjs` получает `/v5/product/info/prices`: `price.net_price` — себестоимость, `price.price` — базовая seller price, `price.marketing_seller_price` уже хранится как `pricing.sellerPrice`. Эти две seller цены не являются автоматически ценой покупателя. `price.customerPrice` появляется только при документированном поле с подтверждённым смыслом; иначе NULL и «Недоступна». Источник каждой цены и observedAt сохраняются. Добавление реального customer field делается точечно в Seller collector и его тестах.

Ledger v3 хранит `skuDaily[].values` в копейках и расходы со знаком начислений, обычно отрицательным. Domain переводит их в RUB один раз, меняет знак расходов по бухгалтерскому смыслу и объединяет период. `complete`, `foreignRecords`, `unknownUnitRows`, `residualRecords`, несопоставленные/shared fees и покрытие периода участвуют в status. Нельзя передавать NULL как 0 или объявлять стоимость полной только потому, что каталог содержит net_price.

Возвраты сохраняются со знаком; COGS учитывает net sold/returned units только при подтверждённой единице и корректном cost. Заказы рекламы, выручка заказа и реализованная выручка ledger не взаимозаменяемы. Поле `orders` функции economics имеет явно согласованный denominator (`orderBasis: order|unit`); нельзя выдавать salesRows или netUnits за число заказов без проверки basis. Для CVR и max spend basis должен совпадать. Advertising вычитается ровно один раз: Seller ledger ads и Performance spend — альтернативные источники для сопоставимого периода/scope, не сумма. Неатрибутированные рекламные расходы/компенсации дают partial, а не скрытое нулевое значение.

## API CONTRACT

Все ответы JSON, `Cache-Control:no-store`. GET ничего не отправляет в Ozon. Missing credentials — нормальный HTTP 200 с `connection.status='not_connected'`, пустыми рекламными показателями и reason; цены остаются видны. Недоступная SQL инфраструктура — 503, не пустой успешный отчёт.

| Method/path | Request / result |
| --- | --- |
| `GET /api/optimizer/prices` | Общие фильтры ниже; paginated Seller product rows. |
| `GET /api/optimizer/ads` | Те же фильтры плюс campaign; paginated campaign/SKU rows. |
| `GET /api/optimizer/sku/:id` | `id` = URL-encoded Seller product_id; обязательный `store`, необязательный `campaign`. Detail `{item,price,advertising,economics,optimizer,history,capabilities}`. |
| `GET /api/optimizer/settings` | `{settings,revision,capabilities}`; optional store для effective overrides. |
| `POST /api/optimizer/settings` | `{storeId?,expectedRevision,settings}`; разрешённые поля валидируются; mode AUTO → 400 `AUTO_DISABLED`. |
| `GET /api/optimizer/performance/status` | Optional `store`; `{stores:[{storeId,configured,status,lastTestAt,lastSuccessAt,retryAt,errorCode}]}`. |
| `POST /api/optimizer/performance/credentials` | `{storeId,clientId,clientSecret}`; `{ok,storeId,configured:true,status,revision}`. Никаких ключей в ответе. |
| `POST /api/optimizer/performance/test` | `{storeId}`; проверяет сохранённое соединение, `{ok,storeId,status,checkedAt,errorCode}`. |
| `POST /api/optimizer/performance/refresh` | `{storeId}`; 202 `{ok,storeId,queued:true,attemptId}` либо идемпотентный receipt. |
| `POST /api/optimizer/experiments` | Только локальный owner record о вручную сделанном изменении: `{storeId,productId,campaignId?,dimension,beforeValue,afterValue,startedAt,observeUntil,expectedRevision?}`. Нет вызова price/bid write. |
| `POST /api/optimizer/experiments/transition` | `{experimentId,expectedRevision,status}`; validate state transition, сохранение audit. |

Общие query: `store`, `campaign`, `search` (до 200 символов), `state`, `confidence`, `onlyScalable=true`, `onlyBlocked=true`, `from`, `to`, `limit` (default 50, max 200), `offset` (default 0). Default period — последние 14 полных календарных дней Europe/Moscow; max 90 дней; unknown enum/date → 400. Сортировка детерминированная store/product/campaign/SKU. `total` и `summary` относятся ко всему фильтру до пагинации. Summary сообщает completeness, не суммирует неизвестное как достоверный 0.

Все POST используют существующий `authorize`, `x-pult-command-id`, `x-pult-command-timestamp`; если команда продублирована в body, identity должна совпасть. Повтор той же команды возвращает прежний receipt. Изменённый payload с тем же ID → 409 `COMMAND_ID_REUSED`; revision conflict → 409; uncertain commit → 503 `OUTCOME_UNKNOWN` с указанием повторить ту же identity. Коды upstream безопасны (`PERFORMANCE_NOT_CONNECTED`, `PERFORMANCE_UNAUTHORIZED`, `PERFORMANCE_FORBIDDEN`, `PERFORMANCE_RATE_LIMIT`, `PERFORMANCE_UNAVAILABLE`, `PERFORMANCE_INVALID_RESPONSE`).

## DATA SHAPES

Общий list envelope:

```js
{
  items: [], total: 0, limit: 50, offset: 0,
  generatedAt: '2026-09-24T08:00:00.000Z',
  period: {from: '2026-09-10', to: '2026-09-23', timeZone: 'Europe/Moscow'},
  summary: {},
  connection: {status: 'not_connected', stores: []},
  capabilities: {priceWrite: false, bidWrite: false, auto: false}
}
```

Одна price row; ads row использует тот же product/economics/optimizer, плюс одну campaign и её advertising. Это примеры структуры, не production mock data:

```js
{
  key: 'store-id:product-id',
  product: {id: 'product-id', storeId: 'store-id', storeName: 'Магазин',
    sku: 'sku-id', skus: ['sku-id'], offerId: 'offer-id', name: 'Товар', active: true},
  price: {sellerPrice: null, promotionalSellerPrice: null, customerPrice: null,
    customerPriceSource: null, sellerCustomerDifference: null,
    sellerCustomerDifferencePct: null, currency: 'RUB', observedAt: null},
  cost: {unitCost: null, currency: 'RUB', status: 'missing', observedAt: null},
  stock: {quantity: null, days: null, observedAt: null},
  campaign: null,
  advertising: {connected: false, scope: 'campaign_sku', model: null,
    unit: null, currentBid: null, competitiveBid: null, minimumBid: null,
    impressions: null, clicks: null, orders: null, ctrPct: null, cpc: null,
    cvrPct: null, spend: null, revenue: null, drrPct: null,
    orderBasis: null, observedAt: null, complete: false},
  economics: {contributionBeforeAds: null, contributionAfterAds: null,
    contributionBeforeAdsPerOrder: null, contributionPerOrder: null,
    marginPct: null, economicsStatus: 'insufficient', missingFields: []},
  optimizer: {state: 'BLOCKED', action: 'NONE', recommendedPrice: null,
    recommendedBid: null, maxProfitableBid: null, confidence: 'LOW',
    reasonCodes: ['INSUFFICIENT_DATA'], humanReason: 'Недостаточно данных.',
    blockers: ['INSUFFICIENT_DATA']},
  sourceRevisions: {}, stale: true
}
```

`campaign` = `{id,name,state,paymentType}`. Цена/ставка NULL отображается «—», не 0. `CTR=clicks/impressions*100`, `CVR=orders/clicks*100`, `CPC=spend/clicks`, `DRR=spend/revenue*100`; нулевой/неизвестный denominator → NULL. Seller/customer difference = sellerPrice − customerPrice; процент от sellerPrice при sellerPrice>0.

Prices summary: `priceUpCount`, `observingCount`, `blockedCount`, `rollbackCount`, `averageSellerCustomerDifference`, `potentialContributionIncrease`, `complete`. Ads summary: `spend`, `revenue`, `contributionAfterAds`, `drrPct`, `belowCompetitiveCount`, `aboveProfitableCount`, `scalableCount`, `blockedCount`, `complete`. Потенциальный прирост NULL без обоснованной quantity assumption; рост цены не доказывает рост прибыли. Mean difference считается только по реальным парам цен, с `pricedPairCount`.

Detail `advertising` — массив кампаний и отдельная SKU aggregate statistics при scope SKU; `history` — упорядоченные experiment/decision события с dimension и timestamps, без произвольного SQL/source dump.

## OPTIMIZER CONTRACT

Pure функции не читают время, environment, HTTP, SQL или files; `now` передаётся явно. На входе number|null, currency RUB, конечные безопасные числа; infinity/NaN/числовые строки и неизвестные единицы не исправляются молча.

```js
optimizerDecision({
  now, product, price, cost, stock,
  finance: {realizedRevenue, cost, commission, logistics, acquiring,
    marketplaceServices, compensation, advertising, orders,
    orderBasis, complete, observedAt, periodFrom, periodTo},
  ads: {connected, model, unit, currentBid, competitiveBid, minimumBid,
    impressions, clicks, orders, spend, revenue, orderBasis,
    observedAt, complete, periodFrom, periodTo},
  settings,
  history: {state, activeExperiment, lastActionAt,
    baseline: null, current: null, priceTestPassed: false}
})
// => {state, action, recommendedPrice, recommendedBid, maxProfitableBid,
//     confidence, reasonCodes, humanReason, blockers}
```

`product/price/cost/stock` совпадают с shapes выше; `ads` — нормализованная advertising. `history.baseline/current` при наличии содержат `{contributionAfterAds,orders,periodDays,complete}` для сопоставимых окон. `activeExperiment` содержит `{id,dimension,beforeValue,afterValue,startedAt,observeUntil,status}`. Нет истории → BASELINE/наблюдение; выданная рекомендация сама не означает начало эксперимента.

Public signatures и формулы:

```js
calculateContributionEconomics({realizedRevenue, cost, commission, logistics,
  acquiring, marketplaceServices, compensation, advertising, orders, complete})
// before = revenue - cost - commission - logistics - acquiring - services + compensation
// after = before - advertising
// beforePerOrder = before / orders; contributionPerOrder = after / orders
// marginPct = after / realizedRevenue * 100
// => {contributionBeforeAds, contributionAfterAds, contributionBeforeAdsPerOrder,
//     contributionPerOrder, marginPct, economicsStatus, missingFields}

calculateMaxAdSpendPerOrder({contributionBeforeAdsPerOrder, targetProfitPerOrder})
// => max(0, beforePerOrder - targetProfitPerOrder), либо null
calculateMaxCpc({maxAdSpendPerOrder, observedCVR, safetyFactor})
// => maxAdSpendPerOrder * observedCVR * safetyFactor, либо null
calculateRecommendedBid({currentBid, competitiveBid, minimumBid,
  maxProfitableBid, competitiveBuffer, bidStepPct, bidIncrement})
// => floor_to_increment(min(maxProfitableBid, competitiveBid*competitiveBuffer,
//                          currentBid*(1+bidStepPct))), либо null
calculateRecommendedPrice({sellerPrice, priceStepPct, allowed, priceIncrement})
// => rounded sellerPrice*(1+priceStepPct), только если allowed=true; иначе null
qualityGate(input, {action} = {}) // => string[] конкретных blockers
confidence(input) // => 'HIGH' | 'MEDIUM' | 'LOW'
```

Finance inputs — суммы за один период; cost здесь полный COGS периода, не `cost.unitCost`. `contributionBeforeAds` — общий итог; max spend получает именно per-order величину, поэтому количество заказов не умножает потолок ставки ошибочно. `economicsStatus='complete'` только при всех подтверждённых компонентах/периоде; partial означает, что часть расчёта достоверна, insufficient — нет базы для прибыли. Известный нулевой расход допустим; отсутствующий расход NULL. Если before известен, after может оставаться NULL из-за advertising. Число заказов 0 не создаёт бесконечный per-order profit.

Settings defaults: `{mode:'OBSERVE',killSwitch:false,targetProfitPerOrder:0,priceStepPct:0.05,bidStepPct:0.10,competitiveBuffer:1,safetyFactor:0.8,minStock:5,minStockDays:7,maxPriceAgeHours:24,maxAdsAgeHours:2,minImpressions:1000,minClicks:100,minOrders:10,observationDays:7,cooldownHours:72}`. Поля stepPct/CVR — доли (0.05=5%); UI проценты переводит один раз. Price/bid increments поступают из достоверной валюты/контракта API, не из удобства округления. Если profit floor не задан владельцем, 0 — лишь граница положительного contribution, не обещание чистой прибыли после налогов.

Quality gates: missing cost; inactive/unknown product; missing/stale price; low/unknown stock; insufficient/partial economics для увеличения риска; negative contribution; incomplete period; experiment active; cooldown; kill switch. Для BID дополнительно missing/stale ads, несовпадение scopes/period/orderBasis, invalid counts, unsupported model/unit, отсутствие minimum/current/competitive bid и ambiguous SKU. При minimumBid > maxProfitableBid — `MIN_BID_EXCEEDS_PROFIT_CAP`, без увеличения cap. Price page продолжает показывать Seller данные без Performance подключения, но не выдумывает прибыль/рекомендацию при неизвестных advertising costs.

Недостаток выборки не даёт BID_UP/PRICE_UP. Confidence зависит от количества impressions/clicks/orders, полноты и стабильности нескольких дней, а не только высокой CVR. Один аномальный день или 1 заказ/1 клик не даёт HIGH. Расчётная ставка всегда <= maxProfitableBid; competitive bid — ориентир, не цель обязательного достижения. Известная завышенная текущая ставка может дать HOLD/BLOCKED либо рекомендацию отката ранее подтверждённого эксперимента; она никогда не повышается ради competitive.

State machine:

| State | Смысл и следующий переход |
| --- | --- |
| `BASELINE` | Накопление сопоставимой базы; action NONE. После достаточной базы → допустимый PRICE_UP/BID_UP/HOLD. |
| `PRICE_UP` | Только recommendation PRICE; новый эксперимент цены обычно +5%, при пройденном gate. |
| `WAIT_PRICE` | В истории реально отмечен price experiment; до зрелого окна action NONE. |
| `BID_UP` | Только recommendation BID; profitable reach после price test либо при достаточной подтверждённой базе и profit floor. |
| `WAIT_ADS` | В истории реально отмечен bid experiment; ждём зрелое окно, action NONE. |
| `HOLD` | Нет обоснованного улучшения абсолютного contribution либо low confidence; action NONE. |
| `ROLLBACK` | Зрелый сопоставимый эксперимент ухудшил absolute contribution/нарушил floor; recommendation возвращает только его dimension к beforeValue. Фактической записи нет. |
| `BLOCKED` | Конкретные quality blockers; action NONE. Ожидание действующего experiment отражается WAIT_* и blocker/reason WAITING_FOR_EXPERIMENT. |

**На один шаг только одна dimension.** `action=PRICE` → recommendedBid=NULL; `action=BID` → recommendedPrice=NULL; `action=NONE` → обе NULL. В состоянии ROLLBACK dimension берётся из единственного экспериментального изменения, а не меняет обе величины. `maxProfitableBid` — диагностический потолок, может быть показан при action PRICE/NONE, только если расчёт полный.

Цель — максимальный абсолютный contribution при выполненном profit floor. Сопоставление экспериментов нормализует длину окон, возвраты и полноту; высокая маржа сама по себе не превосходит больший прибыльный объём. Нельзя прогнозировать новую CVR или стабильность спроса без наблюдений. `PROFIT_BUFFER_AVAILABLE`, `BID_BELOW_COMPETITIVE`, `MAX_PROFITABLE_LIMIT`, `LOW_STOCK`, `INSUFFICIENT_DATA`, `WAITING_FOR_EXPERIMENT`, `LOW_CONFIDENCE`, `PROFIT_FLOOR_VIOLATED` — machine-readable reason codes; humanReason объясняет владельцу факты и ограничение.

## OWNERSHIP

| Агент | Своя область |
| --- | --- |
| Backend/API | Новые transport/acquisition/schema/repository/domain/routes и их tests. Точечные wiring changes в postgres-application/server-composition/cadence/dispatcher; upgrade/provisioning schema path. Реальное чтение customer field при подтверждении официального контракта — costs.cjs + тест. Не frontend и не pure формулы. |
| Optimizer | `optimizer/economics.cjs`, `optimizer/decision.cjs`, `test/optimizer-economics.test.cjs`, `test/optimizer-decision.test.cjs`. Pure data contract и детерминированные тесты; не OAuth/SQL/UI. |
| Frontend | `dist/prices.html`, `dist/ads.html`, `dist/optimizer.js`, `dist/optimizer.css`; точечные `dist/connections.html`, `dist/connections.js`, `dist/navigation.js`; UI tests. Existing premium styles и command transport, не новые глобальные зависимости. |
| Integration | Сведение контрактов, актуальный main, совместимость npm start/upgrade path, полные тесты и проверка write fences. После backend/pure — исправления review SQL/math/security с regression tests; общие конфликты разрешает интегратор. |
| Architecture | Только этот документ; обновления контрактов согласуются до параллельного изменения областей. |

Frontend показывает store/campaign/search/state/confidence/scalable/blocked filters, ограниченную страницу строк и detail с PRICE/ADVERTISING/ECONOMICS/OPTIMIZER/HISTORY. При отсутствии API — «Performance API не подключён» и «Подключить рекламу»; режим AUTO locked, явная подпись «Изменения на Ozon не отправляются». Никаких mock fallback. Global Kill Switch отражает реальное значение settings, не создаёт впечатления включённого AUTO.

## Проверка и Phase 2

Backend tests: token/cache/expiry, один retry 401, 403, Retry-After 429, 500, корректный конец pagination/повтор cursor, batching competitive/minimum, malformed data, missing credentials, store isolation, credential rotation race, secret absent from responses/errors/logs, command replay, partial refresh, no per-SKU SQL/HTTP, additive schema/indexes и read-only allowlist. UI tests проверяют API contract, NULL, not-connected, filters/page limit/detail, settings и секрет после сохранения.

Pure tests: missing fields и нули отдельно, refunds и signs, per-order units, high competitive > cap, minimum > cap, rounding floor, safety factor, 0 orders/clicks, inconsistent CVR, 1/1 sample, stale/low stock/inactive/cooldown/kill, PRICE +5%, BID max +10%, HOLD/BLOCKED/ROLLBACK, never both actions, большая absolute profit при меньшей марже, период/attribution mismatch. HTTP в pure tests отсутствует.

Для будущей Phase 2 потребуется отдельный writer с capability/owner opt-in; свежий повторный read перед apply, revision compare, hard price/bid/budget caps, unique action identity, durable outbox/receipt, recovery неизвестного исхода, проверка результата в Ozon, audit и действующая аварийная блокировка. Одного переключения mode недостаточно. В Phase 1 writer модуль/маршруты apply и credentials с write scopes не добавляются.
