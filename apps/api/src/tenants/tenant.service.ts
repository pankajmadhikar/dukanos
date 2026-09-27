import { randomUUID } from "node:crypto";
import { HttpStatus, Injectable } from "@nestjs/common";
import { BusinessType, DocumentType, MembershipRole } from "@prisma/client";
import { AppConfigService } from "../common/config/app-config.service";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { AuditRecorder } from "../audit/audit-recorder";
import { DEFAULT_EXPENSE_CATEGORIES } from "../expenses/default-categories";
import { issueShopGrant } from "../auth/shop-grant";
import { normalizeIndianPhone } from "../auth/phone";

const COUNTERS: Array<[DocumentType, string]> = [
  [DocumentType.SALE, "S-"],
  [DocumentType.PURCHASE, "P-"],
  [DocumentType.SALE_RETURN, "SR-"],
  [DocumentType.PURCHASE_RETURN, "PR-"],
  [DocumentType.STOCK_ADJUSTMENT, "ADJ-"],
  [DocumentType.STOCK_TRANSFER, "TR-"],
];

export interface ShopSummary {
  id: string;
  name: string;
  role: MembershipRole;
}

export interface ShopSelection extends ShopSummary {
  shopContext: string;
}

export interface NewShopInput {
  name: string;
  businessType: BusinessType;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
}

@Injectable()
export class TenantService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly config: AppConfigService,
    private readonly audit: AuditRecorder,
  ) {}

  async list(userId: string): Promise<ShopSummary[]> {
    return this.transactions.runAsUser(userId, async (tx) => {
      const rows = await tx.membership.findMany({
        where: { userId, isActive: true },
        select: {
          role: true,
          tenant: { select: { id: true, name: true, isActive: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      return rows
        .filter((row) => row.tenant.isActive)
        .map((row) => ({ id: row.tenant.id, name: row.tenant.name, role: row.role }));
    });
  }

  async create(userId: string, sessionId: string, input: NewShopInput): Promise<ShopSelection> {
    const phone = input.phone ? this.phone(input.phone) : await this.ownerPhone(userId);
    const tenantId = randomUUID();
    const locationId = randomUUID();
    const membershipId = randomUUID();
    const name = input.name.trim();
    await this.transactions.run({ tenantId, userId }, async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenantId,
          name,
          businessType: input.businessType,
          phone,
          email: input.email ?? null,
          address: input.address ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          pincode: input.pincode ?? null,
          country: "IN",
          currency: "INR",
          timezone: "Asia/Kolkata",
        },
      });
      await tx.location.create({
        data: {
          id: locationId,
          tenantId,
          name: "Main Shop",
          code: "MAIN",
          isDefault: true,
        },
      });
      await tx.tenant.update({
        where: { id: tenantId },
        data: { defaultLocationId: locationId },
      });
      await tx.membership.create({
        data: {
          id: membershipId,
          tenantId,
          userId,
          role: MembershipRole.OWNER,
        },
      });
      await tx.documentCounter.createMany({
        data: COUNTERS.map(([documentType, prefix]) => ({
          tenantId,
          documentType,
          prefix,
          nextNumber: 1,
          padWidth: 5,
        })),
      });
      await tx.expenseCategory.createMany({
        data: DEFAULT_EXPENSE_CATEGORIES.map((name) => ({
          tenantId,
          name,
          isSystem: true,
          isActive: true,
        })),
        skipDuplicates: true,
      });
      await this.audit.write(tx, {
        action: "tenant.created",
        entityType: "tenant",
        entityId: tenantId,
        tenantId,
        actorUserId: userId,
      });
    });
    return {
      id: tenantId,
      name,
      role: MembershipRole.OWNER,
      shopContext: await this.grant(userId, sessionId, tenantId),
    };
  }

  async select(userId: string, sessionId: string, tenantId: string): Promise<ShopSelection> {
    this.assertUuid(tenantId);
    const shop = await this.transactions.runForMember(userId, tenantId, async (tx, role) => {
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId, isActive: true },
        select: { id: true, name: true },
      });
      if (!tenant) {
        throw new AppException(
          ErrorCode.TENANT_ACCESS_DENIED,
          "You do not have access to this shop.",
          HttpStatus.FORBIDDEN,
        );
      }
      await this.audit.write(tx, {
        action: "tenant.selected",
        entityType: "tenant",
        entityId: tenant.id,
        tenantId: tenant.id,
        actorUserId: userId,
      });
      return { id: tenant.id, name: tenant.name, role };
    });
    return { ...shop, shopContext: await this.grant(userId, sessionId, shop.id) };
  }

  async current(userId: string, tenantId: string): Promise<ShopSummary> {
    return this.transactions.runForMember(userId, tenantId, async (tx, role) => {
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId, isActive: true },
        select: { id: true, name: true },
      });
      if (!tenant) {
        throw new AppException(
          ErrorCode.TENANT_ACCESS_DENIED,
          "You do not have access to this shop.",
          HttpStatus.FORBIDDEN,
        );
      }
      return { id: tenant.id, name: tenant.name, role };
    });
  }

  private async grant(userId: string, sessionId: string, tenantId: string): Promise<string> {
    const session = await this.transactions.runAsUser(userId, (tx) =>
      tx.session.findFirst({
        where: { id: sessionId, userId },
        select: { expiresAt: true },
      }),
    );
    if (!session) {
      throw new AppException(
        ErrorCode.AUTH_INVALID_SESSION,
        "Sign in again.",
        HttpStatus.UNAUTHORIZED,
      );
    }
    return issueShopGrant(
      {
        sessionId,
        userId,
        tenantId,
        expiresAt: Math.floor(session.expiresAt.getTime() / 1000),
      },
      this.config.sessionSecret,
    );
  }

  private async ownerPhone(userId: string): Promise<string> {
    const user = await this.transactions.runPlatform((tx) =>
      tx.user.findUnique({ where: { id: userId }, select: { phone: true } }),
    );
    if (!user) {
      throw new AppException(
        ErrorCode.AUTH_INVALID_SESSION,
        "Sign in again.",
        HttpStatus.UNAUTHORIZED,
      );
    }
    return user.phone;
  }

  private phone(input: string): string {
    try {
      return normalizeIndianPhone(input);
    } catch {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Enter a valid Indian mobile number.",
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private assertUuid(value: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Shop id is invalid.",
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
