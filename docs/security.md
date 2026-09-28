# Security

## Authentication

A request is accepted only after a hashed session is active, the shop grant matches that session and user, and the membership is active. `TenantTransactionService` then sets the tenant for row-level security. `x-tenant-id`, `body.tenantId`, and `query.tenantId` are not tenant authority.

Session tokens and OTP codes are stored as hashes. Logout sets `revoked_at`. Production refuses `OTP_PROVIDER=console` and `capture`. There is no SMS provider. Development prints the code in the API log.

OTP request and verify, and AI processing, use in-memory rate limits. Production must set `RATE_LIMIT_STORE=memory` and run one API process. A second process would not share those limits.

## HTTP

Helmet sets security headers. CORS is an explicit list. Staging and production require `https` origins and reject `*`. The production JSON parser limit is `JSON_BODY_LIMIT` (default `256kb`). List endpoints cap page size at 100. Sale lines are capped in the DTO. Client errors do not include stack traces. `x-request-id` is validated or replaced with a UUID and returned on the response.

The shop cookie is `HttpOnly` and `SameSite=Lax`. It is `Secure` when `NODE_ENV=production`.

## Database

`DATABASE_URL` must be `dukaan_app` (or `DATABASE_APP_ROLE`). Startup fails if that role is a superuser or has `BYPASSRLS`. `DATABASE_ADMIN_URL` is for migrations and backups only.

Business tables use tenant policies and composite foreign keys. Cross-tenant reads and writes are covered by the API tests. The application role cannot see another shop's rows inside a tenant transaction.

## Logs and the browser

API logs are JSON. Redaction strips database URLs and assignments that look like passwords, tokens, OTP values, and API keys. The browser reporter writes a short JSON line and drops messages that mention tokens, OTP, or passwords. It does not send those events to a vendor. The service worker does not cache `/api`. Production web builds do not emit source maps.

## Audit

Business commands write `audit_logs` inside the same transaction as the change. Application users do not get an API to edit or delete those rows. Login without a selected shop is a log line, not an audit row, because the app role cannot insert a null tenant.

## Checklist

- Secrets stay in untracked `.env` files. Examples contain placeholders.
- Frontend has only `VITE_API_BASE_URL`.
- HTTPS, a real staging host, and SMS delivery are not configured in this repository.
- Shared rate limiting is not implemented.
- Error monitoring is structured logs, not an external product.
