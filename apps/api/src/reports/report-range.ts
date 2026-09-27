import { HttpStatus } from "@nestjs/common";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { ShopDb } from "../database/prisma.types";
import { assertCivilDate, ledgerDateText } from "../payments/settlement-support";

export const REPORT_PERIODS = [
  "today",
  "yesterday",
  "week",
  "previous_week",
  "month",
  "previous_month",
  "year",
  "custom",
] as const;

export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export const COMPARISON_PERIODS = ["today", "week", "month"] as const;

export type ComparisonPeriod = (typeof COMPARISON_PERIODS)[number];

export interface BusinessRange {
  period: ReportPeriod;
  from: string;
  to: string;
}

export async function resolveBusinessRange(
  tx: ShopDb,
  tenantId: string,
  query: { period?: ReportPeriod; from?: string; to?: string },
): Promise<BusinessRange> {
  const period: ReportPeriod = query.period ?? (query.from || query.to ? "custom" : "today");
  if (period === "custom") {
    if (!query.from || !query.to) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "A custom range needs both from and to dates.",
        HttpStatus.BAD_REQUEST,
      );
    }
    assertCivilDate(query.from);
    assertCivilDate(query.to);
    if (query.from > query.to) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "The start date is after the end date.",
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  const from = query.from ?? "2000-01-01";
  const to = query.to ?? "2000-01-01";
  const rows = await tx.$queryRaw<Array<{ start_date: Date | string; end_date: Date | string }>>`
    SELECT start_date, end_date
    FROM (
      SELECT (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date AS today
      FROM tenants
      WHERE id = ${tenantId}::uuid
    ) shop,
    LATERAL (
      SELECT
        CASE ${period}
          WHEN 'today' THEN shop.today
          WHEN 'yesterday' THEN shop.today - 1
          WHEN 'week' THEN (shop.today - (EXTRACT(ISODOW FROM shop.today)::int - 1))
          WHEN 'previous_week' THEN (shop.today - (EXTRACT(ISODOW FROM shop.today)::int - 1) - 7)
          WHEN 'month' THEN date_trunc('month', shop.today::timestamp)::date
          WHEN 'previous_month' THEN (date_trunc('month', shop.today::timestamp) - interval '1 month')::date
          WHEN 'year' THEN date_trunc('year', shop.today::timestamp)::date
          ELSE ${from}::date
        END AS start_date,
        CASE ${period}
          WHEN 'today' THEN shop.today
          WHEN 'yesterday' THEN shop.today - 1
          WHEN 'week' THEN ((shop.today - (EXTRACT(ISODOW FROM shop.today)::int - 1)) + 6)
          WHEN 'previous_week' THEN (shop.today - (EXTRACT(ISODOW FROM shop.today)::int - 1) - 1)
          WHEN 'month' THEN (date_trunc('month', shop.today::timestamp) + interval '1 month' - interval '1 day')::date
          WHEN 'previous_month' THEN (date_trunc('month', shop.today::timestamp) - interval '1 day')::date
          WHEN 'year' THEN (date_trunc('year', shop.today::timestamp) + interval '1 year' - interval '1 day')::date
          ELSE ${to}::date
        END AS end_date
    ) bounds
  `;
  const range = rows[0];
  if (!range) {
    throw new AppException(ErrorCode.NOT_FOUND, "Shop was not found.", HttpStatus.NOT_FOUND);
  }
  return {
    period,
    from: ledgerDateText(range.start_date),
    to: ledgerDateText(range.end_date),
  };
}

export async function resolveComparisonRanges(
  tx: ShopDb,
  tenantId: string,
  comparison: ComparisonPeriod,
): Promise<{ current: BusinessRange; previous: BusinessRange }> {
  const currentPeriod: ReportPeriod = comparison;
  const previousPeriod: ReportPeriod =
    comparison === "today" ? "yesterday" : comparison === "week" ? "previous_week" : "previous_month";
  const [current, previous] = await Promise.all([
    resolveBusinessRange(tx, tenantId, { period: currentPeriod }),
    resolveBusinessRange(tx, tenantId, { period: previousPeriod }),
  ]);
  return { current, previous };
}

export async function shopBusinessDate(tx: ShopDb, tenantId: string): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ today: Date | string }>>`
    SELECT (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date AS today
    FROM tenants
    WHERE id = ${tenantId}::uuid
  `;
  const today = rows[0]?.today;
  if (!today) {
    throw new AppException(ErrorCode.NOT_FOUND, "Shop was not found.", HttpStatus.NOT_FOUND);
  }
  return ledgerDateText(today);
}
