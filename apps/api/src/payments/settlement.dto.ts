import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
} from "class-validator";
import { IsMoneyConstraint } from "../catalog/decimal";

/** Methods a new settlement may record. Older enum values stay valid on historical rows. */
export const SETTLEMENT_METHODS = ["CASH", "UPI"] as const;
export type SettlementMethod = (typeof SETTLEMENT_METHODS)[number];

export class RecordSettlementDto {
  @ApiProperty({ example: "300.00" })
  @Validate(IsMoneyConstraint)
  amount!: string;

  @ApiProperty({
    enum: SETTLEMENT_METHODS,
    description:
      "Cash, or UPI the shopkeeper confirmed by hand. DukaanOS does not verify UPI and does not call a payment provider.",
  })
  @IsIn(SETTLEMENT_METHODS)
  method!: SettlementMethod;

  @ApiPropertyOptional({
    example: "2026-09-24",
    description: "Shop business date. Defaults to now in the shop timezone.",
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  paymentDate?: string;

  @ApiPropertyOptional({
    description: "Optional note such as a UPI reference the shopkeeper typed. Not a verified payment id.",
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note?: string;
}

export class ListSettlementPaymentsQuery {
  @ApiPropertyOptional({ example: "2026-09-01" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ example: "2026-09-24" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional({ enum: SETTLEMENT_METHODS })
  @IsOptional()
  @IsIn(SETTLEMENT_METHODS)
  method?: SettlementMethod;

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

export class ListLedgerQuery {
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
