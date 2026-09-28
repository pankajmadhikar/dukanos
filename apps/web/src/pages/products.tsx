import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Allow } from "../components/shell";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Gate,
  Money,
  Page,
  Pager,
  controlClass,
  paginationOf,
} from "../components/ui";
import { useDebounced } from "../hooks/use-debounced";
import { shopApi } from "../lib/api/shop";
import { formatBusinessDate, formatQty, moneyInput, stockInput } from "../lib/format";
import { asList, asRecord, asText } from "../lib/json";
import { can } from "../lib/permissions";
import { useSession } from "../stores/session";
import { useToast } from "../stores/toast";

export function ProductsPage() {
  const role = useSession((state) => state.shop?.role);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search);
  const products = useQuery({
    queryKey: ["products", debounced, page],
    queryFn: () => shopApi.products(debounced, page),
  });
  const pager = paginationOf(products.data);
  return (
    <Page
      title="Products"
      action={
        can(role, "catalog.manage") ? (
          <div className="flex gap-2">
            <Link to="/products/new" className="inline-flex min-h-12 items-center rounded-xl bg-accent px-4 font-semibold text-accent-ink">
              + Add product
            </Link>
            <Link to="/ai" className="inline-flex min-h-12 items-center rounded-xl border border-line bg-card px-4 font-semibold">
              + Camera add
            </Link>
          </div>
        ) : null
      }
    >
      <input
        className={controlClass}
        placeholder="Search products..."
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setPage(1);
        }}
      />
      <Gate
        query={products}
        loading="Loading products..."
        empty={
          <EmptyState title="No products yet." body="Add your first product or use Camera add.">
            {can(role, "catalog.manage") ? (
              <>
                <Link to="/products/new" className="inline-flex min-h-12 items-center rounded-xl bg-accent px-4 font-semibold text-accent-ink">
                  Add product
                </Link>
                <Link to="/ai" className="inline-flex min-h-12 items-center rounded-xl border border-line px-4 font-semibold">
                  Camera add
                </Link>
              </>
            ) : null}
          </EmptyState>
        }
      >
        {(data) => (
          <div className="flex flex-col gap-2">
            {asList(data).map((item) => {
              const row = asRecord(item);
              if (!row) return null;
              return (
                <Link key={asText(row.id)} to={`/products/${asText(row.id)}`} className="rounded-2xl bg-card p-4">
                  <span className="block text-lg font-semibold">{asText(row.name)}</span>
                  <span className="text-sm text-muted">
                    {asText(row.sku) || "No SKU"} · {asText(row.barcode) || "No barcode"}
                  </span>
                  <span className="mt-1 block">
                    <Money value={asText(row.sellingPrice)} />
                    {asText(row.isActive) === "false" ? " · Inactive" : ""}
                  </span>
                </Link>
              );
            })}
            <Pager page={pager.page} total={pager.total} limit={pager.limit} onPage={setPage} />
          </div>
        )}
      </Gate>
    </Page>
  );
}

export function ProductFormPage() {
  return (
    <Allow action="catalog.manage">
      <ProductForm />
    </Allow>
  );
}

function ProductForm() {
  const navigate = useNavigate();
  const role = useSession((state) => state.shop?.role);
  const client = useQueryClient();
  const units = useQuery({ queryKey: ["units"], queryFn: () => shopApi.units() });
  const unitRows = asList(units.data?.data);
  const addUnit = useMutation({
    mutationFn: (preset: { name: string; shortCode: string; decimalPlaces: number }) => shopApi.createUnit(preset),
    onSuccess: async (body) => {
      await client.invalidateQueries({ queryKey: ["units"] });
      setUnitId(asText(asRecord(body.data)?.id));
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : "Something went wrong."),
  });
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => shopApi.categories() });
  const brands = useQuery({ queryKey: ["brands"], queryFn: () => shopApi.brands() });
  const [name, setName] = useState("");
  const [unitId, setUnitId] = useState("");
  const [selling, setSelling] = useState("");
  const [purchase, setPurchase] = useState("");
  const [sku, setSku] = useState("");
  const [barcode, setBarcode] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [minimum, setMinimum] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      shopApi.createProduct({
        name: name.trim(),
        unitId,
        ...(moneyInput(selling) ? { defaultSellingPrice: moneyInput(selling) } : {}),
        ...(can(role, "catalog.cost") && moneyInput(purchase) ? { defaultPurchasePrice: moneyInput(purchase) } : {}),
        ...(sku.trim() ? { sku: sku.trim() } : {}),
        ...(barcode.trim() ? { barcode: barcode.trim() } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(brandId ? { brandId } : {}),
        ...(stockInput(minimum) ? { minimumStockLevel: stockInput(minimum) } : {}),
      }),
    onSuccess: (body) => {
      useToast.getState().show("Product added");
      navigate(`/products/${asText(asRecord(body.data)?.id)}`);
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : "Something went wrong."),
  });

  return (
    <Page title="Add product">
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <Field label="Product name" required>
          <input className={controlClass} value={name} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <Field label="Unit" required>
          {unitRows.length === 0 ? (
            <div className="flex flex-wrap gap-2">
              {[
                { name: "Piece", shortCode: "pc", decimalPlaces: 0 },
                { name: "Kg", shortCode: "kg", decimalPlaces: 3 },
                { name: "Packet", shortCode: "pkt", decimalPlaces: 0 },
              ].map((preset) => (
                <Button
                  key={preset.shortCode}
                  type="button"
                  disabled={addUnit.isPending}
                  onClick={() => addUnit.mutate(preset)}
                >
                  {preset.name}
                </Button>
              ))}
            </div>
          ) : (
            <select className={controlClass} value={unitId} onChange={(event) => setUnitId(event.target.value)} required>
              <option value="">Choose unit</option>
              {unitRows.map((unit) => {
                const row = asRecord(unit);
                return (
                  <option key={asText(row?.id)} value={asText(row?.id)}>
                    {asText(row?.name)}
                  </option>
                );
              })}
            </select>
          )}
        </Field>
        <Field label="Selling price">
          <input className={controlClass} inputMode="decimal" value={selling} onChange={(event) => setSelling(event.target.value)} />
        </Field>
        {can(role, "catalog.cost") ? (
          <Field label="Purchase price">
            <input className={controlClass} inputMode="decimal" value={purchase} onChange={(event) => setPurchase(event.target.value)} />
          </Field>
        ) : null}
        <Field label="SKU">
          <input className={controlClass} value={sku} onChange={(event) => setSku(event.target.value)} />
        </Field>
        <Field label="Barcode">
          <input className={controlClass} inputMode="numeric" value={barcode} onChange={(event) => setBarcode(event.target.value)} />
        </Field>
        <Field label="Category">
          <select className={controlClass} value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            <option value="">None</option>
            {asList(categories.data?.data).map((item) => {
              const row = asRecord(item);
              return (
                <option key={asText(row?.id)} value={asText(row?.id)}>
                  {asText(row?.name)}
                </option>
              );
            })}
          </select>
        </Field>
        <Field label="Brand">
          <select className={controlClass} value={brandId} onChange={(event) => setBrandId(event.target.value)}>
            <option value="">None</option>
            {asList(brands.data?.data).map((item) => {
              const row = asRecord(item);
              return (
                <option key={asText(row?.id)} value={asText(row?.id)}>
                  {asText(row?.name)}
                </option>
              );
            })}
          </select>
        </Field>
        <Field label="Minimum stock">
          <input className={controlClass} inputMode="decimal" value={minimum} onChange={(event) => setMinimum(event.target.value)} />
        </Field>
        {error ? <p className="text-bad">{error}</p> : null}
        <Button type="submit" disabled={save.isPending || name.trim().length === 0 || unitId.length === 0}>
          {save.isPending ? "Saving..." : "Save product"}
        </Button>
        <Link to="/masters" className="font-semibold text-accent">
          Categories and brands
        </Link>
      </form>
    </Page>
  );
}

