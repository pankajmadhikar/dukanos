import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { Button, ConfirmDialog, EmptyState, ErrorState, Field, Loading, Money, Notice, Page, controlClass } from "../components/ui";
import { ApiError } from "../lib/api/client";
import { shopApi } from "../lib/api/shop";
import { formatBusinessDate, formatQty, stockInput } from "../lib/format";
import { asList, asRecord, asText } from "../lib/json";
import { can } from "../lib/permissions";
import { useSession } from "../stores/session";
import { useToast } from "../stores/toast";

export function SalesPage() {
  const sales = useQuery({ queryKey: ["sales"], queryFn: () => shopApi.sales(1) });
  return (
    <Page title="Sales">
      {sales.isLoading ? <Loading label="Loading sales..." /> : null}
      {sales.isError ? <ErrorState error={sales.error} onRetry={() => void sales.refetch()} /> : null}
      {!sales.isLoading && asList(sales.data?.data).length === 0 ? (
        <EmptyState title="No sales yet." body="The first bill will show up here.">
          <Link to="/sell" className="font-semibold text-accent">
            Sell
          </Link>
        </EmptyState>
      ) : null}
      {asList(sales.data?.data).map((item) => {
        const row = asRecord(item);
        if (!row) return null;
        return (
          <Link key={asText(row.id)} to={`/sales/${asText(row.id)}`} className="block rounded-2xl bg-card p-4">
            <span className="block font-semibold">{asText(row.saleNumber)}</span>
            <span className="text-muted">
              {asText(asRecord(row.customer)?.name) || "Walk-in"} · {formatBusinessDate(asText(row.businessDate))}
            </span>
            <span className="mt-1 block">
              <Money value={asText(row.total)} /> · {asText(row.paymentStatus)}
            </span>
          </Link>
        );
      })}
    </Page>
  );
}

export function SaleDetailPage() {
  const { saleId = "" } = useParams();
  const role = useSession((state) => state.shop?.role);
  const queryClient = useQueryClient();
  const sale = useQuery({ queryKey: ["sale", saleId], queryFn: () => shopApi.sale(saleId) });
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const row = asRecord(sale.data?.data);
  if (sale.isLoading) return <Loading label="Loading sale..." />;
  if (sale.isError) return <ErrorState error={sale.error} onRetry={() => void sale.refetch()} />;
  return (
    <Page title={asText(row?.saleNumber) || "Sale"}>
      <p>
        {asText(asRecord(row?.customer)?.name) || "Walk-in"} · {formatBusinessDate(asText(row?.businessDate))}
      </p>
      <p className="text-3xl font-semibold">
        <Money value={asText(row?.total)} />
      </p>
      {asList(row?.payments).map((payment) => {
        const item = asRecord(payment);
        return (
          <p key={asText(item?.id)}>
            {asText(item?.method)} <Money value={asText(item?.amount)} />
          </p>
        );
      })}
      {"grossProfit" in (row ?? {}) ? (
        <p>
          Gross profit <Money value={asText(row?.grossProfit)} />
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
              Sold {formatQty(asText(line.quantity))} · Already returned {formatQty(asText(line.returnedQuantity))} · Available return{" "}
              {formatQty(asText(line.remainingQuantity))}
            </p>
            <p>
              <Money value={asText(line.unitPrice)} /> · <Money value={asText(line.lineTotal)} />
            </p>
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
          body="Only the available quantity can come back. The bill stays, and stock goes up."
          confirm="Confirm return"
          onClose={() => setConfirm(false)}
          onConfirm={() => {
            const items = Object.entries(quantities)
              .map(([saleItemId, quantity]) => ({ saleItemId, quantity: stockInput(quantity) }))
              .filter((item) => item.quantity && item.quantity !== "0.000");
            void shopApi
              .createSaleReturn({ saleId, items }, crypto.randomUUID())
              .then(() => {
                useToast.getState().show("Return saved");
                setConfirm(false);
                void queryClient.invalidateQueries({ queryKey: ["sale", saleId] });
                void queryClient.invalidateQueries({ queryKey: ["stock"] });
                void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
              })
              .catch((caught: unknown) => {
                setConfirm(false);
                setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong.");
              });
          }}
        />
      ) : null}
    </Page>
  );
}
