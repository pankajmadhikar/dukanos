import { createHash } from "node:crypto";
import { HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { ShopDb } from "../database/prisma.types";
import { SETTLEMENT_METHODS, SettlementMethod } from "./settlement.dto";

export interface SettlementPaymentView {
  id: string;
  amount: string;
  method: string;
  paymentDate: string;
  businessDate: string;
  reference: string | null;
  note: string | null;
  createdAt: string;
  createdBy: { id: string; name: string };
}

export function assertSettlementAmount(amount: Prisma.Decimal): void {
  if (amount.lte(0)) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      "Amount must be greater than zero.",
      HttpStatus.BAD_REQUEST,
    );
  }
}

export function assertSettlementMethod(method: string): asserts method is SettlementMethod {
  if (!SETTLEMENT_METHODS.includes(method as SettlementMethod)) {
    throw new AppException(
      ErrorCode.UNSUPPORTED_PAYMENT_METHOD,
      "A settlement records only cash or UPI.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export function assertCivilDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      "Payment date must be YYYY-MM-DD.",
      HttpStatus.BAD_REQUEST,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      "Payment date is not a real calendar date.",
      HttpStatus.BAD_REQUEST,
    );
  }
}

export function blankToNull(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function asDecimal(value: unknown): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) {
    return value;
  }
  return new Prisma.Decimal(String(value));
}

export function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function businessDateText(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function ledgerDateText(value: Date | string): string {
  if (typeof value === "string") {
    return value.slice(0, 10);
  }
  return businessDateText(value);
}

export function normalizeKey(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const key = value.trim();
  if (key.length > 128 || /\s/.test(key)) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      "Idempotency-Key must be 1 to 128 characters without spaces.",
      HttpStatus.BAD_REQUEST,
    );
  }
  return key;
}

export function digest(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export async function shopInstant(tx: ShopDb, tenantId: string, businessDate: string | undefined): Promise<Date> {
  if (!businessDate) {
    return new Date();
  }
  const rows = await tx.$queryRaw<Array<{ ts: Date }>>`
    SELECT ((${businessDate}::text || ' 12:00:00')::timestamp AT TIME ZONE timezone) AS ts
    FROM tenants
    WHERE id = ${tenantId}::uuid
  `;
  const instant = rows[0]?.ts;
  if (!instant) {
    throw new AppException(ErrorCode.NOT_FOUND, "Shop was not found.", HttpStatus.NOT_FOUND);
  }
  return instant;
}

/** Returns the stored payment id when this key already succeeded. Null means the key was just claimed. */
export async function claimIdempotency(
  tx: ShopDb,
  tenantId: string,
  key: string,
  requestHash: string,
): Promise<string | null> {
  const existing = await tx.idempotencyKey.findUnique({
    where: { tenantId_key: { tenantId, key } },
  });
  if (!existing) {
    await tx.idempotencyKey.create({ data: { tenantId, key, requestHash } });
    return null;
  }
  if (existing.requestHash !== requestHash) {
    throw new AppException(
      ErrorCode.IDEMPOTENCY_CONFLICT,
      "This idempotency key was already used for a different request.",
      HttpStatus.CONFLICT,
    );
  }
  const stored = existing.responseBody as { id?: string } | null;
  if (!stored?.id) {
    throw new AppException(
      ErrorCode.IDEMPOTENCY_CONFLICT,
      "This request was already processed.",
      HttpStatus.CONFLICT,
    );
  }
  return stored.id;
}

export async function rememberIdempotency(tx: ShopDb, tenantId: string, key: string, paymentId: string): Promise<void> {
  await tx.idempotencyKey.update({
    where: { tenantId_key: { tenantId, key } },
    data: { responseStatus: 201, responseBody: { id: paymentId } satisfies Prisma.InputJsonObject },
  });
}

export function exceedsOutstanding(): AppException {
  return new AppException(
    ErrorCode.PAYMENT_EXCEEDS_OUTSTANDING,
    "Payment cannot be more than the outstanding balance.",
    HttpStatus.CONFLICT,
  );
}

export async function addCustomerCollection(
  tx: ShopDb,
  tenantId: string,
  businessDate: Date,
  amount: Prisma.Decimal,
): Promise<void> {
  const day = businessDateText(businessDate);
  await tx.$executeRaw`
    INSERT INTO daily_summaries (
      id, tenant_id, business_date, customer_collections
    ) VALUES (
      uuidv7(),
      ${tenantId}::uuid,
      ${day}::date,
      ${amount.toFixed(2)}::numeric
    )
    ON CONFLICT (tenant_id, business_date) DO UPDATE SET
      customer_collections = daily_summaries.customer_collections + EXCLUDED.customer_collections,
      updated_at = CURRENT_TIMESTAMP
    WHERE daily_summaries.closed_at IS NULL
  `;
}

export async function addSupplierPaymentSummary(
  tx: ShopDb,
  tenantId: string,
  businessDate: Date,
  amount: Prisma.Decimal,
): Promise<void> {
  const day = businessDateText(businessDate);
  await tx.$executeRaw`
    INSERT INTO daily_summaries (
      id, tenant_id, business_date, supplier_payments
    ) VALUES (
      uuidv7(),
      ${tenantId}::uuid,
      ${day}::date,
      ${amount.toFixed(2)}::numeric
    )
    ON CONFLICT (tenant_id, business_date) DO UPDATE SET
      supplier_payments = daily_summaries.supplier_payments + EXCLUDED.supplier_payments,
      updated_at = CURRENT_TIMESTAMP
    WHERE daily_summaries.closed_at IS NULL
  `;
}
