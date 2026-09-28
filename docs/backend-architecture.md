# Backend foundation

DukaanOS is one NestJS application. Domain folders under `apps/api/src` are module boundaries. Sale voids are not posted yet. AI intake stores drafts only. Stock changes go through `InventoryLedgerService` after a shopkeeper confirms.

The database contract in `docs/database-architecture.md` is unchanged. Prisma migrations stay the source of schema changes.

## Process

```text
HTTP request
  -> request id middleware (AsyncLocalStorage)
  -> authentication guard
  -> session lookup (app.user_id only)
  -> shop grant checked against an active membership
  -> controller
  -> TenantTransactionService
  -> set_config(..., true) inside the transaction
  -> Prisma transaction client
  -> commit or rollback
```

`@CurrentUser()` reads the user from the server session. `@CurrentTenant()` reads the shop only after membership has been verified. Neither decorator reads `x-tenant-id` or a body field.

## Authentication

Login is phone OTP. `POST /api/v1/auth/request-otp` and `POST /api/v1/auth/verify-otp` are public. The code is HMAC-SHA256 with `OTP_PEPPER` and stored in `otp_challenges.code_hash`. The API response never includes the code.

`OtpSender` is the delivery port. `OTP_PROVIDER=console` logs the code in development. Tests use an in-memory capture provider. Production refuses both. SMS providers can implement `OtpSender` later.

The session token is `Authorization: Bearer`. The database stores SHA-256 of the whole token. The token embeds the user id so the API can set `app.user_id` before the session row is visible under RLS. Logout sets `revoked_at` and keeps the row.

The `sessions` table has no selected-shop column. After membership is checked, the API issues an HMAC shop grant bound to that session and user. Web clients receive it as the `HttpOnly` cookie `dukaan_shop` (`Secure` in production, `SameSite=Lax`). Mobile clients send the same value in `x-dukaan-shop`. Every later request checks the grant and the membership again. A raw shop id in the path is accepted only by `POST /api/v1/tenants/:tenantId/select`, and only after `runForMember` sees an active membership.

`runPlatform` is for users and OTP rows, which have no tenant policy. `runAsUser` sets `app.user_id` only. `runForMember` sets the user, loads the membership, and only then sets `app.tenant_id`. `run` is for work whose shop was already authorized, including creation of a new shop id.

Rate limits for OTP request and verify are an in-memory window keyed by phone and client IP. They are not shared across processes. Replace `AuthRateLimiter` with a shared store before running more than one API process.

`auth.login` is a structured log. `tenant.created`, `tenant.selected`, and `auth.logout` (when a shop is selected) are `audit_logs` rows inside the shop transaction. `dukaan_app` cannot insert a null `tenant_id`, so login is not an audit row.

## Catalog

`CatalogModule` owns products, units, categories, brands, barcodes, and catalog price history. Every call uses `TenantTransactionService.run` after the shop grant and membership check. `x-tenant-id` is ignored.

`OWNER`, `ADMIN`, and `STOCK_KEEPER` can change the catalog. `CASHIER` can search and read selling price, name, SKU, barcode, and unit. The JSON response omits `purchasePrice` and `averageCost` for a cashier. RLS does not hide those columns.

A new product does not create an inventory movement or balance. Price edits write `product_price_history` in the same transaction with source `MANUAL`. Search tries an exact barcode, then an exact SKU, then `ILIKE` on `name`, `name_en`, `name_hi`, and `name_mr`. `ProductPricingService.resolveSellingPrice` is the later customer-price boundary. It has no HTTP route.

## Tenant transaction

```ts
return this.tenantTransaction.run({ tenantId, userId }, async (tx) => {
  // tx is ShopDb. Row level security already applies.
});
```

`set_config` third argument is the SQL literal `true`. That is `SET LOCAL`. The next transaction on the same pooled connection does not keep the shop id.

`DatabaseModule` exports `TenantTransactionService`, not a general unscoped write API. `PrismaService` holds the single client and is not exported. Health checks call `SELECT 1` through `DatabaseHealthIndicator`.

