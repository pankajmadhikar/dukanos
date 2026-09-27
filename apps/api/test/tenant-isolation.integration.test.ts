import "dotenv/config";
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "@jest/globals";
import { NestFactory } from "@nestjs/core";
import { INestApplication } from "@nestjs/common";
import { Client } from "pg";
import { AppModule } from "../src/app.module";
import { TenantTransactionService } from "../src/database/tenant-transaction.service";

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  throw new Error("DATABASE_ADMIN_URL is required for tenant isolation tests.");
}

describe("tenant transaction isolation", () => {
  let app: INestApplication;
  let transactions: TenantTransactionService;
  let admin: Client;
  let tenantA = "";
  let tenantB = "";
  let productA = "";
  let productB = "";
  const userA = randomUUID();
  const userB = randomUUID();

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await cleanup(admin);

    app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
    transactions = app.get(TenantTransactionService);

    tenantA = randomUUID();
    tenantB = randomUUID();
    const unitA = randomUUID();
    const unitB = randomUUID();
    productA = randomUUID();
    productB = randomUUID();

    await admin.query(
      `INSERT INTO tenants (id, name, business_type, phone)
       VALUES ($1, '[RLS] Shop A', 'GROCERY', $2), ($3, '[RLS] Shop B', 'GROCERY', $4)`,
      [tenantA, phone(), tenantB, phone()],
    );
    await admin.query(
      `INSERT INTO units (id, tenant_id, name, short_code, decimal_places)
       VALUES ($1, $2, 'Piece', 'pc', 0), ($3, $4, 'Piece', 'pc', 0)`,
      [unitA, tenantA, unitB, tenantB],
    );
    await admin.query(
      `INSERT INTO products (id, tenant_id, name, unit_id)
       VALUES ($1, $2, 'A rice', $3), ($4, $5, 'B rice', $6)`,
      [productA, tenantA, unitA, productB, tenantB, unitB],
    );
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin);
      await admin.end();
    }
    if (app) {
      await app.close();
    }
  });

  it("shows only the shop whose transaction context is set", async () => {
    const visibleToA = await transactions.run(
      { tenantId: tenantA, userId: userA },
      async (tx) => {
        const role = await tx.$queryRaw<Array<{ role_name: string }>>`
          SELECT current_user AS role_name
        `;
        assert.equal(role[0]?.role_name, "dukaan_app");
        return tx.product.findMany({ select: { id: true, tenantId: true } });
      },
    );
    assert.deepEqual(
      visibleToA.map((row) => row.id),
      [productA],
    );
    assert.equal(
      visibleToA.every((row) => row.tenantId === tenantA),
      true,
    );

    const afterA = await transactions.readUnscopedSession();
    assert.equal(afterA.tenantId, null);
    assert.equal(afterA.userId, null);
    assert.equal(afterA.visibleProducts, 0);

    const visibleToB = await transactions.run(
      { tenantId: tenantB, userId: userB },
      async (tx) => tx.product.findMany({ select: { id: true, tenantId: true } }),
    );
    assert.deepEqual(
      visibleToB.map((row) => row.id),
      [productB],
    );

    const afterB = await transactions.readUnscopedSession();
    assert.equal(afterB.tenantId, null);
    assert.equal(afterB.userId, null);
    assert.equal(afterB.visibleProducts, 0);
  });

  it("rolls back a shop write when the callback throws", async () => {
    const unitId = randomUUID();
    await assert.rejects(
      () =>
        transactions.run({ tenantId: tenantA, userId: userA }, async (tx) => {
          await tx.unit.create({
            data: {
              id: unitId,
              tenantId: tenantA,
              name: "Rollback unit",
              shortCode: "rb",
              decimalPlaces: 0,
            },
          });
          throw new Error("rollback");
        }),
      /rollback/,
    );
    const left = await admin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM units WHERE id = $1",
      [unitId],
    );
    assert.equal(left.rows[0]?.count, "0");
  });
});

async function cleanup(admin: Client): Promise<void> {
  await admin.query(
    `DELETE FROM products WHERE tenant_id IN (SELECT id FROM tenants WHERE name LIKE '[RLS]%')`,
  );
  await admin.query(
    `DELETE FROM units WHERE tenant_id IN (SELECT id FROM tenants WHERE name LIKE '[RLS]%')`,
  );
  await admin.query(`DELETE FROM tenants WHERE name LIKE '[RLS]%'`);
}

function phone(): string {
  const digits = Math.floor(Math.random() * 1_000_000_0000)
    .toString()
    .padStart(10, "0");
  return `+91${digits}`;
}
