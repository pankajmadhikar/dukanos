import "dotenv/config";
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "@jest/globals";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Client } from "pg";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { CapturingOtpSender } from "../src/auth/capturing-otp-sender";
import { OTP_SENDER } from "../src/auth/otp-sender";
import { normalizeIndianPhone } from "../src/auth/phone";
import { configureApp } from "../src/configure-app";

jest.setTimeout(60_000);
process.env.PRISMA_CONNECTION_LIMIT = "2";
process.env.OTP_IP_LIMIT = "500";

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  throw new Error("DATABASE_ADMIN_URL is required for sales tests.");
}

let serial = 7600001000;
const phones: string[] = [];

describe("sales", () => {
  let app: INestApplication;
  let admin: Client;
  let sender: CapturingOtpSender;
  let ownerToken = "";
  let ownerShop = "";
  let shopId = "";
  let locationId = "";
  let cashierToken = "";
  let cashierShop = "";
  let stockToken = "";
  let stockShop = "";
  let otherToken = "";
  let otherShop = "";
  let otherLocationId = "";
  let unitId = "";

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.init();
    sender = app.get<CapturingOtpSender>(OTP_SENDER);

    const owner = await login(nextNational());
    ownerToken = owner.token;
    const created = await createShop(ownerToken, "[SAL] Shop A");
    shopId = created.id;
    ownerShop = created.shopContext;
    locationId = await defaultLocation(shopId);

    const cashier = await login(nextNational());
    const stock = await login(nextNational());
    const other = await login(nextNational());
    await admin.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role)
       VALUES ($1, $2, $3, 'CASHIER'), ($4, $2, $5, 'STOCK_KEEPER')
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [randomUUID(), shopId, cashier.userId, randomUUID(), stock.userId],
    );
    cashierToken = cashier.token;
    cashierShop = await selectShop(cashier.token, shopId);
    stockToken = stock.token;
    stockShop = await selectShop(stock.token, shopId);
    otherToken = other.token;
    const otherCreated = await createShop(other.token, "[SAL] Shop B");
    otherShop = otherCreated.shopContext;
    otherLocationId = await defaultLocation(otherCreated.id);

    const unit = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/units")
      .send({ name: "Piece", shortCode: "pcs", decimalPlaces: 0 });
    assert.equal(unit.status, 201, JSON.stringify(unit.body));
    unitId = unit.body.data.id as string;
  });

  afterAll(async () => {
    delete process.env.PRISMA_CONNECTION_LIMIT;
    try {
      if (admin) {
        await cleanup(admin, phones);
        await admin.end();
      }
    } finally {
      if (app) {
        await app.close();
      }
    }
  });

  it("creates, lists, and deactivates customers inside the shop", async () => {
    const created = await authed(cashierToken, cashierShop)
      .post("/api/v1/customers")
      .send({ name: "  Rahul  ", phone: "9876500001" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.name, "Rahul");
    assert.equal(created.body.data.receivableBalance, "0.00");
    assert.equal(created.body.data.isActive, true);

    const listed = await authed(ownerToken, ownerShop).get("/api/v1/customers?search=rahul");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data[0].id, created.body.data.id);

    const otherList = await authed(otherToken, otherShop).get("/api/v1/customers");
    assert.equal(
      otherList.body.data.some((row: { id: string }) => row.id === created.body.data.id),
      false,
    );
    const otherGet = await authed(otherToken, otherShop).get(`/api/v1/customers/${created.body.data.id}`);
    assert.equal(otherGet.status, 404);
    const otherPatch = await authed(otherToken, otherShop)
      .patch(`/api/v1/customers/${created.body.data.id}`)
      .send({ name: "Stolen" });
    assert.equal(otherPatch.status, 404);

    const noted = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/customers/${created.body.data.id}`)
      .send({ notes: "Pays weekly" });
    assert.equal(noted.status, 200);
    assert.equal(noted.body.data.notes, "Pays weekly");

    const off = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/customers/${created.body.data.id}`)
      .send({ isActive: false });
    assert.equal(off.body.data.isActive, false);
    const activeOnly = await authed(ownerToken, ownerShop).get("/api/v1/customers");
    assert.equal(
      activeOnly.body.data.some((row: { id: string }) => row.id === created.body.data.id),
      false,
    );
    const including = await authed(ownerToken, ownerShop).get("/api/v1/customers?isActive=all");
    assert.equal(
      including.body.data.some((row: { id: string }) => row.id === created.body.data.id),
      true,
    );
  });

  it("sells stock, records COGS, and keeps the historical price", async () => {
    const customerId = await createCustomer("Cost buyer");
    const productId = await createProduct("Soap", "100.00");
    await openStock(productId, "10", "80.00");
    const sold = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({
        customerId,
        saleDate: "2026-09-24",
        items: [{ productId, quantity: "3" }],
        payments: [{ method: "CASH", amount: "300.00" }],
      });
    assert.equal(sold.status, 201, JSON.stringify(sold.body));
    assert.match(sold.body.data.saleNumber, /^S-\d{5}$/);
    assert.equal(sold.body.data.businessDate, "2026-09-24");
    assert.equal(sold.body.data.total, "300.00");
    assert.equal(sold.body.data.paid, "300.00");
    assert.equal(sold.body.data.outstanding, "0.00");
    assert.equal(sold.body.data.paymentStatus, "PAID");
    assert.equal(sold.body.data.items[0].unitPrice, "100.00");
    assert.equal(sold.body.data.items[0].lineTotal, "300.00");
    assert.equal(sold.body.data.items[0].unitCost, "80.00");
    assert.equal(sold.body.data.cogs, "240.00");
    assert.equal(sold.body.data.grossProfit, "60.00");
    assert.equal(sold.body.data.payments.length, 1);
    await assertStock(productId, "7.000", "80.00");

    const movement = await admin.query<{
      movement_type: string;
      reference_type: string;
      reference_id: string;
      source_line_id: string;
      unit_cost: string;
    }>(
      `SELECT movement_type, reference_type, reference_id::text, source_line_id::text, unit_cost::text
       FROM inventory_movements
       WHERE product_id = $1::uuid AND movement_type = 'SALE'`,
      [productId],
    );
    assert.equal(movement.rows[0]?.movement_type, "SALE");
    assert.equal(movement.rows[0]?.reference_type, "SALE");
    assert.equal(movement.rows[0]?.reference_id, sold.body.data.id);
    assert.equal(movement.rows[0]?.source_line_id, sold.body.data.items[0].id);
    assert.equal(movement.rows[0]?.unit_cost, "80.00");

    const ledger = await admin.query<{ credits: string }>(
      `SELECT count(*)::text AS credits FROM customer_ledger WHERE reference_id = $1::uuid`,
      [sold.body.data.id],
    );
    assert.equal(ledger.rows[0]?.credits, "0");
    const balance = await admin.query<{ receivable: string }>(
      `SELECT receivable_balance::text AS receivable FROM customers WHERE id = $1::uuid`,
      [customerId],
    );
    assert.equal(balance.rows[0]?.receivable, "0.00");

    const cashierView = await authed(cashierToken, cashierShop).get(`/api/v1/sales/${sold.body.data.id}`);
    assert.equal(cashierView.status, 200, JSON.stringify(cashierView.body));
    assert.equal(cashierView.body.data.total, "300.00");
    assert.equal("cogs" in cashierView.body.data, false);
    assert.equal("grossProfit" in cashierView.body.data, false);
    assert.equal("unitCost" in cashierView.body.data.items[0], false);

    const stockView = await authed(stockToken, stockShop).get(`/api/v1/sales/${sold.body.data.id}`);
    assert.equal("cogs" in stockView.body.data, false);

    const repriced = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/catalog/products/${productId}`)
      .send({ defaultSellingPrice: "110.00" });
    assert.equal(repriced.status, 200);
    const detail = await authed(ownerToken, ownerShop).get(`/api/v1/sales/${sold.body.data.id}`);
    assert.equal(detail.body.data.items[0].unitPrice, "100.00");
    const listed = await authed(ownerToken, ownerShop).get(
      `/api/v1/sales?locationId=${locationId}&saleNumber=${sold.body.data.saleNumber}`,
    );
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.data[0].id, sold.body.data.id);
  });

  it("records partial, split, and walk-in payments without anonymous credit", async () => {
    const customerId = await createCustomer("Udhaar buyer");
    const productId = await createProduct("Rice bag", "100.00");
    await openStock(productId, "20", "40.00");

    const partial = await sell(customerId, productId, "5", [{ method: "CASH", amount: "300.00" }]);
    assert.equal(partial.status, 201, JSON.stringify(partial.body));
    assert.equal(partial.body.data.total, "500.00");
    assert.equal(partial.body.data.paid, "300.00");
    assert.equal(partial.body.data.outstanding, "200.00");
    assert.equal(partial.body.data.paymentStatus, "PARTIAL");
    await assertStock(productId, "15.000", "40.00");
    const owed = await admin.query<{ receivable: string; debit: string }>(
      `SELECT c.receivable_balance::text AS receivable,
              (SELECT COALESCE(SUM(debit_amount), 0)::text FROM customer_ledger
               WHERE customer_id = c.id AND entry_type = 'CREDIT_SALE' AND reference_id = $2::uuid) AS debit
       FROM customers c WHERE c.id = $1::uuid`,
      [customerId, partial.body.data.id],
    );
    assert.equal(owed.rows[0]?.receivable, "200.00");
    assert.equal(owed.rows[0]?.debit, "200.00");

    const splitProduct = await createProduct("Oil tin", "100.00");
    await openStock(splitProduct, "20", "50.00");
    const split = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({
        customerId,
        items: [{ productId: splitProduct, quantity: "10" }],
        payments: [
          { method: "CASH", amount: "400.00" },
          { method: "UPI", amount: "300.00", reference: "UPI-88" },
        ],
      });
    assert.equal(split.status, 201, JSON.stringify(split.body));
    assert.equal(split.body.data.total, "1000.00");
    assert.equal(split.body.data.paid, "700.00");
    assert.equal(split.body.data.outstanding, "300.00");
    assert.equal(split.body.data.payments.length, 2);
    const splitDebit = await admin.query<{ debit: string }>(
      `SELECT debit_amount::text AS debit FROM customer_ledger WHERE reference_id = $1::uuid`,
      [split.body.data.id],
    );
    assert.equal(splitDebit.rows[0]?.debit, "300.00");
    const afterSplit = await admin.query<{ receivable: string }>(
      `SELECT receivable_balance::text AS receivable FROM customers WHERE id = $1::uuid`,
      [customerId],
    );
    assert.equal(afterSplit.rows[0]?.receivable, "500.00");

    const walkProduct = await createProduct("Biscuit", "50.00");
    await openStock(walkProduct, "4", "10.00");
    const walk = await authed(cashierToken, cashierShop)
      .post("/api/v1/sales")
      .send({
        items: [{ productId: walkProduct, quantity: "2" }],
        payments: [{ method: "CASH", amount: "100.00" }],
      });
    assert.equal(walk.status, 201, JSON.stringify(walk.body));
    assert.equal(walk.body.data.customer, null);
    assert.equal(walk.body.data.outstanding, "0.00");
    assert.equal("cogs" in walk.body.data, false);
    const walkLedger = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM customer_ledger WHERE reference_id = $1::uuid`,
      [walk.body.data.id],
    );
    assert.equal(walkLedger.rows[0]?.count, "0");

    const salesBefore = await countSales();
    const anonymous = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({
        items: [{ productId: walkProduct, quantity: "1" }],
        payments: [{ method: "CASH", amount: "20.00" }],
      });
    assert.equal(anonymous.status, 409);
    assert.equal(anonymous.body.error.code, "CUSTOMER_REQUIRED_FOR_CREDIT");
    assert.equal(await countSales(), salesBefore);
    await assertStock(walkProduct, "2.000", "10.00");

    const over = await sell(customerId, productId, "1", [{ method: "CASH", amount: "150.00" }]);
    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, "PAYMENT_EXCEEDS_SALE");

    const history = await authed(ownerToken, ownerShop).get(`/api/v1/customers/${customerId}/sales`);
    assert.equal(history.status, 200);
    assert.equal(
      history.body.data.some((row: { id: string; outstanding: string }) => row.id === partial.body.data.id && row.outstanding === "200.00"),
      true,
    );
    const summary = await authed(cashierToken, cashierShop).get(`/api/v1/customers/${customerId}/summary`);
    assert.equal(summary.status, 200, JSON.stringify(summary.body));
    assert.equal(summary.body.data.outstanding, "500.00");
  });

  it("records cash and UPI only after the shopkeeper confirms", async () => {
    const auditsBefore = await auditCount();
    const productId = await createProduct("Soap", "100.00");
    await openStock(productId, "10", "40.00");
    const shopDay = await admin.query<{ day: string }>(
      `SELECT shop_business_date(now(), timezone)::text AS day FROM tenants WHERE id = $1::uuid`,
      [shopId],
    );
    const dayBefore = await summaryFor(shopDay.rows[0]?.day ?? "");

    const cash = await authed(cashierToken, cashierShop)
      .post("/api/v1/sales")
      .send({
        items: [{ productId, quantity: "1" }],
        payments: [{ method: "CASH", amount: "100.00" }],
      });
    assert.equal(cash.status, 201, JSON.stringify(cash.body));
    assert.equal(cash.body.data.total, "100.00");
    assert.equal(cash.body.data.paid, "100.00");
    assert.equal(cash.body.data.outstanding, "0.00");
    assert.equal(cash.body.data.customer, null);
    assert.equal(cash.body.data.payments[0].method, "CASH");
    assert.equal(cash.body.data.payments[0].amount, "100.00");
    const cashRow = await admin.query<{ payment_method: string; amount: string; external_reference: string | null }>(
      `SELECT payment_method::text, amount::text, external_reference
       FROM payments WHERE reference_id = $1::uuid`,
      [cash.body.data.id],
    );
    assert.equal(cashRow.rows.length, 1);
    assert.equal(cashRow.rows[0]?.payment_method, "CASH");
    assert.equal(cashRow.rows[0]?.amount, "100.00");
    assert.equal(cashRow.rows[0]?.external_reference, null);

    const upiKey = randomUUID();
    const upiBody = {
      items: [{ productId, quantity: "2" }],
      payments: [{ method: "UPI", amount: "200.00" }],
    };
    const upi = await authed(cashierToken, cashierShop)
      .post("/api/v1/sales")
      .set("Idempotency-Key", upiKey)
      .send(upiBody);
    assert.equal(upi.status, 201, JSON.stringify(upi.body));
    assert.equal(upi.body.data.total, "200.00");
    assert.equal(upi.body.data.paid, "200.00");
    assert.equal(upi.body.data.outstanding, "0.00");
    assert.equal(upi.body.data.customer, null);
    assert.equal(upi.body.data.payments.length, 1);
    assert.equal(upi.body.data.payments[0].method, "UPI");
    assert.equal(upi.body.data.payments[0].amount, "200.00");
    assert.equal(upi.body.data.payments[0].reference, null);
    await assertStock(productId, "7.000", "40.00");
    const movement = await admin.query<{ movement_type: string; quantity_delta: string }>(
      `SELECT movement_type::text, quantity_delta::text
       FROM inventory_movements
       WHERE reference_id = $1::uuid AND reference_type = 'SALE'`,
      [upi.body.data.id],
    );
    assert.equal(movement.rows.length, 1);
    assert.equal(movement.rows[0]?.movement_type, "SALE");
    assert.equal(movement.rows[0]?.quantity_delta, "-2.000");
    const saved = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sales WHERE id = $1::uuid`,
      [upi.body.data.id],
    );
    assert.equal(saved.rows[0]?.count, "1");

    const replay = await authed(cashierToken, cashierShop)
      .post("/api/v1/sales")
      .set("Idempotency-Key", upiKey)
      .send(upiBody);
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.data.id, upi.body.data.id);
    const duplicates = await admin.query<{ sales: string; payments: string; movements: string }>(
      `SELECT
         (SELECT count(*)::text FROM sales WHERE id = $1::uuid) AS sales,
         (SELECT count(*)::text FROM payments WHERE reference_id = $1::uuid) AS payments,
         (SELECT count(*)::text FROM inventory_movements WHERE reference_id = $1::uuid) AS movements`,
      [upi.body.data.id],
    );
    assert.equal(duplicates.rows[0]?.sales, "1");
    assert.equal(duplicates.rows[0]?.payments, "1");
    assert.equal(duplicates.rows[0]?.movements, "1");

    const dayAfter = await summaryFor(upi.body.data.businessDate as string);
    assert.equal(Number(dayAfter.totalSales) - Number(dayBefore.totalSales), 300);
    assert.equal(Number(dayAfter.transactions) - Number(dayBefore.transactions), 2);
    assert.equal(Number(await auditCount()) - Number(auditsBefore), 4);

    const rahul = await createCustomer("Rahul");
    const creditProduct = await createProduct("Atta", "500.00");
    await openStock(creditProduct, "4", "200.00");
    const credit = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({
        customerId: rahul,
        items: [{ productId: creditProduct, quantity: "1" }],
        payments: [
          { method: "CASH", amount: "200.00" },
          { method: "UPI", amount: "100.00" },
        ],
      });
    assert.equal(credit.status, 201, JSON.stringify(credit.body));
    assert.equal(credit.body.data.total, "500.00");
    assert.equal(credit.body.data.paid, "300.00");
    assert.equal(credit.body.data.outstanding, "200.00");
    const tenders = credit.body.data.payments as Array<{ method: string; amount: string }>;
    assert.deepEqual(
      tenders.map((row) => `${row.method}:${row.amount}`).sort(),
      ["CASH:200.00", "UPI:100.00"],
    );
    const receivable = await admin.query<{ receivable: string }>(
      `SELECT receivable_balance::text AS receivable FROM customers WHERE id = $1::uuid`,
      [rahul],
    );
    assert.equal(receivable.rows[0]?.receivable, "200.00");
    await assertStock(creditProduct, "3.000", "200.00");
    const creditDay = await summaryFor(credit.body.data.businessDate as string);
    assert.equal(Number(creditDay.totalSales) > Number(dayAfter.totalSales), true);

    const salesBefore = await countSales();
    const stockBefore = await movementCount(productId);
    for (const method of ["CARD", "BANK_TRANSFER", "OTHER"]) {
      const rejected = await authed(ownerToken, ownerShop)
        .post("/api/v1/sales")
        .send({
          items: [{ productId, quantity: "1" }],
          payments: [{ method, amount: "100.00" }],
        });
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
      assert.equal(rejected.body.error.code, "VALIDATION_ERROR");
      assert.equal(
        JSON.stringify(rejected.body.error.details).includes("payments.0.method"),
        true,
        JSON.stringify(rejected.body),
      );
    }
    const filtered = await authed(ownerToken, ownerShop).get("/api/v1/sales?paymentMethod=CARD");
    assert.equal(filtered.status, 400);
    assert.equal(filtered.body.error.code, "VALIDATION_ERROR");
    assert.equal(await countSales(), salesBefore);
    assert.equal(await movementCount(productId), stockBefore);
    await assertStock(productId, "7.000", "40.00");

    const spec = await request(app.getHttpServer()).get("/api/docs-json");
    const schemas = spec.body.components.schemas as Record<string, { properties?: { method?: { enum?: string[] } } }>;
    assert.deepEqual(schemas.SalePaymentDto?.properties?.method?.enum, ["CASH", "UPI"]);
  });

  it("uses the customer price and rolls back invalid sales", async () => {
    const special = await createCustomer("Special");
    const regular = await createCustomer("Regular");
    const productId = await createProduct("Tea", "100.00");
    await openStock(productId, "30", "20.00");
    const priced = await authed(ownerToken, ownerShop)
      .post(`/api/v1/catalog/products/${productId}/customer-prices`)
      .send({ customerId: special, sellingPrice: "90.00" });
    assert.equal(priced.status, 200, JSON.stringify(priced.body));
    const cashierPrice = await authed(cashierToken, cashierShop)
      .post(`/api/v1/catalog/products/${productId}/customer-prices`)
      .send({ customerId: special, sellingPrice: "1.00" });
    assert.equal(cashierPrice.status, 403);

    const specialSale = await sell(special, productId, "1", [{ method: "CASH", amount: "90.00" }]);
    assert.equal(specialSale.status, 201, JSON.stringify(specialSale.body));
    assert.equal(specialSale.body.data.items[0].unitPrice, "90.00");
    assert.equal(specialSale.body.data.items[0].priceSource, "CUSTOMER");
    const regularSale = await sell(regular, productId, "1", [{ method: "CASH", amount: "100.00" }]);
    assert.equal(regularSale.status, 201, JSON.stringify(regularSale.body));
    assert.equal(regularSale.body.data.items[0].unitPrice, "100.00");
    assert.equal(regularSale.body.data.items[0].priceSource, "LIST");

    await authed(ownerToken, ownerShop)
      .patch(`/api/v1/catalog/products/${productId}`)
      .send({ defaultSellingPrice: "110.00" });
    const kept = await authed(ownerToken, ownerShop).get(`/api/v1/sales/${specialSale.body.data.id}`);
    assert.equal(kept.body.data.items[0].unitPrice, "90.00");
    const productSales = await authed(ownerToken, ownerShop).get(`/api/v1/catalog/products/${productId}/sales`);
    assert.equal(productSales.status, 200);
    assert.equal(
      productSales.body.data.some((row: { unitPrice: string }) => row.unitPrice === "90.00"),
      true,
    );

    const good = await createProduct("Good pen", "10.00");
    const bad = await createProduct("Bad pen", "10.00");
    await openStock(good, "10", "4.00");
    await openStock(bad, "2", "4.00");
    const salesBefore = await countSales();
    const movementsBefore = await movementCount(good);
    const mixed = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({
        customerId: regular,
        items: [
          { productId: good, quantity: "5" },
          { productId: bad, quantity: "3" },
        ],
        payments: [{ method: "CASH", amount: "80.00" }],
      });
    assert.equal(mixed.status, 409, JSON.stringify(mixed.body));
    assert.equal(mixed.body.error.code, "INSUFFICIENT_STOCK");
    assert.equal(await countSales(), salesBefore);
    assert.equal(await movementCount(good), movementsBefore);
    await assertStock(good, "10.000", "4.00");
    await assertStock(bad, "2.000", "4.00");

    const short = await createProduct("Short stock", "10.00");
    await openStock(short, "2", "5.00");
    const tooMany = await sell(regular, short, "3", [{ method: "CASH", amount: "30.00" }]);
    assert.equal(tooMany.status, 409);
    assert.equal(tooMany.body.error.code, "INSUFFICIENT_STOCK");
    await assertStock(short, "2.000", "5.00");
    const stray = await admin.query<{ payments: string; ledger: string }>(
      `SELECT
         (SELECT count(*)::text FROM payments WHERE reference_id IS NOT NULL AND reference_type = 'SALE'
            AND reference_id NOT IN (SELECT id FROM sales)) AS payments,
         (SELECT count(*)::text FROM customer_ledger WHERE reference_type = 'SALE'
            AND reference_id NOT IN (SELECT id FROM sales)) AS ledger`,
    );
    assert.equal(stray.rows[0]?.payments, "0");
    assert.equal(stray.rows[0]?.ledger, "0");

    await authed(ownerToken, ownerShop).post(`/api/v1/catalog/products/${good}/deactivate`).send({});
    const inactiveProduct = await sell(regular, good, "1", [{ method: "CASH", amount: "10.00" }]);
    assert.equal(inactiveProduct.status, 409);
    assert.equal(inactiveProduct.body.error.code, "PRODUCT_INACTIVE");

    await authed(ownerToken, ownerShop).patch(`/api/v1/customers/${special}`).send({ isActive: false });
    const inactiveCustomer = await sell(special, productId, "1", [{ method: "CASH", amount: "90.00" }]);
    assert.equal(inactiveCustomer.status, 409);
    assert.equal(inactiveCustomer.body.error.code, "CUSTOMER_INACTIVE");

    const zero = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({ customerId: regular, items: [{ productId, quantity: "0" }], payments: [] });
    assert.equal(zero.status, 400);
    const duplicate = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({
        customerId: regular,
        items: [
          { productId, quantity: "1" },
          { productId, quantity: "1" },
        ],
        payments: [{ method: "CASH", amount: "200.00" }],
      });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, "DUPLICATE_SALE_LINE");

    const foreign = await authed(otherToken, otherShop)
      .post("/api/v1/customers")
      .send({ name: "Other customer" });
    const stolenCustomer = await sell(foreign.body.data.id as string, productId, "1", [
      { method: "CASH", amount: "110.00" },
    ]);
    assert.equal(stolenCustomer.status, 404);
    assert.equal(stolenCustomer.body.error.code, "CUSTOMER_NOT_FOUND");
    const foreignLocation = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({
        customerId: regular,
        locationId: otherLocationId,
        items: [{ productId, quantity: "1" }],
        payments: [{ method: "CASH", amount: "110.00" }],
      });
    assert.equal(foreignLocation.status, 404);
    const hidden = await authed(otherToken, otherShop).get(`/api/v1/sales/${specialSale.body.data.id}`);
    assert.equal(hidden.status, 404);
  });

  it("keeps retries, concurrent bills, and side effects consistent", async () => {
    const customerId = await createCustomer("Retry buyer");
    const productId = await createProduct("Salt", "25.00");
    await openStock(productId, "40", "10.00");
    const key = `sale-${productId}`;
    const body = {
      customerId,
      items: [{ productId, quantity: "4" }],
      payments: [{ method: "CASH", amount: "60.00" }],
    };
    const first = await authed(ownerToken, ownerShop).post("/api/v1/sales").set("Idempotency-Key", key).send(body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await authed(ownerToken, ownerShop).post("/api/v1/sales").set("Idempotency-Key", key).send(body);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.data.id, first.body.data.id);
    assert.equal(second.body.data.saleNumber, first.body.data.saleNumber);
    assert.equal(await movementCount(productId), "2");
    const money = await admin.query<{ payments: string; ledger: string }>(
      `SELECT
         (SELECT count(*)::text FROM payments WHERE reference_id = $1::uuid) AS payments,
         (SELECT count(*)::text FROM customer_ledger WHERE reference_id = $1::uuid) AS ledger`,
      [first.body.data.id],
    );
    assert.equal(money.rows[0]?.payments, "1");
    assert.equal(money.rows[0]?.ledger, "1");
    await assertStock(productId, "36.000", "10.00");
    const changed = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .set("Idempotency-Key", key)
      .send({ ...body, items: [{ productId, quantity: "5" }] });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, "IDEMPOTENCY_CONFLICT");

    const shared = await createProduct("Shared sack", "20.00");
    await openStock(shared, "10", "8.00");
    const salesBefore = await countSales();
    const auditsBefore = await auditCount();
    const [left, right] = await Promise.all([
      authed(ownerToken, ownerShop)
        .post("/api/v1/sales")
        .send({
          customerId,
          items: [{ productId: shared, quantity: "7" }],
          payments: [{ method: "CASH", amount: "140.00" }],
        }),
      authed(stockToken, stockShop)
        .post("/api/v1/sales")
        .send({
          customerId,
          items: [{ productId: shared, quantity: "6" }],
          payments: [{ method: "UPI", amount: "120.00" }],
        }),
    ]);
    const results = [left, right];
    const ok = results.filter((result) => result.status === 201);
    const denied = results.filter((result) => result.status === 409);
    assert.equal(ok.length, 1, JSON.stringify(results.map((result) => result.body)));
    assert.equal(denied.length, 1);
    assert.equal(denied[0]?.body.error.code, "INSUFFICIENT_STOCK");
    const soldQuantity = ok[0]?.body.data.items[0].quantity as string;
    await assertStock(shared, soldQuantity === "7.000" ? "3.000" : "4.000", "8.00");
    assert.equal(Number(await countSales()) - Number(salesBefore), 1);
    const auditsAfter = await auditCount();
    assert.equal(Number(auditsAfter) - Number(auditsBefore), 2);
    assert.notEqual(ok[0]?.body.data.saleNumber, undefined);
    assert.match(ok[0]?.body.data.saleNumber as string, /^S-\d{5}$/);

    const leftBill = await createProduct("Left bill", "5.00");
    const rightBill = await createProduct("Right bill", "5.00");
    await openStock(leftBill, "2", "1.00");
    await openStock(rightBill, "2", "1.00");
    const [a, b] = await Promise.all([
      sell(customerId, leftBill, "1", [{ method: "CASH", amount: "5.00" }]),
      sell(customerId, rightBill, "1", [{ method: "CASH", amount: "5.00" }]),
    ]);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.notEqual(a.body.data.saleNumber, b.body.data.saleNumber);

    const side = await admin.query<{ purchases: string; supplier_ledger: string; expenses: string }>(
      `SELECT
         (SELECT count(*)::text FROM purchases WHERE tenant_id = $1::uuid) AS purchases,
         (SELECT count(*)::text FROM supplier_ledger WHERE tenant_id = $1::uuid) AS supplier_ledger,
         (SELECT count(*)::text FROM expenses WHERE tenant_id = $1::uuid) AS expenses`,
      [shopId],
    );
    assert.equal(side.rows[0]?.purchases, "0");
    assert.equal(side.rows[0]?.supplier_ledger, "0");
    assert.equal(side.rows[0]?.expenses, "0");

    const summary = await admin.query<{ total_sales: string; transaction_count: string }>(
      `SELECT total_sales::text, transaction_count::text
       FROM daily_summaries WHERE tenant_id = $1::uuid AND business_date = $2::date`,
      [shopId, first.body.data.businessDate],
    );
    assert.equal(Number(summary.rows[0]?.transaction_count) > 0, true);
    assert.equal(Number(summary.rows[0]?.total_sales) > 0, true);

    const spec = await request(app.getHttpServer()).get("/api/docs-json");
    const paths = Object.keys(spec.body.paths as Record<string, unknown>);
    for (const path of [
      "/api/v1/customers",
      "/api/v1/customers/{customerId}",
      "/api/v1/customers/{customerId}/sales",
      "/api/v1/customers/{customerId}/summary",
      "/api/v1/sales",
      "/api/v1/sales/{saleId}",
      "/api/v1/catalog/products/{productId}/sales",
      "/api/v1/catalog/products/{id}/customer-prices",
    ]) {
      assert.equal(paths.includes(path), true, path);
    }
  });

  it("accepts an offline sale at a known selling price and still rejects negative stock", async () => {
    const productId = await createProduct("Parle-G", "10.00");
    await openStock(productId, "10", "6.00");
    const raised = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/catalog/products/${productId}`)
      .send({ defaultSellingPrice: "12.00" });
    assert.equal(raised.status, 200, JSON.stringify(raised.body));

    const key = `offline-sale:${productId}`;
    const offlineBody = {
      source: "OFFLINE_SYNC",
      items: [{ productId, quantity: "7", unitPrice: "10.00" }],
      payments: [{ method: "CASH", amount: "70.00" }],
    };
    const posted = await authed(ownerToken, ownerShop).post("/api/v1/sales").set("Idempotency-Key", key).send(offlineBody);
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    assert.equal(posted.body.data.items[0].unitPrice, "10.00");
    assert.match(posted.body.data.saleNumber as string, /^S-\d{5}$/);
    await assertStock(productId, "3.000", "6.00");

    const replay = await authed(ownerToken, ownerShop).post("/api/v1/sales").set("Idempotency-Key", key).send(offlineBody);
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.data.id, posted.body.data.id);
    assert.equal(await movementCount(productId), "2");
    const audits = await admin.query<{ created: string; source: string | null }>(
      `SELECT
         (SELECT count(*)::text FROM audit_logs WHERE entity_id = $1::uuid AND action = 'sale.created') AS created,
         (SELECT metadata->>'source' FROM audit_logs WHERE entity_id = $1::uuid AND action = 'sale.created' LIMIT 1) AS source`,
      [posted.body.data.id],
    );
    assert.equal(audits.rows[0]?.created, "1");
    assert.equal(audits.rows[0]?.source, "OFFLINE_SYNC");

    const changed = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .set("Idempotency-Key", key)
      .send({ ...offlineBody, items: [{ productId, quantity: "1", unitPrice: "10.00" }] });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, "IDEMPOTENCY_CONFLICT");

    const livePrice = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({ items: [{ productId, quantity: "1", unitPrice: "10.00" }], payments: [{ method: "CASH", amount: "10.00" }] });
    assert.equal(livePrice.status, 409);
    assert.equal(livePrice.body.error.code, "SALE_PRICE_MISMATCH");

    const short = await authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({
        source: "OFFLINE_SYNC",
        items: [{ productId, quantity: "6", unitPrice: "12.00" }],
        payments: [{ method: "CASH", amount: "72.00" }],
      });
    assert.equal(short.status, 409);
    assert.equal(short.body.error.code, "INSUFFICIENT_STOCK");
    assert.match(short.body.error.message as string, /Available: 3/);
    assert.match(short.body.error.message as string, /Requested: 6/);
    await assertStock(productId, "3.000", "6.00");

    const catalog = await authed(cashierToken, cashierShop).get("/api/v1/pos/catalog?limit=100");
    assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
    const row = (catalog.body.data as Array<Record<string, unknown>>).find((item) => item.productId === productId);
    assert.ok(row);
    assert.equal(row?.sellingPrice, "12.00");
    assert.equal(row?.quantity, "3.000");
    assert.equal("purchasePrice" in (row ?? {}), false);
    assert.equal("averageCost" in (row ?? {}), false);
    const customers = await authed(cashierToken, cashierShop).get("/api/v1/pos/customers?limit=100");
    assert.equal(customers.status, 200, JSON.stringify(customers.body));
    const prices = await authed(cashierToken, cashierShop).get("/api/v1/pos/customer-prices?limit=100");
    assert.equal(prices.status, 200, JSON.stringify(prices.body));
  });

  function authed(token: string, shopContext: string) {
    const http = request(app.getHttpServer());
    const headers = (method: "get" | "post" | "patch" | "delete") => (path: string) =>
      http[method](path).set("Authorization", `Bearer ${token}`).set("x-dukaan-shop", shopContext);
    return { get: headers("get"), post: headers("post"), patch: headers("patch"), delete: headers("delete") };
  }

  async function login(national: string): Promise<{ token: string; userId: string }> {
    const requested = await request(app.getHttpServer()).post("/api/v1/auth/request-otp").send({ phone: national });
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    const code = sender.latest(normalizeIndianPhone(national));
    assert.ok(code);
    const verified = await request(app.getHttpServer())
      .post("/api/v1/auth/verify-otp")
      .send({ phone: national, code });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    return { token: verified.body.data.token as string, userId: verified.body.data.user.id as string };
  }

  async function createShop(token: string, name: string): Promise<{ id: string; shopContext: string }> {
    const response = await request(app.getHttpServer())
      .post("/api/v1/tenants")
      .set("Authorization", `Bearer ${token}`)
      .send({ name, businessType: "GROCERY" });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { id: response.body.data.id as string, shopContext: response.body.data.shopContext as string };
  }

  async function selectShop(token: string, tenantId: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/tenants/${tenantId}/select`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.data.shopContext as string;
  }

  async function createCustomer(name: string): Promise<string> {
    const response = await authed(ownerToken, ownerShop).post("/api/v1/customers").send({ name });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.id as string;
  }

  async function createProduct(name: string, sellingPrice: string): Promise<string> {
    const response = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/products")
      .send({ name, unitId, defaultSellingPrice: sellingPrice });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.id as string;
  }

  async function openStock(productId: string, quantity: string, unitCost: string): Promise<void> {
    const response = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .send({ productId, quantity, unitCost });
    assert.equal(response.status, 201, JSON.stringify(response.body));
  }

  function sell(
    customerId: string,
    productId: string,
    quantity: string,
    payments: Array<{ method: string; amount: string }>,
  ) {
    return authed(ownerToken, ownerShop)
      .post("/api/v1/sales")
      .send({ customerId, items: [{ productId, quantity }], payments });
  }

  async function defaultLocation(tenantId: string): Promise<string> {
    const rows = await admin.query<{ id: string }>(
      `SELECT id FROM locations WHERE tenant_id = $1::uuid AND is_default = true`,
      [tenantId],
    );
    const id = rows.rows[0]?.id;
    assert.ok(id);
    return id;
  }

  async function assertStock(productId: string, quantity: string, averageCost: string): Promise<void> {
    const rows = await admin.query<{ quantity: string; average_cost: string }>(
      `SELECT quantity::text, average_cost::text FROM inventory_balances WHERE product_id = $1::uuid`,
      [productId],
    );
    assert.equal(rows.rows[0]?.quantity, quantity);
    assert.equal(rows.rows[0]?.average_cost, averageCost);
  }

  async function movementCount(productId: string): Promise<string> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inventory_movements WHERE product_id = $1::uuid`,
      [productId],
    );
    return rows.rows[0]?.count ?? "0";
  }

  async function countSales(): Promise<string> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sales WHERE tenant_id = $1::uuid`,
      [shopId],
    );
    return rows.rows[0]?.count ?? "0";
  }

  async function summaryFor(businessDate: string): Promise<{ totalSales: string; transactions: string }> {
    const rows = await admin.query<{ total_sales: string; transaction_count: string }>(
      `SELECT total_sales::text, transaction_count::text
       FROM daily_summaries WHERE tenant_id = $1::uuid AND business_date = $2::date`,
      [shopId, businessDate],
    );
    return {
      totalSales: rows.rows[0]?.total_sales ?? "0",
      transactions: rows.rows[0]?.transaction_count ?? "0",
    };
  }

  async function auditCount(): Promise<string> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
       WHERE tenant_id = $1::uuid AND action IN ('sale.created', 'sale.posted')`,
      [shopId],
    );
    return rows.rows[0]?.count ?? "0";
  }
});

