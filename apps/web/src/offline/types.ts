export type QueueStatus = "PENDING" | "SYNCING" | "SYNCED" | "RETRYING" | "NEEDS_ATTENTION";

export interface CachedProduct {
  tenantId: string;
  productId: string;
  name: string;
  nameEn: string | null;
  nameHi: string | null;
  nameMr: string | null;
  nameFold: string;
  sku: string | null;
  barcodes: string[];
  sellingPrice: string | null;
  unit: string;
  active: boolean;
  quantity: string;
  cachedAt: string;
}

export interface CachedBarcode {
  tenantId: string;
  barcode: string;
  productId: string;
}

export interface CachedCustomer {
  tenantId: string;
  customerId: string;
  name: string;
  phone: string | null;
  active: boolean;
  outstanding: string | null;
  cachedAt: string;
}

export interface CachedCustomerPrice {
  tenantId: string;
  customerId: string;
  productId: string;
  sellingPrice: string;
}

export interface QueuedItem {
  productId: string;
  name: string;
  quantity: string;
  sellingPrice: string;
}

export interface QueuedPayment {
  method: "CASH" | "UPI";
  amount: string;
}

export interface QueuedSale {
  localId: string;
  localRef: string;
  idempotencyKey: string;
  tenantId: string;
  userId: string;
  createdAt: string;
  customerId: string | null;
  customerName: string | null;
  items: QueuedItem[];
  originalItems: QueuedItem[] | null;
  payments: QueuedPayment[];
  requestBody: Record<string, unknown>;
  status: QueueStatus;
  retryCount: number;
  nextAttemptAt: string | null;
  paused: boolean;
  createdOfflineAt: string;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
  shopMessage: string | null;
  serverSaleId: string | null;
  serverSaleNumber: string | null;
  syncedAt: string | null;
}

export interface StoredCart {
  tenantId: string;
  lines: Array<{
    productId: string;
    name: string;
    quantity: string;
    listPrice: string | null;
    stock: string | null;
    cachedPrice: string | null;
  }>;
  customerId: string | null;
  customerName: string | null;
}
