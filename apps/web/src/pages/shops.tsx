import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Button, EmptyState, ErrorState, Field, Loading, controlClass } from "../components/ui";
import { ApiError } from "../lib/api/client";
import { shopApi } from "../lib/api/shop";
import { asList, asRecord, asText } from "../lib/json";
import { roleLabel } from "../lib/permissions";
import { useSession } from "../stores/session";

export function ShopsPage() {
  const navigate = useNavigate();
  const setShop = useSession((state) => state.setShop);
  const shops = useQuery({ queryKey: ["shops"], queryFn: () => shopApi.shops() });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openShop(tenantId: string) {
    setError(null);
    setBusy(true);
    try {
      const body = await shopApi.selectShop(tenantId);
      const data = asRecord(body.data);
      if (!data) {
        setError("Something went wrong.");
        return;
      }
      setShop({
        id: asText(data.id),
        name: asText(data.name),
        role: asText(data.role),
        shopContext: asText(data.shopContext),
      });
      navigate("/dashboard");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function createShop() {
    setBusy(true);
    setError(null);
    try {
      const body = await shopApi.createShop({ name: name.trim(), businessType: "GROCERY" });
      const data = asRecord(body.data);
      if (!data) {
        return;
      }
      setShop({
        id: asText(data.id),
        name: asText(data.name),
        role: asText(data.role),
        shopContext: asText(data.shopContext),
      });
      navigate("/dashboard");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col gap-4 px-4 py-8">
      <h1 className="text-3xl font-semibold">Your shops</h1>
      {shops.isLoading ? <Loading label="Loading shops..." /> : null}
      {shops.isError ? <ErrorState error={shops.error} onRetry={() => void shops.refetch()} /> : null}
      {error ? <p className="whitespace-pre-line text-bad">{error}</p> : null}
      <div className="flex flex-col gap-3">
        {asList(shops.data?.data).map((shop) => {
          const row = asRecord(shop);
          if (!row) {
            return null;
          }
          return (
            <article key={asText(row.id)} className="rounded-2xl border border-line bg-card p-4">
              <h2 className="text-xl font-semibold">{asText(row.name)}</h2>
              <p className="text-muted">{roleLabel(asText(row.role))}</p>
              <div className="mt-3">
                <Button disabled={busy} onClick={() => void openShop(asText(row.id))}>
                  Open shop
                </Button>
              </div>
            </article>
          );
        })}
      </div>
      {!shops.isLoading && asList(shops.data?.data).length === 0 ? (
        <EmptyState title="No shop yet." body="Create the shop you will run from this phone." />
      ) : null}
      {creating ? (
        <div className="flex flex-col gap-3 rounded-2xl bg-card p-4">
          <Field label="Shop name" required>
            <input className={controlClass} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Button disabled={busy || name.trim().length === 0} onClick={() => void createShop()}>
            Create shop
          </Button>
        </div>
      ) : (
        <Button tone="quiet" onClick={() => setCreating(true)}>
          + New shop
        </Button>
      )}
    </main>
  );
}
