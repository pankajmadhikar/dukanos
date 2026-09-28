import { moneyInput, stockInput, toPaise } from "../lib/format";
import type { Json } from "../lib/json";
import { isQuotaError, openOfflineDb, requestDone, SYNCED_RETENTION_MS, transactionDone } from "./db";
import type { QueuedItem, QueuedPayment, QueuedSale, QueueStatus } from "./types";

const ACTIVE: QueueStatus[] = ["PENDING", "SYNCING", "RETRYING", "NEEDS_ATTENTION"];

export class OfflineStoreError extends Error {
  readonly quota: boolean;

  constructor(message: string, quota: boolean) {
    super(message);
    this.name = "OfflineStoreError";
    this.quota = quota;
  }
}

export function localRef(localId: string): string {
  return `OFF-${localId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export function lineMoney(unitPrice: string, quantity: string): string | null {
  const money = moneyInput(unitPrice);
  const stock = stockInput(quantity);
  if (!money || !stock) return null;
  const paise = toPaise(money);
  if (paise === null) return null;
  const milli = BigInt(stock.replace(".", ""));
  const line = (paise * milli + 500n) / 1000n;
  const whole = line / 100n;
  const cents = (line % 100n).toString().padStart(2, "0");
  return `${whole}.${cents}`;
}

export function sumMoney(amounts: string[]): string | null {
  let total = 0n;
  for (const amount of amounts) {
    const paise = toPaise(amount);
    if (paise === null) return null;
    total += paise;
  }
  const whole = total / 100n;
  const cents = (total % 100n).toString().padStart(2, "0");
  return `${whole}.${cents}`;
}

export interface NewOfflineSale {
  tenantId: string;
  userId: string;
  customerId: string | null;
  customerName: string | null;
  items: QueuedItem[];
  payments: QueuedPayment[];
  idempotencyKey?: string;
  requestBody?: Json;
}

export async function enqueueSale(input: NewOfflineSale): Promise<QueuedSale> {
  const localId = crypto.randomUUID();
  const idempotencyKey = input.idempotencyKey ?? `offline-sale:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const requestBody: QueuedSale["requestBody"] = input.requestBody
    ? (input.requestBody as unknown as QueuedSale["requestBody"])
    : {
        ...(input.customerId ? { customerId: input.customerId } : {}),
        source: "OFFLINE_SYNC",
        items: input.items.map((item) => ({
          productId: item.productId,
          quantity: stockInput(item.quantity) ?? item.quantity,
          unitPrice: moneyInput(item.sellingPrice) ?? item.sellingPrice,
        })),
        ...(input.payments.length > 0 ? { payments: input.payments } : {}),
      };
  const sale: QueuedSale = {
    localId,
    localRef: localRef(localId),
    idempotencyKey,
    tenantId: input.tenantId,
    userId: input.userId,
    createdAt: now,
    customerId: input.customerId,
    customerName: input.customerName,
    items: input.items,
    originalItems: null,
    payments: input.payments,
    requestBody: requestBody as QueuedSale["requestBody"],
    status: "PENDING",
    retryCount: 0,
    nextAttemptAt: null,
    paused: false,
    createdOfflineAt: now,
    lastAttemptAt: null,
    lastErrorCode: null,
    shopMessage: null,
    serverSaleId: null,
    serverSaleNumber: null,
    syncedAt: null,
  };
  try {
    const db = await openOfflineDb();
    const tx = db.transaction(["sales", "products"], "readwrite");
    tx.objectStore("sales").add(sale);
    adjustEstimates(tx.objectStore("products"), input.tenantId, input.items, -1);
    await transactionDone(tx);
  } catch (error) {
    if (isQuotaError(error)) {
      throw new OfflineStoreError("Offline storage is full. Connect to the internet to sync pending sales.", true);
    }
    throw new OfflineStoreError("The sale could not be saved on this device.", false);
  }
  return sale;
}

