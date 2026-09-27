import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export class CreateIntakeDto {
  @ApiPropertyOptional({
    example: "IMAGE",
    description: "Video processing is not enabled in this phase.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  sourceType?: string;
}

export class UploadUrlDto {
  @ApiProperty({ example: "shop-products.jpg" })
  @IsString()
  @MinLength(1)
  @MaxLength(180)
  fileName!: string;

  @ApiProperty({ example: "image/jpeg" })
  @IsString()
  @MaxLength(80)
  contentType!: string;

  @ApiProperty({ example: 5242880 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50_000_000)
  size!: number;
}

export class UpdateIntakeItemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  brand?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sku?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  unit?: string;

  @ApiPropertyOptional({ example: "10" })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  quantity?: string;

  @ApiPropertyOptional({ example: "10.00" })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  purchasePrice?: string;

  @ApiPropertyOptional({ example: "12.00" })
  @IsOptional()
  @IsString()
  @MaxLength(24)
  sellingPrice?: string;

  @ApiPropertyOptional({ description: "Shopkeeper accepts a suggested existing product." })
  @IsOptional()
  @IsUUID()
  matchedProductId?: string;
}

export class ConfirmIntakeDto {
  @ApiProperty({ enum: ["CREATE_PRODUCT_ONLY", "CREATE_PRODUCT_AND_STOCK"] })
  @IsIn(["CREATE_PRODUCT_ONLY", "CREATE_PRODUCT_AND_STOCK"])
  mode!: "CREATE_PRODUCT_ONLY" | "CREATE_PRODUCT_AND_STOCK";

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID("all", { each: true })
  itemIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  supplierId?: string;
}
