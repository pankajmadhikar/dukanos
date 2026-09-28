import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Allow } from "../components/shell";
import { Button, ConfirmDialog, ErrorState, Loading, Money, Notice, Page } from "../components/ui";
import { ApiError } from "../lib/api/client";
import { shopApi } from "../lib/api/shop";
import { formatBusinessDate, formatInstant } from "../lib/format";
import { asRecord, asText } from "../lib/json";
import { useToast } from "../stores/toast";

export function ClosingPage() {
  return (
    <Allow action="dailyClosing.close">
      <ClosingScreen />
    </Allow>
  );
}

function ClosingScreen() {
  const queryClient = useQueryClient();
  const today = useQuery({ queryKey: ["dashboard", "today"], queryFn: () => shopApi.dashboardToday() });
  const businessDate = asText(asRecord(today.data?.data)?.businessDate);
  const closing = useQuery({
    queryKey: ["closing", businessDate],
    enabled: businessDate.length === 10,
    queryFn: () => shopApi.closingGet(businessDate),
    retry: false,
  });
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const missing = closing.error instanceof ApiError && closing.error.status === 404;
  const snapshot = asRecord(closing.data?.data);
  const sales = asRecord(snapshot?.sales) ?? asRecord(asRecord(today.data?.data)?.sales);
  const profit = asRecord(snapshot?.profit) ?? asRecord(asRecord(today.data?.data)?.profit);
  const collections = asRecord(snapshot?.collections) ?? asRecord(asRecord(today.data?.data)?.collections);

  async function closeDay(rebuild: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (rebuild) {
        await shopApi.closingRebuild(businessDate);
      } else {
        await shopApi.closingClose(businessDate);
      }
      useToast.getState().show(rebuild ? "Closing rebuilt" : "Day closed");
      setConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ["closing", businessDate] });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong.");
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  }

  if (today.isLoading || (closing.isLoading && !missing)) {
    return <Loading label="Loading today's closing..." />;
  }
  if (today.isError) {
    return <ErrorState error={today.error} onRetry={() => void today.refetch()} />;
  }
  if (closing.isError && !missing) {
    return <ErrorState error={closing.error} onRetry={() => void closing.refetch()} />;
  }

  return (
    <Page title="Today's closing">
      <p className="text-muted">{formatBusinessDate(businessDate)}</p>
      {snapshot ? <p className="text-lg font-semibold">Day closed · {formatInstant(asText(snapshot.closedAt))}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Figure label="Sales" value={asText(sales?.grossSales)} />
        <Figure label="Returns" value={asText(sales?.salesReturns)} />
        <Figure label="Net sales" value={asText(sales?.netSales)} />
        {profit ? <Figure label="Expenses" value={asText(profit.expenses)} /> : null}
        <Figure label="Cash" value={asText(collections?.cash) || asText(collections?.cashReceived)} />
        <Figure label="UPI" value={asText(collections?.upi)} />
      </div>
      <p className="text-sm text-muted">Closing stores the day's numbers. It does not block later corrections the shop still allows.</p>
      {error ? <Notice>{error}</Notice> : null}
      {snapshot ? (
        <Button onClick={() => void closeDay(true)} disabled={busy}>
          Rebuild closing
        </Button>
      ) : (
        <Button onClick={() => setConfirm(true)}>Close day</Button>
      )}
      {confirm ? (
        <ConfirmDialog
          title="Close this day?"
          body="This saves today's numbers. You can rebuild the closing later if the day changes."
          confirm="Close day"
          busy={busy}
          onClose={() => setConfirm(false)}
          onConfirm={() => void closeDay(false)}
        />
      ) : null}
    </Page>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <article className="rounded-2xl bg-card p-4">
      <p className="text-muted">{label}</p>
      <p className="text-2xl font-semibold">
        <Money value={value} />
      </p>
    </article>
  );
}
