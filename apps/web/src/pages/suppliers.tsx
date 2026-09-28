import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Allow } from "../components/shell";
import { Button, EmptyState, ErrorState, Field, Loading, Money, Notice, Page, controlClass } from "../components/ui";
import { useDebounced } from "../hooks/use-debounced";
import { ApiError } from "../lib/api/client";
import { shopApi } from "../lib/api/shop";
import { moneyInput, toPaise } from "../lib/format";
import { asList, asRecord, asText } from "../lib/json";
import { useToast } from "../stores/toast";

export function SuppliersPage() {
  return (
    <Allow action="supplier.view">
      <SupplierList />
    </Allow>
  );
}

function SupplierList() {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const debounced = useDebounced(search);
  const suppliers = useQuery({
    queryKey: ["suppliers", debounced],
    queryFn: () => shopApi.suppliers(debounced, 1),
  });
  return (
    <Page title="Suppliers" action={<Button onClick={() => setOpen(true)}>+ Add supplier</Button>}>
      <input className={controlClass} placeholder="Search suppliers" value={search} onChange={(event) => setSearch(event.target.value)} />
      {open ? <SupplierForm onDone={() => setOpen(false)} /> : null}
      {suppliers.isLoading ? <Loading label="Loading suppliers..." /> : null}
      {suppliers.isError ? <ErrorState error={suppliers.error} onRetry={() => void suppliers.refetch()} /> : null}
      {!suppliers.isLoading && asList(suppliers.data?.data).length === 0 ? (
        <EmptyState title="No suppliers yet." body="Add the distributor you buy from." />
      ) : null}
      {asList(suppliers.data?.data).map((item) => {
        const row = asRecord(item);
        if (!row) return null;
        return (
          <Link key={asText(row.id)} to={`/suppliers/${asText(row.id)}`} className="rounded-2xl bg-card p-4">
            <span className="block text-lg font-semibold">{asText(row.name)}</span>
            <span className="text-muted">{asText(row.phone) || "No phone"}</span>
            {"payableBalance" in row ? (
              <span className="mt-1 block">
                Outstanding <Money value={asText(row.payableBalance)} />
              </span>
            ) : null}
          </Link>
        );
      })}
    </Page>
  );
}

function SupplierForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="grid gap-3 rounded-2xl bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void shopApi
          .createSupplier({ name: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}) })
          .then(() => {
            useToast.getState().show("Supplier added");
            void queryClient.invalidateQueries({ queryKey: ["suppliers"] });
            onDone();
          })
          .catch((caught: unknown) => setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong."));
      }}
    >
      <Field label="Name" required>
        <input className={controlClass} value={name} required onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Phone">
        <input className={controlClass} inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />
      </Field>
      {error ? <Notice>{error}</Notice> : null}
      <Button type="submit">Save supplier</Button>
    </form>
  );
}

export function SupplierDetailPage() {
  const { supplierId = "" } = useParams();
  const queryClient = useQueryClient();
  const supplier = useQuery({ queryKey: ["supplier", supplierId], queryFn: () => shopApi.supplier(supplierId) });
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"CASH" | "UPI">("CASH");
  const [error, setError] = useState<string | null>(null);
  const row = asRecord(supplier.data?.data);
  if (supplier.isLoading) return <Loading label="Loading supplier..." />;
  if (supplier.isError) return <ErrorState error={supplier.error} onRetry={() => void supplier.refetch()} />;
  const due = asText(row?.payableBalance);
  return (
    <Allow action="supplier.view">
      <Page title={asText(row?.name) || "Supplier"}>
        <p>{asText(row?.phone)}</p>
        {"payableBalance" in (row ?? {}) ? (
          <p className="text-3xl font-semibold">
            Outstanding <Money value={due} />
          </p>
        ) : null}
        <h2 className="text-lg font-semibold">Pay supplier</h2>
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
        {error ? <Notice>{error}</Notice> : null}
        <Button
          onClick={() => {
            const money = moneyInput(amount);
            const paying = money ? toPaise(money) : null;
            const outstanding = toPaise(due);
            if (!money || paying === null) {
              setError("Enter the amount paid.");
              return;
            }
            if (outstanding !== null && paying > outstanding) {
              setError("Amount is more than the outstanding.");
              return;
            }
            void shopApi
              .paySupplier(supplierId, { amount: money, method }, crypto.randomUUID())
              .then(() => {
                useToast.getState().show("Payment saved");
                setAmount("");
                void queryClient.invalidateQueries({ queryKey: ["supplier", supplierId] });
              })
              .catch((caught: unknown) => setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong."));
          }}
        >
          Pay
        </Button>
      </Page>
    </Allow>
  );
}
