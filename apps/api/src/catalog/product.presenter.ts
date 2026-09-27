import { Prisma } from "@prisma/client";
import { canSeeCost } from "./catalog-access";
import { formatMoney, formatStock } from "./decimal";

export interface UnitView {
  id: string;
  name: string;
  shortCode: string;
}

export interface NamedView {
  id: string;
  name: string;
}

export interface BarcodeView {
  id: string;
  barcode: string;
  barcodeType: string | null;
  isPrimary: boolean;
}

export interface ProductRow {
  id: string;
  name: string;
  nameEn: string | null;
  nameHi: string | null;
  nameMr: string | null;
  sku: string | null;
  isActive: boolean;
  defaultPurchasePrice: Prisma.Decimal | null;
  defaultSellingPrice: Prisma.Decimal | null;
  averageCost: Prisma.Decimal | null;
  minimumStockLevel: Prisma.Decimal | null;
  unit: UnitView;
  category: NamedView | null;
  brand: NamedView | null;
  barcodes: BarcodeView[];
}

export function presentProduct(row: ProductRow, role: string | null, detail: boolean) {
  const primary = row.barcodes.find((barcode) => barcode.isPrimary) ?? row.barcodes[0];
  const body: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    sku: row.sku,
    barcode: primary?.barcode ?? null,
    category: row.category,
    brand: row.brand,
    unit: detail ? row.unit : row.unit.name,
    sellingPrice: formatMoney(row.defaultSellingPrice),
    isActive: row.isActive,
  };
  if (detail) {
    body.nameEn = row.nameEn;
    body.nameHi = row.nameHi;
    body.nameMr = row.nameMr;
    body.barcodes = row.barcodes;
    body.minimumStockLevel = formatStock(row.minimumStockLevel);
  }
  if (canSeeCost(role)) {
    body.purchasePrice = formatMoney(row.defaultPurchasePrice);
    body.averageCost = formatMoney(row.averageCost);
  }
  return body;
}

export function presentPriceHistory(
  row: {
    priceType: string;
    oldPrice: Prisma.Decimal | null;
    newPrice: Prisma.Decimal;
    source: string;
    changedBy: string | null;
    changedAt: Date;
  },
) {
  return {
    priceType: row.priceType,
    oldPrice: formatMoney(row.oldPrice),
    newPrice: formatMoney(row.newPrice),
    source: row.source,
    changedBy: row.changedBy,
    changedAt: row.changedAt.toISOString(),
  };
}
