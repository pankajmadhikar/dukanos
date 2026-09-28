import "dotenv/config";
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "@jest/globals";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Client } from "pg";
import request, { Response } from "supertest";
import { AppModule } from "../src/app.module";
import { AiIntakeService } from "../src/ai-intake/ai-intake.service";
import { imageSignatureSample } from "../src/ai-intake/intake-media";
import { MockAiProductIntakeProvider } from "../src/ai-intake/mock-ai-product-intake.provider";
import { MockObjectStorage } from "../src/ai-intake/object-storage";
import { CapturingOtpSender } from "../src/auth/capturing-otp-sender";
import { OTP_SENDER } from "../src/auth/otp-sender";
import { normalizeIndianPhone } from "../src/auth/phone";
import { configureApp } from "../src/configure-app";

jest.setTimeout(60_000);
process.env.PRISMA_CONNECTION_LIMIT = "2";
process.env.OTP_IP_LIMIT = "500";

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  throw new Error("DATABASE_ADMIN_URL is required for AI intake tests.");
}

let serial = 8200001000;
const phones: string[] = [];

describe("ai intake", () => {
  let app: INestApplication;
  let admin: Client;
  let sender: CapturingOtpSender;
  let provider: MockAiProductIntakeProvider;
  let storage: MockObjectStorage;
  let intake: AiIntakeService;
  let ownerToken = "";
  let ownerUserId = "";
  let ownerShop = "";
  let shopId = "";
  let adminToken = "";
  let adminShop = "";
  let cashierToken = "";
  let cashierShop = "";
  let stockToken = "";
  let stockShop = "";
  let otherToken = "";
  let otherUserId = "";
  let otherShopId = "";
  let otherShop = "";
  let unitId = "";

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.init();
    sender = app.get<CapturingOtpSender>(OTP_SENDER);
    provider = app.get(MockAiProductIntakeProvider);
    storage = app.get(MockObjectStorage);
    intake = app.get(AiIntakeService);

    const owner = await login(nextNational());
    ownerToken = owner.token;
    ownerUserId = owner.userId;
    const created = await createShop(ownerToken, "[AI] Shop A");
    shopId = created.id;
    ownerShop = created.shopContext;

    const shopAdmin = await login(nextNational());
    const cashier = await login(nextNational());
    const stock = await login(nextNational());
    const other = await login(nextNational());
    await admin.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role)
       VALUES ($1, $2, $3, 'ADMIN'), ($4, $2, $5, 'CASHIER'), ($6, $2, $7, 'STOCK_KEEPER')
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [
        randomUUID(),
        shopId,
        shopAdmin.userId,
        randomUUID(),
        cashier.userId,
        randomUUID(),
        stock.userId,
      ],
    );
    adminToken = shopAdmin.token;
    adminShop = await selectShop(shopAdmin.token, shopId);
    cashierToken = cashier.token;
    cashierShop = await selectShop(cashier.token, shopId);
    stockToken = stock.token;
    stockShop = await selectShop(stock.token, shopId);
    otherToken = other.token;
    otherUserId = other.userId;
    const otherCreated = await createShop(other.token, "[AI] Shop B");
    otherShopId = otherCreated.id;
    otherShop = otherCreated.shopContext;

    const unit = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/units")
      .send({ name: "Packet", shortCode: "pkt", decimalPlaces: 0 });
    assert.equal(unit.status, 201, JSON.stringify(unit.body));
    unitId = unit.body.data.id as string;
    const category = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/categories")
      .send({ name: "Biscuits" });
    assert.equal(category.status, 201, JSON.stringify(category.body));
    const brand = await authed(ownerToken, ownerShop).post("/api/v1/catalog/brands").send({ name: "Parle" });
    assert.equal(brand.status, 201, JSON.stringify(brand.body));
  });

  afterAll(async () => {
    try {
      if (admin) {
        await cleanup(admin, phones);
        await admin.end();
      }
    } finally {
      delete process.env.PRISMA_CONNECTION_LIMIT;
      if (app) {
        await app.close();
      }
    }
  });

  it("creates a shop intake and keeps other shops out", async () => {
    const denied = await authed(cashierToken, cashierShop).post("/api/v1/ai/intake").send({});
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "AI_INTAKE_ACCESS_DENIED");

    const leaked = await authed(ownerToken, ownerShop)
      .post("/api/v1/ai/intake")
      .send({ tenantId: shopId });
    assert.equal(leaked.status, 400);

    const created = await authed(ownerToken, ownerShop).post("/api/v1/ai/intake").send({});
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, "UPLOADED");
    assert.equal(typeof created.body.data.id, "string");
    assert.equal(typeof created.body.data.createdAt, "string");

    const asAdmin = await authed(adminToken, adminShop).post("/api/v1/ai/intake").send({});
    assert.equal(asAdmin.status, 201, JSON.stringify(asAdmin.body));

    const otherGet = await authed(otherToken, otherShop).get(`/api/v1/ai/intake/${created.body.data.id}`);
    assert.equal(otherGet.status, 404);
    assert.equal(otherGet.body.error.code, "AI_INTAKE_NOT_FOUND");
  });

  it("issues an upload URL and rejects bad media", async () => {
    const intakeId = await createIntake(ownerToken, ownerShop);
    const video = await authed(ownerToken, ownerShop)
      .post(`/api/v1/ai/intake/${intakeId}/upload-url`)
      .send({ fileName: "clip.mp4", contentType: "video/mp4", size: 1000 });
    assert.equal(video.status, 400);
    assert.match(video.body.error.message, /Video processing is not enabled/);

    const gif = await authed(ownerToken, ownerShop)
      .post(`/api/v1/ai/intake/${intakeId}/upload-url`)
      .send({ fileName: "photo.gif", contentType: "image/gif", size: 1000 });
    assert.equal(gif.status, 400);

    const mismatch = await authed(ownerToken, ownerShop)
      .post(`/api/v1/ai/intake/${intakeId}/upload-url`)
      .send({ fileName: "photo.png", contentType: "image/jpeg", size: 1000 });
    assert.equal(mismatch.status, 400);

    const huge = await authed(ownerToken, ownerShop)
      .post(`/api/v1/ai/intake/${intakeId}/upload-url`)
      .send({ fileName: "photo.jpg", contentType: "image/jpeg", size: 10 * 1024 * 1024 + 1 });
    assert.equal(huge.status, 400);

    const other = await authed(otherToken, otherShop)
      .post(`/api/v1/ai/intake/${intakeId}/upload-url`)
      .send({ fileName: "photo.jpg", contentType: "image/jpeg", size: 1000 });
    assert.equal(other.status, 404);

    const uploaded = await authed(ownerToken, ownerShop)
      .post(`/api/v1/ai/intake/${intakeId}/upload-url`)
      .send({ fileName: "shop-products.jpg", contentType: "image/jpeg", size: 2048 });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.data.method, "PUT");
    assert.equal(uploaded.body.data.headers["content-type"], "image/jpeg");
    assert.match(uploaded.body.data.url, /^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/dev\/mock-storage\//);
    assert.match(uploaded.body.data.objectKey, new RegExp(`^tenants/${shopId}/ai-intake/${intakeId}/`));
    assert.equal(String(uploaded.body.data.objectKey).includes("shop-products"), false);
    assert.equal(JSON.stringify(uploaded.body).includes("secret"), false);
    assert.equal(typeof uploaded.body.data.expiresAt, "string");

    const png = await createIntake(stockToken, stockShop);
    const pngUpload = await authed(stockToken, stockShop)
      .post(`/api/v1/ai/intake/${png}/upload-url`)
      .send({ fileName: "shelf.webp", contentType: "image/webp", size: 300 });
    assert.equal(pngUpload.status, 200, JSON.stringify(pngUpload.body));
  });

  it("does not process twice and does not create stock before confirmation", async () => {
    const before = await counts();
    const intakeId = await prepare(ownerToken, ownerShop, "shop-products.jpg");
    const queued = await authed(ownerToken, ownerShop).post(`/api/v1/ai/intake/${intakeId}/process`);
    assert.equal(queued.status, 200, JSON.stringify(queued.body));
    assert.equal(queued.body.data.status, "QUEUED");
    assert.equal(queued.body.data.items.length, 0);
    const processed = await waitStatus(ownerToken, ownerShop, intakeId, "DRAFT_READY");
    assert.equal(processed.body.data.media.contentType, "image/jpeg");
    assert.equal(processed.body.data.items.length, 1);
    const item = processed.body.data.items[0];
    assert.equal(item.name, "Parle-G Biscuits");
    assert.equal(item.barcode, "8901234567890");
    assert.equal(item.quantity, "12.000");
    assert.equal(item.purchasePrice, "10.00");
    assert.equal(item.sellingPrice, "12.00");
    assert.equal(item.confidence, "0.9400");
    assert.equal(item.status, "PENDING");
    assert.equal(item.unit, "packet");
    const after = await counts();
    assert.equal(after.products, before.products);
    assert.equal(after.purchases, before.purchases);
    assert.equal(after.movements, before.movements);
    assert.equal(after.balances, before.balances);

    const again = await authed(ownerToken, ownerShop).post(`/api/v1/ai/intake/${intakeId}/process`);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "CONFLICT");

    const bare = await createIntake(ownerToken, ownerShop);
    const missing = await authed(ownerToken, ownerShop).post(`/api/v1/ai/intake/${bare}/process`);
    assert.equal(missing.status, 409);
  });

  it("keeps a failed analysis from creating products and allows a retry", async () => {
    const before = await counts();
    const failedId = await prepare(ownerToken, ownerShop, "unreadable.jpg");
    const queued = await authed(ownerToken, ownerShop).post(`/api/v1/ai/intake/${failedId}/process`);
    assert.equal(queued.status, 200, JSON.stringify(queued.body));
    assert.equal(queued.body.data.status, "QUEUED");
    const saved = await waitStatus(ownerToken, ownerShop, failedId, "FAILED");
    assert.equal(saved.body.data.items.length, 0);
    assert.equal(saved.body.data.failureReason, "We could not process this image. Please try again.");
    assert.equal(JSON.stringify(saved.body).includes("AI_API_KEY"), false);
    const denied = await authed(ownerToken, ownerShop).post(`/api/v1/ai/intake/${failedId}/retry`);
    assert.equal(denied.status, 409, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, "AI_INTAKE_NOT_RETRYABLE");
    const after = await counts();
    assert.equal(after.products, before.products);
    assert.equal(after.purchases, before.purchases);
    assert.equal(after.movements, before.movements);
    assert.equal(after.balances, before.balances);

    const retryId = await prepare(ownerToken, ownerShop, "fail-once.jpg");
    const first = await authed(ownerToken, ownerShop).post(`/api/v1/ai/intake/${retryId}/process`);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.status, "QUEUED");
    const second = await waitStatus(ownerToken, ownerShop, retryId, "DRAFT_READY");
    assert.equal(second.body.data.items[0].name, "Parle-G Biscuits");
    const still = await counts();
    assert.equal(still.products, before.products);
  });

  it("marks a slow provider as failed instead of leaving processing running", async () => {
    const intakeId = await prepare(ownerToken, ownerShop, "slow.jpg");
    process.env.AI_INTAKE_PROVIDER_TIMEOUT_MS = "30";
    try {
      const timed = await authed(ownerToken, ownerShop).post(`/api/v1/ai/intake/${intakeId}/process`);
      assert.equal(timed.status, 200, JSON.stringify(timed.body));
      assert.equal(timed.body.data.status, "QUEUED");
      const saved = await waitStatus(ownerToken, ownerShop, intakeId, "FAILED");
      assert.equal(saved.body.data.items.length, 0);
    } finally {
      delete process.env.AI_INTAKE_PROVIDER_TIMEOUT_MS;
    }
  });

  it("rejects a second process while the first is still running", async () => {
    const intakeId = await prepare(ownerToken, ownerShop, "hold.jpg");
    provider.armHold();
    try {
      const first = await authed(ownerToken, ownerShop).post(`/api/v1/ai/intake/${intakeId}/process`);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.data.status, "QUEUED");
      await provider.whenEntered();
      const second = await authed(ownerToken, ownerShop).post(`/api/v1/ai/intake/${intakeId}/process`);
      assert.equal(second.status, 409, JSON.stringify(second.body));
      assert.equal(second.body.error.code, "CONFLICT");
      provider.release();
      const ready = await waitStatus(ownerToken, ownerShop, intakeId, "DRAFT_READY");
      assert.equal(ready.body.data.items.length, 1);
    } finally {
      provider.release();
    }
  });

  it("matches barcode, SKU, and exact name, and keeps fuzzy names for review", async () => {
    const barcodeProduct = await createProduct("Existing Biscuits", { barcode: "8901999888777" });
    const barcodeIntake = await prepare(ownerToken, ownerShop, "barcode-match.jpg");
    const barcodeView = await analyzed(ownerToken, ownerShop, barcodeIntake);
    assert.equal(barcodeView.body.data.items[0].matchType, "EXACT_BARCODE_MATCH");
    assert.equal(barcodeView.body.data.items[0].matchedProduct.id, barcodeProduct);
    assert.equal(barcodeView.body.data.items[0].needsReview, false);

    const skuProduct = await createProduct("Shop Biscuits", { sku: "PARLE-G" });
    const skuIntake = await prepare(ownerToken, ownerShop, "sku-match.jpg");
    const skuView = await analyzed(ownerToken, ownerShop, skuIntake);
    assert.equal(skuView.body.data.items[0].matchType, "EXACT_SKU_MATCH");
    assert.equal(skuView.body.data.items[0].matchedProduct.id, skuProduct);
    assert.equal(skuView.body.data.items[0].sku, "PARLE-G");

    await createProduct("Groundnut Oil");
    const nameIntake = await prepare(ownerToken, ownerShop, "exact-name.jpg");
    const nameView = await analyzed(ownerToken, ownerShop, nameIntake);
    assert.equal(nameView.body.data.items[0].matchType, "EXACT_NAME_MATCH");
    assert.equal(nameView.body.data.items[0].matchedProduct.name, "Groundnut Oil");

    const similar = await createProduct("Parle-G 250 Gram");
    const fuzzyIntake = await prepare(ownerToken, ownerShop, "fuzzy.jpg");
    const fuzzyView = await analyzed(ownerToken, ownerShop, fuzzyIntake);
    const fuzzy = fuzzyView.body.data.items[0];
    assert.equal(fuzzy.matchType, "POSSIBLE_MATCH");
    assert.equal(fuzzy.reviewStatus, "NEEDS_REVIEW");
    assert.equal(fuzzy.matchedProduct, null);
    assert.equal(typeof fuzzy.possibleProduct.id, "string");
    assert.notEqual(fuzzy.name, "Parle-G 250 Gram");

    const accepted = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/ai/intake/${fuzzyIntake}/items/${fuzzy.id}`)
      .send({ matchedProductId: similar });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.matchType, "SHOPKEEPER_MATCH");
    assert.equal(accepted.body.data.matchedProduct.id, similar);
    const before = await productCount();
    const confirmed = await authed(ownerToken, ownerShop)
      .post(`/api/v1/ai/intake/${fuzzyIntake}/confirm`)
      .send({ mode: "CREATE_PRODUCT_ONLY" });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.data.items[0].created, false);
    assert.equal(confirmed.body.data.items[0].productId, similar);
    assert.equal(await productCount(), before);

    const unknownId = await prepare(ownerToken, ownerShop, "unknown.jpg");
    const unknown = await analyzed(ownerToken, ownerShop, unknownId);
    assert.equal(unknown.body.data.items[0].name, "Unknown Product");
    assert.equal(unknown.body.data.items[0].matchType, "NEW_PRODUCT");
    assert.equal(unknown.body.data.items[0].matchedProduct, null);
    assert.equal(unknown.body.data.items[0].reviewStatus, "NEEDS_REVIEW");
    assert.equal(unknown.body.data.items[0].confidence, "0.4200");
  });

  it("edits and rejects drafts without writing the catalog", async () => {
    const before = await productCount();
    const intakeId = await prepare(ownerToken, ownerShop, "low.jpg");
    const processed = await analyzed(ownerToken, ownerShop, intakeId);
    const itemId = processed.body.data.items[0].id as string;
    assert.equal(processed.body.data.items[0].reviewStatus, "NEEDS_REVIEW");
    assert.equal(await productCount(), before);

    const blank = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/ai/intake/${intakeId}/items/${itemId}`)
      .send({ name: "   " });
    assert.equal(blank.status, 400);
    const badPrice = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/ai/intake/${intakeId}/items/${itemId}`)
      .send({ purchasePrice: "abc" });
    assert.equal(badPrice.status, 400);
    const other = await authed(otherToken, otherShop)
      .patch(`/api/v1/ai/intake/${intakeId}/items/${itemId}`)
      .send({ name: "Stolen" });
    assert.equal(other.status, 404);

    const edited = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/ai/intake/${intakeId}/items/${itemId}`)
      .send({ name: "Loose Leaf Tea", quantity: "3" });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.data.name, "Loose Leaf Tea");
    assert.equal(edited.body.data.quantity, "3.000");
    assert.equal(edited.body.data.status, "PENDING");
    const unchanged = await authed(ownerToken, ownerShop).get(`/api/v1/ai/intake/${intakeId}`);
    assert.equal(unchanged.body.data.status, "DRAFT_READY");

    const rejected = await authed(ownerToken, ownerShop).post(
      `/api/v1/ai/intake/${intakeId}/items/${itemId}/reject`,
    );
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.data.status, "REJECTED");
    const confirm = await authed(ownerToken, ownerShop)
      .post(`/api/v1/ai/intake/${intakeId}/confirm`)
      .send({ mode: "CREATE_PRODUCT_ONLY", itemIds: [itemId] });
    assert.equal(confirm.status, 409);
    assert.equal(await productCount(), before);
    const cashier = await authed(cashierToken, cashierShop).get(`/api/v1/ai/intake/${intakeId}`);
    assert.equal(cashier.status, 403);
  });

  it("confirms a new product and opening stock through the existing services", async () => {
    const before = await counts();
    const openings = await auditCount("inventory.opening_created");
    const intakeId = await prepare(ownerToken, ownerShop, "parle-confirm.jpg");
    const processed = await analyzed(ownerToken, ownerShop, intakeId);
    const mid = await counts();
    assert.equal(mid.products, before.products);
    assert.equal(mid.movements, before.movements);
    assert.equal(mid.purchases, before.purchases);
    const item = processed.body.data.items[0];
    const edited = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/ai/intake/${intakeId}/items/${item.id}`)
      .send({ quantity: "10" });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.data.quantity, "10.000");

    const confirmed = await authed(ownerToken, ownerShop)
      .post(`/api/v1/ai/intake/${intakeId}/confirm`)
      .set("Idempotency-Key", "ai-parle-stock")
      .send({ mode: "CREATE_PRODUCT_AND_STOCK" });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.data.status, "CONFIRMED");
    assert.equal(confirmed.body.data.purchaseId, null);
    assert.equal(confirmed.body.data.items[0].created, true);
    const productId = confirmed.body.data.items[0].productId as string;

    const replay = await authed(ownerToken, ownerShop)
      .post(`/api/v1/ai/intake/${intakeId}/confirm`)
      .set("Idempotency-Key", "ai-parle-stock")
      .send({ mode: "CREATE_PRODUCT_AND_STOCK" });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.items[0].productId, productId);

    const conflict = await authed(ownerToken, ownerShop)
      .post(`/api/v1/ai/intake/${intakeId}/confirm`)
      .set("Idempotency-Key", "ai-parle-stock")
      .send({ mode: "CREATE_PRODUCT_ONLY" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");

    const again = await authed(ownerToken, ownerShop)
      .post(`/api/v1/ai/intake/${intakeId}/confirm`)
      .send({ mode: "CREATE_PRODUCT_AND_STOCK" });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "CONFLICT");

    const product = await authed(ownerToken, ownerShop).get(`/api/v1/catalog/products/${productId}`);
    assert.equal(product.status, 200, JSON.stringify(product.body));
    assert.equal(product.body.data.name, "Parle-G Biscuits");
    assert.equal(product.body.data.barcode, "8901234567890");
    assert.equal(product.body.data.brand.name, "Parle");
    assert.equal(product.body.data.category.name, "Biscuits");
    assert.equal(product.body.data.sellingPrice, "12.00");
    assert.equal(product.body.data.purchasePrice, "10.00");
    await assertStock(productId, "10.000", "10.00");
    const moved = await admin.query<{ movement_type: string; count: string }>(
      `SELECT movement_type, count(*)::text AS count
       FROM inventory_movements WHERE product_id = $1::uuid GROUP BY movement_type`,
      [productId],
    );
    assert.equal(moved.rows.length, 1);
    assert.equal(moved.rows[0]?.movement_type, "OPENING_STOCK");
    assert.equal(moved.rows[0]?.count, "1");
    const barcodes = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM product_barcodes
       WHERE tenant_id = $1::uuid AND barcode = '8901234567890'`,
      [shopId],
    );
    assert.equal(barcodes.rows[0]?.count, "1");
    assert.equal(await auditCount("inventory.opening_created"), openings + 1);
    const intakeAudit = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
       WHERE tenant_id = $1::uuid AND entity_id = $2::uuid AND action = 'ai_intake.confirmed'`,
      [shopId, intakeId],
    );
    assert.equal(intakeAudit.rows[0]?.count, "1");
    const productAudit = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
       WHERE tenant_id = $1::uuid AND entity_id = $2::uuid AND action = 'product.created'`,
      [shopId, productId],
    );
    assert.equal(productAudit.rows[0]?.count, "1");
  });

  it("confirms an existing product with a purchase and the shop purchase counter", async () => {
    const productId = await createProduct("Rice Bag", {
      barcode: "8901777666555",
      defaultSellingPrice: "80.00",
    });
    const opened = await authed(ownerToken, ownerShop)
      .post("/api/v1/inventory/opening")
      .send({ productId, quantity: "10", unitCost: "10.00" });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const supplier = await authed(ownerToken, ownerShop).post("/api/v1/suppliers").send({ name: "Rice Mill" });
    assert.equal(supplier.status, 201, JSON.stringify(supplier.body));
    const expectedNumber = await nextPurchaseNumber();

    const intakeId = await prepare(ownerToken, ownerShop, "rice-bill.jpg");
    const processed = await analyzed(ownerToken, ownerShop, intakeId);
    const itemId = processed.body.data.items[0].id as string;
    const linked = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/ai/intake/${intakeId}/items/${itemId}`)
      .send({
        matchedProductId: productId,
        barcode: "8901777666555",
        quantity: "10",
        purchasePrice: "20.00",
      });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.equal(linked.body.data.matchType, "SHOPKEEPER_MATCH");

    const confirmed = await authed(stockToken, stockShop)
      .post(`/api/v1/ai/intake/${intakeId}/confirm`)
      .send({
        mode: "CREATE_PRODUCT_AND_STOCK",
        supplierId: supplier.body.data.id,
      });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.data.items[0].created, false);
    assert.equal(confirmed.body.data.items[0].productId, productId);
    assert.equal(confirmed.body.data.purchaseNumber, expectedNumber);
    await assertStock(productId, "20.000", "15.00");
    const purchase = await authed(ownerToken, ownerShop).get(
      `/api/v1/purchases/${confirmed.body.data.purchaseId}`,
    );
    assert.equal(purchase.status, 200, JSON.stringify(purchase.body));
    assert.equal(purchase.body.data.purchaseNumber, expectedNumber);
  });

  it("creates a product without stock when stock figures are absent", async () => {
    const intakeId = await prepare(ownerToken, ownerShop, "exact-name-only.jpg");
    const processed = await analyzed(ownerToken, ownerShop, intakeId);
    assert.equal(processed.body.data.items[0].matchType, "EXACT_NAME_MATCH");
    const beforeMoves = await counts();
    const confirmed = await authed(ownerToken, ownerShop)
      .post(`/api/v1/ai/intake/${intakeId}/confirm`)
      .send({ mode: "CREATE_PRODUCT_ONLY" });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.data.items[0].created, false);
    assert.equal(confirmed.body.data.purchaseId, null);
    const after = await counts();
    assert.equal(after.movements, beforeMoves.movements);
    assert.equal(after.purchases, beforeMoves.purchases);
  });

  it("refuses a duplicate barcode and rolls back a duplicate SKU", async () => {
    const existing = await createProduct("Old Tin", { barcode: "8901888777666" });
    const off = await authed(ownerToken, ownerShop)
      .patch(`/api/v1/catalog/products/${existing}`)
      .send({ isActive: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const before = await productCount();
    const intakeId = await prepare(ownerToken, ownerShop, "taken-barcode.jpg");
    const processed = await analyzed(ownerToken, ownerShop, intakeId);
    assert.equal(processed.body.data.items[0].matchedProduct, null);
    const denied = await authed(ownerToken, ownerShop)
      .post(`/api/v1/ai/intake/${intakeId}/confirm`)
      .send({ mode: "CREATE_PRODUCT_ONLY" });
    assert.equal(denied.status, 409, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, "BARCODE_ALREADY_EXISTS");
    assert.equal(await productCount(), before);
    const still = await authed(ownerToken, ownerShop).get(`/api/v1/ai/intake/${intakeId}`);
    assert.equal(still.body.data.status, "DRAFT_READY");
    assert.equal(still.body.data.items[0].status, "PENDING");

    const rollbackId = await prepare(ownerToken, ownerShop, "rollback.jpg");
    await analyzed(ownerToken, ownerShop, rollbackId);
    const failed = await authed(ownerToken, ownerShop)
      .post(`/api/v1/ai/intake/${rollbackId}/confirm`)
      .send({ mode: "CREATE_PRODUCT_ONLY" });
    assert.equal(failed.status, 409, JSON.stringify(failed.body));
    assert.equal(failed.body.error.code, "SKU_ALREADY_EXISTS");
    const names = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM products
       WHERE tenant_id = $1::uuid AND name IN ('First Draft', 'Second Draft')`,
      [shopId],
    );
    assert.equal(names.rows[0]?.count, "0");
    const open = await authed(ownerToken, ownerShop).get(`/api/v1/ai/intake/${rollbackId}`);
    assert.equal(open.body.data.status, "DRAFT_READY");
    assert.equal(open.body.data.items.every((item: { status: string }) => item.status === "PENDING"), true);

    const noUnit = await prepare(ownerToken, ownerShop, "no-unit.jpg");
    await analyzed(ownerToken, ownerShop, noUnit);
    const missingUnit = await authed(ownerToken, ownerShop)
      .post(`/api/v1/ai/intake/${noUnit}/confirm`)
      .send({ mode: "CREATE_PRODUCT_ONLY" });
    assert.equal(missingUnit.status, 400, JSON.stringify(missingUnit.body));
    const sugar = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM products WHERE tenant_id = $1::uuid AND name = 'Loose Sugar'`,
      [shopId],
    );
    assert.equal(sugar.rows[0]?.count, "0");
  });

  it("confirms every selected item in one request", async () => {
    const intakeId = await prepare(ownerToken, ownerShop, "multi.jpg");
    const processed = await analyzed(ownerToken, ownerShop, intakeId);
    assert.equal(processed.body.data.items.length, 2);
    const confirmed = await authed(adminToken, adminShop)
      .post(`/api/v1/ai/intake/${intakeId}/confirm`)
      .send({ mode: "CREATE_PRODUCT_AND_STOCK" });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.data.status, "CONFIRMED");
    assert.equal(confirmed.body.data.items.length, 2);
    assert.equal(confirmed.body.data.items.every((item: { created: boolean }) => item.created), true);
    for (const item of confirmed.body.data.items as Array<{ productId: string }>) {
      const rows = await admin.query<{ quantity: string }>(
        `SELECT quantity::text AS quantity FROM inventory_balances WHERE product_id = $1::uuid`,
        [item.productId],
      );
      assert.equal(rows.rows.length, 1);
    }
  });

  it("keeps intake media inside the shop that uploaded it", async () => {
    const intakeId = await prepare(ownerToken, ownerShop, "private.jpg");
    const media = await authed(ownerToken, ownerShop).get(`/api/v1/ai/intake/${intakeId}/media-url`);
    assert.equal(media.status, 200, JSON.stringify(media.body));
    assert.match(media.body.data.url, /^http:\/\/127\.0\.0\.1\/mock-storage\/download\//);
    assert.equal(typeof media.body.data.expiresAt, "string");
    assert.equal(JSON.stringify(media.body).includes("secret"), false);

    const otherMedia = await authed(otherToken, otherShop).get(`/api/v1/ai/intake/${intakeId}/media-url`);
    assert.equal(otherMedia.status, 404);
    const otherProcess = await authed(otherToken, otherShop).post(`/api/v1/ai/intake/${intakeId}/process`);
    assert.equal(otherProcess.status, 404);
    const otherRetry = await authed(otherToken, otherShop).post(`/api/v1/ai/intake/${intakeId}/retry`);
    assert.equal(otherRetry.status, 404);

    await intake.runJob({ tenantId: otherShopId, userId: otherUserId, role: "OWNER", intakeId });
    const unchanged = await authed(ownerToken, ownerShop).get(`/api/v1/ai/intake/${intakeId}`);
    assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body));
    assert.equal(unchanged.body.data.status, "UPLOADED");
    assert.equal(unchanged.body.data.items.length, 0);
  });

  it("rejects an upload that was not stored or does not match the declared image", async () => {
    const missingId = await createIntake(ownerToken, ownerShop);
    const issued = await authed(ownerToken, ownerShop)
      .post(`/api/v1/ai/intake/${missingId}/upload-url`)
      .send({ fileName: "missing.jpg", contentType: "image/jpeg", size: 64 });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const missing = await authed(ownerToken, ownerShop).post(`/api/v1/ai/intake/${missingId}/process`);
    assert.equal(missing.status, 409, JSON.stringify(missing.body));
    assert.equal(missing.body.error.code, "AI_INTAKE_UPLOAD_NOT_VERIFIED");

    const mismatchId = await createIntake(ownerToken, ownerShop);
    const mismatchUpload = await authed(ownerToken, ownerShop)
      .post(`/api/v1/ai/intake/${mismatchId}/upload-url`)
      .send({ fileName: "wrong.jpg", contentType: "image/jpeg", size: 64 });
    await storage.put(mismatchUpload.body.data.objectKey as string, {
      contentType: "image/png",
      bytes: imageSignatureSample("image/png", 64),
    });
    const mismatch = await authed(ownerToken, ownerShop).post(`/api/v1/ai/intake/${mismatchId}/process`);
    assert.equal(mismatch.status, 400, JSON.stringify(mismatch.body));
    assert.equal(mismatch.body.error.code, "AI_INTAKE_MEDIA_INVALID");

    const pngId = await prepare(ownerToken, ownerShop, "shelf.png", "image/png");
    const png = await analyzed(ownerToken, ownerShop, pngId);
    assert.equal(png.body.data.status, "DRAFT_READY");
    const webpId = await prepare(ownerToken, ownerShop, "shelf.webp", "image/webp");
    const webp = await analyzed(ownerToken, ownerShop, webpId);
    assert.equal(webp.body.data.status, "DRAFT_READY");
  });

  it("recovers a stale processing session and enforces the retry limit", async () => {
    const intakeId = await prepare(ownerToken, ownerShop, "hold.jpg");
    provider.armHold();
    try {
      const queued = await authed(ownerToken, ownerShop).post(`/api/v1/ai/intake/${intakeId}/process`);
      assert.equal(queued.status, 200, JSON.stringify(queued.body));
      await provider.whenEntered();
      process.env.AI_INTAKE_PROCESSING_TIMEOUT_MINUTES = "0";
      await delay(20);
      const stale = await authed(ownerToken, ownerShop).get(`/api/v1/ai/intake/${intakeId}`);
      assert.equal(stale.body.data.status, "FAILED", JSON.stringify(stale.body));
      assert.equal(stale.body.data.canRetry, true);
      provider.release();
      await delay(30);
      const still = await authed(ownerToken, ownerShop).get(`/api/v1/ai/intake/${intakeId}`);
      assert.equal(still.body.data.status, "FAILED");
      const retried = await authed(ownerToken, ownerShop).post(`/api/v1/ai/intake/${intakeId}/retry`);
      assert.equal(retried.status, 200, JSON.stringify(retried.body));
      assert.equal(retried.body.data.status, "QUEUED");
      const ready = await waitStatus(ownerToken, ownerShop, intakeId, "DRAFT_READY");
      assert.equal(ready.body.data.items[0].name, "Parle-G Biscuits");
    } finally {
      delete process.env.AI_INTAKE_PROCESSING_TIMEOUT_MINUTES;
      provider.release();
    }

    const limitedId = await prepare(ownerToken, ownerShop, "fail-once.jpg");
    process.env.AI_MAX_RETRIES = "0";
    try {
      const queued = await authed(ownerToken, ownerShop).post(`/api/v1/ai/intake/${limitedId}/process`);
      assert.equal(queued.status, 200, JSON.stringify(queued.body));
      const failed = await waitStatus(ownerToken, ownerShop, limitedId, "FAILED");
      assert.equal(failed.body.data.canRetry, false);
      const limited = await authed(ownerToken, ownerShop).post(`/api/v1/ai/intake/${limitedId}/retry`);
      assert.equal(limited.status, 409, JSON.stringify(limited.body));
      assert.equal(limited.body.error.code, "AI_INTAKE_RETRY_LIMIT");
    } finally {
      delete process.env.AI_MAX_RETRIES;
    }
  });

  it("deletes abandoned media after the retention window and keeps an open draft", async () => {
    const openId = await prepare(ownerToken, ownerShop, "keep.jpg");
    await analyzed(ownerToken, ownerShop, openId);
    const abandonedId = await prepare(ownerToken, ownerShop, "drop.jpg");
    const abandoned = await authed(ownerToken, ownerShop).get(`/api/v1/ai/intake/${abandonedId}`);
    const abandonedKey = abandoned.body.data.media.objectKey as string;
    process.env.AI_INTAKE_MEDIA_RETENTION_DAYS = "0";
    try {
      const removed = await intake.cleanupExpiredMedia({
        tenantId: shopId,
        userId: ownerUserId,
        role: "OWNER",
      });
      assert.equal(removed > 0, true);
      assert.equal(await storage.exists(abandonedKey), false);
      const open = await authed(ownerToken, ownerShop).get(`/api/v1/ai/intake/${openId}`);
      assert.equal(open.body.data.status, "DRAFT_READY");
      assert.equal(await storage.exists(open.body.data.media.objectKey as string), true);
    } finally {
      delete process.env.AI_INTAKE_MEDIA_RETENTION_DAYS;
    }
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

  async function createIntake(token: string, shop: string): Promise<string> {
    const response = await authed(token, shop).post("/api/v1/ai/intake").send({});
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.id as string;
  }

  async function prepare(
    token: string,
    shop: string,
    fileName: string,
    contentType = "image/jpeg",
  ): Promise<string> {
    const intakeId = await createIntake(token, shop);
    const size = 64;
    const uploaded = await authed(token, shop)
      .post(`/api/v1/ai/intake/${intakeId}/upload-url`)
      .send({ fileName, contentType, size });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
    const objectKey = uploaded.body.data.objectKey as string;
    assert.match(objectKey, new RegExp(`^tenants/.+/ai-intake/${intakeId}/`));
    await storage.put(objectKey, { contentType, bytes: imageSignatureSample(contentType, size) });
    return intakeId;
  }

  async function analyzed(token: string, shop: string, intakeId: string): Promise<Response> {
    const queued = await authed(token, shop).post(`/api/v1/ai/intake/${intakeId}/process`);
    assert.equal(queued.status, 200, JSON.stringify(queued.body));
    assert.equal(queued.body.data.status, "QUEUED");
    return waitStatus(token, shop, intakeId, "DRAFT_READY");
  }

  async function waitStatus(token: string, shop: string, intakeId: string, status: string): Promise<Response> {
    const deadline = Date.now() + 8_000;
    let latest: Response | undefined;
    while (Date.now() < deadline) {
      latest = await authed(token, shop).get(`/api/v1/ai/intake/${intakeId}`);
      assert.equal(latest.status, 200, JSON.stringify(latest.body));
      const current = latest.body.data.status as string;
      if (current === status) {
        return latest;
      }
      if ((current === "FAILED" && status !== "FAILED") || (current === "DRAFT_READY" && status === "FAILED")) {
        assert.fail(JSON.stringify(latest.body));
      }
      await delay(25);
    }
    assert.fail(`intake status stayed ${String(latest?.body?.data?.status)}`);
  }

  async function createProduct(
    name: string,
    extra: { barcode?: string; sku?: string; defaultSellingPrice?: string } = {},
  ): Promise<string> {
    const response = await authed(ownerToken, ownerShop)
      .post("/api/v1/catalog/products")
      .send({ name, unitId, ...extra });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.data.id as string;
  }

  async function counts(): Promise<{ products: string; purchases: string; movements: string; balances: string }> {
    const rows = await admin.query<{ products: string; purchases: string; movements: string; balances: string }>(
      `SELECT
         (SELECT count(*)::text FROM products WHERE tenant_id = $1::uuid) AS products,
         (SELECT count(*)::text FROM purchases WHERE tenant_id = $1::uuid) AS purchases,
         (SELECT count(*)::text FROM inventory_movements WHERE tenant_id = $1::uuid) AS movements,
         (SELECT count(*)::text FROM inventory_balances WHERE tenant_id = $1::uuid) AS balances`,
      [shopId],
    );
    const row = rows.rows[0];
    assert.ok(row);
    return row;
  }

  async function productCount(): Promise<string> {
    return (await counts()).products;
  }

  async function auditCount(action: string): Promise<number> {
    const rows = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs WHERE tenant_id = $1::uuid AND action = $2`,
      [shopId, action],
    );
    return Number(rows.rows[0]?.count ?? "0");
  }

  async function assertStock(productId: string, quantity: string, averageCost: string): Promise<void> {
    const rows = await admin.query<{ quantity: string; average_cost: string }>(
      `SELECT quantity::text AS quantity, average_cost::text AS average_cost
       FROM inventory_balances WHERE product_id = $1::uuid`,
      [productId],
    );
    assert.equal(rows.rows[0]?.quantity, quantity);
    assert.equal(rows.rows[0]?.average_cost, averageCost);
  }

  async function nextPurchaseNumber(): Promise<string> {
    const rows = await admin.query<{ prefix: string; next_number: number; pad_width: number }>(
      `SELECT prefix, next_number, pad_width
       FROM document_counters
       WHERE tenant_id = $1::uuid AND document_type = 'PURCHASE'`,
      [shopId],
    );
    const row = rows.rows[0];
    assert.ok(row);
    return `${row.prefix}${String(row.next_number).padStart(row.pad_width, "0")}`;
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function nextNational(): string {
  serial += 1;
  const national = String(serial);
  phones.push(normalizeIndianPhone(national));
  return national;
}

async function cleanup(admin: Client, numbers: string[]): Promise<void> {
  const tenants = `(SELECT id FROM tenants WHERE name LIKE '[AI]%')`;
  await admin.query("ALTER TABLE inventory_movements DISABLE TRIGGER inventory_movements_append_only");
  await admin.query("ALTER TABLE stock_adjustment_items DISABLE TRIGGER stock_adjustment_items_draft_only");
  await admin.query("ALTER TABLE stock_adjustments DISABLE TRIGGER stock_adjustments_no_delete");
  await admin.query("ALTER TABLE supplier_ledger DISABLE TRIGGER supplier_ledger_append_only");
  await admin.query("ALTER TABLE purchase_items DISABLE TRIGGER purchase_items_draft_only");
  await admin.query("ALTER TABLE purchases DISABLE TRIGGER purchases_no_delete");
  await admin.query("ALTER TABLE product_price_history DISABLE TRIGGER product_price_history_append_only");
  await admin.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only");
  try {
    await admin.query(`DELETE FROM ai_intake_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM ai_intake_sessions WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM inventory_movements WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM inventory_balances WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM stock_adjustment_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM stock_adjustments WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM supplier_ledger WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM purchase_items WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM purchases WHERE tenant_id IN ${tenants}`);
    await admin.query(`DELETE FROM idempotency_keys WHERE tenant_id IN ${tenants}`);
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
    await admin.query("ALTER TABLE supplier_ledger ENABLE TRIGGER supplier_ledger_append_only");
    await admin.query("ALTER TABLE purchase_items ENABLE TRIGGER purchase_items_draft_only");
    await admin.query("ALTER TABLE purchases ENABLE TRIGGER purchases_no_delete");
    await admin.query("ALTER TABLE product_price_history ENABLE TRIGGER product_price_history_append_only");
    await admin.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only");
  }
  await admin.query(`DELETE FROM product_barcodes WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM products WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM categories WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM brands WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM units WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM suppliers WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM expense_categories WHERE tenant_id IN ${tenants}`);
  await admin.query(
    `DELETE FROM memberships
     WHERE tenant_id IN ${tenants}
        OR user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`UPDATE tenants SET default_location_id = NULL WHERE name LIKE '[AI]%'`);
  await admin.query(`DELETE FROM locations WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM document_counters WHERE tenant_id IN ${tenants}`);
  await admin.query(`DELETE FROM tenants WHERE name LIKE '[AI]%'`);
  await admin.query(
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`DELETE FROM otp_challenges WHERE phone = ANY($1::text[])`, [numbers]);
  await admin.query(`DELETE FROM users WHERE phone = ANY($1::text[])`, [numbers]);
}
