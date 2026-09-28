import { useEffect, useState } from "react";
import { Button } from "../components/ui";
import { useOffline } from "../offline/connectivity";
import { reviseQuantity } from "../offline/queue";
import { salesForShop, syncShop } from "../offline/sync";
import type { QueuedSale } from "../offline/types";
import { useSession } from "../stores/session";

export function SyncPage() {
  const shopId = useSession((state) => state.shop?.id) ?? "";
  const waiting = useOffline((state) => state.waiting);
  const attention = useOffline((state) => state.attention);
  const [sales, setSales] = useState<QueuedSale[]>([]);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ localId: string; productId: string; quantity: string } | null>(null);

  async function load() {
    setSales(await salesForShop(shopId));
  }

  useEffect(() => {
    void load();
  }, [shopId, waiting, attention]);

  return (
    <section className="mx-auto flex w-full max-w-lg flex-col gap-3">
      <h1 className="text-2xl font-semibold">Sync</h1>
      <Button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void syncShop(shopId, true).finally(() => {
            setBusy(false);
            void load();
          });
        }}
      >
        {busy ? "Syncing..." : "Sync now"}
      </Button>
      {waiting === 0 && attention === 0 ? <p>All sales synced ✓</p> : null}
      {sales.map((sale) => (
        <article key={sale.localId} className="rounded-2xl bg-card p-4">
          <p className="font-semibold">
            {sale.status === "SYNCED" ? `✓ ${sale.serverSaleNumber ?? sale.localRef} Synced` : null}
            {sale.status === "PENDING" || sale.status === "RETRYING" || sale.status === "SYNCING"
              ? `⟳ ${sale.localRef} · Sale waiting for internet`
              : null}
            {sale.status === "NEEDS_ATTENTION" ? `⚠ ${sale.localRef} · Sale needs attention` : null}
          </p>
          {sale.shopMessage ? <p className="mt-2 whitespace-pre-line">{sale.shopMessage}</p> : null}
          {sale.items.map((item) => (
            <p key={item.productId} className="text-sm text-muted">
              {item.name} · {item.quantity}
            </p>
          ))}
          {sale.status === "NEEDS_ATTENTION" && sale.lastErrorCode === "INSUFFICIENT_STOCK" ? (
            <div className="mt-3">
              <Button
                tone="quiet"
                onClick={() =>
                  setEdit({
                    localId: sale.localId,
                    productId: sale.items[0]?.productId ?? "",
                    quantity: sale.items[0]?.quantity ?? "1",
                  })
                }
              >
                Review
              </Button>
            </div>
          ) : null}
        </article>
      ))}
      {edit ? (
        <form
          className="rounded-2xl bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void reviseQuantity(edit.localId, edit.productId, edit.quantity).then(() => {
              setEdit(null);
              void syncShop(shopId, true).then(() => load());
            });
          }}
        >
          <label className="flex flex-col gap-1 font-medium">
            Quantity
            <input
              className="min-h-12 rounded-xl border border-line px-3"
              inputMode="decimal"
              value={edit.quantity}
              onChange={(event) => setEdit({ ...edit, quantity: event.target.value })}
            />
          </label>
          <Button type="submit">Save and sync</Button>
        </form>
      ) : null}
    </section>
  );
}
