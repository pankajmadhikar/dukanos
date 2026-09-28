export type ShopRole = "OWNER" | "ADMIN" | "STOCK_KEEPER" | "CASHIER";

export type Action =
  | "sales.create"
  | "sales.return"
  | "catalog.manage"
  | "catalog.cost"
  | "inventory.manage"
  | "finance.view"
  | "supplier.view"
  | "expenses.view"
  | "expenses.manage"
  | "dailyClosing.close"
  | "ai.intake"
  | "reports.view";

const MANAGERS = new Set<ShopRole>(["OWNER", "ADMIN", "STOCK_KEEPER"]);
const OWNERS = new Set<ShopRole>(["OWNER", "ADMIN"]);

export function can(role: string | null | undefined, action: Action): boolean {
  if (role !== "OWNER" && role !== "ADMIN" && role !== "STOCK_KEEPER" && role !== "CASHIER") {
    return false;
  }
  if (action === "sales.create" || action === "reports.view") {
    return true;
  }
  if (action === "finance.view" || action === "expenses.manage" || action === "dailyClosing.close") {
    return OWNERS.has(role);
  }
  return MANAGERS.has(role);
}

export function roleLabel(role: string | null | undefined): string {
  if (role === "OWNER") return "Owner";
  if (role === "ADMIN") return "Manager";
  if (role === "STOCK_KEEPER") return "Stock";
  if (role === "CASHIER") return "Cashier";
  return "";
}
