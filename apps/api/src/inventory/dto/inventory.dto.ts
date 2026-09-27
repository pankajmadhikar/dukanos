import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { MovementType } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsEnum,
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
  ValidateIf,
} from "class-validator";
import { IsMoneyConstraint, IsStockConstraint } from "../../catalog/decimal";

export class OpeningStockDto {
  @ApiPropertyOptional({ description: "Defaults to the shop's Main Shop location." })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiProperty()
  @IsUUID()
  productId!: string;

  @ApiProperty({ example: "10.000" })
  @Validate(IsStockConstraint)
  quantity!: string;

  @ApiProperty({ example: "80.00" })
  @Validate(IsMoneyConstraint)
  unitCost!: string;
}

export class StockAdjustmentDto {
  @ApiPropertyOptional({ description: "Defaults to the shop's Main Shop location." })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiProperty()
  @IsUUID()
  productId!: string;

  @ApiProperty({ enum: ["IN", "OUT", "DAMAGE", "EXPIRY"] })
  @IsIn(["IN", "OUT", "DAMAGE", "EXPIRY"])
  type!: "IN" | "OUT" | "DAMAGE" | "EXPIRY";

  @ApiProperty({ example: "5.000" })
  @Validate(IsStockConstraint)
  quantity!: string;

  @ApiPropertyOptional({ example: "80.00", description: "Required when type is IN." })
  @ValidateIf((dto: StockAdjustmentDto) => dto.type === "IN")
  @Validate(IsMoneyConstraint)
  unitCost?: string;

  @ApiPropertyOptional({ example: "Physical count mismatch" })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reason?: string;
}

export class ListInventoryQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ description: "Product name, SKU, or barcode." })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  @ApiPropertyOptional({ enum: ["true", "false"] })
  @IsOptional()
  @IsIn(["true", "false"])
  lowStock?: string;

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

export class InventorySummaryQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class MovementQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ enum: MovementType })
  @IsOptional()
  @IsEnum(MovementType)
  movementType?: MovementType;

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
