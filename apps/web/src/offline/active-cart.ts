import { openOfflineDb, transactionDone } from "./db";
import type { StoredCart } from "./types";

export async function loadCart(tenantId: string): Promise<StoredCart | null> {
  const db = await openOfflineDb();
  const row = await new Promise<StoredCart | undefined>((resolve, reject) => {
    const request = db.transaction("carts").objectStore("carts").get(tenantId);
    request.onsuccess = () => resolve(request.result as StoredCart | undefined);
    request.onerror = () => reject(request.error);
  });
  if (!row || row.lines.length === 0) return null;
  return row;
}

export async function saveCart(cart: StoredCart): Promise<void> {
  const db = await openOfflineDb();
  const tx = db.transaction("carts", "readwrite");
  if (cart.lines.length === 0) tx.objectStore("carts").delete(cart.tenantId);
  else tx.objectStore("carts").put(cart);
  await transactionDone(tx);
}
