import { shopApi } from "../lib/api/shop";
import { asList, asRecord, asText, type Json } from "../lib/json";
import { openOfflineDb, requestDone, transactionDone } from "./db";
import type { CachedCustomer, CachedCustomerPrice, CachedProduct } from "./types";
import { applyPendingStock } from "./queue";

const PAGE = 100;
const MAX_PAGES = 40;

export function foldName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export async function refreshPosCache(tenantId: string): Promise<void> {
  const started = new Date().toISOString();
  const products = await collectPages((page) => shopApi.posCatalog(page));
  const customers = await collectPages((page) => shopApi.posCustomers(page));
  const prices = await collectPages((page) => shopApi.posCustomerPrices(page));
  const db = await openOfflineDb();
  const tx = db.transaction(["products", "barcodes", "customers", "customerPrices", "metadata"], "readwrite");
  const productStore = tx.objectStore("products");
  const barcodeStore = tx.objectStore("barcodes");
  const customerStore = tx.objectStore("customers");
  const priceStore = tx.objectStore("customerPrices");
  const seenProducts = new Set<string>();
  for (const row of products) {
    const product = toProduct(tenantId, row, started);
    if (!product) continue;
    seenProducts.add(product.productId);
    productStore.put(product);
    for (const barcode of product.barcodes) {
      barcodeStore.put({ tenantId, barcode, productId: product.productId });
    }
  }
  const seenCustomers = new Set<string>();
  for (const row of customers) {
    const customer = toCustomer(tenantId, row, started);
    if (!customer) continue;
    seenCustomers.add(customer.customerId);
    customerStore.put(customer);
  }
  for (const row of prices) {
    const price = toPrice(tenantId, row);
    if (price) priceStore.put(price);
  }
  tx.objectStore("metadata").put({ tenantId, key: "catalogUpdatedAt", value: started });
  await transactionDone(tx);
  await dropStale(tenantId, seenProducts, seenCustomers);
  await applyPendingStock(tenantId);
}

async function dropStale(tenantId: string, products: Set<string>, customers: Set<string>): Promise<void> {
  const db = await openOfflineDb();
  const tx = db.transaction(["products", "barcodes", "customers"], "readwrite");
  const productStore = tx.objectStore("products");
  const cursor = productStore.index("byTenant").openCursor(IDBKeyRange.only(tenantId));
  await walk(cursor, (row, current) => {
    const product = row as CachedProduct;
    if (!products.has(product.productId)) {
      current.delete();
      for (const barcode of product.barcodes) {
        tx.objectStore("barcodes").delete([tenantId, barcode]);
      }
    }
  });
  const customerCursor = tx.objectStore("customers").index("byTenant").openCursor(IDBKeyRange.only(tenantId));
  await walk(customerCursor, (row, current) => {
    const customer = row as CachedCustomer;
    if (!customers.has(customer.customerId)) current.delete();
  });
  await transactionDone(tx);
}

export async function searchProducts(tenantId: string, raw: string): Promise<CachedProduct[]> {
  const query = raw.trim();
  if (!query) return [];
  const db = await openOfflineDb();
  const exactBarcode = await requestDone(
    db.transaction("barcodes").objectStore("barcodes").get([tenantId, query]),
  );
  if (exactBarcode && typeof exactBarcode === "object" && "productId" in exactBarcode) {
    const product = await getProduct(tenantId, String(exactBarcode.productId));
    return product ? [product] : [];
  }
  const sku = await requestDone(
    db.transaction("products").objectStore("products").index("bySku").get([tenantId, query]),
  );
  if (sku) return [sku as CachedProduct];
  const folded = foldName(query);
  const prefix = await prefixProducts(tenantId, folded);
  if (prefix.length > 0) return prefix.slice(0, 20);
  return scanNames(tenantId, folded);
}

export async function findBarcode(tenantId: string, barcode: string): Promise<CachedProduct | null> {
  const matches = await searchProducts(tenantId, barcode);
  return matches[0] ?? null;
}

export async function getProduct(tenantId: string, productId: string): Promise<CachedProduct | null> {
  const db = await openOfflineDb();
  const row = await requestDone(db.transaction("products").objectStore("products").get([tenantId, productId]));
  return (row as CachedProduct | undefined) ?? null;
}

export async function searchCustomers(tenantId: string, raw: string): Promise<CachedCustomer[]> {
  const folded = foldName(raw);
  if (!folded) return [];
  const db = await openOfflineDb();
  const tx = db.transaction("customers");
  const cursor = tx.objectStore("customers").index("byTenant").openCursor(IDBKeyRange.only(tenantId));
  const matches: CachedCustomer[] = [];
  await walk(cursor, (row) => {
    const customer = row as CachedCustomer;
    const haystack = foldName(`${customer.name} ${customer.phone ?? ""}`);
    if (haystack.includes(folded)) matches.push(customer);
  });
  return matches.slice(0, 20);
}

export async function getCustomer(tenantId: string, customerId: string): Promise<CachedCustomer | null> {
  const db = await openOfflineDb();
  const row = await requestDone(
    db.transaction("customers").objectStore("customers").get([tenantId, customerId]),
  );
  return (row as CachedCustomer | undefined) ?? null;
}

