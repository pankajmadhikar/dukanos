import { HttpStatus, Injectable } from "@nestjs/common";
import { Request } from "express";
import { AppConfigService } from "../common/config/app-config.service";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { readShopGrant } from "./shop-grant";
import { SessionService } from "./session.service";

export interface ResolvedAccess {
  userId: string;
  sessionId: string;
  tenantId: string | null;
  role: string | null;
  /** Set when a shop grant was present but membership no longer allows it. */
  shopError: AppException | null;
}

@Injectable()
export class AuthContextService {
  constructor(
    private readonly sessions: SessionService,
    private readonly transactions: TenantTransactionService,
    private readonly config: AppConfigService,
  ) {}

  async resolve(request: Request): Promise<ResolvedAccess> {
    const token = bearerToken(request.header("authorization"));
    if (!token) {
      throw new AppException(
        ErrorCode.AUTH_REQUIRED,
        "Authentication is required.",
        HttpStatus.UNAUTHORIZED,
      );
    }
    const session = await this.sessions.authenticate(token);
    const grant = this.shopGrant(request);
    if (!grant) {
      return {
        userId: session.userId,
        sessionId: session.sessionId,
        tenantId: null,
        role: null,
        shopError: null,
      };
    }
    if (grant.sessionId !== session.sessionId || grant.userId !== session.userId) {
      return {
        userId: session.userId,
        sessionId: session.sessionId,
        tenantId: null,
        role: null,
        shopError: denied(),
      };
    }
    try {
      const access = await this.transactions.runForMember(
        session.userId,
        grant.tenantId,
        async (_tx, role) => role,
      );
      return {
        userId: session.userId,
        sessionId: session.sessionId,
        tenantId: grant.tenantId,
        role: access,
        shopError: null,
      };
    } catch (error) {
      if (
        error instanceof AppException &&
        (error.code === ErrorCode.TENANT_ACCESS_DENIED ||
          error.code === ErrorCode.MEMBERSHIP_INACTIVE)
      ) {
        return {
          userId: session.userId,
          sessionId: session.sessionId,
          tenantId: null,
          role: null,
          shopError: error,
        };
      }
      throw error;
    }
  }

  private shopGrant(request: Request) {
    const header = request.header("x-dukaan-shop");
    const cookie = readCookie(request.header("cookie"), "dukaan_shop");
    const token = header || cookie;
    if (!token) {
      return null;
    }
    return readShopGrant(token, this.config.sessionSecret);
  }
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const [scheme, value] = header.split(" ");
  if (scheme !== "Bearer" || !value) {
    return null;
  }
  return value;
}

function denied(): AppException {
  return new AppException(
    ErrorCode.TENANT_ACCESS_DENIED,
    "You do not have access to this shop.",
    HttpStatus.FORBIDDEN,
  );
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      return rest.join("=");
    }
  }
  return undefined;
}
