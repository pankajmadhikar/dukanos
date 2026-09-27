import assert from "node:assert/strict";
import { describe, it } from "@jest/globals";
import { parseMoney, parseStock } from "../src/catalog/decimal";
import { normalizeBarcode, normalizeSearch, normalizeSku } from "../src/catalog/text";
import { AppException } from "../src/common/errors/app.exception";
import { ErrorCode } from "../src/common/errors/error-codes";

describe("catalog text and money", () => {
  it("keeps unicode search text and normalizes sku and barcode", () => {
    assert.equal(normalizeSearch("  पार्ले   जी  "), "पार्ले जी");
    assert.equal(normalizeSku(" pg 250 "), "PG250");
    assert.equal(normalizeBarcode(" 890 111 "), "890111");
  });

  it("accepts decimal money and rejects floats that are not prices", () => {
    assert.equal(parseMoney(10).toFixed(2), "10.00");
    assert.equal(parseMoney("10.50").toFixed(2), "10.50");
    assert.equal(parseStock("1.250").toFixed(3), "1.250");
    assert.throws(
      () => parseMoney(Number.POSITIVE_INFINITY),
      (error: unknown) =>
        error instanceof AppException && error.code === ErrorCode.INVALID_PRODUCT_PRICE,
    );
    assert.throws(
      () => parseMoney("-1"),
      (error: unknown) =>
        error instanceof AppException && error.code === ErrorCode.INVALID_PRODUCT_PRICE,
    );
    assert.throws(
      () => parseStock("1.2345"),
      (error: unknown) =>
        error instanceof AppException && error.code === ErrorCode.INVALID_MINIMUM_STOCK,
    );
  });
});