`readUnscopedSession()` exists to prove the GUC is gone after commit. It is not a catalog API.

In tests the pool size is 1 so a leaked session setting cannot hide on a different connection. Production uses Prisma's default pool.

## Roles

| Use | Role |
| --- | --- |
| `prisma migrate`, seed, `tests/database-contract.test.ts` | `DATABASE_ADMIN_URL` |
| API process | `dukaan_app` via `DATABASE_URL` |

The migration creates `dukaan_app` as `NOLOGIN`. `npm run db:ensure-app-role` grants `LOGIN` with the password from `DATABASE_URL`. Startup reads `pg_roles` and exits if the connected role bypasses RLS.

## HTTP

- Prefix: `/api/v1`
- Success: the resource body, plus `x-request-id`. Health responses also include `requestId` so the caller can see the context value.
- Failure:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "requestId": "...",
    "details": [{ "field": "hack", "messages": ["property hack should not exist"] }]
  }
}
```

`details` is present for validation only. PostgreSQL text, Prisma stacks, and secrets are not returned.

Controllers take explicit DTO classes. The global pipe whitelists properties and rejects anything else. Prisma input types are not request bodies.

## Errors and logs

Codes live in `apps/api/src/common/errors/error-codes.ts`. Database mapping covers unique violations, foreign keys, check constraints, and serialization or deadlock. Idempotency unique violations use `IDEMPOTENCY_CONFLICT`.

Logs are one JSON object per line: `timestamp`, `level`, `requestId`, `userId`, `tenantId`, `module`, `operation`, `durationMs`. Request bodies are not logged. Connection URLs and secret assignments are redacted.

## Inventory

`InventoryModule` posts opening stock, adjustments, damage, and expiry. Every stock change goes through `InventoryLedgerService.post` inside `TenantTransactionService.run`. That method locks the balance row, writes one inventory movement, and updates `inventory_balances` in the same transaction. Other modules must not write `inventory_balances` themselves.

Opening stock and adjustments are confirmed `stock_adjustments` documents. The movement references the adjustment line. `OPENING` becomes `OPENING_STOCK`. `DAMAGE` and `EXPIRY` keep those movement types. A correction uses `ADJUSTMENT`. The quantity on the API is always positive. The movement stores the signed delta.

Incoming stock recalculates weighted average cost at `NUMERIC(18,2)`, rounded half up. Outbound stock keeps the current average and records that cost on the movement. Quantity cannot go below zero. A second opening for the same product and location returns `OPENING_STOCK_EXISTS`.

`Idempotency-Key` is stored in `idempotency_keys` inside the posting transaction. The same key and the same request return the stored result. A different request with that key returns `IDEMPOTENCY_CONFLICT`.

Cashiers can read quantity and selling price. The presenter omits average cost, unit cost, and stock value for them. Cashiers cannot post stock. Owner, admin, and stock keeper can.

Business dates on movements come from the database trigger and the shop timezone. The service does not calculate that date in JavaScript.

## Suppliers and purchases

`SuppliersModule` stores supplier name and contact details for the selected shop. Deactivation sets `is_active` to false. Historical purchases keep that supplier. A new purchase rejects an inactive supplier.

`PurchasesModule` records a confirmed supplier bill. It does not update `inventory_balances` or `inventory_movements` itself. Each purchase line calls `InventoryLedgerService.post` with movement type `PURCHASE` and a reference to that line. The ledger locks the balance, writes the movement, and updates weighted average cost.

A confirmed bill must account for its total. This module does not record a supplier payment. It records the unpaid amount as a `supplier_ledger` credit and updates `payable_balance` so the database check `payments + payable = grand_total` passes. Payments stay empty.

Purchase numbers come from `next_document_number` for `PURCHASE` after the idempotency key is claimed. A retry with the same key returns the original bill. Posted purchases are not edited or deleted.

## Customers and sales

`CustomersModule` stores a customer name and optional contact details. Deactivation sets `is_active` to false. A new sale rejects an inactive customer. Walk-in sales omit the customer.

`SalesModule` records a completed sale. Selling price comes from `ProductPricingService`: the current customer price when one exists, otherwise the catalog selling price. The sale line stores that price. A later catalog change does not rewrite it.

Each line calls `InventoryLedgerService.post` with movement type `SALE`. The ledger locks the balance, rejects a sale that would go below zero, and keeps the average cost. The sale line stores that average as `unit_cost` before the movement is written, because sale lines are append-only. Cost of goods sold is quantity times that cost. Gross profit is the sale total minus that cost. Owners and admins see both. Cashiers and stock keepers do not.

A new sale records only `CASH` or `UPI`. The shopkeeper confirms that the money was received. DukaanOS stores that confirmation on `payments` and does not verify UPI or call a payment provider. Card, bank transfer, and other values remain in the database enum so older rows stay valid, and a new sale rejects them. The payment sum cannot exceed the total. The unpaid remainder is one `CREDIT_SALE` debit and an increase of `receivable_balance`. A fully paid sale writes no customer ledger row. A walk-in cash or UPI sale is allowed when it is paid in full. A walk-in sale with an unpaid remainder is rejected. Sale numbers come from `next_document_number` for `SALE` after the idempotency key is claimed. Posted sales are not edited or deleted. The shop row has no UPI id yet, so a checkout QR cannot be generated until that column exists.

The same transaction adds the sale to `daily_summaries` for that business date: sales total, net sales, cash received, credit sales, quantity sold, transaction count, and gross profit. Closing receivable and payable balances stay for a later rebuild.

A sale created on a device while it had no connection is posted later through the same `SalesService.create` path. The body sets `source` to `OFFLINE_SYNC` and includes the selling price the device had cached. The server stores that price when it is the current price, a selling price from the last 30 `product_price_history` rows, or the current customer price. Any other price is `SALE_PRICE_MISMATCH`. An online sale still omits `source`. An online `unitPrice` must match the current resolved price. `OFFLINE_SYNC` ignores a browser `saleDate`. The shop timezone still chooses the business date, and the server clock still chooses the transaction time. The sale number still comes from `next_document_number`. Stock, the customer ledger, payments, and `daily_summaries` are written only inside that sale transaction. There is no offline ledger and no offline payment table.

The idempotency key is claimed inside the same transaction. The hash includes `source` and the offered price. The same key and the same body return the original sale, including when the device lost the first response. A different body returns `IDEMPOTENCY_CONFLICT`. A rolled-back attempt, such as `INSUFFICIENT_STOCK`, removes the key so a later corrected body can use it. The first successful post writes `sale.created` with metadata `{ source: "OFFLINE_SYNC" }`. A replay does not write that audit again.

`GET /api/v1/pos/catalog`, `/api/v1/pos/customers`, and `/api/v1/pos/customer-prices` page the data a till needs. Each page is at most 100 rows. The catalog includes the selling price, barcodes, and quantity at the default location. It does not include purchase price, average cost, or profit. Customer outstanding on that response is a snapshot for the device. The ledger remains authoritative. Any signed-in shop role can read these routes. Creating the sale still requires the sales permission on the current session.

## Returns

`SalesReturnsModule` posts a confirmed return against an existing sale. `PurchaseReturnsModule` posts a confirmed return against an existing purchase. Neither module writes `inventory_balances` or `inventory_movements` itself. Each line calls `InventoryLedgerService.post`.

A sales return uses movement type `SALE_RETURN` and brings stock back at `sale_items.unit_cost`. The ledger recalculates the average from that cost. A purchase return uses movement type `PURCHASE_RETURN`, stores the original purchase `unit_cost` on the movement, and leaves the current average unchanged.

Return numbers come from `next_document_number` for `SALE_RETURN` (`SR-`) and `PURCHASE_RETURN` (`PR-`) after the idempotency key is claimed. Posted returns are not edited or deleted. Cashiers cannot record or view them. Owners and admins see sale-return cost and profit. Stock keepers do not. Purchase-return cost follows the purchase rule: owners, admins, and stock keepers can see it.

A sales return reduces the customer receivable first, up to the current balance, with a `SALE_RETURN` credit. Any remainder is one `OUT` cash payment on the return. That payment records money the shopkeeper handed back. It does not reverse UPI and it does not call a payment provider. A walk-in return has no receivable, so the whole amount is that cash record. A purchase return reduces supplier payable with a `PURCHASE_RETURN` debit. Purchases do not update `daily_summaries`, and that cache has no purchase-return column, so a purchase return does not change it. A sales return adds `total_sales_returns` and reduces net sales, gross profit, and quantity sold. It does not add a new sale.

## Settlement

A later customer receipt is `POST /api/v1/customers/:customerId/payments`. A later supplier payment is `POST /api/v1/suppliers/:supplierId/payments`. Both record only `CASH` or `UPI` after the shopkeeper confirms the money. DukaanOS does not verify UPI and does not call a payment provider.

The customer receipt is one `IN` payment with `reference_type = CUSTOMER_RECEIPT` and a null `reference_id`, then a customer ledger `PAYMENT` credit that points at that payment. The supplier payment is one `OUT` payment with `reference_type = SUPPLIER_PAYMENT`, then a supplier ledger `PAYMENT` debit that points at that payment. The party row is locked first. The amount cannot exceed the current receivable or payable, including when that balance is zero. The same transaction updates the cached balance, adds `customer_collections` or `supplier_payments` on `daily_summaries`, and writes `customer.payment_recorded` or `supplier.payment_recorded`. It does not change sales, profit, quantity sold, purchases, or stock.

Owners, admins, stock keepers, and cashiers can record and view customer receipts. Cashiers cannot record or view supplier payments, and supplier detail still hides the payable from them. The same `Idempotency-Key` returns the original payment. A different body returns `IDEMPOTENCY_CONFLICT`.

## Expenses and finance

A new shop receives system expense categories: Rent, Electricity, Salary, Transport, Internet, Maintenance, Packaging, and Other. The shop can add more. A category is deactivated rather than deleted, and an inactive category cannot be used on a new expense. Historical expenses keep the category name.

`POST /api/v1/expenses` records an operating cost. The payment is cash or UPI the shopkeeper confirmed. DukaanOS does not verify UPI. The transaction inserts the expense, inserts an `OUT` payment with `reference_type = EXPENSE`, stores that payment on the expense, adds `total_expenses`, and subtracts the amount from `net_profit` on `daily_summaries`. Posted expenses are not edited, because the payment row cannot be changed. Owners and admins record expenses. Stock keepers can view them. Cashiers cannot.

`GET /api/v1/reports/finance-summary` reads the source documents for a shop business-date range. It does not write sales, stock, ledgers, payments, or expenses.

```text
netSales = grossSales - salesReturns
cogs = sale line cost - return line cost
grossProfit = netSales - cogs
netProfit = grossProfit - expenses
```

Customer receipts, supplier payments, and purchases are reported beside profit. They do not change it. Purchases are not cost of goods sold. Outstanding customer and supplier balances are the current ledger caches, not a historical daily close. Owners and admins see cost and profit. Stock keepers do not see cost of goods sold or profit. Cashiers see sales and collections, and do not see cost, profit, or supplier balances.

## Dashboard, reports, and daily closing

`GET /api/v1/dashboard/today` and `GET /api/v1/reports/finance-summary` use the same source-table totals. A daily closing stores those totals on the existing `daily_summaries` row and sets `closed_at`. Reports do not read that cache. The snapshot can be rebuilt for one business date.

```text
netSales = grossSales - salesReturns
cogs = sale line cost - return line cost
grossProfit = netSales - cogs
netProfit = grossProfit - expenses
```

Cash and UPI collected on a sale stay separate from later customer receipts. Supplier payments stay separate from purchases and from expenses. Damage and expiry are not included in this gross profit. Customer and supplier outstanding on the dashboard are the current balances. A closing stores the ledger totals for entries on or before that business date.

Weeks run Monday through Sunday in the shop timezone. Comparison returns the two periods, the absolute change, and the percentage change. A zero previous total has no percentage when the current total is not zero.

Stock value is on-hand quantity times `inventory_balances.average_cost`. A product is low stock only when quantity is above zero and at or below its minimum. Zero is out of stock. Products with stock and no completed sale in `daysWithoutSale` days (default 30) are listed together. The data does not split that list into slow stock and dead stock.

Owners and admins see cost and profit. Stock keepers do not see cost of goods sold or profit. Cashiers see sales and collections, and do not see cost, profit, or supplier balances. Cashiers do not see stock value.

## AI product intake

Camera intake is a draft. `AiIntakeService` creates `ai_intake_sessions` and `ai_intake_items`. It does not insert products, purchases, payments, or inventory rows. A vision provider implements `AiProductIntakeProvider.analyze` and returns suggestions. The shopkeeper confirms. Confirmation calls `ProductService.createWithin` and either `InventoryService.openingWithin` or `PurchaseService.createWithin`. The provider and the worker never call the ledger.

```text
POST /api/v1/ai/intake
POST /api/v1/ai/intake/:intakeId/upload-url
POST /api/v1/ai/intake/:intakeId/process
POST /api/v1/ai/intake/:intakeId/retry
GET  /api/v1/ai/intake/:intakeId
GET  /api/v1/ai/intake/:intakeId/media-url
PATCH /api/v1/ai/intake/:intakeId/items/:itemId
POST /api/v1/ai/intake/:intakeId/items/:itemId/reject
POST /api/v1/ai/intake/:intakeId/confirm
```

The shop comes from the membership grant. `tenantId` in the body is rejected by the validation pipe. `OWNER`, `ADMIN`, and `STOCK_KEEPER` can run intake. `CASHIER` cannot.

`POST .../process` verifies the private object and returns `QUEUED`. It does not wait for the model. The worker claims the row, calls the provider outside the database transaction, then writes `DRAFT_READY` or `FAILED`. Poll `GET` until one of those statuses. `QUEUED` is derived from `raw_output.job` while the database status is still `UPLOADED`. There is no `CREATED` status. `DRAFT_READY` is the review state. A second process while the job is queued or running returns `CONFLICT`. `DRAFT_READY` cannot be processed again. Editing a suggestion does not call the provider.

`FAILED` can be retried only when the failure was transient and the attempt count is within `AI_MAX_RETRIES` (default 2). Invalid images and invalid model output are not retried. A `PROCESSING` or `QUEUED` job older than `AI_INTAKE_PROCESSING_TIMEOUT_MINUTES` (default 10) becomes `FAILED` and can be retried. The next read or retry for that shop performs the recovery. There is no cross-shop sweep, because row security hides other shops.

Video is rejected. JPEG, PNG, and WEBP are accepted when the declared type, extension, stored content type, size, and file signature agree, up to 10 MB (`AI_INTAKE_MAX_UPLOAD_BYTES`). The API generates the object key `tenants/{tenantId}/ai-intake/{intakeId}/{fileId}`. A presigned URL is not an upload. Processing checks the object first. Download URLs expire. Credentials are not returned.

`AI_PROVIDER=mock` and `OBJECT_STORAGE_PROVIDER=mock` are the development defaults. Tests force both, even if a real provider is present in the environment. Production refuses mock AI and mock storage. `AI_PROVIDER=openai` uses `OpenAiVisionIntakeProvider` with `AI_API_KEY`, `AI_VISION_MODEL`, and `AI_API_BASE_URL`. `OBJECT_STORAGE_PROVIDER=s3` uses a private S3-compatible bucket. Provider errors are stored as codes such as `AI_PROVIDER_TIMEOUT`. The shop sees `We could not process this image. Please try again.` Logs record provider, model, duration, size, and item count. They do not record keys, image bytes, or presigned URLs.

The model output is validated before any draft row is written. Missing barcode, SKU, quantity, and prices stay null. An invalid payload fails the whole analysis. The mock still selects a fixture from the original file name (`unreadable`, `fail-once`, `slow`, `unknown`, `low`, `fuzzy`, `sku-match`, `exact-name`, `barcode-match`, `taken-barcode`, `multi`, `rollback`, `no-unit`, `hold`, otherwise Parle-G). Each item stores one confidence on `ai_intake_items.confidence`. Field-level scores are not a column. Evidence, when the provider sends it, stays in `raw_suggestion`.

Matching reads the shop with indexed lookups, not a full catalog load. Exact barcode, then exact SKU, then exact normalized name set `matched_product_id`. A shared word such as "Parle" can set `possibleProduct` and leaves `matched_product_id` empty until the shopkeeper sends `matchedProductId`. Below `AI_CONFIDENCE_THRESHOLD` (default 0.85, also read from `AI_INTAKE_CONFIDENCE_THRESHOLD`) the item stays `needsReview`. Nothing is confirmed automatically.

Processing is limited per minute in memory (`AI_INTAKE_MAX_REQUESTS_PER_MINUTE`, default 60) for the shop, the user, and the client IP. A rolling day cap (`AI_INTAKE_MAX_DAILY_PROCESSES`, default 500) counts `ai_intake.processed` and `ai_intake.processing_failed` in `audit_logs`. The minute window is not shared across API processes.

Abandoned `UPLOADED` media, failed media, and confirmed media are deleted after `AI_INTAKE_MEDIA_RETENTION_DAYS` (default 30). `QUEUED`, `PROCESSING`, and `DRAFT_READY` are kept. Cleanup runs for the current shop when that shop uses intake. It does not scan other shops.

`POST .../confirm` with `CREATE_PRODUCT_ONLY` calls `ProductService.createWithin` for new products and leaves stock untouched. `CREATE_PRODUCT_AND_STOCK` also posts stock when quantity and purchase price are both present. With `supplierId` that is one `PurchaseService.createWithin` call, so the purchase number comes from `next_document_number`. Without a supplier it calls `InventoryService.openingWithin` for each stock line. Missing quantity or purchase price does not invent a value. Confirmation of an existing `matched_product_id` does not create a second product. The same transaction marks the items `ACCEPTED` and the session `CONFIRMED` when no `PENDING` items remain. A failure rolls the product, stock, and draft status back together. The same `Idempotency-Key` and body returns the stored result. A different body returns `IDEMPOTENCY_CONFLICT`.

Audit rows are `ai_intake.created`, `ai_intake.media_uploaded`, `ai_intake.processed`, `ai_intake.processing_failed`, `ai_intake.processing_retried`, `ai_intake.media_deleted`, `ai_intake.item_updated`, `ai_intake.item_rejected`, and `ai_intake.confirmed`, plus the catalog, opening, or purchase events those services already write.

The queue is in-process. It is not Redis. The database row lock is what stops two workers from analyzing the same intake.

## Health and docs

```text
GET /api/v1/health
GET /api/v1/health/live
GET /api/v1/health/ready
GET /api/docs
```

Liveness does not touch PostgreSQL. Readiness runs `SELECT 1`. Swagger is mounted outside production.

## Shutdown

`SIGTERM` and `SIGINT` run Nest shutdown hooks outside tests. The HTTP server closes and `PrismaService` disconnects.

## What is intentionally absent

Password and PIN login, invite and recovery OTP, membership administration beyond the creating owner, sale voids, GST filing, payroll, video intake, and per-field confidence. The intake queue and the per-minute limit live in one API process. They are not a shared Redis queue. Catalog creates products and does not create stock. AI intake does not create stock either. The shopkeeper confirms, and then catalog, opening stock, or purchases write the ledger. Inventory posts opening stock and adjustments through the ledger. Purchases post stock only by calling that ledger, and they record the unpaid bill on the supplier payable ledger rather than as a payment. Sales post stock only by calling that ledger, record payments received, and record the unpaid remainder as customer receivable. Sales returns and purchase returns post stock only by calling that ledger.
