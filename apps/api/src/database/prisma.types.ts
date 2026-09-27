import { Prisma, PrismaClient } from "@prisma/client";

/**
 * Prisma transaction client after app.tenant_id and app.user_id are set.
 * Shop reads and writes take this client. They do not take the root PrismaClient.
 */
export type ShopDb = Prisma.TransactionClient;

export interface TenantScope {
  tenantId: string;
  userId: string;
}

export interface UnscopedSession {
  tenantId: string | null;
  userId: string | null;
  visibleProducts: number;
}

export type ApplicationPrisma = PrismaClient;