function nextNational(): string {
  serial += 1;
  const national = String(serial);
  phones.push(normalizeIndianPhone(national));
  return national;
}

async function cleanup(admin: Client, numbers: string[]): Promise<void> {
  const tenants = `(SELECT id FROM tenants WHERE name LIKE '[SAL]%')`;
  await admin.query("ALTER TABLE inventory_movements DISABLE TRIGGER inventory_movements_append_only");
  await admin.query("ALTER TABLE stock_adjustment_items DISABLE TRIGGER stock_adjustment_items_draft_only");
  await admin.query("ALTER TABLE stock_adjustments DISABLE TRIGGER stock_adjustments_no_delete");
  await admin.query("ALTER TABLE customer_ledger DISABLE TRIGGER customer_ledger_append_only");
  await admin.query("ALTER TABLE payments DISABLE TRIGGER payments_append_only");
  await admin.query("ALTER TABLE sale_items DISABLE TRIGGER sale_items_append_only");
  await admin.query("ALTER TABLE sales DISABLE TRIGGER sales_no_delete");
  await admin.query("ALTER TABLE product_price_history DISABLE TRIGGER product_price_history_append_only");
  await admin.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only");
  try {
    await admin.query(`DELETE FROM inventory_movements WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM inventory_balances WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM stock_adjustment_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM stock_adjustments WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM customer_ledger WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM payments WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM sale_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM sales WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM daily_summaries WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM idempotency_keys WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM customer_product_prices WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM product_price_history WHERE tenant_id IN ${tenants}`);
    await admin.query(
      `DELETE FROM audit_logs
       WHERE tenant_id IN ${tenants}
          OR actor_user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
      [numbers],
    );
  } finally {
    await admin.query("ALTER TABLE inventory_movements ENABLE TRIGGER inventory_movements_append_only");
    await admin.query("ALTER TABLE stock_adjustment_items ENABLE TRIGGER stock_adjustment_items_draft_only");
    await admin.query("ALTER TABLE stock_adjustments ENABLE TRIGGER stock_adjustments_no_delete");
    await admin.query("ALTER TABLE customer_ledger ENABLE TRIGGER customer_ledger_append_only");
    await admin.query("ALTER TABLE payments ENABLE TRIGGER payments_append_only");
    await admin.query("ALTER TABLE sale_items ENABLE TRIGGER sale_items_append_only");
    await admin.query("ALTER TABLE sales ENABLE TRIGGER sales_no_delete");
    await admin.query("ALTER TABLE product_price_history ENABLE TRIGGER product_price_history_append_only");
    await admin.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only");
  }
  await admin.query(`DELETE FROM product_barcodes WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM products WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM units WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM customers WHERE tenant_id IN ${tenants}`);
  await admin.query(
    `DELETE FROM memberships
     WHERE tenant_id IN ${tenants}
        OR user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`UPDATE tenants SET default_location_id = NULL WHERE name LIKE '[SAL]%'`);
  await admin.query(`DELETE FROM locations WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM document_counters WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM expense_categories WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM tenants WHERE name LIKE '[SAL]%'`);
  await admin.query(
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`DELETE FROM otp_challenges WHERE phone = ANY($1::text[])`, [numbers]);
  await admin.query(`DELETE FROM users WHERE phone = ANY($1::text[])`, [numbers]);
}
