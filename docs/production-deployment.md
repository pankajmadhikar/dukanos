# Production deployment

DukaanOS stays one NestJS API process, one React PWA, and one PostgreSQL database. AI intake runs inside the API process. There is no Redis, Kubernetes, or separate worker service in this repository.

## Environments

| `APP_ENV` | `NODE_ENV` | What it may use |
| --- | --- | --- |
| `development` | `development` | Local PostgreSQL, console OTP, mock AI, mock storage |
| `test` | `test` | Test PostgreSQL. AI and storage are forced to mock |
| `staging` | `production` | Its own database, HTTPS origin, OpenAI, private S3 |
| `production` | `production` | Its own database, HTTPS origin, OpenAI, private S3 |

Staging and production refuse localhost database URLs, `http://` CORS origins, `CORS_ORIGINS=*`, console OTP, mock AI, and mock storage. `RATE_LIMIT_STORE` must be `memory`. That value means the process-local limiter is accepted and the API must run as one process. A `redis` value fails startup because shared limiting is not implemented.

`VITE_API_BASE_URL` is the only frontend setting. Backend secrets are not `VITE_*` variables.

## Suggested hosts

```text
https://app.example  static PWA
https://api.example  NestJS, npm run start:prod
```

Use the real domain. Authenticated traffic needs HTTPS. Cookies use `Secure` when `NODE_ENV=production`.

## Order

1. Take a backup with `scripts/backup-database.sh`.
2. Deploy an API build that still accepts the current schema.
3. Run `npm run db:migrate` with `DATABASE_ADMIN_URL`. Never run `prisma migrate reset`.
4. Check `GET /api/v1/health/ready`.
5. Deploy the PWA with `VITE_API_BASE_URL` pointing at that API.
6. Smoke-test a dedicated shop, not a merchant's live shop.

Rollback is the previous API build and the previous PWA build. Do not roll a migration backward. If a migration fails, stop and restore from the backup taken in step 1.

## What this repository does not deploy

No domain, certificate, staging host, or managed PostgreSQL is configured here. CI in `.github/workflows/ci.yml` installs, migrates a throwaway Postgres 18, lints, tests, and builds. A green CI run is not a production deploy.