export async function customerPrice(
  tenantId: string,
  customerId: string,
  productId: string,
): Promise<string | null> {
  const db = await openOfflineDb();
  const row = await requestDone(
    db.transaction("customerPrices").objectStore("customerPrices").get([tenantId, customerId, productId]),
  );
  const price = row as CachedCustomerPrice | undefined;
  return price?.sellingPrice ?? null;
}

export async function catalogUpdatedAt(tenantId: string): Promise<string | null> {
  const db = await openOfflineDb();
  const row = await requestDone(
    db.transaction("metadata").objectStore("metadata").get([tenantId, "catalogUpdatedAt"]),
  );
  if (!row || typeof row !== "object" || !("value" in row)) return null;
  return typeof row.value === "string" ? row.value : null;
}

export async function saveSnapshot(tenantId: string, key: string, value: Json): Promise<void> {
  const db = await openOfflineDb();
  const tx = db.transaction("metadata", "readwrite");
  tx.objectStore("metadata").put({ tenantId, key, value, savedAt: new Date().toISOString() });
  await transactionDone(tx);
}

export async function loadSnapshot(tenantId: string, key: string): Promise<{ value: Json; savedAt: string } | null> {
  const db = await openOfflineDb();
  const row = await requestDone(db.transaction("metadata").objectStore("metadata").get([tenantId, key]));
  if (!row || typeof row !== "object" || !("value" in row)) return null;
  const savedAt = "savedAt" in row && typeof row.savedAt === "string" ? row.savedAt : "";
  return { value: row.value as Json, savedAt };
}

async function prefixProducts(tenantId: string, folded: string): Promise<CachedProduct[]> {
  const db = await openOfflineDb();
  const range = IDBKeyRange.bound([tenantId, folded], [tenantId, `${folded}\uffff`]);
  const cursor = db.transaction("products").objectStore("products").index("byName").openCursor(range);
  const matches: CachedProduct[] = [];
  await walk(cursor, (row) => {
    if (matches.length < 20) matches.push(row as CachedProduct);
  });
  return matches;
}

async function scanNames(tenantId: string, folded: string): Promise<CachedProduct[]> {
  const db = await openOfflineDb();
  const cursor = db
    .transaction("products")
    .objectStore("products")
    .index("byTenant")
    .openCursor(IDBKeyRange.only(tenantId));
  const matches: CachedProduct[] = [];
  let seen = 0;
  await walk(cursor, (row) => {
    seen += 1;
    const product = row as CachedProduct;
    const names = [product.name, product.nameEn, product.nameHi, product.nameMr].filter(Boolean).join(" ");
    if (foldName(names).includes(folded)) matches.push(product);
    return matches.length < 20 && seen < 800;
  });
  return matches;
}

function toProduct(tenantId: string, row: Json, cachedAt: string): CachedProduct | null {
  const record = asRecord(row);
  const productId = asText(record?.productId);
  const name = asText(record?.name);
  if (!productId || !name) return null;
  const barcodes = asList(record?.barcodes).map((item) => asText(item)).filter(Boolean);
  return {
    tenantId,
    productId,
    name,
    nameEn: asText(record?.nameEn) || null,
    nameHi: asText(record?.nameHi) || null,
    nameMr: asText(record?.nameMr) || null,
    nameFold: foldName([name, asText(record?.nameEn), asText(record?.nameHi), asText(record?.nameMr)].join(" ")),
    sku: asText(record?.sku) || null,
    barcodes,
    sellingPrice: asText(record?.sellingPrice) || null,
    unit: asText(record?.unit),
    active: record?.active !== false,
    quantity: asText(record?.quantity) || "0",
    cachedAt,
  };
}

function toCustomer(tenantId: string, row: Json, cachedAt: string): CachedCustomer | null {
  const record = asRecord(row);
  const customerId = asText(record?.customerId);
  const name = asText(record?.name);
  if (!customerId || !name) return null;
  return {
    tenantId,
    customerId,
    name,
    phone: asText(record?.phone) || null,
    active: record?.active !== false,
    outstanding: asText(record?.outstanding) || null,
    cachedAt,
  };
}

function toPrice(tenantId: string, row: Json): CachedCustomerPrice | null {
  const record = asRecord(row);
  const customerId = asText(record?.customerId);
  const productId = asText(record?.productId);
  const sellingPrice = asText(record?.sellingPrice);
  if (!customerId || !productId || !sellingPrice) return null;
  return { tenantId, customerId, productId, sellingPrice };
}

async function collectPages(load: (page: number) => Promise<Record<string, Json>>): Promise<Json[]> {
  const rows: Json[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await load(page);
    const chunk = asList(body.data);
    rows.push(...chunk);
    const pagination = asRecord(body.pagination);
    const total = typeof pagination?.total === "number" ? pagination.total : rows.length;
    if (chunk.length < PAGE || rows.length >= total) break;
  }
  return rows;
}

function walk(
  request: IDBRequest<IDBCursorWithValue | null>,
  visit: (value: unknown, cursor: IDBCursorWithValue) => boolean | void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const keep = visit(cursor.value, cursor);
      if (keep === false) {
        resolve();
        return;
      }
      cursor.continue();
    };
  });
}
