import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
} from "class-validator";
import { IsMoneyConstraint } from "../../catalog/decimal";
import { SETTLEMENT_METHODS, SettlementMethod } from "../../payments/settlement.dto";
import { REPORT_PERIODS, ReportPeriod } from "../../reports/report-range";

export class CreateExpenseCategoryDto {
  @ApiProperty({ example: "Packaging" })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
}

export class UpdateExpenseCategoryDto {
  @ApiProperty({ example: "Shop rent" })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
}

export class ListExpenseCategoriesQuery {
  @ApiPropertyOptional({ enum: ["true", "false", "all"], default: "true" })
  @IsOptional()
  @IsIn(["true", "false", "all"])
  isActive?: "true" | "false" | "all";
}

export class CreateExpenseDto {
  @ApiProperty()
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ example: "1500.00" })
  @Validate(IsMoneyConstraint)
  amount!: string;

  @ApiPropertyOptional({
    example: "2026-09-24",
    description: "Shop business date. Defaults to now in the shop timezone.",
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expenseDate?: string;

  @ApiProperty({
    enum: SETTLEMENT_METHODS,
    description: "Cash or UPI the shopkeeper confirmed. DukaanOS does not verify UPI.",
  })
  @IsIn(SETTLEMENT_METHODS)
  paymentMethod!: SettlementMethod;

  @ApiPropertyOptional({ example: "Shop electricity" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    description: "Optional note such as a UPI reference the shopkeeper typed. Not a verified payment id.",
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  reference?: string;
}

export class ListExpensesQuery {
  @ApiPropertyOptional({ example: "2026-09-01" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ example: "2026-09-24" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ enum: SETTLEMENT_METHODS })
  @IsOptional()
  @IsIn(SETTLEMENT_METHODS)
  paymentMethod?: SettlementMethod;

  @ApiPropertyOptional({ description: "Matches the note or the payment reference." })
  @IsOptional()
  @IsString()
  @MaxLength(128)
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

export class ExpenseSummaryQuery {
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
