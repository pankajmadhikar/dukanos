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

## One API process

Deploy exactly one API process. `RATE_LIMIT_STORE=memory` is the accepted setting, and the intake queue lives in that process. Do not add a second replica, and do not add Redis, until shared limits and a shared queue exist. A separate worker is not required for the current design.

## Shop bootstrap

Creating a shop in the API writes the default location, document counters, and system expense categories. Units are created later through the catalog API. `npm run db:seed` is the development seed (`[DEV]` rows only) and must not run against staging or production. Do not insert fake sales into a production database.

## CI

GitHub Actions run [36382927899](https://github.com/pankajmadhikar/dukanos/actions/runs/36382927899) on commit `7d83eee` completed successfully. It started at `2026-09-28T05:40:29Z` and finished at `2026-09-28T05:42:26Z` (about 2 minutes). The `check` job passed install, Postgres 18, `prisma migrate deploy`, the app role, lint, API tests, web tests, and both builds.

`main` requires a pull request and that `check` status. Force pushes and branch deletion are off. Admin bypass is still allowed. There is no production deploy workflow, so a green check is not a release.

## Intended hosts

The existing site at `https://babyto.in` stays where it is. DukaanOS uses only:

```text
https://dukanos.babyto.in       Vercel, apps/web
https://api.dukanos.babyto.in  Render, one NestJS process
```

`render.yaml` describes that API: one instance, PostgreSQL 18, `prisma migrate deploy`, then `db:ensure-app-role`. Render’s database owner is `DATABASE_ADMIN_URL`. `DATABASE_URL` must be a separate `dukaan_app` user, `NOSUPERUSER` and `NOBYPASSRLS`. `apps/web/vercel.json` is the PWA build. Set `VITE_API_BASE_URL` to `https://api.dukanos.babyto.in` on that Vercel project only. Do not add either subdomain to the existing Babyto project.

Production login cannot send a code. `OTP_PROVIDER=console` is refused, and the only production sender is `UnconfiguredOtpSender`, which returns “Verification codes cannot be delivered right now.” Do not turn console OTP on to get past that.

These files are not applied. This machine has no `vercel` or `render` CLI, no `~/.vercel` or `~/.render` login, and no provider token. DNS targets are not known until those providers create the services. `babyto.in` currently resolves to `216.198.79.1` with nameservers `hyperion.dns-parking.com` and `atlas.dns-parking.com`. Those records were not changed.
