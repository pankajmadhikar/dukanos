import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Allow } from "../components/shell";
import { Button, EmptyState, Field, Notice, Page, controlClass } from "../components/ui";
import { useDebounced } from "../hooks/use-debounced";
import { ApiError } from "../lib/api/client";
import { shopApi } from "../lib/api/shop";
import { formatQty, moneyInput, stockInput } from "../lib/format";
import { asList, asRecord, asText, type Json } from "../lib/json";

const statusLabel: Record<string, string> = {
  UPLOADED: "Uploaded",
  QUEUED: "Queued",
  PROCESSING: "Processing",
  DRAFT_READY: "Ready",
  FAILED: "Failed",
  CONFIRMED: "Confirmed",
};

export function IntakePage() {
  return (
    <Allow action="ai.intake">
      <IntakeFlow />
    </Allow>
  );
}

function IntakeFlow() {
  const queryClient = useQueryClient();
  const units = useQuery({ queryKey: ["units"], queryFn: () => shopApi.units() });
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [intakeId, setIntakeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [cameraNote, setCameraNote] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [camera, setCamera] = useState(false);

  const intake = useQuery({
    queryKey: ["intake", intakeId],
    enabled: Boolean(intakeId),
    queryFn: () => shopApi.intakeGet(intakeId ?? ""),
    refetchInterval: (query) => {
      const status = asText(asRecord(query.state.data?.data)?.status);
      return status === "QUEUED" || status === "PROCESSING" || status === "UPLOADED" ? 2000 : false;
    },
  });
  const session = asRecord(intake.data?.data);
  const status = asText(session?.status);

  useEffect(() => {
    if (!camera) return;
    let stream: MediaStream | null = null;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraNote("Camera is not available. Upload an image instead.");
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
      })
      .catch(() => setCameraNote("Camera permission was denied. Upload an image instead."));
    return () => stream?.getTracks().forEach((track) => track.stop());
  }, [camera]);

  function choose(next: File | null) {
    setFile(next);
    setSaved(null);
    setError(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(next ? URL.createObjectURL(next) : null);
  }

  async function upload() {
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      const created = await shopApi.intakeCreate();
      const id = asText(asRecord(created.data)?.id);
      const ticket = await shopApi.intakeUploadUrl(id, {
        fileName: file.name || "shop.jpg",
        contentType: file.type || "image/jpeg",
        size: file.size,
      });
      const data = asRecord(ticket.data);
      const headers = asRecord(data?.headers);
      const headerMap: Record<string, string> = {};
      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          if (typeof value === "string") headerMap[key] = value;
        }
      }
      await shopApi.uploadImage(asText(data?.url), headerMap, file, setProgress);
      await shopApi.intakeProcess(id);
      setIntakeId(id);
      setProgress(null);
    } catch (caught) {
      setProgress(null);
      setError(caught instanceof ApiError ? caught.shopText() : "Something went wrong.");
    }
  }

  function capture() {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      choose(new File([blob], "shop.jpg", { type: "image/jpeg" }));
      setCamera(false);
    }, "image/jpeg");
  }

  if (saved) {
    return (
      <Page title="Products saved">
        <p>{saved}</p>
        <Button
          onClick={() => {
            setSaved(null);
            setIntakeId(null);
            choose(null);
            void queryClient.invalidateQueries({ queryKey: ["products"] });
            void queryClient.invalidateQueries({ queryKey: ["stock"] });
          }}
        >
          Add another
        </Button>
      </Page>
    );
  }

  return (
    <Page title="Camera add">
      {!intakeId ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setCamera(true)}>Use camera</Button>
            <label className="inline-flex min-h-12 cursor-pointer items-center rounded-xl border border-line bg-card px-4 font-semibold">
              Upload image
              <input
                className="sr-only"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(event) => choose(event.target.files?.[0] ?? null)}
              />
            </label>
          </div>
          {cameraNote ? <Notice>{cameraNote}</Notice> : null}
          {camera ? (
            <div className="flex flex-col gap-2">
              <video ref={videoRef} className="w-full rounded-2xl bg-ink" muted playsInline />
              <Button onClick={capture}>Take photo</Button>
            </div>
          ) : null}
          {preview ? <img src={preview} alt="Selected shop photo" className="max-h-80 rounded-2xl object-contain" /> : null}
          {file ? (
            <div className="flex gap-2">
              <Button onClick={() => void upload()}>{progress === null ? "Upload" : `Uploading ${Math.round(progress * 100)}%`}</Button>
              <Button tone="quiet" onClick={() => choose(null)}>
                Remove
              </Button>
            </div>
          ) : (
            <EmptyState title="Add products from a photo." body="Take a picture of the shelf, bill, or product, then review what we find." />
          )}
        </div>
      ) : null}
      {intakeId && status !== "DRAFT_READY" && status !== "CONFIRMED" ? (
        <section className="rounded-2xl bg-card p-5">
          <h2 className="text-xl font-semibold">
            {status === "FAILED" ? "We could not process this image. Please try again." : "Analyzing your products..."}
          </h2>
          <p className="mt-1 text-muted">{status === "FAILED" ? "" : "This may take a few seconds."}</p>
          <p className="mt-3 text-lg font-semibold">{statusLabel[status] ?? status}</p>
          {status === "FAILED" && asText(session?.canRetry) !== "false" ? (
            <Button
              onClick={() => {
                void shopApi.intakeRetry(intakeId).then(() => void intake.refetch());
              }}
            >
              Try again
            </Button>
          ) : null}
        </section>
      ) : null}
      {status === "DRAFT_READY" && intakeId ? (
        <DraftReview
          intakeId={intakeId}
          items={asList(session?.items)}
          units={asList(units.data?.data)}
          onSaved={(message) => setSaved(message)}
          onChange={() => void intake.refetch()}
        />
      ) : null}
      {error ? <Notice>{error}</Notice> : null}
    </Page>
  );
}

