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
  throw new Error("DATABASE_ADMIN_URL is required for settlement tests.");
}

let serial = 7900001000;
const phones: string[] = [];

describe("settlements", () => {
  let app: INestApplication;
  let admin: Client;
  let sender: CapturingOtpSender;
  let ownerToken = "";
  let ownerShop = "";
  let ownerUserId = "";
  let shopId = "";
  let cashierToken = "";
  let cashierShop = "";
  let cashierUserId = "";
  let stockToken = "";
  let stockShop = "";
  let stockUserId = "";
  let adminToken = "";
  let adminShop = "";
  let otherToken = "";
  let otherShop = "";
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
    ownerUserId = owner.userId;
    const created = await createShop(ownerToken, "[PAY] Shop A");
    shopId = created.id;
    ownerShop = created.shopContext;

    const cashier = await login(nextNational());
    const stock = await login(nextNational());
    const manager = await login(nextNational());
    const other = await login(nextNational());
    await admin.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role)
       VALUES ($1, $2, $3, 'CASHIER'), ($4, $2, $5, 'STOCK_KEEPER'), ($6, $2, $7, 'ADMIN')
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [
        randomUUID(),
        shopId,
        cashier.userId,
        randomUUID(),
        stock.userId,
        randomUUID(),
        manager.userId,
      ],
    );
    cashierToken = cashier.token;
    cashierUserId = cashier.userId;
    cashierShop = await selectShop(cashier.token, shopId);
    stockToken = stock.token;
    stockUserId = stock.userId;
    stockShop = await selectShop(stock.token, shopId);
    adminToken = manager.token;
    adminShop = await selectShop(manager.token, shopId);
    otherToken = other.token;
    const otherCreated = await createShop(other.token, "[PAY] Shop B");
    otherShop = otherCreated.shopContext;

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

  it("settles a customer receivable without changing sales", async () => {
    const productId = await createProduct("Settlement rice", "1000.00");
    await openStock(productId, "5", "400.00");
    const customerId = await createCustomer("Rahul");
    const sold = await sell(customerId, productId, "1", [{ method: "CASH", amount: "700.00" }]);
    assert.equal(sold.status, 201, JSON.stringify(sold.body));
    assert.equal(sold.body.data.outstanding, "300.00");

    const before = await shopTotals();
    const salesBefore = await countRows("sales");
    const movementsBefore = await countRows("inventory_movements");

    const detail = await authed(cashierToken, cashierShop).get(`/api/v1/customers/${customerId}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.data.receivableBalance, "300.00");
    assert.equal(detail.body.data.paymentCount, 0);
    assert.equal(detail.body.data.latestPayment, null);

    const over = await payCustomer(
      ownerToken,
      ownerShop,
      customerId,
      { amount: "400.00", method: "CASH" },
      "cust-rollback",
    );
    assert.equal(over.status, 409, JSON.stringify(over.body));
    assert.equal(over.body.success, false);
    assert.equal(over.body.error.code, "PAYMENT_EXCEEDS_OUTSTANDING");
    assert.equal(typeof over.body.error.requestId, "string");
    assert.equal(await receiptCount(customerId), "0");
    assert.equal(await receivable(customerId), "300.00");

    const partial = await payCustomer(
      stockToken,
      stockShop,
      customerId,
      { amount: "100.00", method: "UPI", reference: "UTR-100", note: "Counter" },
      "cust-rollback",
    );
    assert.equal(partial.status, 201, JSON.stringify(partial.body));
    assert.equal(partial.body.data.amount, "100.00");
    assert.equal(partial.body.data.method, "UPI");
    assert.equal(partial.body.data.reference, "UTR-100");
    assert.equal(partial.body.data.note, "Counter");
    assert.equal(partial.body.data.createdBy.id, stockUserId);
    assert.equal(typeof partial.body.data.createdBy.name, "string");
    assert.equal("phone" in partial.body.data.createdBy, false);
    assert.equal(await receivable(customerId), "200.00");

    const replay = await payCustomer(
      stockToken,
      stockShop,
      customerId,
      { amount: "100.00", method: "UPI", reference: "UTR-100", note: "Counter" },
      "cust-rollback",
    );
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.data.id, partial.body.data.id);
    assert.equal(await receiptCount(customerId), "1");

    const conflict = await payCustomer(
      ownerToken,
      ownerShop,
      customerId,
      { amount: "50.00", method: "CASH" },
      "cust-rollback",
    );
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(await receiptCount(customerId), "1");

    const stored = await admin.query<{
      direction: string;
      reference_type: string;
      no_ref: boolean;
      payment_method: string;
      external_reference: string;
    }>(
      `SELECT direction::text, reference_type::text, reference_id IS NULL AS no_ref,
              payment_method::text, external_reference
       FROM payments WHERE id = $1::uuid`,
      [partial.body.data.id],
    );
    assert.equal(stored.rows[0]?.direction, "IN");
    assert.equal(stored.rows[0]?.reference_type, "CUSTOMER_RECEIPT");
    assert.equal(stored.rows[0]?.no_ref, true);
    assert.equal(stored.rows[0]?.payment_method, "UPI");
    assert.equal(stored.rows[0]?.external_reference, "UTR-100");

    const ledgerLine = await admin.query<{ entry_type: string; credit: string; debit: string }>(
      `SELECT entry_type::text, credit_amount::text AS credit, debit_amount::text AS debit
       FROM customer_ledger WHERE reference_id = $1::uuid`,
      [partial.body.data.id],
    );
    assert.equal(ledgerLine.rows[0]?.entry_type, "PAYMENT");
    assert.equal(ledgerLine.rows[0]?.credit, "100.00");
    assert.equal(ledgerLine.rows[0]?.debit, "0.00");

    const audit = await admin.query<{ request_id: string; metadata: { amount: string; method: string; customerId: string } }>(
      `SELECT request_id, metadata FROM audit_logs
       WHERE entity_id = $1::uuid AND action = 'customer.payment_recorded'`,
      [partial.body.data.id],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0]?.request_id, partial.body.requestId);
    assert.equal(audit.rows[0]?.metadata.amount, "100.00");
    assert.equal(audit.rows[0]?.metadata.method, "UPI");
    assert.equal(audit.rows[0]?.metadata.customerId, customerId);
    assert.equal(JSON.stringify(audit.rows[0]?.metadata).includes("token"), false);

    const history = await authed(cashierToken, cashierShop).get(
      `/api/v1/customers/${customerId}/payments?method=UPI`,
    );
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.data.length, 1);
    assert.equal(history.body.data[0].id, partial.body.data.id);
    assert.equal(history.body.data[0].reference, "UTR-100");
    const day = history.body.data[0].businessDate as string;
    const ranged = await authed(ownerToken, ownerShop).get(
      `/api/v1/customers/${customerId}/payments?from=${day}&to=${day}`,
    );
    assert.equal(ranged.body.data.length, 1);
    const future = await authed(ownerToken, ownerShop).get(
      `/api/v1/customers/${customerId}/payments?from=2099-01-01`,
    );
    assert.equal(future.body.data.length, 0);
    const cardFilter = await authed(ownerToken, ownerShop).get(
      `/api/v1/customers/${customerId}/payments?method=CARD`,
    );
    assert.equal(cardFilter.status, 400);
    assert.equal(cardFilter.body.error.code, "VALIDATION_ERROR");

    const ledger = await authed(stockToken, stockShop).get(
      `/api/v1/customers/${customerId}/ledger?limit=100`,
    );
    assert.equal(ledger.status, 200, JSON.stringify(ledger.body));
    assert.deepEqual(
      ledger.body.data.map((row: { type: string; debit: string; credit: string; runningBalance: string }) => ({
        type: row.type,
        debit: row.debit,
        credit: row.credit,
        runningBalance: row.runningBalance,
      })),
      [
        { type: "CREDIT_SALE", debit: "300.00", credit: "0.00", runningBalance: "300.00" },
        { type: "PAYMENT", debit: "0.00", credit: "100.00", runningBalance: "200.00" },
      ],
    );
    assert.equal(ledger.body.data[1].reference.type, "CUSTOMER_RECEIPT");
    assert.equal(ledger.body.data[1].reference.id, partial.body.data.id);

    const settled = await payCustomer(cashierToken, cashierShop, customerId, {
      amount: "200.00",
      method: "CASH",
    });
    assert.equal(settled.status, 201, JSON.stringify(settled.body));
    assert.equal(settled.body.data.method, "CASH");
    assert.equal(settled.body.data.reference, null);
    assert.equal(settled.body.data.createdBy.id, cashierUserId);
    assert.equal(await receivable(customerId), "0.00");

    const closed = await authed(ownerToken, ownerShop).get(`/api/v1/customers/${customerId}`);
    assert.equal(closed.body.data.receivableBalance, "0.00");
    assert.equal(closed.body.data.paymentCount, 2);
    assert.equal(closed.body.data.latestPayment.amount, "200.00");
    assert.equal(closed.body.data.latestPayment.method, "CASH");

    const zero = await payCustomer(ownerToken, ownerShop, customerId, { amount: "10.00", method: "CASH" });
    assert.equal(zero.status, 409, JSON.stringify(zero.body));
    assert.equal(zero.body.error.code, "PAYMENT_EXCEEDS_OUTSTANDING");
    assert.equal(await receiptCount(customerId), "2");
    assert.equal(await receivable(customerId), "0.00");

    const nothing = await payCustomer(ownerToken, ownerShop, customerId, { amount: "0.00", method: "CASH" });
    assert.equal(nothing.status, 400, JSON.stringify(nothing.body));
    assert.equal(nothing.body.error.code, "VALIDATION_ERROR");
    const card = await payCustomer(ownerToken, ownerShop, customerId, { amount: "10.00", method: "CARD" });
    assert.equal(card.status, 400, JSON.stringify(card.body));
    assert.equal(card.body.error.code, "VALIDATION_ERROR");
    const badDate = await payCustomer(ownerToken, ownerShop, customerId, {
      amount: "10.00",
      method: "CASH",
      paymentDate: "2026-02-31",
    });
    assert.equal(badDate.status, 400, JSON.stringify(badDate.body));
    const foreignTenant = await payCustomer(ownerToken, ownerShop, customerId, {
      amount: "10.00",
      method: "CASH",
      tenantId: shopId,
    });
    assert.equal(foreignTenant.status, 400, JSON.stringify(foreignTenant.body));
    const patched = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/customers/${customerId}`)
      .send({ receivableBalance: "0.00" });
    assert.equal(patched.status, 400, JSON.stringify(patched.body));

    const otherPay = await payCustomer(otherToken, otherShop, customerId, { amount: "10.00", method: "CASH" });
    assert.equal(otherPay.status, 404, JSON.stringify(otherPay.body));
    assert.equal(otherPay.body.error.code, "CUSTOMER_NOT_FOUND");

    const after = await shopTotals();
    assert.equal(Number(after.total_sales), Number(before.total_sales));
    assert.equal(Number(after.gross_profit), Number(before.gross_profit));
    assert.equal(Number(after.net_profit), Number(before.net_profit));
    assert.equal(Number(after.cash_received), Number(before.cash_received));
    assert.equal(Number(after.credit_sales), Number(before.credit_sales));
    assert.equal(Number(after.products_sold), Number(before.products_sold));
    assert.equal(Number(after.transaction_count), Number(before.transaction_count));
    assert.equal(Number(after.supplier_payments), Number(before.supplier_payments));
    assert.equal(Number(after.total_purchase), Number(before.total_purchase));
    assert.equal((Number(after.customer_collections) - Number(before.customer_collections)).toFixed(2), "300.00");
    assert.equal(await countRows("sales"), salesBefore);
    assert.equal(await countRows("inventory_movements"), movementsBefore);

    const fullCustomer = await createCustomer("Full Pay");
    const fullSale = await sell(fullCustomer, productId, "1", []);
    assert.equal(fullSale.status, 201, JSON.stringify(fullSale.body));
    assert.equal(fullSale.body.data.outstanding, "1000.00");
    const fullPay = await payCustomer(ownerToken, ownerShop, fullCustomer, { amount: "1000.00", method: "CASH" });
    assert.equal(fullPay.status, 201, JSON.stringify(fullPay.body));
    assert.equal(await receivable(fullCustomer), "0.00");
    const fullLedger = await authed(ownerToken, ownerShop).get(`/api/v1/customers/${fullCustomer}/ledger?limit=100`);
    assert.equal(fullLedger.body.data.at(-1).runningBalance, "0.00");
    assert.equal(fullLedger.body.data.at(-1).runningBalance, await receivable(fullCustomer));

    const quiet = await createCustomer("Quiet");
    const quietSale = await sell(quiet, productId, "1", []);
    assert.equal(quietSale.status, 201, JSON.stringify(quietSale.body));
    const deactivated = await authed(ownerToken, ownerShop).patch(`/api/v1/customers/${quiet}`).send({ isActive: false });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    const blocked = await payCustomer(cashierToken, cashierShop, quiet, { amount: "100.00", method: "UPI" });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error.code, "CUSTOMER_INACTIVE");
    assert.equal(await receivable(quiet), "1000.00");
    assert.equal(await receiptCount(quiet), "0");
  });

  it("lets only one concurrent customer payment fit the receivable", async () => {
    const productId = await createProduct("Concurrent rice", "1000.00");
    await openStock(productId, "2", "100.00");
    const customerId = await createCustomer("Concurrent");
    const sold = await sell(customerId, productId, "1", []);
    assert.equal(sold.status, 201, JSON.stringify(sold.body));
    assert.equal(await receivable(customerId), "1000.00");

    const [first, second] = await Promise.all([
      payCustomer(ownerToken, ownerShop, customerId, { amount: "700.00", method: "CASH" }, "cust-a"),
      payCustomer(cashierToken, cashierShop, customerId, { amount: "500.00", method: "UPI" }, "cust-b"),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    const failed = first.status === 409 ? first : second;
    const winner = first.status === 201 ? first : second;
    assert.equal(failed.body.error.code, "PAYMENT_EXCEEDS_OUTSTANDING");
    const balance = await receivable(customerId);
    assert.equal(Number(balance) >= 0, true);
    assert.equal((1000 - Number(winner.body.data.amount)).toFixed(2), balance);
    assert.equal(await receiptCount(customerId), "1");
  });

  it("settles a supplier payable without changing stock or purchases", async () => {
    const supplierId = await createSupplier("Mill");
    const productId = await createProduct("Atta bag");
    const purchased = await buy(supplierId, productId, "10", "500.00");
    assert.equal(purchased.status, 201, JSON.stringify(purchased.body));
    assert.equal(purchased.body.data.total, "5000.00");
    assert.equal(await payable(supplierId), "5000.00");
    const stockBefore = await stockQuantity(productId);
    const movementsBefore = await countRows("inventory_movements");
    const purchaseTotalBefore = await purchaseTotal(purchased.body.data.id as string);
    const before = await shopTotals();

    const over = await paySupplier(
      ownerToken,
      ownerShop,
      supplierId,
      { amount: "6000.00", method: "CASH" },
      "sup-rollback",
    );
    assert.equal(over.status, 409, JSON.stringify(over.body));
    assert.equal(over.body.error.code, "PAYMENT_EXCEEDS_OUTSTANDING");
    assert.equal(await supplierPaymentCount(supplierId), "0");
    assert.equal(await payable(supplierId), "5000.00");

    const partial = await paySupplier(
      stockToken,
      stockShop,
      supplierId,
      { amount: "3000.00", method: "UPI", reference: "UTR-3000", note: "Bank counter" },
      "sup-rollback",
    );
    assert.equal(partial.status, 201, JSON.stringify(partial.body));
    assert.equal(partial.body.data.amount, "3000.00");
    assert.equal(partial.body.data.method, "UPI");
    assert.equal(partial.body.data.reference, "UTR-3000");
    assert.equal(partial.body.data.createdBy.id, stockUserId);
    assert.equal(await payable(supplierId), "2000.00");

    const replay = await paySupplier(
      ownerToken,
      ownerShop,
      supplierId,
      { amount: "3000.00", method: "UPI", reference: "UTR-3000", note: "Bank counter" },
      "sup-rollback",
    );
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.data.id, partial.body.data.id);
    assert.equal(await supplierPaymentCount(supplierId), "1");

    const conflict = await paySupplier(
      ownerToken,
      ownerShop,
      supplierId,
      { amount: "2000.00", method: "CASH" },
      "sup-rollback",
    );
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");

    const stored = await admin.query<{ direction: string; reference_type: string; no_ref: boolean }>(
      `SELECT direction::text, reference_type::text, reference_id IS NULL AS no_ref
       FROM payments WHERE id = $1::uuid`,
      [partial.body.data.id],
    );
    assert.equal(stored.rows[0]?.direction, "OUT");
    assert.equal(stored.rows[0]?.reference_type, "SUPPLIER_PAYMENT");
    assert.equal(stored.rows[0]?.no_ref, true);

    const ledgerLine = await admin.query<{ entry_type: string; debit: string; credit: string }>(
      `SELECT entry_type::text, debit_amount::text AS debit, credit_amount::text AS credit
       FROM supplier_ledger WHERE reference_id = $1::uuid`,
      [partial.body.data.id],
    );
    assert.equal(ledgerLine.rows[0]?.entry_type, "PAYMENT");
    assert.equal(ledgerLine.rows[0]?.debit, "3000.00");
    assert.equal(ledgerLine.rows[0]?.credit, "0.00");

    const audit = await admin.query<{ metadata: { amount: string; supplierId: string } }>(
      `SELECT metadata FROM audit_logs WHERE entity_id = $1::uuid AND action = 'supplier.payment_recorded'`,
      [partial.body.data.id],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0]?.metadata.amount, "3000.00");
    assert.equal(audit.rows[0]?.metadata.supplierId, supplierId);

    const cashierPay = await paySupplier(cashierToken, cashierShop, supplierId, {
      amount: "100.00",
      method: "CASH",
    });
    assert.equal(cashierPay.status, 403, JSON.stringify(cashierPay.body));
    assert.equal(cashierPay.body.error.code, "SUPPLIER_ACCESS_DENIED");
    const cashierList = await authed(cashierToken, cashierShop).get(`/api/v1/suppliers/${supplierId}/payments`);
    assert.equal(cashierList.status, 403);
    const cashierLedger = await authed(cashierToken, cashierShop).get(`/api/v1/suppliers/${supplierId}/ledger`);
    assert.equal(cashierLedger.status, 403);
    const cashierDetail = await authed(cashierToken, cashierShop).get(`/api/v1/suppliers/${supplierId}`);
    assert.equal(cashierDetail.status, 200, JSON.stringify(cashierDetail.body));
    assert.equal("payableBalance" in cashierDetail.body.data, false);
    assert.equal("paymentCount" in cashierDetail.body.data, false);

    const history = await authed(adminToken, adminShop).get(`/api/v1/suppliers/${supplierId}/payments?method=UPI`);
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.data[0].id, partial.body.data.id);
    assert.equal(history.body.data[0].reference, "UTR-3000");

    const ledger = await authed(stockToken, stockShop).get(`/api/v1/suppliers/${supplierId}/ledger?limit=100`);
    assert.equal(ledger.status, 200, JSON.stringify(ledger.body));
    assert.deepEqual(
      ledger.body.data.map((row: { type: string; debit: string; credit: string; runningBalance: string }) => ({
        type: row.type,
        debit: row.debit,
        credit: row.credit,
        runningBalance: row.runningBalance,
      })),
      [
        { type: "PURCHASE", debit: "0.00", credit: "5000.00", runningBalance: "5000.00" },
        { type: "PAYMENT", debit: "3000.00", credit: "0.00", runningBalance: "2000.00" },
      ],
    );

    const settled = await paySupplier(ownerToken, ownerShop, supplierId, { amount: "2000.00", method: "CASH" });
    assert.equal(settled.status, 201, JSON.stringify(settled.body));
    assert.equal(settled.body.data.reference, null);
    assert.equal(settled.body.data.createdBy.id, ownerUserId);
    assert.equal(await payable(supplierId), "0.00");

    const closed = await authed(stockToken, stockShop).get(`/api/v1/suppliers/${supplierId}`);
    assert.equal(closed.body.data.payableBalance, "0.00");
    assert.equal(closed.body.data.paymentCount, 2);
    assert.equal(closed.body.data.latestPayment.method, "CASH");
    assert.equal(closed.body.data.latestPayment.amount, "2000.00");

    const zero = await paySupplier(ownerToken, ownerShop, supplierId, { amount: "1.00", method: "UPI" });
    assert.equal(zero.status, 409, JSON.stringify(zero.body));
    assert.equal(zero.body.error.code, "PAYMENT_EXCEEDS_OUTSTANDING");
    assert.equal(await supplierPaymentCount(supplierId), "2");
    assert.equal(await payable(supplierId), "0.00");

    const after = await shopTotals();
    assert.equal(Number(after.total_sales), Number(before.total_sales));
    assert.equal(Number(after.gross_profit), Number(before.gross_profit));
    assert.equal(Number(after.net_profit), Number(before.net_profit));
    assert.equal(Number(after.products_sold), Number(before.products_sold));
    assert.equal(Number(after.transaction_count), Number(before.transaction_count));
    assert.equal(Number(after.total_purchase), Number(before.total_purchase));
    assert.equal(Number(after.customer_collections), Number(before.customer_collections));
    assert.equal((Number(after.supplier_payments) - Number(before.supplier_payments)).toFixed(2), "5000.00");
    assert.equal(await stockQuantity(productId), stockBefore);
    assert.equal(await countRows("inventory_movements"), movementsBefore);
    assert.equal(await purchaseTotal(purchased.body.data.id as string), purchaseTotalBefore);

    const otherPay = await paySupplier(otherToken, otherShop, supplierId, { amount: "10.00", method: "CASH" });
    assert.equal(otherPay.status, 404, JSON.stringify(otherPay.body));
    assert.equal(otherPay.body.error.code, "SUPPLIER_NOT_FOUND");

    const fullSupplier = await createSupplier("Full Mill");
    const fullProduct = await createProduct("Full atta");
    const fullPurchase = await buy(fullSupplier, fullProduct, "1", "100.00");
    assert.equal(fullPurchase.status, 201, JSON.stringify(fullPurchase.body));
    const fullPay = await paySupplier(adminToken, adminShop, fullSupplier, { amount: "100.00", method: "CASH" });
    assert.equal(fullPay.status, 201, JSON.stringify(fullPay.body));
    assert.equal(await payable(fullSupplier), "0.00");
    const fullLedger = await authed(adminToken, adminShop).get(`/api/v1/suppliers/${fullSupplier}/ledger?limit=100`);
    assert.equal(fullLedger.body.data.at(-1).runningBalance, "0.00");

    const quietSupplier = await createSupplier("Quiet Mill");
    const quietProduct = await createProduct("Quiet atta");
    const quietPurchase = await buy(quietSupplier, quietProduct, "1", "80.00");
    assert.equal(quietPurchase.status, 201, JSON.stringify(quietPurchase.body));
    const deactivated = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/suppliers/${quietSupplier}`)
      .send({ isActive: false });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    const blocked = await paySupplier(stockToken, stockShop, quietSupplier, { amount: "80.00", method: "CASH" });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error.code, "SUPPLIER_INACTIVE");
    assert.equal(await payable(quietSupplier), "80.00");
    assert.equal(await supplierPaymentCount(quietSupplier), "0");
    assert.equal(await stockQuantity(quietProduct), "1.000");
  });

  it("lets only one concurrent supplier payment fit the payable", async () => {
    const supplierId = await createSupplier("Concurrent Mill");
    const productId = await createProduct("Concurrent atta");
    const purchased = await buy(supplierId, productId, "10", "100.00");
    assert.equal(purchased.status, 201, JSON.stringify(purchased.body));
    assert.equal(await payable(supplierId), "1000.00");
    const stockBefore = await stockQuantity(productId);

    const [first, second] = await Promise.all([
      paySupplier(ownerToken, ownerShop, supplierId, { amount: "700.00", method: "CASH" }, "sup-a"),
      paySupplier(stockToken, stockShop, supplierId, { amount: "500.00", method: "UPI" }, "sup-b"),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    const failed = first.status === 409 ? first : second;
    const winner = first.status === 201 ? first : second;
    assert.equal(failed.body.error.code, "PAYMENT_EXCEEDS_OUTSTANDING");
    const balance = await payable(supplierId);
    assert.equal(Number(balance) >= 0, true);
    assert.equal((1000 - Number(winner.body.data.amount)).toFixed(2), balance);
    assert.equal(await supplierPaymentCount(supplierId), "1");
    assert.equal(await stockQuantity(productId), stockBefore);
    assert.equal(await purchaseTotal(purchased.body.data.id as string), "1000.00");
  });

  function authed(token: string, shopContext: string) {
    const http = request(app.getHttpServer());
    const headers = (method: "get" | "post" | "patch" | "delete") => (path: string) =>
      http[method](path).set("Authorization", `Bearer ${token}`).set("x-dukaan-shop", shopContext);
    return { get: headers("get"), post: headers("post"), patch: headers("patch"), delete: headers("delete") };
  }

  function payCustomer(
    token: string,
    shopContext: string,
    customerId: string,
    body: Record<string, unknown>,
    key?: string,
  ) {
    const call = authed(token, shopContext).post(`/api/v1/customers/${customerId}/payments`);
    if (key) {
      call.set("Idempotency-Key", key);
    }
    return call.send(body);
  }

  function paySupplier(
    token: string,
    shopContext: string,
    supplierId: string,
    body: Record<string, unknown>,
    key?: string,
  ) {
    const call = authed(token, shopContext).post(`/api/v1/suppliers/${supplierId}/payments`);
    if (key) {
      call.set("Idempotency-Key", key);
    }
    return call.send(body);
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

  async function createSupplier(name: string): Promise<string> {
    const response = await authed(ownerToken, ownerShop).post("/api/v1/suppliers").send({ name });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.id as string;
  }

  async function createProduct(name: string, sellingPrice = "10.00"): Promise<string> {
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

  function buy(supplierId: string, productId: string, quantity: string, unitCost: string) {
    return authed(ownerToken, ownerShop)
      .post("/api/v1/purchases")
      .send({ supplierId, items: [{ productId, quantity, unitCost }] });
  }

  async function receivable(customerId: string): Promise<string> {
    const rows = await admin.query<{ balance: string }>(
      `SELECT receivable_balance::text AS balance FROM customers WHERE id = $1::uuid`,
      [customerId],
    );
    return rows.rows[0]?.balance ?? "";
  }

  async function payable(supplierId: string): Promise<string> {
    const rows = await admin.query<{ balance: string }>(
      `SELECT payable_balance::text AS balance FROM suppliers WHERE id = $1::uuid`,
      [supplierId],
    );
    return rows.rows[0]?.balance ?? "";
  }

  async function receiptCount(customerId: string): Promise<string> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM payments
       WHERE customer_id = $1::uuid AND reference_type = 'CUSTOMER_RECEIPT'`,
      [customerId],
    );
    return rows.rows[0]?.count ?? "0";
  }

  async function supplierPaymentCount(supplierId: string): Promise<string> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM payments
       WHERE supplier_id = $1::uuid AND reference_type = 'SUPPLIER_PAYMENT'`,
      [supplierId],
    );
    return rows.rows[0]?.count ?? "0";
  }

  async function countRows(table: "sales" | "inventory_movements"): Promise<string> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id = $1::uuid`,
      [shopId],
    );
    return rows.rows[0]?.count ?? "0";
  }

  async function stockQuantity(productId: string): Promise<string> {
    const rows = await admin.query<{ quantity: string }>(
      `SELECT quantity::text FROM inventory_balances WHERE product_id = $1::uuid`,
      [productId],
    );
    return rows.rows[0]?.quantity ?? "";
  }

  async function purchaseTotal(purchaseId: string): Promise<string> {
    const rows = await admin.query<{ total: string }>(
      `SELECT grand_total::text AS total FROM purchases WHERE id = $1::uuid`,
      [purchaseId],
    );
    return rows.rows[0]?.total ?? "";
  }

  async function shopTotals() {
    const rows = await admin.query<{
      total_sales: string;
      gross_profit: string;
      net_profit: string;
      cash_received: string;
      credit_sales: string;
      customer_collections: string;
      supplier_payments: string;
      products_sold: string;
      transaction_count: string;
      total_purchase: string;
    }>(
      `SELECT
         COALESCE(SUM(total_sales), 0)::text AS total_sales,
         COALESCE(SUM(gross_profit), 0)::text AS gross_profit,
         COALESCE(SUM(net_profit), 0)::text AS net_profit,
         COALESCE(SUM(cash_received), 0)::text AS cash_received,
         COALESCE(SUM(credit_sales), 0)::text AS credit_sales,
         COALESCE(SUM(customer_collections), 0)::text AS customer_collections,
         COALESCE(SUM(supplier_payments), 0)::text AS supplier_payments,
         COALESCE(SUM(products_sold), 0)::text AS products_sold,
         COALESCE(SUM(transaction_count), 0)::text AS transaction_count,
         COALESCE(SUM(total_purchase), 0)::text AS total_purchase
       FROM daily_summaries WHERE tenant_id = $1::uuid`,
      [shopId],
    );
    const row = rows.rows[0];
    assert.ok(row);
    return row;
  }
});