export async function listSales(tenantId: string): Promise<QueuedSale[]> {
  const db = await openOfflineDb();
  const rows = await requestDone(
    db.transaction("sales").objectStore("sales").index("byTenantCreated").getAll(IDBKeyRange.bound([tenantId, ""], [tenantId, "\uffff"])),
  );
  return (rows as QueuedSale[]).filter((row) => row.tenantId === tenantId).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function recoverInterrupted(tenantId: string): Promise<void> {
  const sales = await listSales(tenantId);
  const stuck = sales.filter((sale) => sale.status === "SYNCING");
  if (stuck.length === 0) return;
  const db = await openOfflineDb();
  const tx = db.transaction("sales", "readwrite");
  for (const sale of stuck) {
    tx.objectStore("sales").put({ ...sale, status: "PENDING" });
  }
  await transactionDone(tx);
}

export async function queueCounts(tenantId: string): Promise<{ waiting: number; attention: number }> {
  const sales = await listSales(tenantId);
  return {
    waiting: sales.filter((sale) => sale.status === "PENDING" || sale.status === "SYNCING" || sale.status === "RETRYING").length,
    attention: sales.filter((sale) => sale.status === "NEEDS_ATTENTION").length,
  };
}

export async function nextSale(tenantId: string, now = Date.now(), force = false): Promise<QueuedSale | null> {
  const sales = await listSales(tenantId);
  const queued = sales.filter((sale) => sale.status === "PENDING" || sale.status === "RETRYING");
  const first = queued[0];
  if (!first || !validShape(first)) return null;
  if (!force && (first.paused || (first.nextAttemptAt !== null && Date.parse(first.nextAttemptAt) > now))) return null;
  return first;
}

export async function saveSale(sale: QueuedSale): Promise<void> {
  const db = await openOfflineDb();
  const tx = db.transaction("sales", "readwrite");
  tx.objectStore("sales").put(sale);
  await transactionDone(tx);
}

export async function reviseQuantity(localId: string, productId: string, quantity: string): Promise<QueuedSale | null> {
  const db = await openOfflineDb();
  const existing = (await requestDone(db.transaction("sales").objectStore("sales").get(localId))) as QueuedSale | undefined;
  if (!existing || existing.status !== "NEEDS_ATTENTION") return existing ?? null;
  const stock = stockInput(quantity);
  if (!stock || stock === "0.000") return existing;
  const originalItems = existing.originalItems ?? existing.items;
  const items = existing.items.map((item) => (item.productId === productId ? { ...item, quantity: stock } : item));
  const amounts = items.map((item) => lineMoney(item.sellingPrice, item.quantity)).filter((value): value is string => Boolean(value));
  const total = sumMoney(amounts);
  const payments =
    existing.payments.length === 1 && total
      ? [{ method: existing.payments[0].method, amount: total }]
      : existing.payments;
  const revised: QueuedSale = {
    ...existing,
    items,
    originalItems,
    payments,
    requestBody: {
      ...(existing.customerId ? { customerId: existing.customerId } : {}),
      source: "OFFLINE_SYNC",
      items: items.map((item) => ({
        productId: item.productId,
        quantity: stockInput(item.quantity),
        unitPrice: moneyInput(item.sellingPrice),
      })),
      ...(payments.length > 0 ? { payments } : {}),
    },
    status: "PENDING",
    retryCount: 0,
    paused: false,
    nextAttemptAt: null,
    shopMessage: null,
    lastErrorCode: null,
  };
  const tx = db.transaction(["sales", "products"], "readwrite");
  tx.objectStore("sales").put(revised);
  const delta = quantityMilli(stock) - quantityMilli(existing.items.find((item) => item.productId === productId)?.quantity ?? "0");
  if (delta !== 0n) {
    const product = await requestDone(tx.objectStore("products").get([existing.tenantId, productId]));
    if (product && typeof product === "object" && "quantity" in product) {
      const current = quantityMilli(String(product.quantity));
      tx.objectStore("products").put({ ...product, quantity: milliToStock(current - delta) });
    }
  }
  await transactionDone(tx);
  return revised;
}

export async function applyPendingStock(tenantId: string): Promise<void> {
  const sales = await listSales(tenantId);
  const reserved = new Map<string, bigint>();
  for (const sale of sales) {
    if (sale.status === "SYNCED" || !ACTIVE.includes(sale.status)) continue;
    for (const item of sale.items) {
      reserved.set(item.productId, (reserved.get(item.productId) ?? 0n) + quantityMilli(item.quantity));
    }
  }
  if (reserved.size === 0) return;
  const db = await openOfflineDb();
  const tx = db.transaction("products", "readwrite");
  for (const [productId, milli] of reserved) {
    const product = await requestDone(tx.objectStore("products").get([tenantId, productId]));
    if (!product || typeof product !== "object" || !("quantity" in product)) continue;
    const current = quantityMilli(String(product.quantity));
    tx.objectStore("products").put({ ...product, quantity: milliToStock(current - milli) });
  }
  await transactionDone(tx);
}

export async function forgetOldSynced(tenantId: string): Promise<void> {
  const cutoff = Date.now() - SYNCED_RETENTION_MS;
  const sales = await listSales(tenantId);
  const stale = sales.filter((sale) => sale.status === "SYNCED" && sale.syncedAt && Date.parse(sale.syncedAt) < cutoff);
  if (stale.length === 0) return;
  const db = await openOfflineDb();
  const tx = db.transaction("sales", "readwrite");
  for (const sale of stale) tx.objectStore("sales").delete(sale.localId);
  await transactionDone(tx);
}

export async function markMalformed(tenantId: string): Promise<void> {
  const sales = await listSales(tenantId);
  const broken = sales.filter((sale) => ACTIVE.includes(sale.status) && !validShape(sale));
  if (broken.length === 0) return;
  const db = await openOfflineDb();
  const tx = db.transaction("sales", "readwrite");
  for (const sale of broken) {
    tx.objectStore("sales").put({
      ...sale,
      status: "NEEDS_ATTENTION",
      shopMessage: "This sale needs attention.",
      lastErrorCode: "MALFORMED",
    });
  }
  await transactionDone(tx);
}

function validShape(sale: QueuedSale): boolean {
  return Array.isArray(sale.items) && sale.items.length > 0 && typeof sale.idempotencyKey === "string" && sale.idempotencyKey.length > 0;
}

function adjustEstimates(store: IDBObjectStore, tenantId: string, items: QueuedItem[], direction: 1 | -1): void {
  for (const item of items) {
    const request = store.get([tenantId, item.productId]);
    request.onsuccess = () => {
      const product = request.result as { quantity?: string } | undefined;
      if (!product) return;
      const next = quantityMilli(String(product.quantity ?? "0")) + BigInt(direction) * quantityMilli(item.quantity);
      store.put({ ...product, quantity: milliToStock(next < 0n ? 0n : next) });
    };
  }
}

function quantityMilli(value: string): bigint {
  const stock = stockInput(value) ?? "0.000";
  return BigInt(stock.replace(".", ""));
}

function milliToStock(milli: bigint): string {
  const whole = milli / 1000n;
  const fraction = (milli % 1000n).toString().padStart(3, "0");
  return `${whole}.${fraction}`;
}
