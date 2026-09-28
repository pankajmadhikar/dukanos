import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Allow } from "../components/shell";
import { Button, ConfirmDialog, EmptyState, ErrorState, Field, Loading, Money, Notice, Page, controlClass } from "../components/ui";
import { useDebounced } from "../hooks/use-debounced";
import { ApiError } from "../lib/api/client";
import { shopApi } from "../lib/api/shop";
import { formatBusinessDate, formatQty, moneyInput, stockInput } from "../lib/format";
import { asList, asRecord, asText } from "../lib/json";
import { can } from "../lib/permissions";
import { useSession } from "../stores/session";
import { useToast } from "../stores/toast";

export function PurchasesPage() {
  return (
    <Allow action="supplier.view">
      <PurchaseList />
    </Allow>
  );
}

function PurchaseList() {
  const purchases = useQuery({ queryKey: ["purchases"], queryFn: () => shopApi.purchases(1) });
  return (
    <Page
      title="Purchases"
      action={
        <Link to="/purchases/new" className="inline-flex min-h-12 items-center rounded-xl bg-accent px-4 font-semibold text-accent-ink">
          + Purchase
        </Link>
      }
    >
      {purchases.isLoading ? <Loading label="Loading purchases..." /> : null}
      {purchases.isError ? <ErrorState error={purchases.error} onRetry={() => void purchases.refetch()} /> : null}
      {!purchases.isLoading && asList(purchases.data?.data).length === 0 ? (
        <EmptyState title="No purchases yet." body="Record stock you bought from a supplier." />
      ) : null}
      {asList(purchases.data?.data).map((item) => {
        const row = asRecord(item);
        if (!row) return null;
        return (
          <Link key={asText(row.id)} to={`/purchases/${asText(row.id)}`} className="rounded-2xl bg-card p-4">
            <span className="block font-semibold">{asText(row.purchaseNumber)}</span>
            <span className="text-muted">
              {asText(asRecord(row.supplier)?.name)} · {formatBusinessDate(asText(row.businessDate))}
            </span>
            {"total" in row ? (
              <span className="mt-1 block">
                <Money value={asText(row.total)} />
              </span>
            ) : null}
          </Link>
        );
      })}
    </Page>
  );
}

interface DraftLine {
  productId: string;
  name: string;
  quantity: string;
  unitCost: string;
}

export function NewPurchasePage() {
  return (
    <Allow action="supplier.view">
      <NewPurchase />
    </Allow>
  );
}

