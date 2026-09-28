import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
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
  ValidateNested,
} from "class-validator";
import { IsMoneyConstraint, IsStockConstraint } from "../../catalog/decimal";

/** Methods a new sale may record. The database enum also keeps older values for history. */
export const SALE_PAYMENT_METHODS = ["CASH", "UPI"] as const;
export type SalePaymentMethod = (typeof SALE_PAYMENT_METHODS)[number];

export class SaleItemDto {
  @ApiProperty()
  @IsUUID()
  productId!: string;

  @ApiProperty({ example: "2" })
  @Validate(IsStockConstraint)
  quantity!: string;

  @ApiPropertyOptional({
    description: "Checked against the server price. The server price is stored when this is omitted.",
  })
  @IsOptional()
  @Validate(IsMoneyConstraint)
  unitPrice?: string;
}

export class SalePaymentDto {
  @ApiProperty({
    enum: SALE_PAYMENT_METHODS,
    description:
      "Cash or UPI. The shopkeeper confirms the money was received. DukaanOS does not verify the payment.",
  })
  @IsIn(SALE_PAYMENT_METHODS)
  method!: SalePaymentMethod;

  @ApiProperty({ example: "300.00" })
  @Validate(IsMoneyConstraint)
  amount!: string;

  @ApiPropertyOptional({
    description: "Optional note such as a UPI reference the shopkeeper typed. Not a verified payment id.",
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  reference?: string;
}

export class CreateSaleDto {
  @ApiPropertyOptional({ description: "Omit for a fully paid walk-in sale." })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ example: "2026-09-24", description: "Shop business date. Defaults to now in the shop timezone." })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  saleDate?: string;

  @ApiPropertyOptional({ description: "Defaults to the shop's default location." })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({
    enum: ["OFFLINE_SYNC"],
    description:
      "Set only when posting a sale the shop saved while offline. The selling price on each line must be a price this shop has already used. Online sales omit this field.",
  })
  @IsOptional()
  @IsIn(["OFFLINE_SYNC"])
  source?: "OFFLINE_SYNC";

  @ApiProperty({ type: [SaleItemDto] })
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items!: SaleItemDto[];

  @ApiPropertyOptional({ type: [SalePaymentDto] })
  @IsOptional()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => SalePaymentDto)
  payments?: SalePaymentDto[];
}

export class QuoteSaleDto {
  @ApiPropertyOptional({ description: "Omit for a walk-in price check. Prices are not stored." })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiProperty({ type: [SaleItemDto] })
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items!: SaleItemDto[];
}

export class ListSalesQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ example: "2026-09-01" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ example: "2026-09-24" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional({ description: "Sale number, for example S-00001." })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  saleNumber?: string;

  @ApiPropertyOptional({
    enum: SALE_PAYMENT_METHODS,
    description: "Find sales that recorded cash or UPI.",
  })
  @IsOptional()
  @IsIn(SALE_PAYMENT_METHODS)
  paymentMethod?: SalePaymentMethod;

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
