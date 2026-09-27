import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

// These tests create fixtures as the migration role, which bypasses RLS.
// DATABASE_URL is the API role (dukaan_app) and cannot set these fixtures up.
const connectionString =
  process.env.DATABASE_ADMIN_URL ??
  "postgresql://apple@localhost:5432/dukaanos?schema=public";

const AT = "2026-09-23T18:45:00.000Z";

type Sql = Client;

async function connect(): Promise<Sql> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

async function withTx(run: (sql: Sql) => Promise<void>): Promise<void> {
  const sql = await connect();
  try {
    await sql.query("BEGIN");
    await run(sql);
    await sql.query("ROLLBACK");
  } catch (error) {
    await sql.query("ROLLBACK");
    throw error;
  } finally {
    await sql.end();
  }
}

async function expectSqlState(
  sql: Sql,
  text: string,
  params: unknown[],
  code: string,
): Promise<void> {
  await sql.query("SAVEPOINT expect_failure");
  try {
    await sql.query(text, params);
    assert.fail(`expected SQLSTATE ${code}`);
  } catch (error) {
    const pgError = error as { code?: string; severity?: string };
    if (!pgError.severity) {
      throw error;
    }
    assert.equal(pgError.code, code);
    await sql.query("ROLLBACK TO SAVEPOINT expect_failure");
  }
}

async function ids(sql: Sql, count: number): Promise<string[]> {
  const result = await sql.query<{ id: string }>(
    "SELECT uuidv7()::text AS id FROM generate_series(1, $1)",
    [count],
  );
  return result.rows.map((row) => row.id);
}

async function shopFixture(sql: Sql): Promise<{
  tenantId: string;
  userId: string;
  locationId: string;
  unitId: string;
  productId: string;
}> {
  const [tenantId, userId, locationId, unitId, productId] = await ids(sql, 5);
  await sql.query(
    `INSERT INTO users (id, phone, name)
     VALUES ($1, $2, '[DEV] Contract User')`,
    [userId, `+91${userId.replace(/\D/g, "").slice(0, 10)}`],
  );
  await sql.query(
    `INSERT INTO tenants (id, name, business_type, phone)
     VALUES ($1, '[DEV] Contract Shop', 'GROCERY', '+910000000099')`,
    [tenantId],
  );
  await sql.query(
    `INSERT INTO locations (id, tenant_id, name, is_default)
     VALUES ($1, $2, '[DEV] Shop', true)`,
    [locationId, tenantId],
  );
  await sql.query(
    `UPDATE tenants SET default_location_id = $2 WHERE id = $1`,
    [tenantId, locationId],
  );
  await sql.query(
    `INSERT INTO units (id, tenant_id, name, short_code, decimal_places)
     VALUES ($1, $2, 'Piece', 'pc', 0)`,
    [unitId, tenantId],
  );
  await sql.query(
    `INSERT INTO products (
       id, tenant_id, name, name_hi, name_mr, unit_id, default_selling_price, average_cost
     ) VALUES ($1, $2, 'Toor Dal', 'तूर डाळ', 'तूर डाळ', $3, 80, 50)`,
    [productId, tenantId, unitId],
  );
  return { tenantId, userId, locationId, unitId, productId };
}