function NewPurchase() {
  const queryClient = useQueryClient();
  const [supplierSearch, setSupplierSearch] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const supplierText = useDebounced(supplierSearch);
  const productText = useDebounced(productSearch);
  const suppliers = useQuery({
    queryKey: ["purchase-suppliers", supplierText],
    enabled: supplierText.trim().length > 0,
    queryFn: () => shopApi.suppliers(supplierText.trim(), 1),
  });
  const products = useQuery({
    queryKey: ["purchase-products", productText],
    enabled: productText.trim().length > 0,
    queryFn: () => shopApi.products(productText.trim(), 1),
  });
  const [supplierId, setSupplierId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!supplierId || lines.length === 0) {
      setError("Choose a supplier and at least one product.");
      return;
    }
    const items = lines.map((line) => ({
      productId: line.productId,
      quantity: stockInput(line.quantity),
      unitCost: moneyInput(line.unitCost),
    }));
    if (items.some((item) => !item.quantity || !item.unitCost)) {
      setError("Enter quantity and purchase price for every product.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await shopApi.createPurchase(
        {
          supplierId,
          items: items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity as string,
            unitCost: item.unitCost as string,
          })),
        },
        crypto.randomUUID(),
      );
      useToast.getState().show("Purchase saved");
      void queryClient.invalidateQueries({ queryKey: ["purchases"] });
      void queryClient.invalidateQueries({ queryKey: ["stock"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      setLines([]);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="New purchase">
      <Field label="Supplier" required>
        <input className={controlClass} value={supplierSearch} placeholder={supplierName || "Search suppliers"} onChange={(event) => setSupplierSearch(event.target.value)} />
      </Field>
      {supplierName ? <p className="font-semibold">{supplierName}</p> : null}
      {asList(suppliers.data?.data).map((item) => {
        const row = asRecord(item);
        return (
          <button
            key={asText(row?.id)}
            type="button"
            className="min-h-12 rounded-xl bg-card px-3 text-left font-semibold"
            onClick={() => {
              setSupplierId(asText(row?.id));
              setSupplierName(asText(row?.name));
              setSupplierSearch("");
            }}
          >
            {asText(row?.name)}
          </button>
        );
      })}
      <Field label="Products">
        <input className={controlClass} placeholder="Search products..." value={productSearch} onChange={(event) => setProductSearch(event.target.value)} />
      </Field>
      {asList(products.data?.data).map((item) => {
        const row = asRecord(item);
        const id = asText(row?.id);
        return (
          <button
            key={id}
            type="button"
            className="min-h-12 rounded-xl bg-card px-3 text-left font-semibold"
            onClick={() => {
              if (!lines.some((line) => line.productId === id)) {
                setLines([...lines, { productId: id, name: asText(row?.name), quantity: "1", unitCost: "" }]);
              }
              setProductSearch("");
            }}
          >
            {asText(row?.name)}
          </button>
        );
      })}
      {lines.map((line) => (
        <div key={line.productId} className="grid gap-2 rounded-2xl bg-card p-3">
          <p className="font-semibold">{line.name}</p>
          <Field label="Quantity">
            <input
              className={controlClass}
              inputMode="decimal"
              value={line.quantity}
              onChange={(event) =>
                setLines(lines.map((item) => (item.productId === line.productId ? { ...item, quantity: event.target.value } : item)))
              }
            />
          </Field>
          <Field label="Purchase price">
            <input
              className={controlClass}
              inputMode="decimal"
              value={line.unitCost}
              onChange={(event) =>
                setLines(lines.map((item) => (item.productId === line.productId ? { ...item, unitCost: event.target.value } : item)))
              }
            />
          </Field>
        </div>
      ))}
      {error ? <Notice>{error}</Notice> : null}
      <Button disabled={busy} onClick={() => void save()}>
        {busy ? "Saving..." : "Confirm purchase"}
      </Button>
    </Page>
  );
}

export function PurchaseDetailPage() {
  const { purchaseId = "" } = useParams();
  const role = useSession((state) => state.shop?.role);
  const queryClient = useQueryClient();
  const purchase = useQuery({ queryKey: ["purchase", purchaseId], queryFn: () => shopApi.purchase(purchaseId) });
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const row = asRecord(purchase.data?.data);
  if (purchase.isLoading) return <Loading label="Loading purchase..." />;
  if (purchase.isError) return <ErrorState error={purchase.error} onRetry={() => void purchase.refetch()} />;
  return (
    <Allow action="supplier.view">
      <Page title={asText(row?.purchaseNumber) || "Purchase"}>
        <p>
          {asText(asRecord(row?.supplier)?.name)} · {formatBusinessDate(asText(row?.businessDate))}
        </p>
        {"total" in (row ?? {}) ? (
          <p className="text-2xl font-semibold">
            <Money value={asText(row?.total)} />
          </p>
        ) : null}
        {asList(row?.items).map((item) => {
          const line = asRecord(item);
          if (!line) return null;
          const id = asText(line.id);
          return (
            <article key={id} className="rounded-2xl bg-card p-3">
              <p className="font-semibold">{asText(asRecord(line.product)?.name)}</p>
              <p>
                Quantity {formatQty(asText(line.quantity))} · Already returned {formatQty(asText(line.returnedQuantity))} · Available{" "}
                {formatQty(asText(line.remainingQuantity))}
              </p>
              {"unitCost" in line ? (
                <p>
                  Purchase price <Money value={asText(line.unitCost)} /> · <Money value={asText(line.lineTotal)} />
                </p>
              ) : null}
              {can(role, "sales.return") ? (
                <Field label="Return quantity">
                  <input
                    className={controlClass}
                    inputMode="decimal"
                    value={quantities[id] ?? ""}
                    onChange={(event) => setQuantities({ ...quantities, [id]: event.target.value })}
                  />
                </Field>
              ) : null}
            </article>
          );
        })}
        {error ? <Notice>{error}</Notice> : null}
        {can(role, "sales.return") ? <Button onClick={() => setConfirm(true)}>Return items</Button> : null}
        {confirm ? (
          <ConfirmDialog
            title="Return these items?"
            body="Stock will go down and the supplier balance will follow the saved purchase."
            confirm="Confirm return"
            onClose={() => setConfirm(false)}
            onConfirm={() => {
              const items = Object.entries(quantities)
                .map(([purchaseItemId, quantity]) => ({ purchaseItemId, quantity: stockInput(quantity) }))
                .filter((item) => item.quantity && item.quantity !== "0.000");
              void shopApi
                .createPurchaseReturn({ purchaseId, items }, crypto.randomUUID())
                .then(() => {
                  useToast.getState().show("Purchase return saved");
                  setConfirm(false);
                  void queryClient.invalidateQueries({ queryKey: ["purchase", purchaseId] });
                  void queryClient.invalidateQueries({ queryKey: ["stock"] });
                })
                .catch((caught: unknown) => {
                  setConfirm(false);
                  setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong.");
                });
            }}
          />
        ) : null}
      </Page>
    </Allow>
  );
}