export function ProductDetailPage() {
  const { productId = "" } = useParams();
  const role = useSession((state) => state.shop?.role);
  const queryClient = useQueryClient();
  const product = useQuery({ queryKey: ["product", productId], queryFn: () => shopApi.product(productId) });
  const history = useQuery({ queryKey: ["price-history", productId], queryFn: () => shopApi.priceHistory(productId) });
  const [confirm, setConfirm] = useState(false);
  const row = asRecord(product.data?.data);
  const active = row?.isActive !== false;

  return (
    <Page title={asText(row?.name) || "Product"}>
      <Gate query={product} loading="Loading product...">
        {(data) => {
          const item = asRecord(data);
          return (
            <article className="grid gap-2 rounded-2xl bg-card p-4">
              <Line label="Selling price" value={<Money value={asText(item?.sellingPrice)} />} />
              <Line label="SKU" value={asText(item?.sku) || "—"} />
              <Line label="Barcode" value={asText(item?.barcode) || "—"} />
              <Line label="Brand" value={asText(asRecord(item?.brand)?.name) || "—"} />
              <Line label="Category" value={asText(asRecord(item?.category)?.name) || "—"} />
              <Line label="Minimum stock" value={formatQty(asText(item?.minimumStockLevel))} />
              {item && "purchasePrice" in item ? <Line label="Purchase price" value={<Money value={asText(item.purchasePrice)} />} /> : null}
              {item && "averageCost" in item ? <Line label="Average cost" value={<Money value={asText(item.averageCost)} />} /> : null}
              <p>{active ? "Active" : "Inactive"}</p>
            </article>
          );
        }}
      </Gate>
      <h2 className="text-lg font-semibold">Selling price</h2>
      <Gate query={history} loading="Loading price history...">
        {(data) => (
          <div className="flex flex-col gap-2">
            {asList(data)
              .filter((item) => asText(asRecord(item)?.priceType) === "SELLING" || can(role, "catalog.cost"))
              .map((item, index) => {
                const entry = asRecord(item);
                const kind = asText(entry?.priceType) === "SELLING" ? "Selling price" : "Purchase price";
                return (
                  <p key={`${asText(entry?.changedAt)}-${index}`}>
                    {kind} <Money value={asText(entry?.newPrice)} /> · {formatBusinessDate(asText(entry?.changedAt))}
                  </p>
                );
              })}
          </div>
        )}
      </Gate>
      {can(role, "catalog.manage") && active ? (
        <Button tone="danger" onClick={() => setConfirm(true)}>
          Deactivate product
        </Button>
      ) : null}
      {confirm ? (
        <ConfirmDialog
          title="Deactivate this product?"
          body="It will stay in old bills and can be turned back on."
          confirm="Deactivate"
          onClose={() => setConfirm(false)}
          onConfirm={() => {
            void shopApi.deactivateProduct(productId).then(() => {
              setConfirm(false);
              void queryClient.invalidateQueries({ queryKey: ["product", productId] });
              useToast.getState().show("Product deactivated");
            });
          }}
        />
      ) : null}
    </Page>
  );
}

function Line({ label, value }: { label: string; value: ReactNode }) {
  return (
    <p>
      <span className="text-muted">{label}</span>
      <span className="mt-0.5 block text-lg font-semibold">{value}</span>
    </p>
  );
}
