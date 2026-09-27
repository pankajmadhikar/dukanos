import assert from "node:assert/strict";
import { describe, it } from "@jest/globals";
import { readCurrentTenant } from "../src/common/decorators/current-tenant.decorator";
import { readCurrentUser } from "../src/common/decorators/current-user.decorator";
import { ErrorCode } from "../src/common/errors/error-codes";
import { AppException } from "../src/common/errors/app.exception";
import { resolveRequestId } from "../src/common/utils/request-id";
import { RequestContextService } from "../src/context/request-context.service";
import { RequestStore } from "../src/context/request-store";

const userId = "00000000-0000-4000-8000-0000000000aa";
const tenantA = "00000000-0000-4000-8000-0000000000a1";
const tenantB = "00000000-0000-4000-8000-0000000000b1";

function store(overrides: Partial<RequestStore> = {}): RequestStore {
  return {
    requestId: "request-01",
    userId: null,
    tenantId: null,
    sessionId: null,
    deviceId: null,
    role: null,
    ...overrides,
  };
}

describe("request context", () => {
  it("keeps concurrent stores apart and clears them afterwards", async () => {
    const context = new RequestContextService();
    const seen: string[] = [];
    await Promise.all([
      context.run(store({ requestId: "request-a", tenantId: tenantA }), async () => {
        await delay(15);
        seen.push(context.current()?.requestId ?? "");
      }),
      context.run(store({ requestId: "request-b", tenantId: tenantB }), async () => {
        await delay(5);
        seen.push(context.current()?.requestId ?? "");
      }),
    ]);
    assert.deepEqual(seen.sort(), ["request-a", "request-b"]);
    assert.equal(context.current(), undefined);
  });

  it("restores the outer store after a nested run", async () => {
    const context = new RequestContextService();
    await context.run(store({ tenantId: tenantA, requestId: "outer-req" }), async () => {
      await context.run(store({ tenantId: tenantB, requestId: "inner-req" }), async () => {
        assert.equal(context.current()?.tenantId, tenantB);
      });
      assert.equal(context.current()?.tenantId, tenantA);
    });
    assert.equal(context.current(), undefined);
  });

  it("accepts a safe request id and replaces an unsafe one", () => {
    assert.equal(resolveRequestId("request-a1"), "request-a1");
    assert.notEqual(resolveRequestId("bad"), "bad");
    assert.match(resolveRequestId(undefined), /^[0-9a-f-]{36}$/i);
    assert.notEqual(resolveRequestId("../etc/passwd"), "../etc/passwd");
  });

  it("reads the user and shop from the store only", () => {
    const principal = readCurrentUser(store({ userId, sessionId: "session-1" }));
    assert.deepEqual(principal, { id: userId, sessionId: "session-1" });
    assert.equal(readCurrentTenant(store({ tenantId: tenantA })).tenantId, tenantA);

    assert.throws(
      () => readCurrentUser(store()),
      (error: unknown) =>
        error instanceof AppException && error.code === ErrorCode.AUTH_REQUIRED,
    );
    assert.throws(
      () => readCurrentTenant(store()),
      (error: unknown) =>
        error instanceof AppException && error.code === ErrorCode.TENANT_REQUIRED,
    );
    assert.throws(
      () => readCurrentTenant(store({ userId })),
      (error: unknown) =>
        error instanceof AppException && error.code === ErrorCode.TENANT_NOT_SELECTED,
    );
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