async function postPurchase(
  sql: Sql,
  shop: Awaited<ReturnType<typeof shopFixture>>,
  options: {
    quantity: string;
    unitCost: string;
    lineTotal: string;
    supplierId?: string;
    onCredit?: boolean;
  },
): Promise<{ purchaseId: string; itemId: string }> {
  const [purchaseId, itemId, movementId, balanceId, paymentId, ledgerId] =
    await ids(sql, 6);
  await sql.query(
    `INSERT INTO purchases (
       id, tenant_id, supplier_id, location_id, bill_number, purchase_date,
       business_date, subtotal, discount_total, tax_total, grand_total, status, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, DATE '2026-09-23', $7, 0, 0, $7, 'DRAFT', $8
     )`,
    [
      purchaseId,
      shop.tenantId,
      options.supplierId ?? null,
      shop.locationId,
      `P-${purchaseId.slice(0, 8)}`,
      AT,
      options.lineTotal,
      shop.userId,
    ],
  );
  await sql.query(
    `INSERT INTO purchase_items (
       id, tenant_id, purchase_id, product_id, quantity, unit_cost, line_total
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      itemId,
      shop.tenantId,
      purchaseId,
      shop.productId,
      options.quantity,
      options.unitCost,
      options.lineTotal,
    ],
  );
  await sql.query(
    `INSERT INTO inventory_movements (
       id, tenant_id, product_id, location_id, movement_type, quantity_delta,
       unit_cost, reference_type, reference_id, source_line_id, occurred_at, business_date, created_by
     ) VALUES (
       $1, $2, $3, $4, 'PURCHASE', $5, $6, 'PURCHASE', $7, $8, $9, DATE '2026-09-23', $10
     )`,
    [
      movementId,
      shop.tenantId,
      shop.productId,
      shop.locationId,
      options.quantity,
      options.unitCost,
      purchaseId,
      itemId,
      AT,
      shop.userId,
    ],
  );
  await sql.query(
    `INSERT INTO inventory_balances (
       id, tenant_id, product_id, location_id, quantity, average_cost
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [balanceId, shop.tenantId, shop.productId, shop.locationId, options.quantity, options.unitCost],
  );
  if (options.onCredit && options.supplierId) {
    await sql.query(
      `UPDATE suppliers SET payable_balance = $3 WHERE id = $1 AND tenant_id = $2`,
      [options.supplierId, shop.tenantId, options.lineTotal],
    );
    await sql.query(
      `INSERT INTO supplier_ledger (
         id, tenant_id, supplier_id, entry_type, debit_amount, credit_amount,
         reference_type, reference_id, business_date
       ) VALUES ($1, $2, $3, 'PURCHASE', 0, $4, 'PURCHASE', $5, DATE '2026-09-24')`,
      [ledgerId, shop.tenantId, options.supplierId, options.lineTotal, purchaseId],
    );
  } else {
    await sql.query(
      `INSERT INTO payments (
         id, tenant_id, amount, payment_method, direction, reference_type, reference_id,
         payment_date, business_date, created_by
       ) VALUES ($1, $2, $3, 'CASH', 'OUT', 'PURCHASE', $4, $5, DATE '2026-09-23', $6)`,
      [paymentId, shop.tenantId, options.lineTotal, purchaseId, AT, shop.userId],
    );
  }
  await sql.query(
    `UPDATE purchases SET status = 'CONFIRMED' WHERE id = $1`,
    [purchaseId],
  );
  return { purchaseId, itemId };
}

describe("database contract", () => {
  let probe: Sql;

  before(async () => {
    probe = await connect();
  });

  after(async () => {
    await probe.end();
  });

  it("stores money as numeric and time as timestamptz", async () => {
    const floats = await probe.query(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type IN ('double precision', 'real')`,
    );
    assert.equal(floats.rowCount, 0);

    const money = await probe.query(
      `SELECT data_type, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sales' AND column_name = 'grand_total'`,
    );
    assert.equal(money.rows[0].data_type, "numeric");
    assert.equal(Number(money.rows[0].numeric_precision), 18);
    assert.equal(Number(money.rows[0].numeric_scale), 2);

    const quantity = await probe.query(
      `SELECT data_type, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sale_items' AND column_name = 'quantity'`,
    );
    assert.equal(quantity.rows[0].data_type, "numeric");
    assert.equal(Number(quantity.rows[0].numeric_scale), 3);

    const time = await probe.query(
      `SELECT data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sales' AND column_name = 'sale_date'`,
    );
    assert.equal(time.rows[0].data_type, "timestamp with time zone");
  });

  it("converts shop business dates in Asia/Kolkata, not UTC", async () => {
    const result = await probe.query(
      `SELECT shop_business_date($1::timestamptz, 'Asia/Kolkata')::text AS business_date,
              (($1::timestamptz AT TIME ZONE 'UTC')::date)::text AS utc_date`,
      ["2026-09-23T18:45:00.000Z"],
    );
    assert.equal(result.rows[0].utc_date, "2026-09-23");
    assert.equal(result.rows[0].business_date, "2026-09-24");
  });

  it("forces row level security on shop tables", async () => {
    const result = await probe.query(
      `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'products'`,
    );
    assert.equal(result.rows[0].enabled, true);
    assert.equal(result.rows[0].forced, true);
  });

  it("hides another shop's products, sales, customers, and stock", async () => {
    await withTx(async (sql) => {
      const shopA = await shopFixture(sql);
      const shopB = await shopFixture(sql);
      const [customerA, customerB, saleA, balanceA] = await ids(sql, 4);
      await sql.query(
        `INSERT INTO customers (id, tenant_id, name, phone) VALUES ($1, $2, 'Asha', '9000000001')`,
        [customerA, shopA.tenantId],
      );
      await sql.query(
        `INSERT INTO customers (id, tenant_id, name, phone) VALUES ($1, $2, 'Bela', '9000000002')`,
        [customerB, shopB.tenantId],
      );
      await postPurchase(sql, shopA, { quantity: "5", unitCost: "10", lineTotal: "50" });
      await sql.query(
        `INSERT INTO inventory_balances (id, tenant_id, product_id, location_id, quantity)
         VALUES ($1, $2, $3, $4, 1)`,
        [balanceA, shopB.tenantId, shopB.productId, shopB.locationId],
      );
      await sql.query("SET LOCAL ROLE dukaan_app");
      await sql.query(`SELECT set_config('app.tenant_id', $1, true)`, [shopA.tenantId]);

      const products = await sql.query(`SELECT id FROM products`);
      assert.deepEqual(products.rows.map((row) => row.id), [shopA.productId]);

      const otherProduct = await sql.query(`SELECT id FROM products WHERE id = $1`, [
        shopB.productId,
      ]);
      assert.equal(otherProduct.rowCount, 0);

      const customers = await sql.query(`SELECT id FROM customers`);
      assert.deepEqual(customers.rows.map((row) => row.id), [customerA]);

      const stock = await sql.query(`SELECT product_id FROM inventory_balances`);
      assert.equal(stock.rowCount, 1);
      assert.equal(stock.rows[0].product_id, shopA.productId);

      await expectSqlState(
        sql,
        `INSERT INTO sales (
           id, tenant_id, location_id, bill_number, sale_date, business_date,
           subtotal, grand_total, payment_status, created_by
         ) VALUES ($1, $2, $3, 'NOPE', $4, DATE '2026-09-24', 1, 1, 'PAID', $5)`,
        [saleA, shopB.tenantId, shopB.locationId, AT, shopA.userId],
        "42501",
      );
    });
  });

  it("does not keep the shop setting after the transaction", async () => {
    const sql = await connect();
    const shop = await (async () => {
      await sql.query("BEGIN");
      const created = await shopFixture(sql);
      await sql.query("COMMIT");
      return created;
    })();
    try {
      await sql.query("BEGIN");
      await sql.query("SET LOCAL ROLE dukaan_app");
      await sql.query(`SELECT set_config('app.tenant_id', $1, true)`, [shop.tenantId]);
      const inside = await sql.query(`SELECT count(*)::int AS n FROM products`);
      assert.equal(inside.rows[0].n, 1);
      await sql.query("COMMIT");

      await sql.query("BEGIN");
      await sql.query("SET LOCAL ROLE dukaan_app");
      const outside = await sql.query(`SELECT count(*)::int AS n FROM products`);
      assert.equal(outside.rows[0].n, 0);
      await sql.query("ROLLBACK");
    } finally {
      await sql.query("RESET ROLE");
      await sql.query(`DELETE FROM inventory_balances WHERE tenant_id = $1`, [shop.tenantId]);
      await sql.query(`DELETE FROM products WHERE tenant_id = $1`, [shop.tenantId]);
      await sql.query(`DELETE FROM units WHERE tenant_id = $1`, [shop.tenantId]);
      await sql.query(`UPDATE tenants SET default_location_id = NULL WHERE id = $1`, [shop.tenantId]);
      await sql.query(`DELETE FROM locations WHERE tenant_id = $1`, [shop.tenantId]);
      await sql.query(`DELETE FROM tenants WHERE id = $1`, [shop.tenantId]);
      await sql.query(`DELETE FROM users WHERE id = $1`, [shop.userId]);
      await sql.end();
    }
  });

  it("rejects a sale line that points at another shop's product", async () => {
    await withTx(async (sql) => {
      const shopA = await shopFixture(sql);
      const shopB = await shopFixture(sql);
      const [saleId, itemId] = await ids(sql, 2);
      await sql.query(
        `INSERT INTO sales (
           id, tenant_id, location_id, bill_number, sale_date, business_date,
           subtotal, grand_total, payment_status, created_by
         ) VALUES ($1, $2, $3, $4, $5, DATE '2026-09-23', 10, 10, 'PAID', $6)`,
        [saleId, shopA.tenantId, shopA.locationId, `S-${saleId.slice(0, 8)}`, AT, shopA.userId],
      );
      await assert.rejects(
        sql.query(
          `INSERT INTO sale_items (
             id, tenant_id, sale_id, product_id, quantity, unit_selling_price, line_total, price_source
           ) VALUES ($1, $2, $3, $4, 1, 10, 10, 'LIST')`,
          [itemId, shopA.tenantId, saleId, shopB.productId],
        ),
        (error: { constraint?: string }) => error.constraint === "sale_items_product_fk",
      );
    });
  });

  it("keeps stock movements and posted bills append-only", async () => {
    await withTx(async (sql) => {
      const shop = await shopFixture(sql);
      const posted = await postPurchase(sql, shop, {
        quantity: "4",
        unitCost: "25",
        lineTotal: "100",
      });
      const [saleId] = await ids(sql, 1);
      await sql.query(
        `INSERT INTO sales (
           id, tenant_id, location_id, bill_number, sale_date, business_date,
           subtotal, grand_total, payment_status, created_by
         ) VALUES ($1, $2, $3, $4, $5, DATE '2026-09-23', 10, 10, 'PAID', $6)`,
        [saleId, shop.tenantId, shop.locationId, `S-${saleId.slice(0, 8)}`, AT, shop.userId],
      );
      await expectSqlState(
        sql,
        `UPDATE inventory_movements SET quantity_delta = 9 WHERE reference_id = $1`,
        [posted.purchaseId],
        "23514",
      );
      await expectSqlState(
        sql,
        `DELETE FROM sales WHERE tenant_id = $1`,
        [shop.tenantId],
        "23514",
      );
      await expectSqlState(
        sql,
        `DELETE FROM purchases WHERE id = $1`,
        [posted.purchaseId],
        "23514",
      );
    });
  });

  it("blocks negative stock unless the shop allows it", async () => {
    await withTx(async (sql) => {
      const shop = await shopFixture(sql);
      const [balanceId] = await ids(sql, 1);
      await assert.rejects(
        sql.query(
          `INSERT INTO inventory_balances (id, tenant_id, product_id, location_id, quantity)
           VALUES ($1, $2, $3, $4, -1)`,
          [balanceId, shop.tenantId, shop.productId, shop.locationId],
        ),
        (error: { code?: string }) => error.code === "23514",
      );
    });
  });

  it("rejects a sale movement that increases stock", async () => {
    await withTx(async (sql) => {
      const shop = await shopFixture(sql);
      await postPurchase(sql, shop, { quantity: "2", unitCost: "10", lineTotal: "20" });
      const [saleId, itemId, movementId] = await ids(sql, 3);
      await sql.query(
        `INSERT INTO sales (
           id, tenant_id, location_id, bill_number, sale_date, business_date,
           subtotal, grand_total, payment_status, status, created_by
         ) VALUES ($1, $2, $3, $4, $5, DATE '2026-09-23', 10, 10, 'PAID', 'COMPLETED', $6)`,
        [saleId, shop.tenantId, shop.locationId, `S-${saleId.slice(0, 8)}`, AT, shop.userId],
      );
      await sql.query(
        `INSERT INTO sale_items (
           id, tenant_id, sale_id, product_id, quantity, unit_selling_price, unit_cost, line_total, price_source
         ) VALUES ($1, $2, $3, $4, 1, 10, 10, 10, 'LIST')`,
        [itemId, shop.tenantId, saleId, shop.productId],
      );
      await assert.rejects(
        sql.query(
          `INSERT INTO inventory_movements (
             id, tenant_id, product_id, location_id, movement_type, quantity_delta,
             unit_cost, reference_type, reference_id, source_line_id, occurred_at, business_date
           ) VALUES ($1, $2, $3, $4, 'SALE', 1, 10, 'SALE', $5, $6, $7, DATE '2026-09-23')`,
          [movementId, shop.tenantId, shop.productId, shop.locationId, saleId, itemId, AT],
        ),
        (error: { code?: string }) => error.code === "23514",
      );
    });
  });

  it("posts a purchase, sale, return, and damage as one traceable stock story", async () => {
    await withTx(async (sql) => {
      const shop = await shopFixture(sql);
      const purchased = await postPurchase(sql, shop, {
        quantity: "10",
        unitCost: "50",
        lineTotal: "500",
      });

      const businessDate = await sql.query(
        `SELECT business_date::text AS business_date FROM purchases WHERE id = $1`,
        [purchased.purchaseId],
      );
      assert.equal(businessDate.rows[0].business_date, "2026-09-24");

      const [saleId, saleItemId, saleMovementId, paymentId] = await ids(sql, 4);
      await sql.query(
        `INSERT INTO sales (
           id, tenant_id, location_id, bill_number, sale_date, business_date,
           subtotal, grand_total, payment_status, created_by
         ) VALUES ($1, $2, $3, $4, $5, DATE '2026-09-23', 160, 160, 'PAID', $6)`,
        [saleId, shop.tenantId, shop.locationId, `S-${saleId.slice(0, 8)}`, AT, shop.userId],
      );
      await sql.query(
        `INSERT INTO sale_items (
           id, tenant_id, sale_id, product_id, quantity, unit_selling_price, unit_cost,
           line_total, price_source
         ) VALUES ($1, $2, $3, $4, 2, 80, 50, 160, 'LIST')`,
        [saleItemId, shop.tenantId, saleId, shop.productId],
      );
      await sql.query(
        `INSERT INTO inventory_movements (
           id, tenant_id, product_id, location_id, movement_type, quantity_delta, unit_cost,
           reference_type, reference_id, source_line_id, occurred_at, business_date, created_by
         ) VALUES ($1, $2, $3, $4, 'SALE', -2, 50, 'SALE', $5, $6, $7, DATE '2026-09-23', $8)`,
        [saleMovementId, shop.tenantId, shop.productId, shop.locationId, saleId, saleItemId, AT, shop.userId],
      );
      await sql.query(
        `UPDATE inventory_balances SET quantity = 8 WHERE tenant_id = $1 AND product_id = $2`,
        [shop.tenantId, shop.productId],
      );
      await sql.query(
        `INSERT INTO payments (
           id, tenant_id, amount, payment_method, direction, reference_type, reference_id,
           payment_date, business_date, created_by
         ) VALUES ($1, $2, 160, 'UPI', 'IN', 'SALE', $3, $4, DATE '2026-09-23', $5)`,
        [paymentId, shop.tenantId, saleId, AT, shop.userId],
      );

      const [returnId, returnItemId, returnMovementId, refundId] = await ids(sql, 4);
      await sql.query(
        `INSERT INTO sale_returns (
           id, tenant_id, original_sale_id, location_id, return_number, return_date,
           business_date, subtotal, refund_amount, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, DATE '2026-09-23', 80, 80, $7)`,
        [returnId, shop.tenantId, saleId, shop.locationId, `SR-${returnId.slice(0, 8)}`, AT, shop.userId],
      );
      await sql.query(
        `INSERT INTO sale_return_items (
           id, tenant_id, sale_return_id, original_sale_item_id, product_id, quantity,
           unit_price, unit_cost, line_total
         ) VALUES ($1, $2, $3, $4, $5, 1, 80, 50, 80)`,
        [returnItemId, shop.tenantId, returnId, saleItemId, shop.productId],
      );
      await sql.query(
        `INSERT INTO inventory_movements (
           id, tenant_id, product_id, location_id, movement_type, quantity_delta, unit_cost,
           reference_type, reference_id, source_line_id, occurred_at, business_date
         ) VALUES ($1, $2, $3, $4, 'SALE_RETURN', 1, 50, 'SALE_RETURN', $5, $6, $7, DATE '2026-09-23')`,
        [returnMovementId, shop.tenantId, shop.productId, shop.locationId, returnId, returnItemId, AT],
      );
      await sql.query(
        `UPDATE inventory_balances SET quantity = 9 WHERE tenant_id = $1 AND product_id = $2`,
        [shop.tenantId, shop.productId],
      );
      await sql.query(
        `INSERT INTO payments (
           id, tenant_id, amount, payment_method, direction, reference_type, reference_id,
           payment_date, business_date, created_by
         ) VALUES ($1, $2, 80, 'CASH', 'OUT', 'SALE_RETURN', $3, $4, DATE '2026-09-23', $5)`,
        [refundId, shop.tenantId, returnId, AT, shop.userId],
      );

      const [adjustmentId, adjustmentItemId, damageMovementId] = await ids(sql, 3);
      await sql.query(
        `INSERT INTO stock_adjustments (
           id, tenant_id, location_id, adjustment_number, adjustment_date, business_date,
           reason, status, created_by
         ) VALUES ($1, $2, $3, $4, $5, DATE '2026-09-23', 'DAMAGE', 'DRAFT', $6)`,
        [adjustmentId, shop.tenantId, shop.locationId, `ADJ-${adjustmentId.slice(0, 8)}`, AT, shop.userId],
      );
      await sql.query(
        `INSERT INTO stock_adjustment_items (
           id, tenant_id, stock_adjustment_id, product_id, quantity_delta, unit_cost
         ) VALUES ($1, $2, $3, $4, -1, 50)`,
        [adjustmentItemId, shop.tenantId, adjustmentId, shop.productId],
      );
      await sql.query(
        `INSERT INTO inventory_movements (
           id, tenant_id, product_id, location_id, movement_type, quantity_delta, unit_cost,
           reference_type, reference_id, source_line_id, occurred_at, business_date
         ) VALUES ($1, $2, $3, $4, 'DAMAGE', -1, 50, 'STOCK_ADJUSTMENT', $5, $6, $7, DATE '2026-09-23')`,
        [damageMovementId, shop.tenantId, shop.productId, shop.locationId, adjustmentId, adjustmentItemId, AT],
      );
      await sql.query(
        `UPDATE inventory_balances SET quantity = 8 WHERE tenant_id = $1 AND product_id = $2`,
        [shop.tenantId, shop.productId],
      );
      await sql.query(
        `UPDATE stock_adjustments SET status = 'CONFIRMED' WHERE id = $1`,
        [adjustmentId],
      );

      await sql.query(`UPDATE products SET average_cost = 99 WHERE id = $1`, [shop.productId]);
      const preserved = await sql.query(
        `SELECT unit_cost FROM sale_items WHERE id = $1`,
        [saleItemId],
      );
      assert.equal(Number(preserved.rows[0].unit_cost), 50);

      const onHand = await sql.query(
        `SELECT quantity FROM inventory_balances WHERE tenant_id = $1 AND product_id = $2`,
        [shop.tenantId, shop.productId],
      );
      assert.equal(Number(onHand.rows[0].quantity), 8);

      const [extraReturnItem] = await ids(sql, 1);
      await assert.rejects(
        sql.query(
          `INSERT INTO sale_return_items (
             id, tenant_id, sale_return_id, original_sale_item_id, product_id, quantity,
             unit_price, unit_cost, line_total
           ) VALUES ($1, $2, $3, $4, $5, 2, 80, 50, 160)`,
          [extraReturnItem, shop.tenantId, returnId, saleItemId, shop.productId],
        ),
        (error: { code?: string }) => error.code === "23514",
      );
    });
  });

  it("rejects a confirmed purchase that does not move stock", async () => {
    await withTx(async (sql) => {
      const shop = await shopFixture(sql);
      const [purchaseId, itemId, paymentId] = await ids(sql, 3);
      await sql.query(
        `INSERT INTO purchases (
           id, tenant_id, location_id, bill_number, purchase_date, business_date,
           subtotal, grand_total, status, created_by
         ) VALUES ($1, $2, $3, $4, $5, DATE '2026-09-23', 10, 10, 'DRAFT', $6)`,
        [purchaseId, shop.tenantId, shop.locationId, `P-${purchaseId.slice(0, 8)}`, AT, shop.userId],
      );
      await sql.query(
        `INSERT INTO purchase_items (
           id, tenant_id, purchase_id, product_id, quantity, unit_cost, line_total
         ) VALUES ($1, $2, $3, $4, 1, 10, 10)`,
        [itemId, shop.tenantId, purchaseId, shop.productId],
      );
      await sql.query(
        `INSERT INTO payments (
           id, tenant_id, amount, payment_method, direction, reference_type, reference_id,
           payment_date, business_date, created_by
         ) VALUES ($1, $2, 10, 'CASH', 'OUT', 'PURCHASE', $3, $4, DATE '2026-09-23', $5)`,
        [paymentId, shop.tenantId, purchaseId, AT, shop.userId],
      );
      await sql.query(`UPDATE purchases SET status = 'CONFIRMED' WHERE id = $1`, [purchaseId]);
      await sql.query("SAVEPOINT purchase_check");
      try {
        await sql.query("SET CONSTRAINTS ALL IMMEDIATE");
        assert.fail("confirmed purchase without a stock movement should not pass");
      } catch (error) {
        const code = (error as { code?: string }).code;
        assert.equal(code, "23514");
        await sql.query("ROLLBACK TO SAVEPOINT purchase_check");
      }
    });
  });

  it("records credit sales and credit purchases on the party ledgers", async () => {
    await withTx(async (sql) => {
      const shop = await shopFixture(sql);
      const [supplierId, customerId] = await ids(sql, 2);
      await sql.query(
        `INSERT INTO suppliers (id, tenant_id, name) VALUES ($1, $2, '[DEV] Mill')`,
        [supplierId, shop.tenantId],
      );
      await sql.query(
        `INSERT INTO customers (id, tenant_id, name) VALUES ($1, $2, '[DEV] Raju')`,
        [customerId, shop.tenantId],
      );
      await postPurchase(sql, shop, {
        quantity: "3",
        unitCost: "20",
        lineTotal: "60",
        supplierId,
        onCredit: true,
      });
      const payable = await sql.query(
        `SELECT payable_balance FROM suppliers WHERE id = $1`,
        [supplierId],
      );
      assert.equal(Number(payable.rows[0].payable_balance), 60);

      const [saleId, itemId, movementId, ledgerId] = await ids(sql, 4);
      await sql.query(
        `INSERT INTO sales (
           id, tenant_id, customer_id, location_id, bill_number, sale_date, business_date,
           subtotal, grand_total, payment_status, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, DATE '2026-09-23', 40, 40, 'UNPAID', $7)`,
        [saleId, shop.tenantId, customerId, shop.locationId, `S-${saleId.slice(0, 8)}`, AT, shop.userId],
      );
      await sql.query(
        `INSERT INTO sale_items (
           id, tenant_id, sale_id, product_id, quantity, unit_selling_price, unit_cost, line_total, price_source
         ) VALUES ($1, $2, $3, $4, 2, 20, 20, 40, 'CUSTOMER')`,
        [itemId, shop.tenantId, saleId, shop.productId],
      );
      await sql.query(
        `INSERT INTO inventory_movements (
           id, tenant_id, product_id, location_id, movement_type, quantity_delta, unit_cost,
           reference_type, reference_id, source_line_id, occurred_at, business_date
         ) VALUES ($1, $2, $3, $4, 'SALE', -2, 20, 'SALE', $5, $6, $7, DATE '2026-09-23')`,
        [movementId, shop.tenantId, shop.productId, shop.locationId, saleId, itemId, AT],
      );
      await sql.query(
        `UPDATE inventory_balances SET quantity = 1 WHERE tenant_id = $1 AND product_id = $2`,
        [shop.tenantId, shop.productId],
      );
      await sql.query(
        `UPDATE customers SET receivable_balance = 40 WHERE id = $1`,
        [customerId],
      );
      await sql.query(
        `INSERT INTO customer_ledger (
           id, tenant_id, customer_id, entry_type, debit_amount, credit_amount,
           reference_type, reference_id, business_date
         ) VALUES ($1, $2, $3, 'CREDIT_SALE', 40, 0, 'SALE', $4, DATE '2026-09-24')`,
        [ledgerId, shop.tenantId, customerId, saleId],
      );

      const receivable = await sql.query(
        `SELECT COALESCE(SUM(debit_amount - credit_amount), 0) AS balance
         FROM customer_ledger WHERE customer_id = $1`,
        [customerId],
      );
      assert.equal(Number(receivable.rows[0].balance), 40);
    });
  });

  it("keeps one current customer price and does not rewrite old bills", async () => {
    await withTx(async (sql) => {
      const shop = await shopFixture(sql);
      const [customerId, priceId, duplicateId] = await ids(sql, 3);
      await sql.query(
        `INSERT INTO customers (id, tenant_id, name) VALUES ($1, $2, '[DEV] Wholesale')`,
        [customerId, shop.tenantId],
      );
      await sql.query(
        `INSERT INTO customer_product_prices (
           id, tenant_id, customer_id, product_id, selling_price
         ) VALUES ($1, $2, $3, $4, 70)`,
        [priceId, shop.tenantId, customerId, shop.productId],
      );
      await expectSqlState(
        sql,
        `INSERT INTO customer_product_prices (
           id, tenant_id, customer_id, product_id, selling_price
         ) VALUES ($1, $2, $3, $4, 65)`,
        [duplicateId, shop.tenantId, customerId, shop.productId],
        "23505",
      );
      await postPurchase(sql, shop, { quantity: "1", unitCost: "40", lineTotal: "40" });
      const [saleId, itemId, movementId, paymentId] = await ids(sql, 4);
      await sql.query(
        `INSERT INTO sales (
           id, tenant_id, customer_id, location_id, bill_number, sale_date, business_date,
           subtotal, grand_total, payment_status, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, DATE '2026-09-23', 70, 70, 'PAID', $7)`,
        [saleId, shop.tenantId, customerId, shop.locationId, `S-${saleId.slice(0, 8)}`, AT, shop.userId],
      );
      await sql.query(
        `INSERT INTO sale_items (
           id, tenant_id, sale_id, product_id, quantity, unit_selling_price, unit_cost, line_total, price_source
         ) VALUES ($1, $2, $3, $4, 1, 70, 40, 70, 'CUSTOMER')`,
        [itemId, shop.tenantId, saleId, shop.productId],
      );
      await sql.query(
        `INSERT INTO inventory_movements (
           id, tenant_id, product_id, location_id, movement_type, quantity_delta, unit_cost,
           reference_type, reference_id, source_line_id, occurred_at, business_date
         ) VALUES ($1, $2, $3, $4, 'SALE', -1, 40, 'SALE', $5, $6, $7, DATE '2026-09-23')`,
        [movementId, shop.tenantId, shop.productId, shop.locationId, saleId, itemId, AT],
      );
      await sql.query(
        `UPDATE inventory_balances SET quantity = 0, average_cost = 40 WHERE tenant_id = $1`,
        [shop.tenantId],
      );
      await sql.query(
        `INSERT INTO payments (
           id, tenant_id, amount, payment_method, direction, reference_type, reference_id,
           payment_date, business_date, created_by
         ) VALUES ($1, $2, 70, 'CASH', 'IN', 'SALE', $3, $4, DATE '2026-09-23', $5)`,
        [paymentId, shop.tenantId, saleId, AT, shop.userId],
      );
      await sql.query(
        `UPDATE customer_product_prices SET selling_price = 55 WHERE id = $1`,
        [priceId],
      );
      await sql.query(
        `UPDATE products SET default_selling_price = 90 WHERE id = $1`,
        [shop.productId],
      );
      const bill = await sql.query(
        `SELECT unit_selling_price FROM sale_items WHERE id = $1`,
        [itemId],
      );
      assert.equal(Number(bill.rows[0].unit_selling_price), 70);
    });
  });

  it("treats an expense as its own record and not as a sale or stock movement", async () => {
    await withTx(async (sql) => {
      const shop = await shopFixture(sql);
      const [categoryId, expenseId] = await ids(sql, 2);
      await sql.query(
        `INSERT INTO expense_categories (id, tenant_id, name, is_system)
         VALUES ($1, $2, 'Rent', true)`,
        [categoryId, shop.tenantId],
      );
      await sql.query(
        `INSERT INTO expenses (
           id, tenant_id, category_id, amount, expense_date, business_date, created_by
         ) VALUES ($1, $2, $3, 1500, $4, DATE '2026-09-23', $5)`,
        [expenseId, shop.tenantId, categoryId, AT, shop.userId],
      );
      const movements = await sql.query(
        `SELECT count(*)::int AS n FROM inventory_movements WHERE tenant_id = $1`,
        [shop.tenantId],
      );
      const sales = await sql.query(
        `SELECT count(*)::int AS n FROM sales WHERE tenant_id = $1`,
        [shop.tenantId],
      );
      const summaries = await sql.query(
        `SELECT count(*)::int AS n FROM daily_summaries WHERE tenant_id = $1`,
        [shop.tenantId],
      );
      assert.equal(movements.rows[0].n, 0);
      assert.equal(sales.rows[0].n, 0);
      assert.equal(summaries.rows[0].n, 0);
    });
  });

  it("does not let an AI intake draft create stock", async () => {
    await withTx(async (sql) => {
      const shop = await shopFixture(sql);
      const [sessionId, itemId] = await ids(sql, 2);
      await sql.query(
        `INSERT INTO ai_intake_sessions (
           id, tenant_id, created_by, source_type, media_reference, status
         ) VALUES ($1, $2, $3, 'IMAGE', 'dev/intake.jpg', 'CONFIRMED')`,
        [sessionId, shop.tenantId, shop.userId],
      );
      await sql.query(
        `INSERT INTO ai_intake_items (
           id, tenant_id, session_id, position, detected_name, detected_name_hi,
           suggested_quantity, suggested_purchase_price, suggested_selling_price, confidence, status
         ) VALUES ($1, $2, $3, 0, 'Sugar', 'साखर', 5, 40, 50, 0.8200, 'ACCEPTED')`,
        [itemId, shop.tenantId, sessionId],
      );
      const movements = await sql.query(
        `SELECT count(*)::int AS n FROM inventory_movements WHERE tenant_id = $1`,
        [shop.tenantId],
      );
      const links = await sql.query(
        `SELECT count(*)::int AS n
         FROM pg_constraint
         WHERE confrelid IN ('inventory_movements'::regclass, 'inventory_balances'::regclass)
           AND conrelid IN ('ai_intake_sessions'::regclass, 'ai_intake_items'::regclass)`,
      );
      assert.equal(movements.rows[0].n, 0);
      assert.equal(links.rows[0].n, 0);
    });
  });

  it("rejects a repeated idempotency key for the same shop", async () => {
    await withTx(async (sql) => {
      const shop = await shopFixture(sql);
      const [first, second] = await ids(sql, 2);
      await sql.query(
        `INSERT INTO idempotency_keys (id, tenant_id, key) VALUES ($1, $2, 'sale-client-1')`,
        [first, shop.tenantId],
      );
      await assert.rejects(
        sql.query(
          `INSERT INTO idempotency_keys (id, tenant_id, key) VALUES ($1, $2, 'sale-client-1')`,
          [second, shop.tenantId],
        ),
        (error: { code?: string }) => error.code === "23505",
      );
    });
  });

  it("allocates distinct bill numbers under concurrent locks", async () => {
    const setup = await connect();
    const [tenantId, userId] = (
      await setup.query<{ id: string }>(
        "SELECT uuidv7()::text AS id FROM generate_series(1, 2)",
      )
    ).rows.map((row) => row.id);
    await setup.query(
      `INSERT INTO users (id, phone, name) VALUES ($1, $2, '[DEV] Counter')`,
      [userId, `+91${userId.replace(/\D/g, "").slice(0, 10)}`],
    );
    await setup.query(
      `INSERT INTO tenants (id, name, business_type, phone)
       VALUES ($1, '[DEV] Counter Shop', 'GENERAL', '+910000000088')`,
      [tenantId],
    );
    await setup.query(
      `INSERT INTO document_counters (tenant_id, document_type, prefix, next_number, pad_width)
       VALUES ($1, 'SALE', 'S-', 1, 5)`,
      [tenantId],
    );
    await setup.end();

    const first = await connect();
    const second = await connect();
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      const firstNumber = await first.query<{ n: string }>(
        `SELECT next_document_number($1, 'SALE') AS n`,
        [tenantId],
      );
      const secondWait = second.query<{ n: string }>(
        `SELECT next_document_number($1, 'SALE') AS n`,
        [tenantId],
      );
      await first.query("COMMIT");
      const secondNumber = await secondWait;
      await second.query("COMMIT");
      assert.equal(firstNumber.rows[0].n, "S-00001");
      assert.equal(secondNumber.rows[0].n, "S-00002");
    } finally {
      await first.end();
      await second.end();
      const cleanup = await connect();
      await cleanup.query(`DELETE FROM document_counters WHERE tenant_id = $1`, [tenantId]);
      await cleanup.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
      await cleanup.query(`DELETE FROM users WHERE id = $1`, [userId]);
      await cleanup.end();
    }
  });
});
