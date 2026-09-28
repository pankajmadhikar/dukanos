# DukaanOS

DukaanOS is a modular monolith for Indian retail shops. The repository contains the PostgreSQL contract, the NestJS API, and the shopkeeper web app in `apps/web`.

PostgreSQL 18 is required. The schema uses PostgreSQL 18 `uuidv7()`.

The API is one NestJS process. Sales, inventory, customers, and AI intake are modules inside that process. They are not separate services. The shop app calls that API. It does not keep its own accounts.

## Local development

1. Install dependencies.

```bash
npm install
```

2. Start PostgreSQL 18.

Homebrew on this machine listens on port 5432. The checked-in Compose file also runs PostgreSQL 18 and publishes it on host port **54329** so it does not collide with a local server:

```bash
docker compose up -d
```

3. Configure environment.

```bash
cp .env.example .env
```

Set two URLs:

- `DATABASE_ADMIN_URL` is the migration and seed role. It may be the database owner. The API must not use it.
- `DATABASE_URL` is `dukaan_app` with a local password. That role is `NOSUPERUSER` and `NOBYPASSRLS`.

Do not point `DATABASE_URL` at `postgres`, the Compose superuser, or your OS superuser.

4. Apply migrations.

```bash
npm run db:migrate
```

5. Allow the application role to log in. This sets `LOGIN` and the password from `DATABASE_URL`. It does not change tables.

```bash
npm run db:ensure-app-role
```

6. Seed development shop data. The seed does not create bills or stock.

```bash
npm run db:seed
```

7. Start the API.

```bash
npm run dev
```

8. Check the process and the database.

```bash
curl http://localhost:3000/api/v1/health/live
curl http://localhost:3000/api/v1/health/ready
```

OpenAPI is served at `http://localhost:3000/api/docs` when `NODE_ENV` is not `production`.

9. Sign in and open a shop. No SMS provider is required. With `OTP_PROVIDER=console` the API log prints `development verification code`.

```bash
curl -s -X POST http://localhost:3000/api/v1/auth/request-otp \
  -H 'content-type: application/json' \
  -d '{"phone":"9876543210"}'
```

Read the code from the API log, then:

```bash
curl -s -X POST http://localhost:3000/api/v1/auth/verify-otp \
  -H 'content-type: application/json' \
  -d '{"phone":"9876543210","code":"THE_CODE"}'
```

The response `data.token` is the bearer session. The database stores only its hash.

```bash
curl -s -X POST http://localhost:3000/api/v1/tenants \
  -H 'authorization: Bearer THE_TOKEN' \
  -H 'content-type: application/json' \
  -d '{"name":"Pankaj Kirana","businessType":"GROCERY"}'
```

Creation returns `shopContext` and sets the `dukaan_shop` cookie. Send that value on later calls as `x-dukaan-shop`. `x-tenant-id` is ignored.

```bash
curl -s http://localhost:3000/api/v1/auth/me \
  -H 'authorization: Bearer THE_TOKEN' \
  -H 'x-dukaan-shop: THE_SHOP_CONTEXT'

curl -s http://localhost:3000/api/v1/tenants/current \
  -H 'authorization: Bearer THE_TOKEN' \
  -H 'x-dukaan-shop: THE_SHOP_CONTEXT'
```

10. Start the shop app in another terminal.

```bash
cd apps/web
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`. The API must already be running. The only public setting is `VITE_API_BASE_URL`.

11. Run tests.

```bash
npm test
npm run db:test
npm run test:web
```

`npm test` runs the API tests. `npm run test:web` runs the shop app tests. `npm run db:test` runs the database contract tests as the migration role. `npm run db:test` runs the database contract tests as the migration role.

## Application role

| Connection | Variable | Who |
| --- | --- | --- |
| Migrations, seed, contract tests | `DATABASE_ADMIN_URL` | Schema owner |
| NestJS API | `DATABASE_URL` | `dukaan_app` |

The API refuses to start if `current_user` is a superuser, has `BYPASSRLS`, or is not `DATABASE_APP_ROLE` (default `dukaan_app`).

Shop queries belong inside `TenantTransactionService.run`. That opens a Prisma transaction and sets `app.tenant_id` and `app.user_id` with `set_config(..., true)`, so the setting is local to the transaction. See `docs/backend-architecture.md`.

## Scripts

```text
dev dev:web start start:prod build build:web lint format
test test:web test:watch test:e2e
db:validate db:format db:generate db:migrate db:seed db:ensure-app-role db:test
```
