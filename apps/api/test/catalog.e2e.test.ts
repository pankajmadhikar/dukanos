import "dotenv/config";
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "@jest/globals";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Prisma } from "@prisma/client";
import { Client } from "pg";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { CapturingOtpSender } from "../src/auth/capturing-otp-sender";
import { OTP_SENDER } from "../src/auth/otp-sender";
import { normalizeIndianPhone } from "../src/auth/phone";
import { configureApp } from "../src/configure-app";
import { TenantTransactionService } from "../src/database/tenant-transaction.service";

jest.setTimeout(60_000);

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  throw new Error("DATABASE_ADMIN_URL is required for catalog tests.");
}

process.env.OTP_IP_LIMIT = "500";

let serial = 7300001000;
const phones: string[] = [];

describe("catalog", () => {
  let app: INestApplication;
  let admin: Client;
  let sender: CapturingOtpSender;
  let transactions: TenantTransactionService;
  let ownerToken = "";
  let ownerShop = "";
  let ownerId = "";
  let shopId = "";
  let adminToken = "";
  let adminShop = "";
  let cashierToken = "";
  let cashierShop = "";
  let stockToken = "";
  let stockShop = "";
  let otherToken = "";
  let otherShop = "";
  let otherShopId = "";
  let unitId = "";

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.init();
    sender = app.get<CapturingOtpSender>(OTP_SENDER);
    transactions = app.get(TenantTransactionService);

    const owner = await login(nextNational());
    ownerToken = owner.token;
    ownerId = owner.userId;
    const created = await createShop(ownerToken, "[CAT] Shop A");
    shopId = created.id;
    ownerShop = created.shopContext;

    const manager = await login(nextNational());
    const cashier = await login(nextNational());
    const stock = await login(nextNational());
    const other = await login(nextNational());
    await admin.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role)
       VALUES ($1, $2, $3, 'ADMIN'), ($4, $2, $5, 'CASHIER'), ($6, $2, $7, 'STOCK_KEEPER')
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [randomUUID(), shopId, manager.userId, randomUUID(), cashier.userId, randomUUID(), stock.userId],
    );
    adminToken = manager.token;
    adminShop = await selectShop(manager.token, shopId);
    cashierToken = cashier.token;
    cashierShop = await selectShop(cashier.token, shopId);
    stockToken = stock.token;
    stockShop = await selectShop(stock.token, shopId);

    otherToken = other.token;
    const otherCreated = await createShop(other.token, "[CAT] Shop B");
    otherShopId = otherCreated.id;
    otherShop = otherCreated.shopContext;

    const unit = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/units")
      .send({ name: "Piece", shortCode: "pcs", decimalPlaces: 0 });
    assert.equal(unit.status, 201, JSON.stringify(unit.body));
    unitId = unit.body.data.id as string;
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin, phones);
      await admin.end();
    }
    if (app) {
      await app.close();
    }
  });

  it("creates a minimal product without stock", async () => {
    const created = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/products")
      .send({ name: "  Parle-G 250g  ", unitId, defaultSellingPrice: 10 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.name, "Parle-G 250g");
    assert.equal(created.body.data.sku, null);
    assert.equal(created.body.data.sellingPrice, "10.00");
    assert.equal(created.body.data.purchasePrice, null);
    assert.equal(created.body.data.unit.shortCode, "pcs");

    const counts = await admin.query<{ movements: string; balances: string }>(
      `SELECT
         (SELECT count(*)::text FROM inventory_movements WHERE product_id = $1::uuid) AS movements,
         (SELECT count(*)::text FROM inventory_balances WHERE product_id = $1::uuid) AS balances`,
      [created.body.data.id],
    );
    assert.equal(counts.rows[0]?.movements, "0");
    assert.equal(counts.rows[0]?.balances, "0");

    const history = await authed(ownerToken, ownerShop).get(
      `/api/v1/catalog/products/${created.body.data.id}/price-history`,
    );
    assert.equal(history.body.data[0].oldPrice, null);
    assert.equal(history.body.data[0].newPrice, "10.00");
    assert.equal(history.body.data[0].source, "MANUAL");
    assert.equal(history.body.data[0].priceType, "SELLING");
  });

  it("enforces who may create and update products", async () => {
    const byAdmin = await authed(adminToken, adminShop)
      .post("/api/v1/catalog/products")
      .send({ name: "Admin soap", unitId });
    assert.equal(byAdmin.status, 201, JSON.stringify(byAdmin.body));
    const byStock = await authed(stockToken, stockShop)
      .post("/api/v1/catalog/products")
      .send({ name: "Stock bulb", unitId, defaultPurchasePrice: "40.00" });
    assert.equal(byStock.status, 201);
    const byCashier = await authed(cashierToken, cashierShop)
      .post("/api/v1/catalog/products")
      .send({ name: "Cashier denied", unitId });
    assert.equal(byCashier.status, 403);
    assert.equal(byCashier.body.error.code, "CATALOG_ACCESS_DENIED");

    const renamed = await authed(adminToken, adminShop)
      .patch(`/api/v1/catalog/products/${byAdmin.body.data.id}`)
      .send({ name: "Admin soap bar" });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.data.name, "Admin soap bar");
    const history = await authed(ownerToken, ownerShop).get(
      `/api/v1/catalog/products/${byAdmin.body.data.id}/price-history`,
    );
    assert.equal(history.body.data.length, 0);

    const denied = await authed(cashierToken, cashierShop)
      .patch(`/api/v1/catalog/products/${byAdmin.body.data.id}`)
      .send({ name: "Nope" });
    assert.equal(denied.status, 403);

    const missingName = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/products")
      .send({ unitId });
    assert.equal(missingName.status, 400);
    const missingUnit = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/products")
      .send({ name: "No unit" });
    assert.equal(missingUnit.status, 400);
    const badPrice = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/products")
      .send({ name: "Bad price", unitId, defaultSellingPrice: "-1" });
    assert.equal(badPrice.status, 400);
  });

  it("rejects inactive or foreign units and duplicate skus", async () => {
    const foreign = await authed(otherToken, otherShop)
      .post("/api/v1/catalog/units")
      .send({ name: "Box", shortCode: "box", decimalPlaces: 0 });
    assert.equal(foreign.status, 201);
    const wrongShop = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/products")
      .send({ name: "Foreign unit", unitId: foreign.body.data.id });
    assert.equal(wrongShop.status, 404);
    assert.equal(wrongShop.body.error.code, "UNIT_NOT_FOUND");

    const retired = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/units")
      .send({ name: "Retired", shortCode: "ret", decimalPlaces: 0 });
    await authed(ownerToken, ownerShop)
      .patch(`/api/v1/catalog/units/${retired.body.data.id}`)
      .send({ isActive: false });
    const inactive = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/products")
      .send({ name: "Inactive unit", unitId: retired.body.data.id });
    assert.equal(inactive.status, 422);
    assert.equal(inactive.body.error.code, "UNIT_INACTIVE");

    const first = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/products")
      .send({ name: "Sku one", unitId, sku: "abc-1" });
    assert.equal(first.status, 201);
    assert.equal(first.body.data.sku, "ABC-1");
    const second = await authed(stockToken, stockShop)
      .post("/api/v1/catalog/products")
      .send({ name: "Sku two", unitId, sku: "abc-1" });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "SKU_ALREADY_EXISTS");
  });

  it("records a price change in the same transaction and rolls it back on failure", async () => {
    const created = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/products")
      .send({
        name: "Price rice",
        unitId,
        defaultPurchasePrice: "80.00",
        defaultSellingPrice: "100.00",
      });
    assert.equal(created.status, 201);
    const id = created.body.data.id as string;
    const updated = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/catalog/products/${id}`)
      .send({ defaultSellingPrice: "120.00" });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.sellingPrice, "120.00");
    assert.equal(updated.body.data.purchasePrice, "80.00");
    const history = await authed(ownerToken, ownerShop).get(
      `/api/v1/catalog/products/${id}/price-history`,
    );
    const selling = history.body.data.find(
      (row: { priceType: string; newPrice: string }) =>
        row.priceType === "SELLING" && row.newPrice === "120.00",
    );
    assert.equal(selling.oldPrice, "100.00");
    assert.equal(selling.source, "MANUAL");

    const before = await admin.query<{ price: string; history: string }>(
      `SELECT p.default_selling_price::text AS price,
              (SELECT count(*)::text FROM product_price_history h WHERE h.product_id = p.id) AS history
       FROM products p WHERE p.id = $1::uuid`,
      [id],
    );
    await assert.rejects(() =>
      transactions.run({ tenantId: shopId, userId: ownerId }, async (tx) => {
        await tx.product.update({
          where: { id },
          data: { defaultSellingPrice: new Prisma.Decimal("150.00") },
        });
        await tx.productPriceHistory.create({
          data: {
            tenantId: shopId,
            productId: id,
            priceType: "SELLING",
            oldPrice: new Prisma.Decimal("120.00"),
            newPrice: new Prisma.Decimal("150.00"),
            source: "MANUAL",
            changedBy: ownerId,
          },
        });
        throw new Error("rollback");
      }),
    );
    const after = await admin.query<{ price: string; history: string }>(
      `SELECT p.default_selling_price::text AS price,
              (SELECT count(*)::text FROM product_price_history h WHERE h.product_id = p.id) AS history
       FROM products p WHERE p.id = $1::uuid`,
      [id],
    );
    assert.equal(after.rows[0]?.price, before.rows[0]?.price);
    assert.equal(after.rows[0]?.history, before.rows[0]?.history);

    await admin.query(`UPDATE products SET average_cost = 82.00 WHERE id = $1::uuid`, [id]);
    const cashierView = await authed(cashierToken, cashierShop).get(`/api/v1/catalog/products/${id}`);
    assert.equal(cashierView.status, 200);
    assert.equal(cashierView.body.data.sellingPrice, "120.00");
    assert.equal("purchasePrice" in cashierView.body.data, false);
    assert.equal("averageCost" in cashierView.body.data, false);
    const cashierJson = JSON.stringify(cashierView.body);
    assert.equal(cashierJson.includes("80.00"), false);
    assert.equal(cashierJson.includes("82.00"), false);
    const cashierHistory = await authed(cashierToken, cashierShop).get(
      `/api/v1/catalog/products/${id}/price-history`,
    );
    assert.equal(
      cashierHistory.body.data.every((row: { priceType: string }) => row.priceType === "SELLING"),
      true,
    );
    const ownerView = await authed(ownerToken, ownerShop).get(`/api/v1/catalog/products/${id}`);
    assert.equal(ownerView.body.data.purchasePrice, "80.00");
    assert.equal(ownerView.body.data.averageCost, "82.00");
  });

  it("looks up barcodes inside the selected shop", async () => {
    const created = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/products")
      .send({
        name: "Parle-G 250g Scan",
        nameEn: "Parle-G",
        nameHi: "पार्ले-जी",
        nameMr: "पार्ले",
        sku: "PG250",
        unitId,
        barcode: "8901111111111",
        defaultSellingPrice: "10.00",
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;
    const extra = await authed(ownerToken, ownerShop)
      .post(`/api/v1/catalog/products/${id}/barcodes`)
      .send({ barcode: "8902222222222", isPrimary: true });
    assert.equal(extra.status, 201);
    const codes = await authed(cashierToken, cashierShop).get(
      `/api/v1/catalog/products/${id}/barcodes`,
    );
    const primary = codes.body.data.find((row: { isPrimary: boolean }) => row.isPrimary);
    assert.equal(primary.barcode, "8902222222222");
    assert.equal(
      codes.body.data.filter((row: { isPrimary: boolean }) => row.isPrimary).length,
      1,
    );

    const duplicate = await authed(stockToken, stockShop)
      .post(`/api/v1/catalog/products/${id}/barcodes`)
      .send({ barcode: "890 1111111111" });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, "BARCODE_ALREADY_EXISTS");

    const scanned = await authed(cashierToken, cashierShop).get(
      "/api/v1/catalog/products/barcode/8902222222222",
    );
    assert.equal(scanned.status, 200);
    assert.equal(scanned.body.data.id, id);
    assert.equal(scanned.body.data.sellingPrice, "10.00");
    assert.equal("purchasePrice" in scanned.body.data, false);

    const otherScan = await authed(otherToken, otherShop).get(
      "/api/v1/catalog/products/barcode/8902222222222",
    );
    assert.equal(otherScan.status, 404);
    const otherAttach = await authed(otherToken, otherShop)
      .post(`/api/v1/catalog/products/${id}/barcodes`)
      .send({ barcode: "8903333333333" });
    assert.equal(otherAttach.status, 404);
    const otherPatch = await authed(otherToken, otherShop)
      .patch(`/api/v1/catalog/products/${id}`)
      .send({ name: "Stolen" });
    assert.equal(otherPatch.status, 404);

    await authed(ownerToken, ownerShop).post(`/api/v1/catalog/products/${id}/deactivate`);
    const inactive = await authed(cashierToken, cashierShop).get(
      "/api/v1/catalog/products/barcode/8902222222222",
    );
    assert.equal(inactive.status, 409);
    assert.equal(inactive.body.error.code, "PRODUCT_INACTIVE");
    const hidden = await authed(cashierToken, cashierShop).get(
      "/api/v1/catalog/products?search=8902222222222",
    );
    assert.equal(hidden.body.pagination.total, 0);
    await authed(ownerToken, ownerShop).post(`/api/v1/catalog/products/${id}/reactivate`);

    for (const term of ["8902222222222", "pg250", "Parle", "PARLE-G", "पार्ले", "पार्ले-जी"]) {
      const found = await authed(cashierToken, cashierShop).get(
        `/api/v1/catalog/products?search=${encodeURIComponent(term)}`,
      );
      assert.equal(found.status, 200, term);
      assert.equal(
        found.body.data.some((row: { id: string }) => row.id === id),
        true,
        term,
      );
    }
    const isolated = await authed(otherToken, otherShop).get(
      "/api/v1/catalog/products?search=Parle-G%20250g%20Scan",
    );
    assert.equal(
      isolated.body.data.some((row: { id: string }) => row.id === id),
      false,
    );
    const pinned = await authed(ownerToken, ownerShop)
      .get("/api/v1/catalog/products")
      .query({ search: "Parle-G 250g Scan" })
      .set("x-tenant-id", otherShopId);
    assert.equal(
      pinned.body.data.some((row: { id: string }) => row.id === id),
      true,
    );
  });

  it("pages a shop catalog without an unbounded limit", async () => {
    for (let index = 1; index <= 24; index += 1) {
      const created = await authed(ownerToken, ownerShop)
        .post("/api/v1/catalog/products")
        .send({ name: `Page Item ${String(index).padStart(2, "0")}`, unitId });
      assert.equal(created.status, 201);
    }
    const started = Date.now();
    const first = await authed(ownerToken, ownerShop).get(
      "/api/v1/catalog/products?search=Page%20Item&page=1&limit=10",
    );
    const second = await authed(ownerToken, ownerShop).get(
      "/api/v1/catalog/products?search=Page%20Item&page=3&limit=10",
    );
    assert.equal(first.body.pagination.total, 24);
    assert.equal(first.body.data.length, 10);
    assert.equal(second.body.data.length, 4);
    assert.equal(first.body.data.every((row: { unit: string }) => row.unit === "Piece"), true);
    assert.ok(Date.now() - started < 2000);
    const huge = await authed(ownerToken, ownerShop).get("/api/v1/catalog/products?limit=1000000");
    assert.equal(huge.status, 400);
  });

  it("manages units, categories, and brands inside the shop", async () => {
    const duplicate = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/units")
      .send({ name: "Piece", shortCode: "pc2", decimalPlaces: 0 });
    assert.equal(duplicate.status, 409);

    const grocery = await authed(adminToken, adminShop)
      .post("/api/v1/catalog/categories")
      .send({ name: "Grocery" });
    assert.equal(grocery.status, 201);
    const biscuits = await authed(adminToken, adminShop)
      .post("/api/v1/catalog/categories")
      .send({ name: "Biscuits", parentId: grocery.body.data.id });
    assert.equal(biscuits.status, 201);
    assert.equal(biscuits.body.data.parentId, grocery.body.data.id);
    const again = await authed(adminToken, adminShop)
      .post("/api/v1/catalog/categories")
      .send({ name: "Biscuits", parentId: grocery.body.data.id });
    assert.equal(again.status, 409);
    const self = await authed(adminToken, adminShop)
      .patch(`/api/v1/catalog/categories/${grocery.body.data.id}`)
      .send({ parentId: grocery.body.data.id });
    assert.equal(self.status, 400);
    await authed(adminToken, adminShop)
      .patch(`/api/v1/catalog/categories/${biscuits.body.data.id}`)
      .send({ isActive: false });
    const inactiveCategory = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/products")
      .send({ name: "Old biscuit", unitId, categoryId: biscuits.body.data.id });
    assert.equal(inactiveCategory.status, 422);
    assert.equal(inactiveCategory.body.error.code, "CATEGORY_INACTIVE");

    const brand = await authed(stockToken, stockShop)
      .post("/api/v1/catalog/brands")
      .send({ name: "Parle" });
    assert.equal(brand.status, 201);
    const brandAgain = await authed(stockToken, stockShop)
      .post("/api/v1/catalog/brands")
      .send({ name: "Parle" });
    assert.equal(brandAgain.status, 409);
    const otherBrands = await authed(otherToken, otherShop).get("/api/v1/catalog/brands");
    assert.equal(
      otherBrands.body.data.some((row: { id: string }) => row.id === brand.body.data.id),
      false,
    );
    const otherUnits = await authed(otherToken, otherShop).get("/api/v1/catalog/units");
    assert.equal(
      otherUnits.body.data.some((row: { id: string }) => row.id === unitId),
      false,
    );

    const spec = await request(app.getHttpServer()).get("/api/docs-json");
    const paths = Object.keys(spec.body.paths as Record<string, unknown>);
    for (const path of [
      "/api/v1/catalog/products",
      "/api/v1/catalog/products/barcode/{barcode}",
      "/api/v1/catalog/products/{id}",
      "/api/v1/catalog/products/{id}/price-history",
      "/api/v1/catalog/categories",
      "/api/v1/catalog/brands",
      "/api/v1/catalog/units",
    ]) {
      assert.equal(paths.includes(path), true, path);
    }
  });

  function authed(token: string, shopContext: string) {
    const http = request(app.getHttpServer());
    const headers = (method: "get" | "post" | "patch" | "delete") => (path: string) =>
      http[method](path).set("Authorization", `Bearer ${token}`).set("x-dukaan-shop", shopContext);
    return { get: headers("get"), post: headers("post"), patch: headers("patch"), delete: headers("delete") };
  }

  async function login(national: string): Promise<{ token: string; userId: string }> {
    const requested = await request(app.getHttpServer())
      .post("/api/v1/auth/request-otp")
      .send({ phone: national });
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
    const code = sender.latest(normalizeIndianPhone(national));
    assert.ok(code);
    const verified = await request(app.getHttpServer())
      .post("/api/v1/auth/verify-otp")
      .send({ phone: national, code });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    return {
      token: verified.body.data.token as string,
      userId: verified.body.data.user.id as string,
    };
  }

  async function createShop(token: string, name: string): Promise<{ id: string; shopContext: string }> {
    const response = await request(app.getHttpServer())
      .post("/api/v1/tenants")
      .set("Authorization", `Bearer ${token}`)
      .send({ name, businessType: "GROCERY" });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return {
      id: response.body.data.id as string,
      shopContext: response.body.data.shopContext as string,
    };
  }

  async function selectShop(token: string, tenantId: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/tenants/${tenantId}/select`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.data.shopContext as string;
  }
});

