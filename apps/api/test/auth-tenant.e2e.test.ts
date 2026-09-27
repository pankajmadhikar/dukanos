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
import { hashSessionToken } from "../src/auth/session-token";
import { configureApp } from "../src/configure-app";
import { TenantTransactionService } from "../src/database/tenant-transaction.service";

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  throw new Error("DATABASE_ADMIN_URL is required for authentication tests.");
}

process.env.OTP_IP_LIMIT = "500";

let serial = 7100001000;
const phones: string[] = [];

describe("authentication and shop access", () => {
  let app: INestApplication;
  let admin: Client;
  let sender: CapturingOtpSender;
  let transactions: TenantTransactionService;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.init();
    sender = app.get<CapturingOtpSender>(OTP_SENDER);
    transactions = app.get(TenantTransactionService);
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

  it("hashes the OTP, hides it from the response, and signs in one user", async () => {
    const national = nextNational();
    const spaced = `+91 ${national.slice(0, 5)} ${national.slice(5)}`;
    const requested = await request(app.getHttpServer())
      .post("/api/v1/auth/request-otp")
      .send({ phone: `0${national}` });
    assert.equal(requested.status, 200);
    assert.equal(requested.body.data.status, "accepted");
    const code = codeFor(national);
    assert.equal(JSON.stringify(requested.body).includes(code), false);
    assert.equal(requested.body.data.otp, undefined);

    const stored = await admin.query<{ code_hash: string }>(
      `SELECT code_hash FROM otp_challenges WHERE phone = $1 ORDER BY created_at DESC LIMIT 1`,
      [normalizeIndianPhone(national)],
    );
    assert.notEqual(stored.rows[0]?.code_hash, code);
    assert.equal(stored.rows[0]?.code_hash.includes(code), false);

    const wrong = await request(app.getHttpServer())
      .post("/api/v1/auth/verify-otp")
      .send({ phone: national, code: code === "000000" ? "111111" : "000000" });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, "AUTH_INVALID_OTP");

    const created = await verify(national, code);
    assert.equal(created.body.data.user.name, "Owner");
    assert.equal(created.body.data.user.phone, normalizeIndianPhone(national));
    assert.equal(created.body.data.otp, undefined);

    const againRequest = await request(app.getHttpServer())
      .post("/api/v1/auth/request-otp")
      .send({ phone: spaced });
    assert.equal(againRequest.status, 200);
    const again = await verify(national, codeFor(national));
    assert.equal(again.body.data.user.id, created.body.data.user.id);

    const people = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM users WHERE phone = $1`,
      [normalizeIndianPhone(national)],
    );
    assert.equal(people.rows[0]?.count, "1");

    const reused = await request(app.getHttpServer())
      .post("/api/v1/auth/verify-otp")
      .send({ phone: national, code: codeFor(national) });
    assert.equal(reused.status, 401);
    assert.equal(reused.body.error.code, "AUTH_OTP_CONSUMED");
  });

  it("rejects an expired code and too many attempts", async () => {
    const expiredPhone = nextNational();
    await request(app.getHttpServer())
      .post("/api/v1/auth/request-otp")
      .send({ phone: expiredPhone });
    await admin.query(
      `UPDATE otp_challenges SET expires_at = now() - interval '1 minute' WHERE phone = $1`,
      [normalizeIndianPhone(expiredPhone)],
    );
    const expired = await request(app.getHttpServer())
      .post("/api/v1/auth/verify-otp")
      .send({ phone: expiredPhone, code: codeFor(expiredPhone) });
    assert.equal(expired.status, 401);
    assert.equal(expired.body.error.code, "AUTH_OTP_EXPIRED");

    const limited = nextNational();
    await request(app.getHttpServer())
      .post("/api/v1/auth/request-otp")
      .send({ phone: limited });
    const real = codeFor(limited);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const bad = await request(app.getHttpServer())
        .post("/api/v1/auth/verify-otp")
        .send({ phone: limited, code: real === "111111" ? "222222" : "111111" });
      assert.equal(bad.status, 401);
    }
    const blocked = await request(app.getHttpServer())
      .post("/api/v1/auth/verify-otp")
      .send({ phone: limited, code: real });
    assert.equal(blocked.status, 401);
    assert.equal(blocked.body.error.code, "AUTH_OTP_TOO_MANY_ATTEMPTS");
  });

  it("stores only the session hash and rejects expired or revoked tokens", async () => {
    const sessionUser = await login(nextNational());
    const hash = hashSessionToken(sessionUser.token);
    const row = await admin.query<{ token_hash: string }>(
      `SELECT token_hash FROM sessions WHERE user_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
      [sessionUser.userId],
    );
    assert.equal(row.rows[0]?.token_hash, hash);
    assert.notEqual(row.rows[0]?.token_hash, sessionUser.token);

    const hidden = await transactions.runPlatform((tx) => tx.session.findMany());
    assert.equal(hidden.length, 0);

    const me = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${sessionUser.token}`);
    assert.equal(me.status, 200);
    assert.equal(me.body.data.id, sessionUser.userId);
    assert.equal(me.body.data.selectedTenant, null);
    assert.equal(me.body.data.passwordHash, undefined);
    assert.equal(me.body.data.pinHash, undefined);
    assert.equal(JSON.stringify(me.body).includes(sessionUser.token), false);

    await admin.query(
      `UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`,
      [hash],
    );
    const stale = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${sessionUser.token}`);
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error.code, "AUTH_SESSION_EXPIRED");

    const revokedUser = await login(nextNational());
    const logout = await request(app.getHttpServer())
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${revokedUser.token}`);
    assert.equal(logout.status, 200);
    const after = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${revokedUser.token}`);
    assert.equal(after.status, 401);
    assert.equal(after.body.error.code, "AUTH_SESSION_REVOKED");
    const kept = await admin.query<{ revoked: boolean }>(
      `SELECT revoked_at IS NOT NULL AS revoked FROM sessions WHERE token_hash = $1`,
      [hashSessionToken(revokedUser.token)],
    );
    assert.equal(kept.rows[0]?.revoked, true);
  });

  it("creates a shop for the owner and refuses another shop", async () => {
    const owner = await login(nextNational());
    const stranger = await login(nextNational());
    const shopA = await createShop(owner.token, "[AUTH] Shop A");
    const shopB = await createShop(stranger.token, "[AUTH] Shop B");

    const ownerRows = await admin.query<{ role: string; locations: string; counters: string }>(
      `SELECT m.role,
              (SELECT count(*)::text FROM locations l WHERE l.tenant_id = t.id AND l.name = 'Main Shop' AND l.is_default) AS locations,
              (SELECT count(*)::text FROM document_counters c WHERE c.tenant_id = t.id) AS counters
       FROM tenants t
       JOIN memberships m ON m.tenant_id = t.id
       WHERE t.id = $1::uuid`,
      [shopA.id],
    );
    assert.equal(ownerRows.rows[0]?.role, "OWNER");
    assert.equal(ownerRows.rows[0]?.locations, "1");
    assert.equal(ownerRows.rows[0]?.counters, "6");

    const list = await request(app.getHttpServer())
      .get("/api/v1/tenants")
      .set("Authorization", `Bearer ${owner.token}`);
    assert.equal(list.status, 200);
    const listed = list.body.data as Array<{ id: string; role: string }>;
    assert.equal(listed.some((shop) => shop.id === shopA.id && shop.role === "OWNER"), true);
    assert.equal(listed.some((shop) => shop.id === shopB.id), false);

    const denied = await request(app.getHttpServer())
      .post(`/api/v1/tenants/${shopB.id}/select`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({});
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "TENANT_ACCESS_DENIED");

    const extra = await request(app.getHttpServer())
      .post(`/api/v1/tenants/${shopA.id}/select`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ tenantId: shopB.id });
    assert.equal(extra.status, 400);

    const selected = await request(app.getHttpServer())
      .post(`/api/v1/tenants/${shopA.id}/select`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({});
    assert.equal(selected.status, 200);
    assert.equal(selected.body.data.id, shopA.id);
    assert.equal(selected.body.data.role, "OWNER");
    assert.match(selected.headers["set-cookie"]?.[0] ?? "", /dukaan_shop=.*HttpOnly/);

    const current = await request(app.getHttpServer())
      .get("/api/v1/tenants/current")
      .query({ tenantId: shopB.id })
      .set("Authorization", `Bearer ${owner.token}`)
      .set("x-dukaan-shop", selected.body.data.shopContext as string)
      .set("x-tenant-id", shopB.id);
    assert.equal(current.status, 200);
    assert.equal(current.body.data.id, shopA.id);

    const missing = await request(app.getHttpServer())
      .get("/api/v1/tenants/current")
      .set("Authorization", `Bearer ${owner.token}`);
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, "TENANT_NOT_SELECTED");

    const profile = await request(app.getHttpServer())
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${owner.token}`)
      .set("x-dukaan-shop", selected.body.data.shopContext as string);
    assert.equal(profile.body.data.selectedTenant.id, shopA.id);
    assert.equal(profile.body.data.selectedTenant.role, "OWNER");

    const unitA = randomUUID();
    const unitB = randomUUID();
    const productA = randomUUID();
    const productB = randomUUID();
    await admin.query(
      `INSERT INTO units (id, tenant_id, name, short_code, decimal_places)
       VALUES ($1, $2, 'Piece', 'pc', 0), ($3, $4, 'Piece', 'pc', 0)`,
      [unitA, shopA.id, unitB, shopB.id],
    );
    await admin.query(
      `INSERT INTO products (id, tenant_id, name, unit_id)
       VALUES ($1, $2, 'A rice', $3), ($4, $5, 'B rice', $6)`,
      [productA, shopA.id, unitA, productB, shopB.id, unitB],
    );

    const visible = await transactions.run({ tenantId: shopA.id, userId: owner.userId }, (tx) =>
      tx.product.findMany({ select: { id: true, tenantId: true } }),
    );
    assert.deepEqual(
      visible.map((row) => row.id),
      [productA],
    );
    const leaked = await transactions.run({ tenantId: shopA.id, userId: owner.userId }, (tx) =>
      tx.product.findFirst({ where: { id: productB } }),
    );
    assert.equal(leaked, null);
    const unscoped = await transactions.readUnscopedSession();
    assert.equal(unscoped.tenantId, null);
    assert.equal(unscoped.userId, null);
  });

  it("rate limits repeated OTP requests for one phone", async () => {
    const national = nextNational();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(app.getHttpServer())
        .post("/api/v1/auth/request-otp")
        .send({ phone: national });
      assert.equal(response.status, 200);
    }
    const limited = await request(app.getHttpServer())
      .post("/api/v1/auth/request-otp")
      .send({ phone: national });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, "AUTH_RATE_LIMITED");
  });

  it("documents the auth routes and rejects an unknown phone shape", async () => {
    const spec = await request(app.getHttpServer()).get("/api/docs-json");
    const paths = Object.keys(spec.body.paths as Record<string, unknown>);
    for (const path of [
      "/api/v1/auth/request-otp",
      "/api/v1/auth/verify-otp",
      "/api/v1/auth/logout",
      "/api/v1/auth/me",
      "/api/v1/tenants",
      "/api/v1/tenants/{tenantId}/select",
      "/api/v1/tenants/current",
    ]) {
      assert.equal(paths.includes(path), true, path);
    }

    const invalid = await request(app.getHttpServer())
      .post("/api/v1/auth/request-otp")
      .send({ phone: "1234567890" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "VALIDATION_ERROR");
    assert.equal(invalid.body.error.message.includes("does not exist"), false);
  });

  function codeFor(national: string): string {
    const code = sender.latest(normalizeIndianPhone(national));
    assert.ok(code);
    return code;
  }

  async function verify(national: string, code: string) {
    const response = await request(app.getHttpServer())
      .post("/api/v1/auth/verify-otp")
      .send({ phone: national, code });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response;
  }

  async function login(national: string): Promise<{ token: string; userId: string }> {
    await request(app.getHttpServer())
      .post("/api/v1/auth/request-otp")
      .send({ phone: national })
      .expect(200);
    const response = await verify(national, codeFor(national));
    return {
      token: response.body.data.token as string,
      userId: response.body.data.user.id as string,
    };
  }

  async function createShop(token: string, name: string): Promise<{ id: string }> {
    const response = await request(app.getHttpServer())
      .post("/api/v1/tenants")
      .set("Authorization", `Bearer ${token}`)
      .send({ name, businessType: "GROCERY", city: "Pune" });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.role, "OWNER");
    return { id: response.body.data.id as string };
  }
});

function nextNational(): string {
  serial += 1;
  const national = String(serial);
  phones.push(normalizeIndianPhone(national));
  return national;
}

async function cleanup(admin: Client, numbers: string[]): Promise<void> {
  await admin.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only");
  try {
    await admin.query(
      `DELETE FROM audit_logs
       WHERE tenant_id IN (SELECT id FROM tenants WHERE name LIKE '[AUTH]%')
          OR actor_user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
      [numbers],
    );
  } finally {
    await admin.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only");
  }
  await admin.query(
    `DELETE FROM products WHERE tenant_id IN (SELECT id FROM tenants WHERE name LIKE '[AUTH]%')`,
  );
  await admin.query(
    `DELETE FROM units WHERE tenant_id IN (SELECT id FROM tenants WHERE name LIKE '[AUTH]%')`,
  );
  await admin.query(
    `DELETE FROM document_counters WHERE tenant_id IN (SELECT id FROM tenants WHERE name LIKE '[AUTH]%')`,
  );
  await admin.query(
    `DELETE FROM expense_categories WHERE tenant_id IN (SELECT id FROM tenants WHERE name LIKE '[AUTH]%')`,
  );
  await admin.query(
    `UPDATE tenants SET default_location_id = NULL WHERE name LIKE '[AUTH]%'`,
  );
  await admin.query(
    `DELETE FROM locations WHERE tenant_id IN (SELECT id FROM tenants WHERE name LIKE '[AUTH]%')`,
  );
  await admin.query(
    `DELETE FROM memberships
     WHERE tenant_id IN (SELECT id FROM tenants WHERE name LIKE '[AUTH]%')
        OR user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`DELETE FROM tenants WHERE name LIKE '[AUTH]%'`);
  await admin.query(
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1::text[]))`,
    [numbers],
  );
  await admin.query(`DELETE FROM otp_challenges WHERE phone = ANY($1::text[])`, [numbers]);
  await admin.query(`DELETE FROM users WHERE phone = ANY($1::text[])`, [numbers]);
}
