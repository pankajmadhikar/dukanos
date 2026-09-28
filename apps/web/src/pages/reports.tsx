import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ErrorState, Loading, Money, Page } from "../components/ui";
import { shopApi } from "../lib/api/shop";
import { formatBusinessDate, formatInstant } from "../lib/format";
import { loadSnapshot, saveSnapshot } from "../offline/catalog";
import { usePosOnline } from "../offline/connectivity";
import { asList, asRecord, asText, type Json } from "../lib/json";
import { can } from "../lib/permissions";
import { useSession } from "../stores/session";

const periods = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
  { id: "custom", label: "Custom" },
];

export function ReportsPage() {
  const role = useSession((state) => state.shop?.role);
  const shopId = useSession((state) => state.shop?.id) ?? "";
  const online = usePosOnline();
  const [section, setSection] = useState("sales");
  const [period, setPeriod] = useState("today");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const customReady = period !== "custom" || (from.length === 10 && to.length === 10);
  const sales = useQuery({
    queryKey: ["reports", "sales", period, from, to],
    enabled: section === "sales" && customReady,
    networkMode: "always",
    queryFn: async () => {
      try {
        const body = await shopApi.reportSales(period, period === "custom" ? from : undefined, period === "custom" ? to : undefined);
        if (shopId) await saveSnapshot(shopId, "report-sales", body).catch(() => undefined);
        return body;
      } catch (error) {
        if (shopId) {
          const cached = await loadSnapshot(shopId, "report-sales").catch(() => null);
          if (cached && asRecord(cached.value)) {
            return { ...asRecord(cached.value), offlineSavedAt: cached.savedAt } as Record<string, Json>;
          }
        }
        throw error;
      }
    },
  });
  const products = useQuery({
    queryKey: ["reports", "products", period, from, to],
    enabled: section === "products" && customReady,
    queryFn: () => shopApi.reportTopProducts(period, period === "custom" ? from : undefined, period === "custom" ? to : undefined),
  });
  const customers = useQuery({
    queryKey: ["reports", "customers", period],
    enabled: section === "customers",
    queryFn: () => shopApi.reportCustomers(period),
  });
  const outstanding = useQuery({
    queryKey: ["reports", "customers", "due"],
    enabled: section === "customers",
    queryFn: () => shopApi.reportOutstandingCustomers(),
  });
  const suppliers = useQuery({
    queryKey: ["reports", "suppliers", period],
    enabled: section === "suppliers" && can(role, "supplier.view"),
    queryFn: () => shopApi.reportSuppliers(period),
  });
  const expenses = useQuery({
    queryKey: ["reports", "expenses", period, from, to],
    enabled: section === "expenses" && can(role, "expenses.view") && customReady,
    queryFn: () => shopApi.reportExpenses(period, period === "custom" ? from : undefined, period === "custom" ? to : undefined),
  });
  const stock = useQuery({
    queryKey: ["reports", "stock"],
    enabled: section === "stock",
    queryFn: () => shopApi.reportStock(),
  });
  const slow = useQuery({
    queryKey: ["reports", "slow"],
    enabled: section === "products",
    queryFn: () => shopApi.reportInactive(),
  });
  const low = useQuery({
    queryKey: ["reports", "low"],
    enabled: section === "products",
    queryFn: () => shopApi.reportLow(),
  });
  const out = useQuery({
    queryKey: ["reports", "out"],
    enabled: section === "products",
    queryFn: () => shopApi.reportOut(),
  });

  const sections = [
    "sales",
    "products",
    "customers",
    ...(can(role, "supplier.view") ? ["suppliers"] : []),
    ...(can(role, "expenses.view") ? ["expenses"] : []),
    "stock",
  ];

  return (
    <Page title="Reports">
      {!online ? (
        <p className="text-sm text-muted">
          {asText(asRecord(sales.data)?.offlineSavedAt)
            ? `Last updated ${formatInstant(asText(asRecord(sales.data)?.offlineSavedAt))}. `
            : sales.dataUpdatedAt > 0
              ? `Last updated ${formatInstant(new Date(sales.dataUpdatedAt).toISOString())}. `
              : ""}
          These figures are not current.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {sections.map((item) => (
          <button key={item} type="button" className={`min-h-12 rounded-full px-4 font-semibold capitalize ${section === item ? "bg-accent text-accent-ink" : "bg-card"}`} onClick={() => setSection(item)}>
            {item}
          </button>
        ))}
      </div>
      {section !== "stock" ? (
        <div className="flex flex-wrap gap-2">
          {periods.map((item) => (
            <button key={item.id} type="button" className={`min-h-12 rounded-full px-4 ${period === item.id ? "bg-ink text-paper" : "bg-card"}`} onClick={() => setPeriod(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      {period === "custom" ? (
        <div className="flex gap-2">
          <input className="min-h-12 rounded-xl border border-line px-3" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          <input className="min-h-12 rounded-xl border border-line px-3" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </div>
      ) : null}
      {section === "sales" ? <SalesReport query={sales} /> : null}
      {section === "products" ? (
        <div className="flex flex-col gap-3">
          <Ranked query={products} title="Top products" moneyKey="salesRevenue" />
          <NameList query={low} title="Low stock" />
          <NameList query={out} title="Out of stock" />
          <NameList query={slow} title="Slow stock" />
        </div>
      ) : null}
      {section === "customers" ? (
        <div className="flex flex-col gap-3">
          <Ranked query={customers} title="Customers" moneyKey="netSales" />
          <Ranked query={outstanding} title="Outstanding customers" moneyKey="outstanding" />
        </div>
      ) : null}
      {section === "suppliers" ? <Ranked query={suppliers} title="Suppliers" moneyKey="outstanding" /> : null}
      {section === "expenses" ? <ExpenseReport query={expenses} /> : null}
      {section === "stock" ? <StockReport query={stock} /> : null}
    </Page>
  );
}

function SalesReport({ query }: { query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof shopApi.reportSales>>>> }) {
  if (query.isLoading) return <Loading label="Loading sales..." />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const row = asRecord(query.data?.data);
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Figure label="Sales" value={asText(row?.grossSales)} />
      <Figure label="Returns" value={asText(row?.salesReturns)} />
      <Figure label="Net sales" value={asText(row?.netSales)} />
      <p className="text-sm text-muted sm:col-span-3">
        {formatBusinessDate(asText(row?.from))} – {formatBusinessDate(asText(row?.to))}
      </p>
    </div>
  );
}

function ExpenseReport({ query }: { query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof shopApi.reportExpenses>>>> }) {
  if (query.isLoading) return <Loading label="Loading expenses..." />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const row = asRecord(query.data?.data);
  return <Figure label="Expenses" value={asText(row?.totalExpenses)} />;
}

function StockReport({ query }: { query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof shopApi.reportStock>>>> }) {
  if (query.isLoading) return <Loading label="Loading stock..." />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const row = asRecord(query.data?.data);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <article className="rounded-2xl bg-card p-4">
        <p className="text-muted">Total stock items</p>
        <p className="text-3xl font-semibold">{String(row?.totalProducts ?? 0)}</p>
      </article>
      <article className="rounded-2xl bg-card p-4">
        <p className="text-muted">Low stock</p>
        <p className="text-3xl font-semibold">{String(row?.lowStockProducts ?? 0)}</p>
      </article>
      <article className="rounded-2xl bg-card p-4">
        <p className="text-muted">Out of stock</p>
        <p className="text-3xl font-semibold">{String(row?.outOfStockProducts ?? 0)}</p>
      </article>
      {row && "totalStockValue" in row ? <Figure label="Stock value" value={asText(row.totalStockValue)} /> : null}
    </div>
  );
}

function Ranked({
  query,
  title,
  moneyKey,
}: {
  query: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => void; data?: { data?: unknown } };
  title: string;
  moneyKey: string;
}) {
  if (query.isLoading) return <Loading label={`Loading ${title.toLowerCase()}...`} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const payload = query.data?.data;
  const rows = Array.isArray(payload) ? payload : asList(asRecord(payload as Json | null)?.customers);
  return (
    <section>
      <h2 className="text-lg font-semibold">{title}</h2>
      {rows.map((item, index) => {
        const row = asRecord(item as Json);
        const name =
          asText(row?.name) || asText(asRecord(row?.customer)?.name) || asText(asRecord(row?.supplier)?.name);
        const amount =
          asText(row?.[moneyKey]) || asText(row?.outstandingBalance) || asText(row?.payableBalance) || asText(row?.netSales);
        return (
          <p key={asText(row?.productId) || asText(row?.id) || String(index)} className="mt-2 rounded-xl bg-card p-3">
            {index + 1}. {name} · <Money value={amount} />
          </p>
        );
      })}
    </section>
  );
}

function NameList({
  query,
  title,
}: {
  query: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => void; data?: { data?: unknown } };
  title: string;
}) {
  if (query.isLoading) return <Loading label={`Loading ${title.toLowerCase()}...`} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  return (
    <section>
      <h2 className="text-lg font-semibold">{title}</h2>
      {asList(query.data?.data as Json | undefined).map((item) => {
        const row = asRecord(item);
        return (
          <p key={asText(row?.productId)} className="mt-2">
            {asText(row?.name)}
          </p>
        );
      })}
    </section>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <article className="rounded-2xl bg-card p-4">
      <p className="text-muted">{label}</p>
      <p className="text-3xl font-semibold">
        <Money value={value} />
      </p>
    </article>
  );
}