function nextNational(): string {
  serial += 1;
  const national = String(serial);
  phones.push(normalizeIndianPhone(national));
  return national;
}

async function cleanup(admin: Client, numbers: string[]): Promise<void> {
  const tenants = `(SELECT id FROM tenants WHERE name LIKE '[CAT]%')`;
  await admin.query("ALTER TABLE product_price_history DISABLE TRIGGER product_price_history_append_only");
  try {
    await admin.query(`DELETE FROM product_price_history WHERE tenant_id IN ${tenants}`);
  } finally {
    await admin.query("ALTER TABLE product_price_history ENABLE TRIGGER product_price_history_append_only");
  }
  await admin.query(`DELETE FROM product_barcodes WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM products WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM categories WHERE tenant_id IN ${tenants} AND parent_id IS NOT NULL`);
  await admin.query(`DELETE FROM categories WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM brands WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM units WHERE tenant_id IN ${tenants}`);
  await admin.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only");
  try {
    await admin.query(
      `DELETE FROM audit_logs
       WHERE tenant_id IN ${tenants}
          OR actor_user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
      [numbers],
    );
  } finally {
    await admin.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only");
  }
  await admin.query(
    `DELETE FROM memberships
     WHERE tenant_id IN ${tenants}
        OR user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`UPDATE tenants SET default_location_id = NULL WHERE name LIKE '[CAT]%'`);
  await admin.query(`DELETE FROM locations WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM document_counters WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM expense_categories WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM tenants WHERE name LIKE '[CAT]%'`);
  await admin.query(
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`DELETE FROM otp_challenges WHERE phone = ANY($1::text[])`, [numbers]);
  await admin.query(`DELETE FROM users WHERE phone = ANY($1::text[])`, [numbers]);
}