function nextNational(): string {
  serial += 1;
  const national = String(serial);
  phones.push(normalizeIndianPhone(national));
  return national;
}

async function cleanup(admin: Client, numbers: string[]): Promise<void> {
  const tenants = `(SELECT id FROM tenants WHERE name LIKE '[PAY]%')`;
  await admin.query("ALTER TABLE inventory_movements DISABLE TRIGGER inventory_movements_append_only");
  await admin.query("ALTER TABLE stock_adjustment_items DISABLE TRIGGER stock_adjustment_items_draft_only");
  await admin.query("ALTER TABLE stock_adjustments DISABLE TRIGGER stock_adjustments_no_delete");
  await admin.query("ALTER TABLE customer_ledger DISABLE TRIGGER customer_ledger_append_only");
  await admin.query("ALTER TABLE supplier_ledger DISABLE TRIGGER supplier_ledger_append_only");
  await admin.query("ALTER TABLE payments DISABLE TRIGGER payments_append_only");
  await admin.query("ALTER TABLE sale_items DISABLE TRIGGER sale_items_append_only");
  await admin.query("ALTER TABLE sales DISABLE TRIGGER sales_no_delete");
  await admin.query("ALTER TABLE purchase_items DISABLE TRIGGER purchase_items_draft_only");
  await admin.query("ALTER TABLE purchases DISABLE TRIGGER purchases_no_delete");
  await admin.query("ALTER TABLE product_price_history DISABLE TRIGGER product_price_history_append_only");
  await admin.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only");
  try {
    await admin.query(`DELETE FROM inventory_movements WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM inventory_balances WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM stock_adjustment_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM stock_adjustments WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM customer_ledger WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM supplier_ledger WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM payments WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM sale_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM sales WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM purchase_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM purchases WHERE tenant_id IN ${tenants}`);
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
    await admin.query("ALTER TABLE supplier_ledger ENABLE TRIGGER supplier_ledger_append_only");
    await admin.query("ALTER TABLE payments ENABLE TRIGGER payments_append_only");
    await admin.query("ALTER TABLE sale_items ENABLE TRIGGER sale_items_append_only");
    await admin.query("ALTER TABLE sales ENABLE TRIGGER sales_no_delete");
    await admin.query("ALTER TABLE purchase_items ENABLE TRIGGER purchase_items_draft_only");
    await admin.query("ALTER TABLE purchases ENABLE TRIGGER purchases_no_delete");
    await admin.query("ALTER TABLE product_price_history ENABLE TRIGGER product_price_history_append_only");
    await admin.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only");
  }
  await admin.query(`DELETE FROM product_barcodes WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM products WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM units WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM customers WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM suppliers WHERE tenant_id IN ${tenants}`);
  await admin.query(
    `DELETE FROM memberships
     WHERE tenant_id IN ${tenants}
        OR user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`UPDATE tenants SET default_location_id = NULL WHERE name LIKE '[PAY]%'`);
  await admin.query(`DELETE FROM locations WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM document_counters WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM expense_categories WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM tenants WHERE name LIKE '[PAY]%'`);
  await admin.query(
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`DELETE FROM otp_challenges WHERE phone = ANY($1::text[])`, [numbers]);
  await admin.query(`DELETE FROM users WHERE phone = ANY($1::text[])`, [numbers]);
}
