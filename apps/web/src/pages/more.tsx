import { Link } from "react-router";
import { can, type Action } from "../lib/permissions";
import { useSession } from "../stores/session";

const links: Array<{ to: string; label: string; action: Action }> = [
  { to: "/customers", label: "Customers", action: "reports.view" },
  { to: "/purchases", label: "Purchases", action: "supplier.view" },
  { to: "/suppliers", label: "Suppliers", action: "supplier.view" },
  { to: "/expenses", label: "Expenses", action: "expenses.view" },
  { to: "/reports", label: "Reports", action: "reports.view" },
  { to: "/daily-closing", label: "Daily Closing", action: "dailyClosing.close" },
  { to: "/settings", label: "Settings", action: "reports.view" },
];

export function MorePage() {
  const role = useSession((state) => state.shop?.role);
  return (
    <section className="mx-auto flex w-full max-w-lg flex-col gap-3">
      <h1 className="text-2xl font-semibold">More</h1>
      <Link to="/sync" className="rounded-2xl bg-card px-4 py-4 text-lg font-semibold">
        Sync
      </Link>
      {links
        .filter((item) => can(role, item.action))
        .map((item) => (
          <Link key={item.to} to={item.to} className="rounded-2xl bg-card px-4 py-4 text-lg font-semibold">
            {item.label}
          </Link>
        ))}
    </section>
  );
}
