import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ShopDb } from "../database/prisma.types";
import { AppLogger } from "../common/logging/app-logger.service";
import { requestContextStorage } from "../context/request-store";

export type ShopAuditAction =
  | "auth.logout"
  | "tenant.created"
  | "tenant.selected"
  | "product.created"
  | "product.updated"
  | "product.deactivated"
  | "product.reactivated"
  | "price.changed"
  | "barcode.added"
  | "barcode.changed"
  | "category.created"
  | "category.updated"
  | "brand.created"
  | "brand.updated"
  | "unit.created"
  | "unit.updated"
  | "inventory.opening_created"
  | "inventory.adjustment_created"
  | "inventory.damage_recorded"
  | "inventory.expiry_recorded"
  | "supplier.created"
  | "supplier.updated"
  | "supplier.deactivated"
  | "purchase.created"
  | "purchase.posted"
  | "customer.created"
  | "customer.updated"
  | "customer.deactivated"
  | "sale.created"
  | "sale.posted"
  | "sale_return.created"
  | "sale_return.posted"
  | "purchase_return.created"
  | "purchase_return.posted"
  | "customer.payment_recorded"
  | "supplier.payment_recorded"
  | "expense.created"
  | "expense.category_created"
  | "expense.category_updated"
  | "expense.category_deactivated"
  | "daily_closing.created"
  | "daily_closing.rebuilt"
  | "ai_intake.created"
  | "ai_intake.processed"
  | "ai_intake.item_updated"
  | "ai_intake.item_rejected"
  | "ai_intake.confirmed";

export interface ShopAuditEvent {
  action: ShopAuditAction;
  entityType: string;
  entityId: string;
  tenantId: string;
  actorUserId: string;
  metadata?: Prisma.InputJsonObject;
}

/**
 * Shop events go to audit_logs inside the caller's transaction.
 * Login has no shop yet. A null tenant_id cannot be inserted by dukaan_app,
 * because the audit policy requires the active shop. Those events are logged
 * without the code, token, or phone.
 */
@Injectable()
export class AuditRecorder {
  constructor(private readonly logger: AppLogger) {}

  async write(tx: ShopDb, event: ShopAuditEvent): Promise<void> {
    const requestId = requestContextStorage.getStore()?.requestId ?? null;
    await tx.auditLog.create({
      data: {
        tenantId: event.tenantId,
        actorUserId: event.actorUserId,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        metadata: event.metadata ?? {},
        requestId,
      },
    });
  }

  platform(action: "auth.login" | "auth.logout", userId: string): void {
    this.logger.write({
      level: "info",
      message: action,
      module: "audit",
      operation: `${action} ${userId}`,
    });
  }
}
