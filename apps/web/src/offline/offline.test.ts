import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api/client";
import { loadCart, saveCart } from "./active-cart";
import { getProduct, searchProducts } from "./catalog";
import { useOffline } from "./connectivity";
import { OFFLINE_DB, isQuotaError, openOfflineDb, resetOfflineDbForTests, transactionDone, upgradeStores } from "./db";
import { enqueueSale, listSales, localRef, markMalformed, nextSale, reviseQuantity, saveSale } from "./queue";
import { stopOfflineSyncForTests, syncShop } from "./sync";
import type { CachedProduct } from "./types";

const request = vi.fn();

vi.mock("../lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("../lib/api/client")>("../lib/api/client");
  return { ...actual, request: (...args: unknown[]) => request(...args) };
});

const shop = "11111111-1111-4111-8111-111111111111";
const otherShop = "22222222-2222-4222-8222-222222222222";

describe("offline pos", () => {
  beforeEach(async () => {
    request.mockReset();
    request.mockImplementation(async (path: string) => {
      if (String(path).startsWith("/api/v1/pos/")) {
        return { data: [], pagination: { total: 0 }, requestId: "req" };
      }
      return { data: {}, requestId: "req" };
    });
    useOffline.setState({ browserOnline: true, apiReachable: true, waiting: 0, attention: 0, signInAgain: false });
    await wipe();
  });

  it("keeps a pending sale, its idempotency key, and the cart after the database is reopened", async () => {
    await rememberProduct(shop, "product-1", "Parle-G", "10.000");
    const sale = await enqueueSale({
      tenantId: shop,
      userId: "user-1",
      customerId: null,
      customerName: null,
      items: [{ productId: "product-1", name: "Parle-G", quantity: "7", sellingPrice: "10.00" }],
      payments: [{ method: "CASH", amount: "70.00" }],
    });
    expect(sale.idempotencyKey.startsWith("offline-sale:")).toBe(true);
    expect(sale.requestBody).toMatchObject({ source: "OFFLINE_SYNC" });
    expect(JSON.stringify(sale)).not.toMatch(/token|purchasePrice|averageCost/i);
    expect(localRef(sale.localId)).toBe(sale.localRef);
    const cached = await getProduct(shop, "product-1");
    expect(cached?.quantity).toBe("3.000");

    await reopen();
    const pending = await listSales(shop);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.idempotencyKey).toBe(sale.idempotencyKey);
    expect(pending[0]?.status).toBe("PENDING");

    await saveCart({
      tenantId: shop,
      lines: [{ productId: "product-1", name: "Parle-G", quantity: "2", listPrice: "10.00", stock: "3.000", cachedPrice: "10.00" }],
      customerId: null,
      customerName: null,
    });
    await reopen();
    const cart = await loadCart(shop);
    expect(cart?.lines[0]?.quantity).toBe("2");
  });

  it("searches barcode, SKU, and name inside one shop", async () => {
    await rememberProduct(shop, "product-1", "Parle-G", "10.000", { sku: "PG-1", barcodes: ["890123"], nameHi: "पार्ले" });
    await rememberProduct(otherShop, "product-2", "Parle-G", "4.000", { sku: "PG-1", barcodes: ["890123"] });
    expect((await searchProducts(shop, "890123")).map((row) => row.productId)).toEqual(["product-1"]);
    expect((await searchProducts(shop, "PG-1")).map((row) => row.productId)).toEqual(["product-1"]);
    expect((await searchProducts(shop, "parle")).map((row) => row.productId)).toEqual(["product-1"]);
    expect((await searchProducts(shop, "पार्ले")).map((row) => row.productId)).toEqual(["product-1"]);
    expect(await searchProducts(otherShop, "890123")).toHaveLength(1);
    expect((await searchProducts(otherShop, "890123"))[0]?.productId).toBe("product-2");
  });

  it("syncs one sale when the first response is lost and retries the same key", async () => {
    const keys: string[] = [];
    let committed = false;
    request.mockImplementation(async (path: string, options?: { idempotencyKey?: string }) => {
      if (String(path).startsWith("/api/v1/pos/")) {
        return { data: [], pagination: { total: 0 }, requestId: "req" };
      }
      keys.push(options?.idempotencyKey ?? "");
      if (!committed) {
        committed = true;
        throw new ApiError("The shop could not be reached. Please try again.", "NETWORK", 0, null, false);
      }
      return { data: { id: "server-sale", saleNumber: "S-00043" }, requestId: "req" };
    });
    const sale = await enqueueSale({
      tenantId: shop,
      userId: "user-1",
      customerId: null,
      customerName: null,
      items: [{ productId: "product-1", name: "Parle-G", quantity: "1", sellingPrice: "10.00" }],
      payments: [{ method: "CASH", amount: "10.00" }],
      idempotencyKey: "offline-sale:stable",
    });
    const first = await syncShop(shop, true);
    expect(first.synced).toBe(0);
    const waiting = await listSales(shop);
    expect(waiting[0]?.status).toBe("RETRYING");
    expect(waiting[0]?.idempotencyKey).toBe("offline-sale:stable");
    expect(await nextSale(shop)).toBeNull();

    const second = await syncShop(shop, true);
    expect(second.synced).toBe(1);
    const synced = await listSales(shop);
    expect(synced[0]?.status).toBe("SYNCED");
    expect(synced[0]?.serverSaleNumber).toBe("S-00043");
    expect(synced[0]?.localId).toBe(sale.localId);
    expect(keys.filter(Boolean)).toEqual(["offline-sale:stable", "offline-sale:stable"]);
  });

  it("marks a stock rejection for review and keeps the original quantity", async () => {
    request.mockImplementation(async (path: string) => {
      if (String(path).startsWith("/api/v1/pos/")) {
        return { data: [], pagination: { total: 0 }, requestId: "req" };
      }
      throw new ApiError("Not enough stock for Parle-G. Available: 3. Requested: 6.", "INSUFFICIENT_STOCK", 409, null, false);
    });
    const sale = await enqueueSale({
      tenantId: shop,
      userId: "user-1",
      customerId: null,
      customerName: null,
      items: [{ productId: "product-1", name: "Parle-G", quantity: "6", sellingPrice: "10.00" }],
      payments: [{ method: "CASH", amount: "60.00" }],
      idempotencyKey: "offline-sale:stock",
    });
    const result = await syncShop(shop, true);
    expect(result.attention).toBe(1);
    const blocked = (await listSales(shop))[0];
    expect(blocked?.status).toBe("NEEDS_ATTENTION");
    expect(blocked?.shopMessage).toContain("Available: 3");
    expect(blocked?.shopMessage).toContain("Requested: 6");
    expect(blocked?.items[0]?.quantity).toBe("6");

    const revised = await reviseQuantity(sale.localId, "product-1", "3");
    expect(revised?.status).toBe("PENDING");
    expect(revised?.idempotencyKey).toBe("offline-sale:stock");
    expect(revised?.items[0]?.quantity).toBe("3.000");
    expect(revised?.originalItems?.[0]?.quantity).toBe("6");
  });

  it("keeps a malformed sale and refuses a write that hits the quota", async () => {
    const sale = await enqueueSale({
      tenantId: shop,
      userId: "user-1",
      customerId: null,
      customerName: null,
      items: [{ productId: "product-1", name: "Parle-G", quantity: "1", sellingPrice: "10.00" }],
      payments: [{ method: "CASH", amount: "10.00" }],
    });
    await saveSale({ ...sale, items: [], idempotencyKey: sale.idempotencyKey });
    await markMalformed(shop);
    const broken = (await listSales(shop))[0];
    expect(broken?.status).toBe("NEEDS_ATTENTION");
    expect(broken?.shopMessage).toBe("This sale needs attention.");
    expect(await listSales(shop)).toHaveLength(1);

    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function add(this: IDBObjectStore, ...args: Parameters<IDBObjectStore["add"]>) {
      if (this.name === "sales") {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      }
      return original.apply(this, args);
    };
    try {
      await expect(
        enqueueSale({
          tenantId: shop,
          userId: "user-1",
          customerId: null,
          customerName: null,
          items: [{ productId: "product-2", name: "Salt", quantity: "1", sellingPrice: "5.00" }],
          payments: [{ method: "CASH", amount: "5.00" }],
        }),
      ).rejects.toThrow("Offline storage is full. Connect to the internet to sync pending sales.");
    } finally {
      IDBObjectStore.prototype.add = original;
    }
    expect(await listSales(shop)).toHaveLength(1);
    expect(isQuotaError(new DOMException("full", "QuotaExceededError"))).toBe(true);
  });

  it("posts a sale again when a previous attempt stopped while syncing", async () => {
    request.mockImplementation(async (path: string, options?: { idempotencyKey?: string }) => {
      if (String(path).startsWith("/api/v1/pos/")) {
        return { data: [], pagination: { total: 0 }, requestId: "req" };
      }
      return { data: { id: "server-sale", saleNumber: "S-00044" }, requestId: options?.idempotencyKey ?? "req" };
    });
    const sale = await enqueueSale({
      tenantId: shop,
      userId: "user-1",
      customerId: null,
      customerName: null,
      items: [{ productId: "product-1", name: "Parle-G", quantity: "1", sellingPrice: "10.00" }],
      payments: [{ method: "CASH", amount: "10.00" }],
      idempotencyKey: "offline-sale:interrupted",
    });
    await saveSale({ ...sale, status: "SYNCING" });
    const result = await syncShop(shop, true);
    expect(result.synced).toBe(1);
    const stored = (await listSales(shop))[0];
    expect(stored?.status).toBe("SYNCED");
    expect(stored?.serverSaleNumber).toBe("S-00044");
    expect(stored?.idempotencyKey).toBe("offline-sale:interrupted");
  });

  it("keeps a pending sale when the local schema version increases", async () => {
    const sale = await enqueueSale({
      tenantId: shop,
      userId: "user-1",
      customerId: null,
      customerName: null,
      items: [{ productId: "product-1", name: "Parle-G", quantity: "1", sellingPrice: "10.00" }],
      payments: [{ method: "CASH", amount: "10.00" }],
    });
    const current = await openOfflineDb();
    current.close();
    resetOfflineDbForTests();
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(OFFLINE_DB, 2);
      opening.onupgradeneeded = () => upgradeStores(opening.result);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const stored = await new Promise<unknown>((resolve, reject) => {
      const get = upgraded.transaction("sales").objectStore("sales").get(sale.localId);
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    upgraded.close();
    expect((stored as { idempotencyKey: string }).idempotencyKey).toBe(sale.idempotencyKey);
  });
});

async function wipe(): Promise<void> {
  stopOfflineSyncForTests();
  try {
    const db = await openOfflineDb();
    db.close();
  } catch {
    // The first test starts from an empty browser.
  }
  resetOfflineDbForTests();
  await new Promise<void>((resolve) => {
    const deleting = indexedDB.deleteDatabase(OFFLINE_DB);
    deleting.onsuccess = () => resolve();
    deleting.onerror = () => resolve();
    deleting.onblocked = () => resolve();
  });
}

async function reopen(): Promise<void> {
  const db = await openOfflineDb();
  db.close();
  resetOfflineDbForTests();
}

async function rememberProduct(
  tenantId: string,
  productId: string,
  name: string,
  quantity: string,
  extra: { sku?: string; barcodes?: string[]; nameHi?: string } = {},
): Promise<void> {
  const product: CachedProduct = {
    tenantId,
    productId,
    name,
    nameEn: null,
    nameHi: extra.nameHi ?? null,
    nameMr: null,
    nameFold: [name, extra.nameHi ?? ""].join(" ").trim().toLocaleLowerCase(),
    sku: extra.sku ?? null,
    barcodes: extra.barcodes ?? [],
    sellingPrice: "10.00",
    unit: "pcs",
    active: true,
    quantity,
    cachedAt: new Date().toISOString(),
  };
  const db = await openOfflineDb();
  const tx = db.transaction(["products", "barcodes"], "readwrite");
  tx.objectStore("products").put(product);
  for (const barcode of product.barcodes) {
    tx.objectStore("barcodes").put({ tenantId, barcode, productId });
  }
  await transactionDone(tx);
}