function DraftReview({
  intakeId,
  items,
  units,
  onSaved,
  onChange,
}: {
  intakeId: string;
  items: Json[];
  units: Json[];
  onSaved: (message: string) => void;
  onChange: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const pending = items.filter((item) => asText(asRecord(item)?.status) !== "REJECTED");
  const existing = pending.filter((item) => asRecord(asRecord(item)?.matchedProduct)?.id).length;
  const fresh = pending.length - existing;

  async function confirm(mode: "CREATE_PRODUCT_ONLY" | "CREATE_PRODUCT_AND_STOCK") {
    setBusy(true);
    setError(null);
    try {
      const result = await shopApi.intakeConfirm(
        intakeId,
        {
          mode,
          ...(supplierId ? { supplierId } : {}),
        },
        crypto.randomUUID(),
      );
      const data = asRecord(result.data);
      const count = asList(data?.items).length;
      onSaved(`${count} products saved. Nothing else was changed.`);
    } catch (caught) {
      const detail = caught instanceof ApiError ? caught.message : "Something went wrong.";
      setError(`We could not save these products.\nNothing was added.\n${detail}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">We found {pending.length} products</h2>
      {pending.map((item) => {
        const row = asRecord(item);
        if (!row) return null;
        return (
          <DraftItem
            key={asText(row.id)}
            intakeId={intakeId}
            item={row}
            units={units}
            onChange={onChange}
          />
        );
      })}
      <article className="rounded-2xl bg-card p-4">
        <p className="text-lg font-semibold">{pending.length} products</p>
        <p>{existing} existing products</p>
        <p>{fresh} new products</p>
        <SupplierPick onSelect={setSupplierId} />
      </article>
      {error ? <Notice>{error}</Notice> : null}
      <Button disabled={busy} onClick={() => void confirm("CREATE_PRODUCT_AND_STOCK")}>
        Confirm stock
      </Button>
      <Button tone="quiet" disabled={busy} onClick={() => void confirm("CREATE_PRODUCT_ONLY")}>
        Save products only
      </Button>
    </section>
  );
}

function DraftItem({
  intakeId,
  item,
  units,
  onChange,
}: {
  intakeId: string;
  item: Record<string, Json>;
  units: Json[];
  onChange: () => void;
}) {
  const id = asText(item.id);
  const [name, setName] = useState(asText(item.name));
  const [quantity, setQuantity] = useState(item.quantity === null ? "" : formatQty(asText(item.quantity)));
  const [purchase, setPurchase] = useState(item.purchasePrice === null ? "" : asText(item.purchasePrice));
  const [selling, setSelling] = useState(item.sellingPrice === null ? "" : asText(item.sellingPrice));
  const [unit, setUnit] = useState(asText(item.unit));
  const matched = asRecord(item.matchedProduct);
  const possible = asRecord(item.possibleProduct);

  async function save(patch: Record<string, Json>) {
    await shopApi.intakePatch(intakeId, id, patch);
    onChange();
  }

  return (
    <article className="rounded-2xl bg-card p-4">
      <p className="text-sm font-semibold text-warn">{confidenceLabel(item)}</p>
      <Field label="Product name">
        <input className={controlClass} value={name} onChange={(event) => setName(event.target.value)} onBlur={() => void save({ name })} />
      </Field>
      {matched ? <p className="mt-2">Matched product · {asText(matched.name)}</p> : null}
      {possible && !matched ? (
        <p className="mt-2">
          Possible match · {asText(possible.name)}{" "}
          <button type="button" className="font-semibold text-accent" onClick={() => void save({ matchedProductId: asText(possible.id) })}>
            Use this
          </button>
        </p>
      ) : null}
      {!matched ? <MatchSearch onPick={(productId) => void save({ matchedProductId: productId })} /> : null}
      <Field label="Quantity">
        <input
          className={controlClass}
          inputMode="decimal"
          placeholder="Enter quantity"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          onBlur={() => {
            const next = stockInput(quantity);
            if (next) void save({ quantity: next });
          }}
        />
      </Field>
      <Field label="Purchase price">
        <input
          className={controlClass}
          inputMode="decimal"
          placeholder="Enter purchase price"
          value={purchase}
          onChange={(event) => setPurchase(event.target.value)}
          onBlur={() => {
            const next = moneyInput(purchase);
            if (next) void save({ purchasePrice: next });
          }}
        />
      </Field>
      <Field label="Selling price">
        <input
          className={controlClass}
          inputMode="decimal"
          placeholder="Enter selling price"
          value={selling}
          onChange={(event) => setSelling(event.target.value)}
          onBlur={() => {
            const next = moneyInput(selling);
            if (next) void save({ sellingPrice: next });
          }}
        />
      </Field>
      <Field label="Unit">
        <select
          className={controlClass}
          value={unit}
          onChange={(event) => {
            setUnit(event.target.value);
            if (event.target.value) void save({ unit: event.target.value });
          }}
        >
          <option value="">Choose a unit</option>
          {units.map((option) => {
            const row = asRecord(option);
            const label = asText(row?.name);
            return (
              <option key={asText(row?.id)} value={label}>
                {label}
              </option>
            );
          })}
        </select>
      </Field>
      <Button
        tone="quiet"
        onClick={() => {
          void shopApi.intakeReject(intakeId, id).then(onChange);
        }}
      >
        Reject
      </Button>
    </article>
  );
}

function MatchSearch({ onPick }: { onPick: (productId: string) => void }) {
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search);
  const products = useQuery({
    queryKey: ["intake-match", debounced],
    enabled: debounced.trim().length > 1,
    queryFn: () => shopApi.products(debounced.trim(), 1),
  });
  return (
    <div className="mt-2">
      <input className={controlClass} placeholder="Match an existing product" value={search} onChange={(event) => setSearch(event.target.value)} />
      {asList(products.data?.data).map((item) => {
        const row = asRecord(item);
        return (
          <button key={asText(row?.id)} type="button" className="mt-1 block min-h-12 text-left font-semibold" onClick={() => onPick(asText(row?.id))}>
            {asText(row?.name)}
          </button>
        );
      })}
    </div>
  );
}

function SupplierPick({ onSelect }: { onSelect: (id: string) => void }) {
  const suppliers = useQuery({ queryKey: ["intake-suppliers"], queryFn: () => shopApi.suppliers("", 1) });
  return (
    <Field label="Supplier, if this came from a bill">
      <select className={controlClass} onChange={(event) => onSelect(event.target.value)}>
        <option value="">No supplier</option>
        {asList(suppliers.data?.data).map((item) => {
          const row = asRecord(item);
          return (
            <option key={asText(row?.id)} value={asText(row?.id)}>
              {asText(row?.name)}
            </option>
          );
        })}
      </select>
    </Field>
  );
}

function confidenceLabel(item: Record<string, Json>): string {
  if (item.needsReview === true || asText(item.matchType) === "POSSIBLE_MATCH") {
    return "Needs review";
  }
  const raw = asText(item.confidence);
  if (!/^\d(\.\d+)?$/.test(raw)) {
    return "Needs review";
  }
  const [whole, fraction = ""] = raw.split(".");
  const milli = Number(whole) * 1000 + Number(fraction.slice(0, 3).padEnd(3, "0"));
  if (milli < 500) return "Low confidence";
  if (milli >= 850) return "High confidence";
  return "Needs review";
}
