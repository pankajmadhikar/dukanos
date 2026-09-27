import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "@jest/globals";
import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthenticationGuard } from "../src/auth/guards/authentication.guard";
import { Public } from "../src/common/decorators/public.decorator";
import { AppConfigService } from "../src/common/config/app-config.service";
import { AppException } from "../src/common/errors/app.exception";
import { ErrorCode } from "../src/common/errors/error-codes";
import { RequestContextService } from "../src/context/request-context.service";

@Public()
class OpenController {}

class ClosedController {}

describe("authentication guard", () => {
  it("allows a public handler and rejects a closed one without a session", async () => {
    const access = {
      resolve: async () => {
        throw new AppException(
          ErrorCode.AUTH_REQUIRED,
          "Authentication is required.",
          401,
        );
      },
    };
    const guard = new AuthenticationGuard(
      new Reflector(),
      new RequestContextService(),
      config(),
      access as never,
    );
    assert.equal(await guard.canActivate(context(OpenController)), true);
    await assert.rejects(
      () => guard.canActivate(context(ClosedController)),
      (error: unknown) =>
        error instanceof AppException && error.code === ErrorCode.AUTH_REQUIRED,
    );
  });
});

function context(target: new () => object): ExecutionContext {
  return {
    getHandler: () => target,
    getClass: () => target,
    getType: () => "http",
    switchToHttp: () => ({
      getRequest: () => ({
        path: "/api/v1/closed",
        headers: { "x-tenant-id": "client-supplied" },
        body: { tenantId: "client-supplied" },
      }),
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as ExecutionContext;
}

function config(): AppConfigService {
  return {
    nodeEnv: "test",
    port: 3000,
    databaseUrl: "postgresql://dukaan_app:dukaan_app_dev_only@localhost/dukaanos",
    apiPrefix: "api",
    logLevel: "info",
    corsOrigins: ["http://localhost:5173"],
    databaseAppRole: "dukaan_app",
    swaggerEnabled: true,
  } as AppConfigService;
}
