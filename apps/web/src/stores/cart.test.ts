import { beforeEach, describe, expect, it } from "vitest";
import { useCart } from "./cart";

describe("sell cart", () => {
  beforeEach(() => useCart.getState().clear());

  it("adds a product, changes quantity, and clears after a sale", () => {
    useCart.getState().add({ productId: "p1", name: "Parle-G", listPrice: "10.00", stock: "42.000" });
    useCart.getState().add({ productId: "p1", name: "Parle-G", listPrice: "10.00", stock: "42.000" });
    expect(useCart.getState().lines[0]?.quantity).toBe("2");
    useCart.getState().setQuantity("p1", "5");
    expect(useCart.getState().lines[0]?.quantity).toBe("5");
    useCart.getState().setCustomer({ id: "c1", name: "Rajesh" });
    useCart.getState().clear();
    expect(useCart.getState().lines).toEqual([]);
    expect(useCart.getState().customerId).toBeNull();
  });
});
