import { describe, expect, it } from "vitest";
import { formatBusinessDate, formatInr, moneyInput, percentLabel, toPaise } from "./format";

describe("Indian money display", () => {
  it("groups rupees without trailing zeros", () => {
    expect(formatInr("125450.00")).toBe("₹1,25,450");
    expect(formatInr("10.50")).toBe("₹10.5");
    expect(formatInr("0.00")).toBe("₹0");
  });

  it("keeps money as text for the API", () => {
    expect(moneyInput("10")).toBe("10.00");
    expect(moneyInput("10.5")).toBe("10.50");
    expect(toPaise("10.20")! + toPaise("0.30")!).toBe(1050n);
  });

  it("shows a backend percent without recalculating it", () => {
    expect(percentLabel("12.00")).toBe("↑ 12%");
    expect(percentLabel("-4.50")).toBe("↓ 4.5%");
    expect(percentLabel(null)).toBeNull();
  });

  it("keeps a business date on the shop calendar", () => {
    expect(formatBusinessDate("2026-09-27")).toMatch(/^27 \w+ 2026$/);
  });
});
