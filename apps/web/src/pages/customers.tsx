import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Button, EmptyState, ErrorState, Field, Loading, Money, Notice, Page, controlClass } from "../components/ui";
import { useDebounced } from "../hooks/use-debounced";
import { ApiError } from "../lib/api/client";
import { shopApi } from "../lib/api/shop";
import { formatBusinessDate, moneyInput, toPaise } from "../lib/format";
import { asList, asRecord, asText } from "../lib/json";
import { usePosOnline } from "../offline/connectivity";
import { useToast } from "../stores/toast";

export function CustomersPage() {
  const [params] = useSearchParams();
  const online = usePosOnline();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(params.get("new") === "1");
  const [offlineNotice, setOfflineNotice] = useState(false);
  const debounced = useDebounced(search);
  const customers = useQuery({
    queryKey: ["customers", debounced],
    queryFn: () => shopApi.customers(debounced, 1),
  });
  return (
    <Page
      title="Customers"
      action={
        <Button
          onClick={() => {
            if (!online) {
              setOfflineNotice(true);
              return;
            }
            setOfflineNotice(false);
            setOpen(true);
          }}
        >
          + Add customer
        </Button>
      }
    >
      <input
        className={controlClass}
        placeholder="Search name or phone"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {offlineNotice || (open && !online) ? <p>Connect to the internet to create/select this customer.</p> : null}
      {open && online ? <CustomerForm onDone={() => setOpen(false)} /> : null}
      {customers.isLoading ? <Loading label="Loading customers..." /> : null}
      {customers.isError ? <ErrorState error={customers.error} onRetry={() => void customers.refetch()} /> : null}
      {!customers.isLoading && asList(customers.data?.data).length === 0 ? (
        <EmptyState title="No customers yet." body="Add a customer when a sale is on credit." />
      ) : null}
      <div className="flex flex-col gap-2">
        {asList(customers.data?.data).map((item) => {
          const row = asRecord(item);
          if (!row) return null;
          return (
            <Link key={asText(row.id)} to={`/customers/${asText(row.id)}`} className="rounded-2xl bg-card p-4">
              <span className="block text-lg font-semibold">{asText(row.name)}</span>
              <span className="text-muted">{asText(row.phone) || "No phone"}</span>
              <span className="mt-1 block">
                Outstanding <Money value={asText(row.receivableBalance)} />
              </span>
            </Link>
          );
        })}
      </div>
    </Page>
  );
}

function CustomerForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="grid gap-3 rounded-2xl bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void shopApi
          .createCustomer({ name: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}) })
          .then(() => {
            useToast.getState().show("Customer added");
            void queryClient.invalidateQueries({ queryKey: ["customers"] });
            onDone();
          })
          .catch((caught: unknown) => setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong."))
          .finally(() => setBusy(false));
      }}
    >
      <Field label="Name" required>
        <input className={controlClass} value={name} onChange={(event) => setName(event.target.value)} required />
      </Field>
      <Field label="Phone">
        <input className={controlClass} inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />
      </Field>
      {error ? <Notice>{error}</Notice> : null}
      <Button type="submit" disabled={busy || name.trim().length === 0}>
        Save customer
      </Button>
    </form>
  );
}

