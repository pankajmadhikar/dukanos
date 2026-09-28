# Operations

## Health

| Route | Meaning |
| --- | --- |
| `GET /api/v1/health/live` | The process is up. It does not check dependencies. |
| `GET /api/v1/health/ready` | PostgreSQL answered `SELECT 1`. |

AI, object storage, and the intake queue do not affect readiness. POS, sales, stock, purchases, and reports keep working when the model provider is down. Intake returns an error for that request.

The intake worker logs `intake worker listening` at startup. After jobs it increments in-process success and failure counters and logs failures. Those counters reset when the process restarts and are not exposed on `/health`. A crashed process recovers a stuck intake the next time that shop reads or retries it, because the database row is the lock.

## Logs

Each line has `timestamp`, `level`, `service`, `environment`, `message`, and, when present, `requestId`, `userId`, `tenantId`, `route` or `module`, `statusCode`, and `durationMs`. Do not log session tokens, shop grants, OTP codes, storage keys, or image bytes.

## What to watch

Watch API 5xx from the JSON logs, readiness failures, PostgreSQL connections against `DB_POOL_SIZE` (default 10 in production, maximum 20), backup script failures, and intake `operation=worker` errors. There is no alert vendor in this repository, and none was attached, because no staging or production host exists. An operator has to ship the JSON logs to whatever system they already run after a host exists.

## Retention

| Data | Policy in this repository |
| --- | --- |
| Sales, stock, ledgers, expenses | Kept. There is no cleanup job. |
| Audit logs | Kept. No application delete API. |
| AI media | Deleted after the retention days when that shop uses intake again. |
| API logs | Whatever the host log store keeps. The API does not rotate them. |
| Backups | Whatever the operator copies off the machine. The script does not delete old dumps. |
| Offline IndexedDB | Stays on that browser until the shopkeeper clears site data. Logout does not sync a pending queue away. |

## Smoke tests that still require a real host

These are not done by CI:

- HTTPS login on the production domain
- A sale in a dedicated staging shop
- An intake upload against the private bucket
- An offline sale synced after reconnect on that staging shop

Use a shop created for the test. Do not post into a merchant's shop.
