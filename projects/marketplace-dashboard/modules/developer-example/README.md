# Пример модуля

Manifest-based module at `/modules/developer-example` with API namespace `/api/modules/developer-example`. The starter API is one `GET` endpoint without query parameters or pagination. Responses use the success/error envelopes documented in `api.schema.json`.

Run its isolated checks with:

```powershell
node scripts/verify-module.cjs developer-example
```

The starter performance smoke expects zero SQL queries. When repository logic starts querying the database, update its expected query count deliberately and keep response-byte reporting as the payload baseline.
