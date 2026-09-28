import type { ReactNode } from "react";
import { ApiError } from "../lib/api/client";
import { asList, asRecord, asText, type Json } from "../lib/json";
import { formatInr } from "../lib/format";
import { useToast } from "../stores/toast";

export function Page({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Button({
  children,
  tone = "accent",
  type = "button",
  disabled,
  onClick,
}: {
  children: ReactNode;
  tone?: "accent" | "quiet" | "danger" | "good";
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void | Promise<void>;
}) {
  const tones = {
    accent: "bg-accent text-accent-ink",
    quiet: "bg-card text-ink border border-line",
    danger: "bg-bad text-white",
    good: "bg-good text-white",
  };
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex min-h-12 items-center justify-center rounded-xl px-4 text-base font-semibold disabled:opacity-50 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
  required,
}: {
  label: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      <span>
        {label}
        {required ? " *" : ""}
      </span>
      {children}
    </label>
  );
}

export const controlClass =
  "min-h-12 w-full rounded-xl border border-line bg-card px-3 text-base text-ink";

export function Money({ value }: { value: string | number | null | undefined }) {
  return <span className="tabular-nums">{formatInr(value)}</span>;
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-3" role="status">
      <p className="text-muted">{label}</p>
      <div className="h-20 animate-pulse rounded-2xl bg-line" />
      <div className="h-20 animate-pulse rounded-2xl bg-line" />
    </div>
  );
}

export function EmptyState({
  title,
  body,
  children,
}: {
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-card p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {body ? <p className="mt-1 text-muted">{body}</p> : null}
      {children ? <div className="mt-4 flex flex-wrap gap-2">{children}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const text = error instanceof ApiError ? error.shopText() : "Something went wrong.";
  return (
    <div className="rounded-2xl border border-bad/40 bg-card p-5" role="alert">
      <p className="whitespace-pre-line font-medium">{text}</p>
      {onRetry ? (
        <div className="mt-3">
          <Button onClick={onRetry}>Try again</Button>
        </div>
      ) : null}
    </div>
  );
}

export function Gate({
  query,
  loading,
  empty,
  children,
}: {
  query: {
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => void;
    data?: Record<string, Json>;
  };
  loading: string;
  empty?: ReactNode;
  children: (data: Json) => ReactNode;
}) {
  if (query.isLoading) {
    return <Loading label={loading} />;
  }
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  const data = query.data?.data ?? null;
  if (empty && asList(data).length === 0) {
    return empty;
  }
  return children(data);
}

export function Pager({
  page,
  total,
  limit,
  onPage,
}: {
  page: number;
  total: number;
  limit: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) {
    return null;
  }
  return (
    <div className="flex items-center justify-between gap-3">
      <Button tone="quiet" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <span className="text-sm text-muted">
        {page} / {pages}
      </span>
      <Button tone="quiet" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </div>
  );
}

export function paginationOf(body: Record<string, Json> | undefined): { page: number; limit: number; total: number } {
  const page = asRecord(body?.pagination);
  return {
    page: typeof page?.page === "number" ? page.page : 1,
    limit: typeof page?.limit === "number" ? page.limit : 20,
    total: typeof page?.total === "number" ? page.total : 0,
  };
}

export function ConfirmDialog({
  title,
  body,
  confirm,
  onConfirm,
  onClose,
  busy,
}: {
  title: string;
  body: string;
  confirm: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink/40 p-4 sm:items-center" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl">
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="mt-2 text-muted">{body}</p>
        <div className="mt-4 flex gap-2">
          <Button tone="danger" disabled={busy} onClick={onConfirm}>
            {confirm}
          </Button>
          <Button tone="quiet" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-line/60 px-3 py-2 text-sm whitespace-pre-line">{children}</p>;
}

export function recordText(row: Json, key: string): string {
  return asText(asRecord(row)?.[key]);
}

export function ToastHost() {
  const message = useToast((state) => state.message);
  if (!message) {
    return null;
  }
  return (
    <div className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-paper shadow-lg lg:bottom-6" role="status">
      {message}
    </div>
  );
}
