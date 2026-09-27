import { HttpStatus, Injectable } from "@nestjs/common";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { RequestContextService } from "../context/request-context.service";
import { RequestStore } from "../context/request-store";
import { MembershipRole } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import { ShopDb, TenantScope, UnscopedSession } from "./prisma.types";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shop database work runs here.
 *
 * The GUCs are set with set_config(..., true), which is SET LOCAL.
 * They die when the transaction commits or rolls back, including when the
 * pooled connection is reused. Do not SET them on the session.
 *
 * Callers pass a tenant id that the application already verified. This
 * method does not read a client header or body.
 */
@Injectable()
export class TenantTransactionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: RequestContextService,
  ) {}

  async run<T>(scope: TenantScope, work: (tx: ShopDb) => Promise<T>): Promise<T> {
    const tenantId = this.requireUuid(scope.tenantId, "tenant");
    const userId = this.requireUuid(scope.userId, "user");

    return this.prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}::text, true)`;
        await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}::text, true)`;

        const parent = this.context.current();
        const next: RequestStore = {
          requestId: parent?.requestId ?? null,
          userId,
          tenantId,
          sessionId: parent?.sessionId ?? null,
          deviceId: parent?.deviceId ?? null,
          role: parent?.role ?? null,
        };
        return this.context.run(next, () => work(tx));
      },
      { timeout: 20_000 },
    );
  }

  /**
   * Users and OTP challenges have no tenant policy.
   * Do not read or write shop tables here. RLS would hide or reject them.
   */
  async runPlatform<T>(work: (tx: ShopDb) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction((tx) => work(tx));
  }

  /**
   * Platform work for one user before a shop is selected.
   * Sets app.user_id only. Shop tables stay hidden.
   */
  async runAsUser<T>(userId: string, work: (tx: ShopDb) => Promise<T>): Promise<T> {
    const id = this.requireUuid(userId, "user");
    return this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${id}::text, true)`;
      const parent = this.context.current();
      const next: RequestStore = {
        requestId: parent?.requestId ?? null,
        userId: id,
        tenantId: null,
        sessionId: parent?.sessionId ?? null,
        deviceId: parent?.deviceId ?? null,
        role: null,
      };
      return this.context.run(next, () => work(tx));
    });
  }

  /**
   * Confirms an active membership before setting the shop GUC.
   * The shop id is not applied until the membership row is visible to this user.
   */
  async runForMember<T>(
    userId: string,
    tenantId: string,
    work: (tx: ShopDb, role: MembershipRole) => Promise<T>,
  ): Promise<T> {
    const user = this.requireUuid(userId, "user");
    const tenant = this.requireUuid(tenantId, "tenant");
    return this.prisma.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${user}::text, true)`;
      const membership = await tx.membership.findFirst({
        where: { userId: user, tenantId: tenant },
        select: { role: true, isActive: true },
      });
      if (!membership) {
        throw new AppException(
          ErrorCode.TENANT_ACCESS_DENIED,
          "You do not have access to this shop.",
          HttpStatus.FORBIDDEN,
        );
      }
      if (!membership.isActive) {
        throw new AppException(
          ErrorCode.MEMBERSHIP_INACTIVE,
          "Your access to this shop is inactive.",
          HttpStatus.FORBIDDEN,
        );
      }
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant}::text, true)`;
      const parent = this.context.current();
      const next: RequestStore = {
        requestId: parent?.requestId ?? null,
        userId: user,
        tenantId: tenant,
        sessionId: parent?.sessionId ?? null,
        deviceId: parent?.deviceId ?? null,
        role: membership.role,
      };
      return this.context.run(next, () => work(tx, membership.role));
    });
  }

  /**
   * Reads session GUCs on the application pool without setting them.
   * Proves a previous transaction did not leak SET LOCAL onto the connection.
   * This is not a shop query API.
   */
  async readUnscopedSession(): Promise<UnscopedSession> {
    return this.prisma.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ tenant_id: string | null; user_id: string | null }>
      >`
        SELECT current_setting('app.tenant_id', true) AS tenant_id,
               current_setting('app.user_id', true) AS user_id
      `;
      const visibleProducts = await tx.product.count();
      const row = rows[0];
      return {
        tenantId: emptyToNull(row?.tenant_id),
        userId: emptyToNull(row?.user_id),
        visibleProducts,
      };
    });
  }

  private requireUuid(value: string, kind: "tenant" | "user"): string {
    if (!value) {
      throw new AppException(
        kind === "tenant" ? ErrorCode.TENANT_REQUIRED : ErrorCode.AUTH_REQUIRED,
        kind === "tenant"
          ? "Shop context is required."
          : "Authentication is required.",
        kind === "tenant" ? HttpStatus.BAD_REQUEST : HttpStatus.UNAUTHORIZED,
      );
    }
    if (!UUID.test(value)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        kind === "tenant"
          ? "Shop id is invalid."
          : "User id is invalid.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return value;
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.length === 0) {
    return null;
  }
  return value;
}