export function CustomerDetailPage() {
  const { customerId = "" } = useParams();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"sales" | "payments" | "ledger">("sales");
  const customer = useQuery({ queryKey: ["customer", customerId], queryFn: () => shopApi.customer(customerId) });
  const summary = useQuery({ queryKey: ["customer-summary", customerId], queryFn: () => shopApi.customerSummary(customerId) });
  const sales = useQuery({ queryKey: ["customer-sales", customerId], queryFn: () => shopApi.customerSales(customerId) });
  const payments = useQuery({ queryKey: ["customer-payments", customerId], queryFn: () => shopApi.customerPayments(customerId) });
  const ledger = useQuery({ queryKey: ["customer-ledger", customerId], queryFn: () => shopApi.customerLedger(customerId) });
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"CASH" | "UPI">("CASH");
  const [error, setError] = useState<string | null>(null);
  const online = usePosOnline();
  const person = asRecord(customer.data?.data);
  const figures = asRecord(summary.data?.data);
  const outstanding = asText(person?.receivableBalance);

  async function receive() {
    const money = moneyInput(amount);
    const due = toPaise(outstanding);
    const paying = money ? toPaise(money) : null;
    if (!money || paying === null) {
      setError("Enter the amount received.");
      return;
    }
    if (due !== null && paying > due) {
      setError("Amount is more than the outstanding.");
      return;
    }
    setError(null);
    try {
      await shopApi.receivePayment(customerId, { amount: money, method }, crypto.randomUUID());
      useToast.getState().show("Payment received");
      setAmount("");
      void queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      void queryClient.invalidateQueries({ queryKey: ["customer-summary", customerId] });
      void queryClient.invalidateQueries({ queryKey: ["customer-payments", customerId] });
      void queryClient.invalidateQueries({ queryKey: ["customer-ledger", customerId] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong.");
    }
  }

  if (customer.isLoading) return <Loading label="Loading customer..." />;
  if (customer.isError) return <ErrorState error={customer.error} onRetry={() => void customer.refetch()} />;

  const active = tab === "sales" ? sales : tab === "payments" ? payments : ledger;

  return (
    <Page title={asText(person?.name) || "Customer"}>
      <p className="text-muted">{asText(person?.phone)}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <article className="rounded-2xl bg-card p-4">
          <p className="text-sm text-muted">Outstanding</p>
          <p className="text-2xl font-semibold">
            <Money value={asText(figures?.outstanding) || outstanding} />
          </p>
        </article>
        <article className="rounded-2xl bg-card p-4">
          <p className="text-sm text-muted">Sales</p>
          <p className="text-2xl font-semibold">
            <Money value={asText(figures?.totalSales)} />
          </p>
        </article>
        <article className="rounded-2xl bg-card p-4">
          <p className="text-sm text-muted">Last purchase</p>
          <p className="text-2xl font-semibold">{formatBusinessDate(asText(figures?.lastSaleDate)) || "—"}</p>
        </article>
      </div>
      <h2 className="text-lg font-semibold">Receive payment</h2>
      {!online ? <p>Receiving a payment requires an internet connection.</p> : null}
      {online ? <>
      <Field label="Amount">
        <input className={controlClass} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button tone={method === "CASH" ? "accent" : "quiet"} onClick={() => setMethod("CASH")}>
          Cash
        </Button>
        <Button tone={method === "UPI" ? "accent" : "quiet"} onClick={() => setMethod("UPI")}>
          UPI
        </Button>
      </div>
      {method === "UPI" ? <p className="text-sm text-muted">Confirm the UPI on your phone, then save.</p> : null}
      {error ? <Notice>{error}</Notice> : null}
      <Button onClick={() => void receive()}>Receive payment</Button>
      </> : null}
      <div className="flex gap-2">
        {(["sales", "payments", "ledger"] as const).map((item) => (
          <button key={item} type="button" className={`min-h-12 rounded-xl px-3 font-semibold capitalize ${tab === item ? "bg-ink text-paper" : "bg-card"}`} onClick={() => setTab(item)}>
            {item === "sales" ? "Sales history" : item === "payments" ? "Payment history" : "Ledger"}
          </button>
        ))}
      </div>
      {active.isLoading ? <Loading label="Loading..." /> : null}
      {active.isError ? <ErrorState error={active.error} onRetry={() => void active.refetch()} /> : null}
      <div className="flex flex-col gap-2">
        {asList(active.data?.data).map((item, index) => {
          const row = asRecord(item);
          if (!row) return null;
          if (tab === "ledger") {
            return (
              <p key={index} className="rounded-xl bg-card p-3">
                {formatBusinessDate(asText(row.date))} · {asText(row.type)} · Debit <Money value={asText(row.debit)} /> · Credit{" "}
                <Money value={asText(row.credit)} />
              </p>
            );
          }
          return (
            <p key={asText(row.id) || String(index)} className="rounded-xl bg-card p-3">
              {asText(row.saleNumber) || asText(row.method)} · {formatBusinessDate(asText(row.businessDate))} ·{" "}
              <Money value={asText(row.total) || asText(row.amount)} />
            </p>
          );
        })}
      </div>
    </Page>
  );
}
