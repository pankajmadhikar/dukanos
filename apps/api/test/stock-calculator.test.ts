import assert from "node:assert/strict";
import { describe, it } from "@jest/globals";
import { Prisma } from "@prisma/client";
import { isLowStock, isOutOfStock, weightedAverage } from "../src/inventory/stock-calculator";

describe("stock calculator", () => {
  it("keeps the weighted average exact at money scale", () => {
    const first = weightedAverage(
      new Prisma.Decimal(0),
      null,
      new Prisma.Decimal(10),
      new Prisma.Decimal("100.00"),
    );
    assert.equal(first.toFixed(2), "100.00");

    const second = weightedAverage(
      new Prisma.Decimal(10),
      new Prisma.Decimal("100.00"),
      new Prisma.Decimal(10),
      new Prisma.Decimal("120.00"),
    );
    assert.equal(second.toFixed(2), "110.00");

    const afterOut = new Prisma.Decimal("110.00");
    const third = weightedAverage(
      new Prisma.Decimal(15),
      afterOut,
      new Prisma.Decimal(5),
      new Prisma.Decimal("130.00"),
    );
    assert.equal(third.toFixed(2), "115.00");

    const rounded = weightedAverage(
      new Prisma.Decimal(100),
      new Prisma.Decimal("50.00"),
      new Prisma.Decimal(20),
      new Prisma.Decimal("55.00"),
    );
    assert.equal(rounded.toFixed(2), "50.83");
  });

  it("separates low stock from out of stock", () => {
    assert.equal(isOutOfStock(new Prisma.Decimal(0)), true);
    assert.equal(isLowStock(new Prisma.Decimal(0), new Prisma.Decimal(5)), false);
    assert.equal(isLowStock(new Prisma.Decimal(5), null), false);
    assert.equal(isLowStock(new Prisma.Decimal("2.000"), new Prisma.Decimal("5.000")), true);
    assert.equal(isLowStock(new Prisma.Decimal(6), new Prisma.Decimal(5)), false);
  });
});
