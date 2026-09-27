import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateIf,
} from "class-validator";
import { IsMoneyConstraint, IsStockConstraint } from "../decimal";

export class CreateUnitDto {
  @ApiProperty({ example: "Piece" })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiProperty({ example: "pcs" })
  @IsString()
  @MinLength(1)
  @MaxLength(8)
  shortCode!: string;

  @ApiProperty({ example: 0, minimum: 0, maximum: 3 })
  @IsInt()
  @Min(0)
  @Max(3)
  decimalPlaces!: number;
}

export class UpdateUnitDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(8)
  shortCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3)
  decimalPlaces?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateCategoryDto {
  @ApiProperty({ example: "Biscuits" })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  parentId?: string;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID()
  parentId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateBrandDto {
  @ApiProperty({ example: "Parle" })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}

export class UpdateBrandDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateProductDto {
  @ApiProperty({ example: "Parle-G 250g" })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameHi?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameMr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sku?: string;

  @ApiProperty()
  @IsUUID()
  unitId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  brandId?: string;

  @ApiPropertyOptional({ example: "8.00" })
  @IsOptional()
  @Validate(IsMoneyConstraint)
  defaultPurchasePrice?: string | number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @Validate(IsMoneyConstraint)
  defaultSellingPrice?: string | number;

  @ApiPropertyOptional()
  @IsOptional()
  @Validate(IsStockConstraint)
  minimumStockLevel?: string | number;

  @ApiPropertyOptional({ example: "8901234567890" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string;
}

export class UpdateProductDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  @MaxLength(200)
  nameEn?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  @MaxLength(200)
  nameHi?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  @MaxLength(200)
  nameMr?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  @MaxLength(64)
  sku?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsUUID()
  brandId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Validate(IsMoneyConstraint)
  defaultPurchasePrice?: string | number;

  @ApiPropertyOptional()
  @IsOptional()
  @Validate(IsMoneyConstraint)
  defaultSellingPrice?: string | number;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @Validate(IsStockConstraint)
  minimumStockLevel?: string | number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateBarcodeDto {
  @ApiProperty({ example: "8901234567890" })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  barcode!: string;

  @ApiPropertyOptional({ example: "EAN13" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  barcodeType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class UpdateBarcodeDto {
  @ApiProperty()
  @IsBoolean()
  isPrimary!: boolean;
}

export class ListProductsQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  brandId?: string;

  @ApiPropertyOptional({ enum: ["true", "false", "all"] })
  @IsOptional()
  @IsString()
  isActive?: string;

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

export class CustomerPriceDto {
  @ApiProperty()
  @IsUUID()
  customerId!: string;

  @ApiProperty({ example: "90.00" })
  @Validate(IsMoneyConstraint)
  sellingPrice!: string;
}

export class ListMasterQuery {
  @ApiPropertyOptional({ enum: ["true", "false", "all"] })
  @IsOptional()
  @IsString()
  isActive?: string;
}
