import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { ErrorState, Loading, Money } from "../components/ui";
import { formatBusinessDate, formatQty, percentLabel } from "../lib/format";
import { shopApi } from "../lib/api/shop";
import { asNumber, asRecord, asText, type Json } from "../lib/json";
import { can } from "../lib/permissions";
import { useSession } from "../stores/session";

export function DashboardPage() {
  const role = useSession((state) => state.shop?.role);
  const today = useQuery({ queryKey: ["dashboard", "today"], queryFn: () => shopApi.dashboardToday() });
  const comparison = useQuery({
    queryKey: ["dashboard", "comparison"],
    queryFn: () => shopApi.dashboardComparison(),
  });
  const low = useQuery({ queryKey: ["stock", "low", "count"], queryFn: () => shopApi.reportLow(1) });
  const out = useQuery({ queryKey: ["stock", "out", "count"], queryFn: () => shopApi.reportOut(1) });
  const slow = useQuery({ queryKey: ["stock", "slow", "count"], queryFn: () => shopApi.reportInactive(1) });

  if (today.isLoading) {
    return <Loading label="Loading dashboard..." />;
  }
  if (today.isError) {
    return <ErrorState error={today.error} onRetry={() => void today.refetch()} />;
  }

  const data = asRecord(today.data?.data);
  const sales = asRecord(data?.sales);
  const collections = asRecord(data?.collections);
  const outstanding = asRecord(data?.outstanding);
  const profit = asRecord(data?.profit);
  const change = asRecord(asRecord(asRecord(comparison.data?.data)?.changePercent)?.sales);
  const salesChange = percentLabel(asText(change?.netSales) || null);

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <header>
        <p className="text-sm text-muted">{formatBusinessDate(asText(data?.businessDate))}</p>
        <h1 className="text-2xl font-semibold">How is the shop doing today?</h1>
      </header>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Sales" value={asText(sales?.netSales)} change={salesChange} />
        <Count label="Transactions" value={asNumber(sales?.transactionCount)} />
        <Count label="Items sold" value={formatQty(asText(sales?.quantitySold))} />
        {profit ? <Metric label="Gross profit" value={asText(profit.grossProfit)} /> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Small label="Cash" value={asText(collections?.cash)} />
        <Small label="UPI" value={asText(collections?.upi)} />
        <Small label="Customer collections" value={asText(collections?.customerCollections)} />
        {profit ? <Small label="Expenses" value={asText(profit.expenses)} /> : null}
        {typeof data?.expenses === "string" ? <Small label="Expenses" value={data.expenses} /> : null}
        <Small label="Receivable" value={asText(outstanding?.customer)} />
        {typeof outstanding?.supplier === "string" ? <Small label="Payable" value={outstanding.supplier} /> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Alert to="/stock?filter=low" label="Low stock" value={totalOf(low.data)} />
        <Alert to="/stock?filter=out" label="Out of stock" value={totalOf(out.data)} />
        <Alert to="/stock?filter=slow" label="Slow stock" value={totalOf(slow.data)} />
        <Alert to="/customers" label="Customer outstanding" money={asText(outstanding?.customer)} />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Quick to="/sell" label="Sell" primary />
        {can(role, "catalog.manage") ? <Quick to="/products/new" label="Add product" /> : null}
        {can(role, "inventory.manage") ? <Quick to="/stock/add" label="Add stock" /> : null}
        <Quick to="/customers?new=1" label="Add customer" />
        {can(role, "expenses.manage") ? <Quick to="/expenses?new=1" label="Add expense" /> : null}
        {can(role, "ai.intake") ? <Quick to="/ai" label="Camera add" /> : null}
      </div>
    </section>
  );
}

function totalOf(body: Record<string, Json> | undefined): string {
  const page = asRecord(body?.pagination);
  return String(typeof page?.total === "number" ? page.total : 0);
}

function Metric({ label, value, change }: { label: string; value: string; change?: string | null }) {
  return (
    <article className="rounded-2xl bg-card p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="text-3xl font-semibold">
        <Money value={value} />
      </p>
      {change ? <p className="text-sm font-semibold text-good">{change} vs yesterday</p> : null}
    </article>
  );
}

function Count({ label, value }: { label: string; value: string | number | null }) {
  return (
    <article className="rounded-2xl bg-card p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="text-3xl font-semibold tabular-nums">{value ?? "0"}</p>
    </article>
  );
}

function Small({ label, value }: { label: string; value: string }) {
  return (
    <article className="rounded-2xl border border-line bg-card p-3">
      <p className="text-sm text-muted">{label}</p>
      <p className="text-xl font-semibold">
        <Money value={value} />
      </p>
    </article>
  );
}

function Alert({ to, label, value, money }: { to: string; label: string; value?: string; money?: string }) {
  return (
    <Link to={to} className="rounded-2xl border border-line bg-card p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="text-2xl font-semibold">{money ? <Money value={money} /> : value}</p>
    </Link>
  );
}

function Quick({ to, label, primary }: { to: string; label: string; primary?: boolean }) {
  return (
    <Link
      to={to}
      className={`flex min-h-14 items-center justify-center rounded-2xl px-3 text-center text-base font-semibold ${
        primary ? "bg-accent text-accent-ink" : "bg-card border border-line"
      }`}
    >
      {label}
    </Link>
  );
}
