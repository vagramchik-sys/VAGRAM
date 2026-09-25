# Performance contract

- PostgreSQL is the source of truth. Keep changes within the existing stack; do not add Redis, ClickHouse, or another service without live measurements proving PostgreSQL is the limit.
- Measure representative routes before changing SQL or caching. Treat a measurable regression in response time, SQL count, or payload as a bug; never trade correctness or data coverage for a faster number.
- User-facing requests read local persisted data and must not wait for Ozon/WB APIs, imports, or full-history recalculation. Keep marketplace calls and heavy work in bounded background jobs.
- Avoid N+1 reads, `SELECT *`, returning raw history when the screen needs aggregates, and repeated work within one request. Acquire database connections as late as practical and release them before external HTTP calls.
- Prefer incremental updates for derived data. Add indexes or aggregates only after query plans, live timings, and raw-result parity demonstrate the benefit.

## Performance budget

- Business dynamics API: p95 under 200 ms when warm.
- Ordinary interactive API routes: p95 under 300 ms when warm.
- Heavy analytics: aim for under 1 second when warm; paginate and bound payloads.
- Main dashboard after warm-up: aim for under 1 second; filter switching should feel under 300 ms.
- These are targets, not permission to hide incomplete or stale data. Report sample size, environment, SQL count/time, pool wait, and payload alongside latency; do not claim an SLA from a small sample.

## Done means

Run the relevant correctness tests, syntax/check, and `npm run perf:smoke` against the local server when available. The smoke is read-only and its timing output is diagnostic; only HTTP correctness, metrics consistency, and generous query/payload bounds gate success. Record what was measured and what was not.
