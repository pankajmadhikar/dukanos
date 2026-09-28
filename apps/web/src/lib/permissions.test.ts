import { describe, expect, it } from "vitest";
import { can } from "./permissions";

describe("shop permissions", () => {
  it("lets a cashier sell and hides cost, profit, suppliers, and expenses", () => {
    expect(can("CASHIER", "sales.create")).toBe(true);
    expect(can("CASHIER", "catalog.cost")).toBe(false);
    expect(can("CASHIER", "finance.view")).toBe(false);
    expect(can("CASHIER", "supplier.view")).toBe(false);
    expect(can("CASHIER", "expenses.view")).toBe(false);
    expect(can("CASHIER", "ai.intake")).toBe(false);
  });

  it("lets an owner see the full shop", () => {
    expect(can("OWNER", "finance.view")).toBe(true);
    expect(can("OWNER", "catalog.cost")).toBe(true);
    expect(can("OWNER", "supplier.view")).toBe(true);
    expect(can("OWNER", "dailyClosing.close")).toBe(true);
    expect(can("ADMIN", "expenses.manage")).toBe(true);
  });

  it("lets stock see cost and stock, not profit", () => {
    expect(can("STOCK_KEEPER", "catalog.cost")).toBe(true);
    expect(can("STOCK_KEEPER", "inventory.manage")).toBe(true);
    expect(can("STOCK_KEEPER", "finance.view")).toBe(false);
    expect(can("STOCK_KEEPER", "expenses.manage")).toBe(false);
  });
});
