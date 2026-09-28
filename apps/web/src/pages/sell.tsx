import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Button, ErrorState, Field, Money, Notice, controlClass } from "../components/ui";
import { useDebounced } from "../hooks/use-debounced";
import { loadCart, saveCart } from "../offline/active-cart";
import { customerPrice, findBarcode, getCustomer, searchCustomers, searchProducts } from "../offline/catalog";
import { useOffline, usePosOnline } from "../offline/connectivity";
import { enqueueSale, lineMoney, OfflineStoreError, sumMoney } from "../offline/queue";
import { onQueueChange, salesForShop } from "../offline/sync";
import type { QueuedSale, StoredCart } from "../offline/types";
import { ApiError } from "../lib/api/client";
import { shopApi } from "../lib/api/shop";
import { formatQty, moneyInput, stockInput, toPaise } from "../lib/format";
import { asList, asRecord, asText, type Json } from "../lib/json";
import { can } from "../lib/permissions";
import { useCart } from "../stores/cart";
import { useSession } from "../stores/session";
import { useToast } from "../stores/toast";

const CREDIT_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

export function SellPage() {
  const queryClient = useQueryClient();
  const searchRef = useRef<HTMLInputElement>(null);
  const lines = useCart((state) => state.lines);
  const add = useCart((state) => state.add);
  const setQuantity = useCart((state) => state.setQuantity);
  const remove = useCart((state) => state.remove);
  const customerId = useCart((state) => state.customerId);
  const customerName = useCart((state) => state.customerName);
  const setCustomer = useCart((state) => state.setCustomer);
  const clear = useCart((state) => state.clear);
  const shopId = useSession((state) => state.shop?.id) ?? "";
  const userId = useSession((state) => state.user?.id) ?? "";
  const role = useSession((state) => state.shop?.role);
  const online = usePosOnline();
  const catalogUpdatedAt = useOffline((state) => state.catalogUpdatedAt);
  const [search, setSearch] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [payMode, setPayMode] = useState<"CASH" | "UPI" | "SPLIT" | "CREDIT">("CASH");
  const [cashPart, setCashPart] = useState("");
  const [upiPart, setUpiPart] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, Json> | null>(null);
  const [offlineDone, setOfflineDone] = useState<QueuedSale | null>(null);
  const [resume, setResume] = useState<StoredCart | null>(null);
  const [cartReady, setCartReady] = useState(false);
  const debounced = useDebounced(search);
  const debouncedCustomer = useDebounced(customerSearch);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!shopId) return;
    void loadCart(shopId)
      .then((cart) => {
        if (cart && useCart.getState().lines.length === 0) setResume(cart);
      })
      .catch(() => undefined)
      .finally(() => setCartReady(true));
  }, [shopId]);

  useEffect(() => {
    if (!shopId || !cartReady || resume) return;
    return useCart.subscribe((state) => {
      void saveCart({
        tenantId: shopId,
        lines: state.lines,
        customerId: state.customerId,
        customerName: state.customerName,
      }).catch(() => undefined);
    });
  }, [shopId, cartReady, resume]);

  const found = useQuery({
    queryKey: ["pos", debounced, online, shopId],
    enabled: debounced.trim().length > 0,
    networkMode: "always",
    queryFn: async () => {
      if (!online) {
        const rows = await searchProducts(shopId, debounced.trim());
        return {
          data: rows.map((row) => ({
            id: row.productId,
            name: row.name,
            sellingPrice: row.sellingPrice,
            quantity: row.quantity,
            offline: true,
          })),
        };
      }
      return shopApi.products(debounced.trim(), 1);
    },
  });
  const stockRows = useQuery({
    queryKey: ["pos-stock", debounced],
    enabled: online && debounced.trim().length > 0,
    queryFn: () => shopApi.inventory({ search: debounced.trim() }),
  });
  const people = useQuery({
    queryKey: ["pos-customers", debouncedCustomer, online, shopId],
    enabled: debouncedCustomer.trim().length > 0,
    networkMode: "always",
    queryFn: async () => {
      if (!online) {
        const rows = await searchCustomers(shopId, debouncedCustomer.trim());
        return { data: rows.map((row) => ({ id: row.customerId, name: row.name, phone: row.phone, outstanding: row.outstanding })) };
      }
      return shopApi.customers(debouncedCustomer.trim(), 1);
    },
  });
  const quote = useQuery({
    queryKey: ["quote", customerId, lines.map((line) => `${line.productId}:${line.quantity}`).join("|")],
    enabled: online && lines.length > 0,
    queryFn: () =>
      shopApi.quoteSale({
        ...(customerId ? { customerId } : {}),
        items: lines.map((line) => ({
          productId: line.productId,
          quantity: stockInput(line.quantity) ?? "1.000",
        })),
      }),
  });

  const quoteData = asRecord(quote.data?.data);
  const quoted = new Map(
    asList(quoteData?.items).map((item) => {
      const row = asRecord(item);
      return [asText(row?.productId), row] as const;
    }),
  );
  const stockByProduct = new Map<string, string>();
  for (const item of asList(stockRows.data?.data)) {
    const row = asRecord(item);
    const product = asRecord(row?.product);
    if (product) {
      stockByProduct.set(asText(product.id), asText(row?.quantity));
    }
  }

  async function addLocalProduct(code: string): Promise<boolean> {
    const product = await findBarcode(shopId, code);
    if (!product) return false;
    add({
      productId: product.productId,
      name: product.name,
      listPrice: product.sellingPrice,
      cachedPrice: product.sellingPrice,
      stock: product.quantity,
    });
    setSearch("");
    return true;
  }

  async function addBarcode(code: string) {
    setError(null);
    if (!online) {
      const foundLocally = await addLocalProduct(code);
      if (!foundLocally) {
        setError("Product not available offline.\nConnect to the internet to search this product.");
      }
      return;
    }
    try {
      const body = await shopApi.barcode(code);
      const product = asRecord(body.data);
      if (!product) {
        return;
      }
      add({
        productId: asText(product.id),
        name: asText(product.name),
        listPrice: asText(product.sellingPrice) || null,
        stock: null,
      });
      setSearch("");
    } catch (caught) {
      if (caught instanceof ApiError && (caught.offline || caught.code === "NETWORK")) {
        useOffline.getState().setApiReachable(false);
        const foundLocally = await addLocalProduct(code);
        if (foundLocally) return;
      }
      setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong.");
    }
  }

  async function complete() {
    if (!online) {
      await completeOffline();
      return;
    }
    if (!quoteData) {
      setError("Wait for the bill total.");
      return;
    }
    const total = asText(quoteData.total);
    const totalPaise = toPaise(total);
    if (totalPaise === null) {
      setError("Wait for the bill total.");
      return;
    }
    const payments: Array<{ method: "CASH" | "UPI"; amount: string }> = [];
    if (payMode === "CASH" || payMode === "UPI") {
      payments.push({ method: payMode, amount: total });
    }
    if (payMode === "SPLIT") {
      const cash = moneyInput(cashPart);
      const upi = moneyInput(upiPart);
      if (cash && cash !== "0.00") payments.push({ method: "CASH", amount: cash });
      if (upi && upi !== "0.00") payments.push({ method: "UPI", amount: upi });
    }
    const paid = payments.reduce((sum, payment) => sum + (toPaise(payment.amount) ?? 0n), 0n);
    if (!customerId && paid !== totalPaise) {
      setError("A walk-in sale must be paid in full. Select a customer for credit.");
      return;
    }
    if (payMode === "CREDIT" && !customerId) {
      setError("Customer required");
      return;
    }
    if (paid > totalPaise) {
      setError("Payment is more than the bill.");
      return;
    }
    const payload = {
      ...(customerId ? { customerId } : {}),
      items: lines.map((line) => ({
        productId: line.productId,
        quantity: stockInput(line.quantity) ?? "1.000",
      })),
      ...(payments.length > 0 ? { payments } : {}),
    };
    const key = crypto.randomUUID();
    setBusy(true);
    setError(null);
    try {
      const body = await shopApi.createSale(payload, key);
      setDone(asRecord(body.data));
      clear();
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["stock"] });
      void queryClient.invalidateQueries({ queryKey: ["sales"] });
      void queryClient.invalidateQueries({ queryKey: ["customers"] });
      useToast.getState().show("Sale completed");
    } catch (caught) {
      if (caught instanceof ApiError && (caught.offline || caught.code === "NETWORK" || caught.status === 0 || caught.status >= 500)) {
        try {
          const sale = await enqueueSale({
            tenantId: shopId,
            userId,
            customerId,
            customerName,
            items: lines.map((line) => ({
              productId: line.productId,
              name: line.name,
              quantity: stockInput(line.quantity) ?? "1.000",
              sellingPrice: moneyInput(asText(quoted.get(line.productId)?.unitPrice) || line.listPrice || "") ?? "0.00",
            })),
            payments,
            idempotencyKey: key,
            requestBody: payload,
          });
          useOffline.getState().setApiReachable(false);
          setOfflineDone(sale);
          clear();
          void queryClient.invalidateQueries({ queryKey: ["pos"] });
          return;
        } catch (storeError) {
          setError(storeError instanceof OfflineStoreError ? storeError.message : "The sale could not be saved on this device.");
          return;
        }
      }
      setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function completeOffline() {
    if (!can(role, "sales.create")) {
      setError("This sign-in cannot sell.");
      return;
    }
    const priced: Array<{ productId: string; name: string; quantity: string; sellingPrice: string; line: string }> = [];
    for (const line of lines) {
      const special = customerId ? await customerPrice(shopId, customerId, line.productId) : null;
      const unit = special || line.cachedPrice || line.listPrice;
      const money = unit ? moneyInput(unit) : null;
      const quantity = stockInput(line.quantity);
      const lineTotal = money && quantity ? lineMoney(money, quantity) : null;
      if (!money || !quantity || !lineTotal) {
        setError("Product not available offline.\nConnect to the internet to search this product.");
        return;
      }
      priced.push({ productId: line.productId, name: line.name, quantity, sellingPrice: money, line: lineTotal });
    }
    const total = sumMoney(priced.map((item) => item.line));
    if (!total) {
      setError("Wait for the bill total.");
      return;
    }
    const payments: Array<{ method: "CASH" | "UPI"; amount: string }> = [];
    if (payMode === "CASH" || payMode === "UPI") payments.push({ method: payMode, amount: total });
    if (payMode === "SPLIT") {
      const cash = moneyInput(cashPart);
      const upi = moneyInput(upiPart);
      if (cash && cash !== "0.00") payments.push({ method: "CASH", amount: cash });
      if (upi && upi !== "0.00") payments.push({ method: "UPI", amount: upi });
    }
    const totalPaise = toPaise(total);
    const paid = payments.reduce((sum, payment) => sum + (toPaise(payment.amount) ?? 0n), 0n);
    if (payMode === "CREDIT" || (!customerId && paid !== totalPaise)) {
      if (!customerId) {
        setError(payMode === "CREDIT" ? "Customer required" : "A walk-in sale must be paid in full. Select a customer for credit.");
        return;
      }
      const customer = await getCustomer(shopId, customerId);
      if (!customer) {
        setError("Customer not available offline.\nConnect to internet.");
        return;
      }
      if (Date.now() - Date.parse(customer.cachedAt) > CREDIT_CACHE_MS) {
        setError("Connect to the internet to refresh this customer before a credit sale.");
        return;
      }
    }
    if (totalPaise !== null && paid > totalPaise) {
      setError("Payment is more than the bill.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const sale = await enqueueSale({
        tenantId: shopId,
        userId,
        customerId,
        customerName,
        items: priced.map((item) => ({
          productId: item.productId,
          name: item.name,
          quantity: item.quantity,
          sellingPrice: item.sellingPrice,
        })),
        payments,
      });
      setOfflineDone(sale);
      clear();
      void queryClient.invalidateQueries({ queryKey: ["pos"] });
    } catch (caught) {
      setError(caught instanceof OfflineStoreError ? caught.message : "The sale could not be saved on this device.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!offlineDone) return;
    return onQueueChange(() => {
      void salesForShop(shopId).then((sales) => {
        const next = sales.find((sale) => sale.localId === offlineDone.localId);
        if (next) setOfflineDone(next);
      });
    });
  }, [offlineDone, shopId]);

  if (offlineDone) {
    const synced = offlineDone.status === "SYNCED" && offlineDone.serverSaleNumber;
    return (
      <section className="mx-auto flex w-full max-w-lg flex-col gap-4">
        <p className="text-sm font-semibold text-muted">OFFLINE</p>
        <h1 className="text-3xl font-semibold">{synced ? "Sale synced" : "Sale saved successfully"}</h1>
        <article className="rounded-2xl bg-card p-4">
          {synced ? (
            <>
              <p className="text-muted">Bill</p>
              <p className="text-2xl font-semibold">{offlineDone.serverSaleNumber}</p>
            </>
          ) : (
            <>
              <p>Waiting for internet</p>
              <p className="mt-3 text-muted">Local ref</p>
              <p className="text-2xl font-semibold">{offlineDone.localRef}</p>
            </>
          )}
        </article>
        <Button
          onClick={() => {
            setOfflineDone(null);
          }}
        >
          New sale
        </Button>
        {synced && offlineDone.serverSaleId ? (
          <Link to={`/sales/${offlineDone.serverSaleId}`} className="text-center font-semibold text-accent">
            View sale
          </Link>
        ) : null}
      </section>
    );
  }

  if (done) {
    const payments = asList(done.payments);
    return (
      <section className="mx-auto flex w-full max-w-lg flex-col gap-4">
        <h1 className="text-3xl font-semibold">Sale completed</h1>
        <article className="rounded-2xl bg-card p-4">
          <p className="text-muted">Bill</p>
          <p className="text-2xl font-semibold">{asText(done.saleNumber)}</p>
          <p className="mt-3 text-muted">Total</p>
          <p className="text-3xl font-semibold">
            <Money value={asText(done.total)} />
          </p>
          {payments.map((payment) => {
            const row = asRecord(payment);
            return (
              <p key={asText(row?.id)} className="mt-2">
                {asText(row?.method)} <Money value={asText(row?.amount)} />
              </p>
            );
          })}
        </article>
        <Button onClick={() => setDone(null)}>New sale</Button>
        <Link to={`/sales/${asText(done.id)}`} className="text-center font-semibold text-accent">
          View sale
        </Link>
      </section>
    );
  }

  return (
    <section className="mx-auto grid w-full max-w-5xl gap-4 lg:grid-cols-[1.1fr_0.9fr]">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">Sell</h1>
        {resume ? (
          <article className="rounded-2xl bg-card p-4">
            <p className="font-semibold">Resume previous sale?</p>
            <div className="mt-3 flex gap-2">
              <Button
                onClick={() => {
                  useCart.setState({
                    lines: resume.lines,
                    customerId: resume.customerId,
                    customerName: resume.customerName,
                  });
                  setResume(null);
                }}
              >
                Resume
              </Button>
              <Button
                tone="quiet"
                onClick={() => {
                  void saveCart({ tenantId: shopId, lines: [], customerId: null, customerName: null });
                  setResume(null);
                }}
              >
                Discard
              </Button>
            </div>
          </article>
        ) : null}
        {catalogUpdatedAt ? (
          <p className="text-sm text-muted">
            {Date.now() - Date.parse(catalogUpdatedAt) > 24 * 60 * 60 * 1000
              ? "Product data may be outdated. Connect to internet to refresh."
              : `Products updated ${catalogUpdatedAt.slice(0, 16).replace("T", " ")}`}
          </p>
        ) : null}
        <input
          ref={searchRef}
          className={controlClass}
          placeholder="Search products..."
          value={search}
          autoFocus
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && /^\d{4,}$/.test(search.trim())) {
              event.preventDefault();
              void addBarcode(search.trim());
            }
          }}
        />
        <Scanner
          onCode={(code) => {
            setSearch(code);
            void addBarcode(code);
          }}
        />
        {found.isLoading ? <p>Loading products...</p> : null}
        {!online && debounced.trim().length > 0 && !found.isLoading && asList(found.data?.data).length === 0 ? (
          <p>Product not available offline. Connect to the internet to search this product.</p>
        ) : null}
        {found.isError ? <ErrorState error={found.error} onRetry={() => void found.refetch()} /> : null}
        <div className="flex flex-col gap-2">
          {asList(found.data?.data).map((item) => {
            const row = asRecord(item);
            if (!row) return null;
            const id = asText(row.id);
            return (
              <button
                key={id}
                type="button"
                className="rounded-2xl bg-card px-4 py-3 text-left"
                onClick={() =>
                  add({
                    productId: id,
                    name: asText(row.name),
                    listPrice: asText(row.sellingPrice) || null,
                    cachedPrice: asText(row.sellingPrice) || null,
                    stock: online ? (stockByProduct.get(id) ?? null) : asText(row.quantity) || null,
                  })
                }
              >
                <span className="block text-lg font-semibold">{asText(row.name)}</span>
                <span className="text-muted">
                  <Money value={asText(row.sellingPrice)} />
                  {online && stockByProduct.has(id) ? ` · Stock: ${formatQty(stockByProduct.get(id))}` : ""}
                  {!online && asText(row.quantity) ? ` · Estimated stock: ${formatQty(asText(row.quantity))}` : ""}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <aside className="flex flex-col gap-3 rounded-2xl bg-card p-4">
        <h2 className="text-xl font-semibold">Cart</h2>
        {lines.length === 0 ? <p className="text-muted">Search or scan a product.</p> : null}
        {lines.map((line) => {
          const priced = quoted.get(line.productId);
          const unit = online ? asText(priced?.unitPrice) || line.listPrice || "" : line.cachedPrice || line.listPrice || "";
          const source = asText(priced?.priceSource);
          return (
            <div key={line.productId} className="border-b border-line pb-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{line.name}</p>
                  <p className="text-sm text-muted">
                    {formatQty(line.quantity)} × <Money value={unit} />
                    {source === "CUSTOMER" ? " · Customer price" : ""}
                    {!online && line.stock ? ` · Estimated stock: ${formatQty(line.stock)}` : ""}
                  </p>
                </div>
                <p className="font-semibold">
                  <Money value={online ? asText(priced?.lineTotal) || unit : lineMoney(unit, line.quantity) || unit} />
                </p>
              </div>
              <div className="mt-2 flex gap-2">
                <Button tone="quiet" onClick={() => changeQty(line.quantity, -1, (next) => setQuantity(line.productId, next), () => remove(line.productId))}>
                  −
                </Button>
                <Button tone="quiet" onClick={() => changeQty(line.quantity, 1, (next) => setQuantity(line.productId, next), () => remove(line.productId))}>
                  +
                </Button>
                <Button tone="quiet" onClick={() => remove(line.productId)}>
                  Remove
                </Button>
              </div>
            </div>
          );
        })}
        <div className="flex items-center justify-between text-xl font-semibold">
          <span>Total</span>
          <Money value={online ? asText(quoteData?.total) : offlineTotal(lines)} />
        </div>
        {quote.isError ? <ErrorState error={quote.error} onRetry={() => void quote.refetch()} /> : null}
        <Field label="Customer">
          <input
            className={controlClass}
            placeholder={customerName ?? "Walk-in customer"}
            value={customerSearch}
            onChange={(event) => setCustomerSearch(event.target.value)}
          />
        </Field>
        {customerName ? (
          <p className="text-sm">
            {customerName}{" "}
            <button type="button" className="font-semibold text-accent" onClick={() => setCustomer(null)}>
              Walk-in
            </button>
          </p>
        ) : null}
        <div className="flex flex-col gap-1">
          {asList(people.data?.data).map((person) => {
            const row = asRecord(person);
            if (!row) return null;
            return (
              <button
                key={asText(row.id)}
                type="button"
                className="min-h-12 rounded-xl px-2 text-left font-semibold"
                onClick={() => {
                  setCustomer({ id: asText(row.id), name: asText(row.name) });
                  setCustomerSearch("");
                }}
              >
                {asText(row.name)} · {asText(row.phone)}
              </button>
            );
          })}
          {!online && debouncedCustomer.trim().length > 0 && asList(people.data?.data).length === 0 ? (
            <p>Customer not available offline. Connect to internet.</p>
          ) : null}
          {online ? (
            <Link to="/customers?new=1" className="font-semibold text-accent">
              + Add customer
            </Link>
          ) : (
            <p className="text-sm text-muted">Connect to the internet to create/select this customer.</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(["CASH", "UPI", "SPLIT", "CREDIT"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`min-h-12 rounded-xl font-semibold ${payMode === mode ? "bg-accent text-accent-ink" : "border border-line"}`}
              onClick={() => setPayMode(mode)}
            >
              {mode === "CASH" ? "Cash" : mode === "UPI" ? "UPI" : mode === "SPLIT" ? "Split" : "Credit"}
            </button>
          ))}
        </div>
        {payMode === "UPI" ? <p className="text-sm text-muted">Confirm the payment on your phone, then tap Payment received.</p> : null}
        {payMode === "SPLIT" ? (
          <div className="grid gap-2">
            <Field label="Cash">
              <input className={controlClass} inputMode="decimal" value={cashPart} onChange={(event) => setCashPart(event.target.value)} />
            </Field>
            <Field label="UPI">
              <input className={controlClass} inputMode="decimal" value={upiPart} onChange={(event) => setUpiPart(event.target.value)} />
            </Field>
          </div>
        ) : null}
        {payMode === "CREDIT" && !customerId ? <p className="font-semibold text-bad">Customer required</p> : null}
        {error ? <Notice>{error}</Notice> : null}
        <Button disabled={busy || lines.length === 0 || (online && quote.isLoading)} onClick={() => void complete()}>
          {busy ? "Saving..." : payMode === "UPI" ? "Payment received" : "Complete sale"}
        </Button>
      </aside>
    </section>
  );
}

function offlineTotal(lines: Array<{ cachedPrice: string | null; listPrice: string | null; quantity: string }>): string {
  const amounts = lines
    .map((line) => lineMoney(line.cachedPrice || line.listPrice || "", line.quantity))
    .filter((value): value is string => Boolean(value));
  return sumMoney(amounts) ?? "0.00";
}

function changeQty(current: string, delta: number, set: (next: string) => void, remove: () => void) {
  const next = Number.parseInt(current, 10) + delta;
  if (!Number.isFinite(next) || next <= 0) {
    remove();
    return;
  }
  set(String(next));
}

function Scanner({ onCode }: { onCode: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    if (!open) {
      return;
    }
    let stop = false;
    let stream: MediaStream | null = null;
    const detector = window.BarcodeDetector ? new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "code_128", "qr_code"] }) : null;
    if (!detector || !navigator.mediaDevices?.getUserMedia) {
      setMessage("Camera scanning is not available on this device. Type the barcode in search.");
      return;
    }
    void navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((media) => {
        stream = media;
        if (videoRef.current) {
          videoRef.current.srcObject = media;
          void videoRef.current.play();
        }
        const tick = () => {
          if (stop || !videoRef.current) return;
          void detector.detect(videoRef.current).then((codes) => {
            const value = codes[0]?.rawValue;
            if (value) {
              stop = true;
              onCodeRef.current(value);
              setOpen(false);
              return;
            }
            if (!stop) requestAnimationFrame(tick);
          });
        };
        requestAnimationFrame(tick);
      })
      .catch(() => setMessage("Camera permission was denied. Type the barcode in search."));
    return () => {
      stop = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [open]);

  return (
    <div>
      <Button tone="quiet" onClick={() => setOpen((value) => !value)}>
        {open ? "Close camera" : "Scan barcode"}
      </Button>
      {open ? (
        <div className="mt-2">
          {message ? <p>{message}</p> : <video ref={videoRef} className="w-full rounded-xl bg-ink" muted playsInline />}
        </div>
      ) : null}
    </div>
  );
}
