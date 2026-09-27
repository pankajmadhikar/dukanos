import { HttpStatus, Injectable } from "@nestjs/common";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { AuditRecorder } from "../audit/audit-recorder";
import { hashSessionToken, userIdFromSessionToken } from "./session-token";

export interface ActiveSession {
  userId: string;
  sessionId: string;
  expiresAt: Date;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly audit: AuditRecorder,
  ) {}

  async authenticate(rawToken: string): Promise<ActiveSession> {
    const userId = userIdFromSessionToken(rawToken);
    if (!userId) {
      throw invalid();
    }
    const hash = hashSessionToken(rawToken);
    return this.transactions.runAsUser(userId, async (tx) => {
      const session = await tx.session.findUnique({ where: { tokenHash: hash } });
      if (!session || session.userId !== userId) {
        throw invalid();
      }
      if (session.revokedAt) {
        throw new AppException(
          ErrorCode.AUTH_SESSION_REVOKED,
          "This session has ended.",
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (session.expiresAt.getTime() <= Date.now()) {
        throw new AppException(
          ErrorCode.AUTH_SESSION_EXPIRED,
          "This session has expired.",
          HttpStatus.UNAUTHORIZED,
        );
      }
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { isActive: true },
      });
      if (!user?.isActive) {
        throw invalid();
      }
      return { userId, sessionId: session.id, expiresAt: session.expiresAt };
    });
  }

  async revoke(userId: string, sessionId: string, tenantId: string | null): Promise<void> {
    await this.transactions.runAsUser(userId, async (tx) => {
      await tx.session.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    if (tenantId) {
      try {
        await this.transactions.runForMember(userId, tenantId, async (tx) => {
          await this.audit.write(tx, {
            action: "auth.logout",
            entityType: "session",
            entityId: sessionId,
            tenantId,
            actorUserId: userId,
          });
        });
      } catch {
        // The session row is already revoked. A missing membership must not undo that.
      }
    }
    this.audit.platform("auth.logout", userId);
  }

  async profile(userId: string): Promise<{
    id: string;
    name: string;
    phone: string;
    email: string | null;
  }> {
    return this.transactions.runPlatform(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, phone: true, email: true },
      });
      if (!user) {
        throw invalid();
      }
      return user;
    });
  }
}

function invalid(): AppException {
  return new AppException(
    ErrorCode.AUTH_INVALID_SESSION,
    "Sign in again.",
    HttpStatus.UNAUTHORIZED,
  );
}
