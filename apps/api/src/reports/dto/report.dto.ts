import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from "class-validator";
import { COMPARISON_PERIODS, ComparisonPeriod, REPORT_PERIODS, ReportPeriod } from "../report-range";

const MOVEMENT_TYPES = [
  "OPENING_STOCK",
  "PURCHASE",
  "SALE",
  "SALE_RETURN",
  "SALE_VOID",
  "PURCHASE_RETURN",
  "DAMAGE",
  "EXPIRY",
  "ADJUSTMENT",
  "TRANSFER_IN",
  "TRANSFER_OUT",
] as const;

const PRODUCT_SORTS = ["quantity", "revenue", "grossProfit"] as const;

export class ReportRangeQuery {
  @ApiPropertyOptional({ enum: REPORT_PERIODS, default: "today" })
  @IsOptional()
  @IsIn(REPORT_PERIODS)
  period?: ReportPeriod;

  @ApiPropertyOptional({ example: "2026-09-01" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ example: "2026-09-24" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;
}

export class ComparisonQuery {
  @ApiPropertyOptional({ enum: COMPARISON_PERIODS, default: "today" })
  @IsOptional()
  @IsIn(COMPARISON_PERIODS)
  period?: ComparisonPeriod;
}

export class PageQuery extends ReportRangeQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ProductReportQuery extends PageQuery {
  @ApiPropertyOptional({ enum: PRODUCT_SORTS, default: "quantity" })
  @IsOptional()
  @IsIn(PRODUCT_SORTS)
  sort?: (typeof PRODUCT_SORTS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

export class TopProductQuery extends ReportRangeQuery {
  @ApiPropertyOptional({ enum: PRODUCT_SORTS, default: "quantity" })
  @IsOptional()
  @IsIn(PRODUCT_SORTS)
  sort?: (typeof PRODUCT_SORTS)[number];

  @ApiPropertyOptional({ default: 10, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

export class StockListQuery extends PageQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class InactiveStockQuery extends StockListQuery {
  @ApiPropertyOptional({ default: 30, description: "Products with stock and no completed sale in this many shop days." })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  daysWithoutSale?: number;
}

export class MovementReportQuery extends PageQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ enum: MOVEMENT_TYPES })
  @IsOptional()
  @IsIn(MOVEMENT_TYPES)
  movementType?: (typeof MOVEMENT_TYPES)[number];
}

export class StockSummaryQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class CloseDayDto {
  @ApiPropertyOptional({ example: "2026-09-24", description: "Shop business date. Defaults to today in the shop timezone." })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  businessDate?: string;
}

export class ClosingListQuery {
  @ApiPropertyOptional({ example: "2026-09-01" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ example: "2026-09-24" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
