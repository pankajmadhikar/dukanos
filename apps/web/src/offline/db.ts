export const OFFLINE_DB = "dukaan-offline";
export const OFFLINE_SCHEMA = 1;

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

let opening: Promise<IDBDatabase> | null = null;

export function offlineAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

export function upgradeStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains("products")) {
    const products = db.createObjectStore("products", { keyPath: ["tenantId", "productId"] });
    products.createIndex("byTenant", "tenantId");
    products.createIndex("bySku", ["tenantId", "sku"]);
    products.createIndex("byName", ["tenantId", "nameFold"]);
  }
  if (!db.objectStoreNames.contains("barcodes")) {
    const barcodes = db.createObjectStore("barcodes", { keyPath: ["tenantId", "barcode"] });
    barcodes.createIndex("byTenant", "tenantId");
  }
  if (!db.objectStoreNames.contains("customers")) {
    const customers = db.createObjectStore("customers", { keyPath: ["tenantId", "customerId"] });
    customers.createIndex("byTenant", "tenantId");
  }
  if (!db.objectStoreNames.contains("customerPrices")) {
    db.createObjectStore("customerPrices", { keyPath: ["tenantId", "customerId", "productId"] });
  }
  if (!db.objectStoreNames.contains("sales")) {
    const sales = db.createObjectStore("sales", { keyPath: "localId" });
    sales.createIndex("byTenantCreated", ["tenantId", "createdAt"]);
    sales.createIndex("byTenantStatus", ["tenantId", "status"]);
  }
  if (!db.objectStoreNames.contains("metadata")) {
    db.createObjectStore("metadata", { keyPath: ["tenantId", "key"] });
  }
  if (!db.objectStoreNames.contains("carts")) {
    db.createObjectStore("carts", { keyPath: "tenantId" });
  }
}

export function openOfflineDb(): Promise<IDBDatabase> {
  if (!offlineAvailable()) {
    return Promise.reject(new Error("IndexedDB is not available."));
  }
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(OFFLINE_DB, OFFLINE_SCHEMA);
      request.onupgradeneeded = () => upgradeStores(request.result);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    opening.catch(() => {
      opening = null;
    });
  }
  return opening;
}

export function resetOfflineDbForTests(): void {
  opening = null;
}

export function requestDone<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("The local save was aborted."));
    transaction.onerror = () => reject(transaction.error);
  });
}

export function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED");
}

export const SYNCED_RETENTION_MS = RETENTION_MS;
