import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Navigate, Outlet, useNavigate } from "react-router";
import { shopApi } from "../lib/api/shop";
import { can, roleLabel } from "../lib/permissions";
import { useOffline, usePosOnline } from "../offline/connectivity";
import { queueCounts } from "../offline/queue";
import { startOfflineSync } from "../offline/sync";
import { useSession } from "../stores/session";
import { useToast } from "../stores/toast";
import { ToastHost } from "./ui";

const primary = [
  { to: "/dashboard", label: "Home", action: "reports.view" as const },
  { to: "/sell", label: "Sell", action: "sales.create" as const },
  { to: "/products", label: "Products", action: "reports.view" as const },
  { to: "/stock", label: "Stock", action: "reports.view" as const },
  { to: "/customers", label: "Customers", action: "reports.view" as const },
  { to: "/purchases", label: "Purchases", action: "supplier.view" as const },
];

function displayName(user: { name: string; phone: string } | null): string {
  if (!user) {
    return "";
  }
  if (user.name && user.name !== "Owner") {
    return user.name;
  }
  return user.phone;
}

const more = [
  { to: "/suppliers", label: "Suppliers", action: "supplier.view" as const },
  { to: "/expenses", label: "Expenses", action: "expenses.view" as const },
  { to: "/reports", label: "Reports", action: "reports.view" as const },
  { to: "/daily-closing", label: "Daily Closing", action: "dailyClosing.close" as const },
  { to: "/settings", label: "Settings", action: "reports.view" as const },
];

export function Shell() {
  const shop = useSession((state) => state.shop);
  const user = useSession((state) => state.user);
  const role = shop?.role;
  const online = usePosOnline();
  const waiting = useOffline((state) => state.waiting);
  const attention = useOffline((state) => state.attention);
  const signInAgain = useOffline((state) => state.signInAgain);
  const lastSynced = useOffline((state) => state.lastSynced);
  const [seenSynced, setSeenSynced] = useState(0);
  useEffect(() => {
    if (shop?.id) startOfflineSync(shop.id);
  }, [shop?.id]);
  useEffect(() => {
    if (lastSynced > seenSynced) {
      const count = lastSynced - seenSynced;
      useToast.getState().show(count === 1 ? "Sale synced" : `${count} sales synced`);
      setSeenSynced(lastSynced);
    }
  }, [lastSynced, seenSynced]);
  const visiblePrimary = primary.filter((item) => can(role, item.action));
  const visibleMore = more.filter((item) => can(role, item.action));
  const bottom = [
    visiblePrimary.find((item) => item.to === "/dashboard"),
    visiblePrimary.find((item) => item.to === "/sell"),
    visiblePrimary.find((item) => item.to === "/products"),
    visiblePrimary.find((item) => item.to === "/stock"),
    { to: "/more", label: "More", action: "reports.view" as const },
  ].filter((item): item is (typeof primary)[number] => Boolean(item));

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="hidden border-r border-line bg-card lg:flex lg:flex-col lg:gap-1 lg:p-4">
        <p className="px-3 pb-3 text-lg font-semibold">{shop?.name}</p>
        {visiblePrimary.map((item) => (
          <SideLink key={item.to} to={item.to} label={item.label} />
        ))}
        <p className="mt-4 px-3 text-xs font-semibold tracking-wide text-muted uppercase">More</p>
        {visibleMore.map((item) => (
          <SideLink key={item.to} to={item.to} label={item.label} />
        ))}
      </aside>
      <div className="flex min-h-screen flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-line bg-card px-4 py-3">
          <div>
            <p className="text-lg font-semibold leading-tight">{shop?.name}</p>
            <p className="text-sm text-muted">
              {displayName(user)} · {roleLabel(role)}
            </p>
            <Link to="/sync" className="text-sm font-semibold">
              <span className={online ? "text-good" : "text-bad"}>{online ? "● Online" : "● Offline"}</span>
            </Link>
          </div>
          <LogoutButton tenantId={shop?.id ?? ""} />
        </header>
        {!online ? (
          <p className="bg-card px-4 py-2 text-sm">Offline mode. Sales will sync when internet returns.</p>
        ) : null}
        {signInAgain ? (
          <p className="bg-card px-4 py-2 text-sm">Sales saved locally. Connect to the internet and sign in again to sync.</p>
        ) : null}
        {waiting > 0 ? (
          <Link to="/sync" className="block bg-card px-4 py-2 text-sm font-semibold">
            {waiting} {waiting === 1 ? "sale" : "sales"} waiting to sync
          </Link>
        ) : null}
        {attention > 0 ? (
          <Link to="/sync" className="block bg-card px-4 py-2 text-sm font-semibold text-bad">
            {attention} {attention === 1 ? "sale needs" : "sales need"} attention
          </Link>
        ) : null}
        <main className="flex-1 px-4 py-4 pb-24 lg:pb-6">
          <Outlet />
        </main>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-card lg:hidden">
        {bottom.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex min-h-16 items-center justify-center text-sm font-semibold ${isActive ? "text-accent" : "text-muted"}`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <ToastHost />
    </div>
  );
}

function SideLink({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `rounded-xl px-3 py-3 text-base font-semibold ${isActive ? "bg-accent text-accent-ink" : "hover:bg-paper"}`
      }
    >
      {label}
    </NavLink>
  );
}

function LogoutButton({ tenantId }: { tenantId: string }) {
  const navigate = useNavigate();
  const clear = useSession((state) => state.clear);
  const [hold, setHold] = useState<string | null>(null);
  return (
    <div className="text-right">
      <button
        type="button"
        className="min-h-12 rounded-xl px-3 font-semibold"
        onClick={() => {
          void queueCounts(tenantId)
            .then((counts) => {
              const pending = counts.waiting + counts.attention;
              if (pending > 0) {
                setHold(
                  `${pending} ${pending === 1 ? "sale is" : "sales are"} waiting to sync. Please connect to the internet before logging out.`,
                );
                return;
              }
              void shopApi.logout().catch(() => undefined);
              clear();
              navigate("/login");
            })
            .catch(() => {
              void shopApi.logout().catch(() => undefined);
              clear();
              navigate("/login");
            });
        }}
      >
        Log out
      </button>
      {hold ? <p className="max-w-64 text-sm text-bad">{hold}</p> : null}
    </div>
  );
}

export function Allow({ action, children }: { action: Parameters<typeof can>[1]; children: ReactNode }) {
  const role = useSession((state) => state.shop?.role);
  if (!can(role, action)) {
    return (
      <section className="rounded-2xl bg-card p-6">
        <h1 className="text-xl font-semibold">This is not available for your role.</h1>
      </section>
    );
  }
  return children;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const token = useSession((state) => state.token);
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

export function RequireShop({ children }: { children: ReactNode }) {
  const token = useSession((state) => state.token);
  const shop = useSession((state) => state.shop);
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  if (!shop?.shopContext) {
    return <Navigate to="/shops" replace />;
  }
  return children;
}
