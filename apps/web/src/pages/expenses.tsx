import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { Allow } from "../components/shell";
import { Button, EmptyState, ErrorState, Field, Loading, Money, Notice, Page, controlClass } from "../components/ui";
import { ApiError } from "../lib/api/client";
import { shopApi } from "../lib/api/shop";
import { formatBusinessDate, moneyInput } from "../lib/format";
import { asList, asRecord, asText } from "../lib/json";
import { can } from "../lib/permissions";
import { useSession } from "../stores/session";
import { useToast } from "../stores/toast";

export function ExpensesPage() {
  return (
    <Allow action="expenses.view">
      <ExpenseScreen />
    </Allow>
  );
}

function ExpenseScreen() {
  const role = useSession((state) => state.shop?.role);
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const summary = useQuery({ queryKey: ["expenses", "today"], queryFn: () => shopApi.expenseSummary() });
  const list = useQuery({ queryKey: ["expenses", "list"], queryFn: () => shopApi.expenses(1) });
  const categories = useQuery({ queryKey: ["expense-categories"], queryFn: () => shopApi.expenseCategories() });
  const [open, setOpen] = useState(params.get("new") === "1");
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"CASH" | "UPI">("CASH");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const money = moneyInput(amount);
    if (!categoryId || !money) {
      setError("Choose a category and enter the amount.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await shopApi.createExpense(
        { categoryId, amount: money, paymentMethod: method, ...(note.trim() ? { note: note.trim() } : {}) },
        crypto.randomUUID(),
      );
      useToast.getState().show("Expense added");
      setAmount("");
      setNote("");
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["expenses"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      title="Expenses"
      action={
        can(role, "expenses.manage") ? (
          <Button onClick={() => setOpen(true)}>+ Add expense</Button>
        ) : null
      }
    >
      {summary.isLoading ? <Loading label="Loading expenses..." /> : null}
      {summary.isError ? <ErrorState error={summary.error} onRetry={() => void summary.refetch()} /> : null}
      <article className="rounded-2xl bg-card p-4">
        <p className="text-sm text-muted">Today's expenses</p>
        <p className="text-3xl font-semibold">
          <Money value={asText(asRecord(summary.data?.data)?.totalExpenses)} />
        </p>
      </article>
      {open && can(role, "expenses.manage") ? (
        <div className="grid gap-3 rounded-2xl bg-card p-4">
          <Field label="Category" required>
            <select className={controlClass} value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">Choose</option>
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
          <Field label="Amount" required>
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
          <Field label="Note">
            <input className={controlClass} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          {error ? <Notice>{error}</Notice> : null}
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? "Saving..." : "Save expense"}
          </Button>
        </div>
      ) : null}
      {list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
      {!list.isLoading && asList(list.data?.data).length === 0 ? <EmptyState title="No expenses yet." /> : null}
      {asList(list.data?.data).map((item) => {
        const row = asRecord(item);
        if (!row) return null;
        return (
          <article key={asText(row.id)} className="rounded-2xl bg-card p-4">
            <p className="font-semibold">{asText(asRecord(row.category)?.name)}</p>
            <p>
              <Money value={asText(row.amount)} /> · {asText(row.paymentMethod)} · {formatBusinessDate(asText(row.businessDate))}
            </p>
            {asText(row.note) ? <p className="text-muted">{asText(row.note)}</p> : null}
          </article>
        );
      })}
    </Page>
  );
}
