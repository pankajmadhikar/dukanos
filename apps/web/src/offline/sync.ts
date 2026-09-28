import { ApiError, request } from "../lib/api/client";
import { asRecord, asText, type Json } from "../lib/json";
import { catalogUpdatedAt, refreshPosCache } from "./catalog";
import { useOffline } from "./connectivity";
import { offlineAvailable } from "./db";
import { forgetOldSynced, listSales, markMalformed, nextSale, queueCounts, recoverInterrupted, saveSale } from "./queue";
import type { QueuedSale } from "./types";

const DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
const listeners = new Set<() => void>();

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let currentTenant = "";

export function onQueueChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function classifySyncError(error: unknown): "auth" | "retry" | "attention" {
  if (!(error instanceof ApiError)) return "retry";
  if (error.status === 401) return "auth";
  if (error.offline || error.code === "NETWORK" || error.code === "OFFLINE" || error.status === 0 || error.status >= 500) {
    return "retry";
  }
  return "attention";
}

export function attentionCopy(error: unknown): string {
  if (!(error instanceof ApiError)) return "This sale needs attention.";
  const stock = /^Not enough stock for (.+)\. Available: (.+)\. Requested: (.+)\.$/.exec(error.message);
  if (stock) {
    return `Sale could not be synced\n\n${stock[1]} does not have enough stock on the server.\n\nAvailable: ${stock[2]}\nRequested: ${stock[3]}`;
  }
  if (error.status === 403) return "This sale could not be synced because this sign-in cannot sell.";
  if (error.code === "IDEMPOTENCY_CONFLICT") return "This sale needs attention. Sync again before changing it.";
  return error.message || "This sale needs attention.";
}

export async function syncShop(tenantId: string, force = false): Promise<{ synced: number; attention: number }> {
  if (!offlineAvailable() || !tenantId) return { synced: 0, attention: 0 };
  const ran = await withLock(async () => {
    await recoverInterrupted(tenantId);
    await forgetOldSynced(tenantId);
    await markMalformed(tenantId);
    let synced = 0;
    let attention = 0;
    let waitMs: number | null = null;
    if (!browserSaysOnline()) {
      await publish(tenantId);
      return { synced, attention };
    }
    for (;;) {
      const sale = await nextSale(tenantId, Date.now(), force);
      if (!sale) break;
      const outcome = await postOne(sale);
      if (outcome.kind === "synced") synced += 1;
      if (outcome.kind === "attention") attention += 1;
      if (outcome.kind === "wait") {
        waitMs = outcome.delayMs;
        break;
      }
      if (outcome.kind === "auth") break;
    }
    if (browserSaysOnline()) {
      try {
        await refreshPosCache(tenantId);
        useOffline.getState().setCatalogUpdatedAt(await catalogUpdatedAt(tenantId));
        useOffline.getState().setApiReachable(true);
      } catch (error) {
        if (classifySyncError(error) === "retry") useOffline.getState().setApiReachable(false);
      }
    }
    if (synced > 0) useOffline.getState().noteSynced(synced);
    await publish(tenantId);
    schedule(tenantId, waitMs ?? 60_000);
    return { synced, attention };
  });
  return ran ?? { synced: 0, attention: 0 };
}

export function startOfflineSync(tenantId: string): void {
  currentTenant = tenantId;
  if (!offlineAvailable()) return;
  if (!started) {
    started = true;
    window.addEventListener("online", () => {
      useOffline.getState().setBrowserOnline(true);
      useOffline.getState().setApiReachable(true);
      if (currentTenant) void syncShop(currentTenant, true);
    });
    window.addEventListener("offline", () => useOffline.getState().setBrowserOnline(false));
  }
  void publish(tenantId);
  void syncShop(tenantId, true);
}

async function postOne(
  sale: QueuedSale,
): Promise<{ kind: "synced" } | { kind: "attention" } | { kind: "auth" } | { kind: "wait"; delayMs: number }> {
  const syncing: QueuedSale = { ...sale, status: "SYNCING", lastAttemptAt: new Date().toISOString() };
  await saveSale(syncing);
  try {
    const body = await request("/api/v1/sales", {
      method: "POST",
      body: sale.requestBody as Json,
      idempotencyKey: sale.idempotencyKey,
    });
    const data = asRecord(body.data);
    await saveSale({
      ...syncing,
      status: "SYNCED",
      serverSaleId: asText(data?.id) || null,
      serverSaleNumber: asText(data?.saleNumber) || null,
      syncedAt: new Date().toISOString(),
      shopMessage: null,
      lastErrorCode: null,
      paused: false,
    });
    useOffline.getState().setApiReachable(true);
    return { kind: "synced" };
  } catch (error) {
    const kind = classifySyncError(error);
    const code = error instanceof ApiError ? error.code : "NETWORK";
    if (kind === "auth") {
      await saveSale({
        ...syncing,
        status: "PENDING",
        shopMessage: "Sales saved locally. Connect to the internet and sign in again to sync.",
        lastErrorCode: code,
      });
      useOffline.getState().setSignInAgain(true);
      return { kind: "auth" };
    }
    if (kind === "retry") {
      const retryCount = syncing.retryCount + 1;
      const paused = retryCount > DELAYS_MS.length;
      const delay = DELAYS_MS[Math.min(syncing.retryCount, DELAYS_MS.length - 1)] ?? 60_000;
      await saveSale({
        ...syncing,
        status: "RETRYING",
        retryCount,
        paused,
        nextAttemptAt: paused ? null : new Date(Date.now() + delay).toISOString(),
        lastErrorCode: code,
        shopMessage: null,
      });
      useOffline.getState().setApiReachable(false);
      return { kind: "wait", delayMs: paused ? 60_000 : delay };
    }
    await saveSale({
      ...syncing,
      status: "NEEDS_ATTENTION",
      lastErrorCode: code,
      shopMessage: attentionCopy(error),
      paused: false,
    });
    return { kind: "attention" };
  }
}

async function publish(tenantId: string): Promise<void> {
  const counts = await queueCounts(tenantId);
  useOffline.getState().setCounts(counts.waiting, counts.attention);
  try {
    useOffline.getState().setCatalogUpdatedAt(await catalogUpdatedAt(tenantId));
  } catch {
    // The catalog time is optional.
  }
  for (const listener of listeners) listener();
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("dukaan-pos");
    channel.postMessage({ type: "queue", tenantId });
    channel.close();
  }
}

export function stopOfflineSyncForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

function schedule(tenantId: string, delayMs: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (browserSaysOnline()) void syncShop(tenantId);
  }, delayMs);
}

function browserSaysOnline(): boolean {
  return useOffline.getState().browserOnline;
}

async function withLock<T>(work: () => Promise<T>): Promise<T | null> {
  const locks = navigator.locks;
  if (!locks) return work();
  return locks.request("dukaan-pos-sync", { ifAvailable: true }, async (lock) => {
    if (!lock) return null;
    return work();
  });
}

export async function salesForShop(tenantId: string): Promise<QueuedSale[]> {
  if (!offlineAvailable()) return [];
  const sales = await listSales(tenantId);
  return sales;
}
