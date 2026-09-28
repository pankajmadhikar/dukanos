# Offline POS

Local offline storage is not the source of truth.

PostgreSQL, the NestJS sales service, and `InventoryLedgerService` remain the source of truth. The browser stores a cache, the active cart, and a queue of sale commands. It does not keep a second inventory ledger, customer ledger, or payment book.

Online sales still call `POST /api/v1/sales/quote` and then `POST /api/v1/sales`. They are not placed in the queue. If that post is sent and the response is lost, or the API returns a temporary failure, the same request body and the same idempotency key are saved and retried.

## What works offline

- Product search by barcode, SKU, and cached name, including cached Hindi and Marathi names
- Cached selling prices and cached customer-specific prices
- Cached customers for the till
- Cart edits, including after a refresh
- Cash, UPI, split, and credit sales for a cached customer
- Automatic sync when the app opens or the browser comes online, a manual Sync now action, and a retry while the app stays open

Purchases, purchase returns, supplier payments, expenses, stock changes, product create and edit, customer create, customer payment settlement, camera add, reports calculation, daily closing, and sales returns stay online. Those screens say they need an internet connection.

## Local database

The IndexedDB database is `dukaan-offline`, schema version 1. A newer app version adds stores only when they are missing. It does not delete pending sales.

| Store | Purpose |
| --- | --- |
| `products` | Sellable product, selling price, unit, and an estimated quantity |
| `barcodes` | Exact barcode lookup |
| `customers` | Name, phone, and a snapshot of outstanding |
| `customerPrices` | Prices the server already stored |
| `sales` | The pending and recently synced sale queue |
| `metadata` | Catalog time and short cached screens |
| `carts` | The sale being prepared |

Every row is keyed with the shop id. Shop A data is not readable as Shop B. The queue does not store the session token, shop grant, AI keys, storage credentials, purchase cost, average cost, or profit.

Synced sales stay for 30 days, then the local copy is removed. Pending and failed sales are not removed on logout, refresh, or an app upgrade.

## Selling offline

The till uses the cached catalog. Product and customer search keep running when the browser reports offline, because those lookups read IndexedDB. A product that is not cached shows: "Product not available offline. Connect to the internet to search this product."

Stock on the device is labeled "Estimated stock". It is the last server quantity minus sales that have not synced. It is not a guarantee. After a refresh of the catalog, the server quantity is stored and the unsynced quantities are subtracted again.

A credit sale needs a cached active customer whose snapshot is less than 7 days old. Outstanding shown from that snapshot is labeled estimated. A missing customer is not created offline.

Completing a sale writes the queue record, its lines, its payments, and the estimated stock change in one IndexedDB transaction. The success screen is shown after that write. The screen says "Sale saved successfully", "Waiting for internet", and a local reference such as `OFF-01JABC`. That reference is not the bill number.

If the write fails because storage is full, the shopkeeper sees "Offline storage is full. Connect to the internet to sync pending sales." and the sale is not treated as saved. A malformed queue row is marked "This sale needs attention." and is kept.

The active cart is saved on the device. After a reload, the till asks "Resume previous sale?" and offers Resume or Discard.

If the catalog is older than 24 hours, the till says the product data may be outdated. Cash sales are still allowed.

## Sync

`OfflineSyncManager` lives in `apps/web/src/offline/sync.ts`. React screens do not post the queue themselves.

One tab holds the `dukaan-pos-sync` lock. Sales post one at a time, oldest first. A sale that is waiting for its retry delay is not skipped in favor of a newer sale. A sale left in `SYNCING` because the page closed mid-request is returned to `PENDING` and sent again with the same idempotency key.

`navigator.onLine` starts an attempt. A successful API call confirms the connection. A browser that says online while the API is down keeps new sales on the device and retries the queue.

Temporary failures wait 5 seconds, then 15, 30, and 60. After that the sale pauses until the browser comes online again or the shopkeeper taps Sync now. Invalid products, customers, payments, permissions, stock, and idempotency conflicts become `NEEDS_ATTENTION`. They are not deleted.

A 401 leaves the sale pending and says: "Sales saved locally. Connect to the internet and sign in again to sync."

Logout is refused while any sale is waiting or needs attention: "N sales are waiting to sync. Please connect to the internet before logging out."

The service worker caches the app shell only. It does not cache `/api`.

## Conflicts

The server checks the signed-in user, the shop, the product, the customer, the quantity, the payment, the offline price, the stock, and the idempotency key.

If two devices sell the same units, one sale posts and the other returns `INSUFFICIENT_STOCK`. The device shows the product, the available quantity, and the requested quantity. It does not reduce the quantity by itself and it does not change stock locally to force the sale. The shopkeeper can review the sale, enter a smaller quantity, and sync again. The original quantity is kept on the queue row. The same idempotency key is reused because the rejected attempt was rolled back.

After a successful sync the screen shows the server bill number, such as `S-00043`.
