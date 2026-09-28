import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Allow } from "../components/shell";
import { Button, ConfirmDialog, EmptyState, ErrorState, Field, Loading, Money, Page, controlClass } from "../components/ui";
import { useDebounced } from "../hooks/use-debounced";
import { ApiError } from "../lib/api/client";
import { shopApi } from "../lib/api/shop";
import { formatQty, moneyInput, stockInput } from "../lib/format";
import { asList, asRecord, asText } from "../lib/json";
import { can } from "../lib/permissions";
import { useSession } from "../stores/session";
import { useToast } from "../stores/toast";

const filters = [
  { id: "all", label: "All" },
  { id: "low", label: "Low stock" },
  { id: "out", label: "Out of stock" },
  { id: "slow", label: "Slow stock" },
] as const;

export function StockPage() {
  const role = useSession((state) => state.shop?.role);
  const [params, setParams] = useSearchParams();
  const filter = params.get("filter") ?? "all";
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search);
  const stock = useQuery({
    queryKey: ["stock", filter, debounced],
    queryFn: () => {
      if (filter === "low") return shopApi.reportLow();
      if (filter === "out") return shopApi.reportOut();
      if (filter === "slow") return shopApi.reportInactive();
      return shopApi.inventory({ search: debounced, lowStock: false });
    },
  });

  return (
    <Page
      title="Stock"
      action={
        can(role, "inventory.manage") ? (
          <div className="flex gap-2">
            <Link to="/stock/add" className="inline-flex min-h-12 items-center rounded-xl bg-accent px-4 font-semibold text-accent-ink">
              Add stock
            </Link>
            {can(role, "ai.intake") ? (
              <Link to="/ai" className="inline-flex min-h-12 items-center rounded-xl border border-line bg-card px-4 font-semibold">
                + Camera add
              </Link>
            ) : null}
          </div>
        ) : null
      }
    >
      <div className="flex flex-wrap gap-2">
        {filters.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`min-h-12 rounded-full px-4 font-semibold ${filter === item.id ? "bg-accent text-accent-ink" : "bg-card"}`}
            onClick={() => setParams(item.id === "all" ? {} : { filter: item.id })}
          >
            {item.label}
          </button>
        ))}
      </div>
      {filter === "all" ? (
        <input className={controlClass} placeholder="Search stock..." value={search} onChange={(event) => setSearch(event.target.value)} />
      ) : null}
      {stock.isLoading ? <Loading label="Loading stock..." /> : null}
      {stock.isError ? <ErrorState error={stock.error} onRetry={() => void stock.refetch()} /> : null}
      {!stock.isLoading && asList(stock.data?.data).length === 0 ? (
        <EmptyState title="No stock in this view." body="Add stock from a purchase, an opening count, or Camera add.">
          {can(role, "inventory.manage") ? (
            <Link to="/stock/add" className="font-semibold text-accent">
              Add stock
            </Link>
          ) : null}
        </EmptyState>
      ) : null}
      <div className="flex flex-col gap-2">
        {asList(stock.data?.data).map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          const product = asRecord(row.product);
          const name = asText(row.name) || asText(product?.name);
          const quantity = asText(row.quantity) || asText(row.currentStockQuantity);
          const minimum = asText(row.minimumStockLevel);
          return (
            <article key={asText(row.productId) || asText(product?.id) || name} className="rounded-2xl bg-card p-4">
              <h2 className="text-lg font-semibold">{name}</h2>
              <p>
                Stock: {formatQty(quantity)}
                {minimum ? ` · Min: ${formatQty(minimum)}` : ""}
              </p>
              {row.lowStock === true ? <p className="font-semibold text-warn">Low stock</p> : null}
              {row.outOfStock === true ? <p className="font-semibold text-bad">Out of stock</p> : null}
              {"stockValue" in row ? (
                <p className="text-sm text-muted">
                  Stock value <Money value={asText(row.stockValue)} />
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
    </Page>
  );
}

export function AddStockPage() {
  return (
    <Allow action="inventory.manage">
      <AddStockForm />
    </Allow>
  );
}

function AddStockForm() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"opening" | "adjustment">("opening");
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search);
  const products = useQuery({
    queryKey: ["stock-products", debounced],
    enabled: debounced.trim().length > 0,
    queryFn: () => shopApi.products(debounced.trim(), 1),
  });
  const [productId, setProductId] = useState("");
  const [productName, setProductName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [cost, setCost] = useState("");
  const [type, setType] = useState<"IN" | "OUT" | "DAMAGE" | "EXPIRY">("IN");
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const qty = stockInput(quantity);
    const unitCost = moneyInput(cost);
    if (!productId || !qty) {
      setError("Choose a product and a quantity.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === "opening") {
        if (!unitCost) {
          setError("Enter the purchase price for this stock.");
          setBusy(false);
          return;
        }
        await shopApi.openingStock({ productId, quantity: qty, unitCost }, crypto.randomUUID());
      } else {
        await shopApi.adjustStock(
          {
            productId,
            quantity: qty,
            type,
            ...(type === "IN" && unitCost ? { unitCost } : {}),
            ...(note.trim() ? { reason: note.trim() } : {}),
          },
          crypto.randomUUID(),
        );
      }
      useToast.getState().show("Stock added");
      void queryClient.invalidateQueries({ queryKey: ["stock"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      setQuantity("");
      setConfirm(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong.");
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Add stock">
      <div className="grid gap-2 sm:grid-cols-3">
        <Link to="/purchases/new" className="rounded-2xl bg-accent px-4 py-4 text-center font-semibold text-accent-ink">
          Purchase stock
        </Link>
        <button type="button" className={`rounded-2xl px-4 py-4 font-semibold ${mode === "opening" ? "bg-ink text-paper" : "bg-card"}`} onClick={() => setMode("opening")}>
          Opening stock
        </button>
        <button type="button" className={`rounded-2xl px-4 py-4 font-semibold ${mode === "adjustment" ? "bg-ink text-paper" : "bg-card"}`} onClick={() => setMode("adjustment")}>
          Adjustment
        </button>
      </div>
      <Field label="Product" required>
        <input className={controlClass} placeholder="Search products..." value={search} onChange={(event) => setSearch(event.target.value)} />
      </Field>
      {productName ? <p className="font-semibold">{productName}</p> : null}
      <div className="flex flex-col gap-1">
        {asList(products.data?.data).map((item) => {
          const row = asRecord(item);
          return (
            <button
              key={asText(row?.id)}
              type="button"
              className="min-h-12 rounded-xl bg-card px-3 text-left font-semibold"
              onClick={() => {
                setProductId(asText(row?.id));
                setProductName(asText(row?.name));
                setSearch("");
              }}
            >
              {asText(row?.name)}
            </button>
          );
        })}
      </div>
      <Field label="Quantity" required>
        <input className={controlClass} inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
      </Field>
      {mode === "opening" || type === "IN" ? (
        <Field label="Purchase price" required={mode === "opening" || type === "IN"}>
          <input className={controlClass} inputMode="decimal" value={cost} onChange={(event) => setCost(event.target.value)} />
        </Field>
      ) : null}
      {mode === "adjustment" ? (
        <>
          <Field label="Type">
            <select className={controlClass} value={type} onChange={(event) => setType(event.target.value as typeof type)}>
              <option value="IN">Add</option>
              <option value="OUT">Remove</option>
              <option value="DAMAGE">Damage</option>
              <option value="EXPIRY">Expiry</option>
            </select>
          </Field>
          <Field label="Note">
            <input className={controlClass} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </>
      ) : null}
      {error ? <p className="whitespace-pre-line text-bad">{error}</p> : null}
      {mode === "adjustment" ? (
        <Button onClick={() => setConfirm(true)}>Review adjustment</Button>
      ) : (
        <Button disabled={busy} onClick={() => void save()}>
          {busy ? "Saving..." : "Save opening stock"}
        </Button>
      )}
      {confirm ? (
        <ConfirmDialog
          title="Adjust stock?"
          body={`${productName}: ${type} ${quantity}. This changes the count in the shop.`}
          confirm="Save adjustment"
          busy={busy}
          onClose={() => setConfirm(false)}
          onConfirm={() => void save()}
        />
      ) : null}
    </Page>
  );
}
