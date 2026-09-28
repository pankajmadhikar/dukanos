import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Button, Page } from "../components/ui";
import { shopApi } from "../lib/api/shop";
import { roleLabel } from "../lib/permissions";
import { useSession } from "../stores/session";

export function SettingsPage() {
  const navigate = useNavigate();
  const user = useSession((state) => state.user);
  const shop = useSession((state) => state.shop);
  const clear = useSession((state) => state.clear);
  const clearShop = useSession((state) => state.clearShop);
  const [theme, setTheme] = useState<string>(() => localStorage.getItem("dukaan.theme") ?? "light");

  useEffect(() => {
    document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
    localStorage.setItem("dukaan.theme", theme);
  }, [theme]);

  return (
    <Page title="Settings">
      <article className="rounded-2xl bg-card p-4">
        <h2 className="text-lg font-semibold">Shop</h2>
        <p>{shop?.name}</p>
        <p className="text-muted">{roleLabel(shop?.role)}</p>
        <Button
          tone="quiet"
          onClick={() => {
            clearShop();
            navigate("/shops");
          }}
        >
          Switch shop
        </Button>
      </article>
      <article className="rounded-2xl bg-card p-4">
        <h2 className="text-lg font-semibold">User</h2>
        <p>{user?.name || "Shop user"}</p>
        <p className="text-muted">{user?.phone}</p>
      </article>
      <article className="rounded-2xl bg-card p-4">
        <h2 className="text-lg font-semibold">Appearance</h2>
        <div className="mt-2 flex gap-2">
          <Button tone={theme === "light" ? "accent" : "quiet"} onClick={() => setTheme("light")}>
            Light
          </Button>
          <Button tone={theme === "dark" ? "accent" : "quiet"} onClick={() => setTheme("dark")}>
            Dark
          </Button>
        </div>
      </article>
      <Button
        tone="danger"
        onClick={() => {
          void shopApi.logout().catch(() => undefined);
          clear();
          navigate("/login");
        }}
      >
        Log out
      </Button>
    </Page>
  );
}
