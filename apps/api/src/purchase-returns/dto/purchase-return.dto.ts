import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateNested,
} from "class-validator";
import { IsStockConstraint } from "../../catalog/decimal";

export class PurchaseReturnItemDto {
  @ApiProperty({ description: "Line on the original purchase." })
  @IsUUID()
  purchaseItemId!: string;

  @ApiProperty({ example: "3" })
  @Validate(IsStockConstraint)
  quantity!: string;
}

export class CreatePurchaseReturnDto {
  @ApiProperty()
  @IsUUID()
  purchaseId!: string;

  @ApiPropertyOptional({ description: "Defaults to the location on the original purchase." })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiProperty({ type: [PurchaseReturnItemDto] })
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PurchaseReturnItemDto)
  items!: PurchaseReturnItemDto[];
}

export class ListPurchaseReturnsQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  purchaseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ description: "Return number, for example PR-00001." })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  returnNumber?: string;

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
