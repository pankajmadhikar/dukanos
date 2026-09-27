import assert from "node:assert/strict";
import { describe, it } from "@jest/globals";
import { PrismaClient } from "@prisma/client";
import { TenantTransactionService } from "../src/database/tenant-transaction.service";
import { PrismaService } from "../src/database/prisma.service";
import { RequestContextService } from "../src/context/request-context.service";
import { AppException } from "../src/common/errors/app.exception";
import { ErrorCode } from "../src/common/errors/error-codes";

const tenantId = "00000000-0000-4000-8000-0000000000c1";
const userId = "00000000-0000-4000-8000-0000000000c2";

describe("tenant transaction wrapper", () => {
  it("sets transaction-local GUCs before the shop callback", async () => {
    const executed: string[] = [];
    const context = new RequestContextService();
    const service = new TenantTransactionService(
      fakePrisma(executed),
      context,
    );
    let seenTenant: string | null = null;
    await service.run({ tenantId, userId }, async () => {
      seenTenant = context.current()?.tenantId ?? null;
      executed.push("work");
    });
    assert.equal(seenTenant, tenantId);
    assert.deepEqual(executed, [
      "SELECT set_config('app.tenant_id', ?::text, true)",
      "SELECT set_config('app.user_id', ?::text, true)",
      "work",
    ]);
    assert.equal(context.current(), undefined);
  });

  it("does not open a transaction for an invalid shop id", async () => {
    let opened = false;
    const service = new TenantTransactionService(
      {
        client: {
          $transaction: async () => {
            opened = true;
          },
        },
      } as unknown as PrismaService,
      new RequestContextService(),
    );
    await assert.rejects(() =>
      service.run({ tenantId: "not-a-uuid", userId }, async () => undefined),
    );
    assert.equal(opened, false);
  });

  it("does not set the shop until membership is confirmed", async () => {
    const executed: string[] = [];
    const tx = {
      $executeRaw: (strings: TemplateStringsArray) => {
        executed.push(strings.join("?"));
        return Promise.resolve(0);
      },
      membership: { findFirst: async () => null },
    };
    const service = new TenantTransactionService(
      {
        client: {
          $transaction: async (work: (inner: typeof tx) => Promise<unknown>) => work(tx),
        },
      } as unknown as PrismaService,
      new RequestContextService(),
    );
    await assert.rejects(
      () => service.runForMember(userId, tenantId, async () => "no"),
      (error: unknown) =>
        error instanceof AppException && error.code === ErrorCode.TENANT_ACCESS_DENIED,
    );
    assert.deepEqual(executed, ["SELECT set_config('app.user_id', ?::text, true)"]);
  });

  it("propagates callback failures so the transaction can roll back", async () => {
    const service = new TenantTransactionService(
      fakePrisma([]),
      new RequestContextService(),
    );
    await assert.rejects(
      () =>
        service.run({ tenantId, userId }, async () => {
          throw new Error("boom");
        }),
      /boom/,
    );
  });
});

function fakePrisma(executed: string[]): PrismaService {
  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      executed.push(strings.join("?"));
      assert.equal(values.length, 1);
      assert.equal(typeof values[0], "string");
      return Promise.resolve(0);
    },
  };
  const client = {
    $transaction: async (work: (inner: typeof tx) => Promise<unknown>) => work(tx),
  };
  return { client: client as unknown as PrismaClient } as PrismaService;
}
