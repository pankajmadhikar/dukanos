import { HttpStatus, Injectable } from "@nestjs/common";
import { PriceType, Prisma } from "@prisma/client";
import { AuditRecorder } from "../audit/audit-recorder";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { mapDatabaseError } from "../common/errors/map-database-error";
import { ShopDb } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { assertUuid, canSeeCost } from "./catalog-access";
import { parseMoney, parseStock, sameMoney } from "./decimal";
import { presentPriceHistory, presentProduct, ProductRow } from "./product.presenter";
import { ProductPricingService } from "./product-pricing.service";
import { escapeLike, normalizeBarcode, normalizeName, normalizeSearch, normalizeSku } from "./text";

const productSelect = {
  id: true,
  name: true,
  nameEn: true,
  nameHi: true,
  nameMr: true,
  sku: true,
  isActive: true,
  defaultPurchasePrice: true,
  defaultSellingPrice: true,
  averageCost: true,
  minimumStockLevel: true,
  unit: { select: { id: true, name: true, shortCode: true } },
  category: { select: { id: true, name: true } },
  brand: { select: { id: true, name: true } },
  barcodes: {
    select: { id: true, barcode: true, barcodeType: true, isPrimary: true },
    orderBy: [{ isPrimary: "desc" as const }, { createdAt: "asc" as const }],
  },
} satisfies Prisma.ProductSelect;

export interface CatalogActor {
  tenantId: string;
  userId: string;
  role: string;
}

export interface ProductWrite {
  name?: string;
  nameEn?: string | null;
  nameHi?: string | null;
  nameMr?: string | null;
  sku?: string | null;
  unitId?: string;
  categoryId?: string | null;
  brandId?: string | null;
  defaultPurchasePrice?: string | number | null;
  defaultSellingPrice?: string | number | null;
  minimumStockLevel?: string | number | null;
  barcode?: string;
  isActive?: boolean;
}

@Injectable()
export class ProductService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly pricing: ProductPricingService,
    private readonly audit: AuditRecorder,
  ) {}

  async create(actor: CatalogActor, input: ProductWrite) {
    return this.transactions.run(actor, (tx) => this.createWithin(tx, actor, input));
  }

  /** Creates a product inside the caller's shop transaction, including barcode and audit. */
  async createWithin(tx: ShopDb, actor: CatalogActor, input: ProductWrite) {
    const name = requiredName(input.name);
    if (!input.unitId) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, "Choose a unit.", HttpStatus.BAD_REQUEST);
    }
    assertUuid(input.unitId, "Unit id");
    const sku = optionalSku(input.sku);
    const purchase = optionalMoney(input.defaultPurchasePrice);
    const selling = optionalMoney(input.defaultSellingPrice);
    const minimum = optionalStock(input.minimumStockLevel);
    const barcode = input.barcode ? normalizeBarcode(input.barcode) : undefined;
    if (input.categoryId) {
      assertUuid(input.categoryId, "Category id");
    }
    if (input.brandId) {
      assertUuid(input.brandId, "Brand id");
    }
    await this.requireUnit(tx, actor.tenantId, input.unitId as string);
    if (input.categoryId) {
      await this.requireCategory(tx, actor.tenantId, input.categoryId);
    }
    if (input.brandId) {
      await this.requireBrand(tx, actor.tenantId, input.brandId);
    }
    const product = await this.insertProduct(tx, {
      tenantId: actor.tenantId,
      name,
      nameEn: optionalLabel(input.nameEn),
      nameHi: optionalLabel(input.nameHi),
      nameMr: optionalLabel(input.nameMr),
      sku,
      unitId: input.unitId as string,
      categoryId: input.categoryId ?? null,
      brandId: input.brandId ?? null,
      defaultPurchasePrice: purchase ?? null,
      defaultSellingPrice: selling ?? null,
      minimumStockLevel: minimum ?? null,
    });
    const changes = priceChanges(null, null, purchase ?? null, selling ?? null);
    await this.pricing.recordManual(
      tx,
      { tenantId: actor.tenantId, userId: actor.userId, productId: product.id },
      changes,
    );
    if (barcode) {
      await this.insertBarcode(tx, actor, product.id, barcode, null, true);
    }
    await this.audit.write(tx, {
      action: "product.created",
      entityType: "product",
      entityId: product.id,
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
    });
    return presentProduct(await this.load(tx, actor.tenantId, product.id), actor.role, true);
  }

  async update(actor: CatalogActor, id: string, input: ProductWrite) {
    assertUuid(id, "Product id");
    if (input.unitId) {
      assertUuid(input.unitId, "Unit id");
    }
    if (input.categoryId) {
      assertUuid(input.categoryId, "Category id");
    }
    if (input.brandId) {
      assertUuid(input.brandId, "Brand id");
    }
    if (!Object.values(input).some((value) => value !== undefined)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Choose a field to update.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const purchase = input.defaultPurchasePrice === undefined ? undefined : optionalMoney(input.defaultPurchasePrice);
    const selling = input.defaultSellingPrice === undefined ? undefined : optionalMoney(input.defaultSellingPrice);
    const minimum = input.minimumStockLevel === undefined ? undefined : optionalStock(input.minimumStockLevel);

    return this.transactions.run(actor, async (tx) => {
      const current = await tx.product.findFirst({
        where: { id, tenantId: actor.tenantId },
        select: {
          id: true,
          isActive: true,
          defaultPurchasePrice: true,
          defaultSellingPrice: true,
        },
      });
      if (!current) {
        throw notFound();
      }
      if (input.unitId) {
        await this.requireUnit(tx, actor.tenantId, input.unitId);
      }
      if (input.categoryId) {
        await this.requireCategory(tx, actor.tenantId, input.categoryId);
      }
      if (input.brandId) {
        await this.requireBrand(tx, actor.tenantId, input.brandId);
      }
      const nextPurchase = purchase === undefined ? current.defaultPurchasePrice : purchase;
      const nextSelling = selling === undefined ? current.defaultSellingPrice : selling;
      try {
        await tx.product.update({
          where: { id },
          data: {
            name: input.name === undefined ? undefined : requiredName(input.name),
            nameEn: input.nameEn === undefined ? undefined : optionalLabel(input.nameEn),
            nameHi: input.nameHi === undefined ? undefined : optionalLabel(input.nameHi),
            nameMr: input.nameMr === undefined ? undefined : optionalLabel(input.nameMr),
            sku: input.sku === undefined ? undefined : optionalSku(input.sku),
            unitId: input.unitId,
            categoryId: input.categoryId,
            brandId: input.brandId,
            defaultPurchasePrice: purchase,
            defaultSellingPrice: selling,
            minimumStockLevel: minimum,
            isActive: input.isActive,
          },
        });
      } catch (error) {
        throw skuConflict(error);
      }
      await this.pricing.recordManual(
        tx,
        { tenantId: actor.tenantId, userId: actor.userId, productId: id },
        priceChanges(current.defaultPurchasePrice, current.defaultSellingPrice, nextPurchase, nextSelling),
      );
      if (input.isActive === false && current.isActive) {
        await this.audit.write(tx, lifecycle(actor, id, "product.deactivated"));
      } else if (input.isActive === true && !current.isActive) {
        await this.audit.write(tx, lifecycle(actor, id, "product.reactivated"));
      } else {
        await this.audit.write(tx, lifecycle(actor, id, "product.updated"));
      }
      return presentProduct(await this.load(tx, actor.tenantId, id), actor.role, true);
    });
  }

  async setCustomerPrice(
    actor: CatalogActor,
    productId: string,
    customerId: string,
    sellingPrice: Prisma.Decimal,
  ): Promise<void> {
    assertUuid(productId, "Product id");
    assertUuid(customerId, "Customer id");
    await this.transactions.run(actor, async (tx) => {
      const product = await tx.product.findFirst({
        where: { id: productId, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!product) {
        throw notFound();
      }
      const customer = await tx.customer.findFirst({
        where: { id: customerId, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!customer) {
        throw new AppException(ErrorCode.CUSTOMER_NOT_FOUND, "Customer was not found.", HttpStatus.NOT_FOUND);
      }
      await this.pricing.setCustomerPrice(
        tx,
        { tenantId: actor.tenantId, customerId, productId },
        sellingPrice,
      );
    });
  }

  async get(actor: CatalogActor, id: string) {
    assertUuid(id, "Product id");
    return this.transactions.run(actor, async (tx) => {
      const row = await this.findRow(tx, actor.tenantId, id);
      if (!row) {
        throw notFound();
      }
      return presentProduct(row, actor.role, true);
    });
  }

  async list(
    actor: CatalogActor,
    query: {
      search?: string;
      categoryId?: string;
      brandId?: string;
      isActive?: boolean | null;
      page: number;
      limit: number;
    },
  ) {
    if (query.categoryId) {
      assertUuid(query.categoryId, "Category id");
    }
    if (query.brandId) {
      assertUuid(query.brandId, "Brand id");
    }
    const search = query.search ? normalizeSearch(query.search) : "";
    return this.transactions.run(actor, async (tx) => {
      const match = search.length > 0 ? await this.exactMatch(tx, actor, search, query) : null;
      const page = match
        ? { ids: query.page === 1 && match ? [match] : [], total: match ? 1 : 0 }
        : await this.searchIds(tx, actor.tenantId, search, query);
      const rows = await this.loadMany(tx, actor.tenantId, page.ids);
      return {
        data: rows.map((row) => presentProduct(row, actor.role, false)),
        pagination: { page: query.page, limit: query.limit, total: page.total },
      };
    });
  }

  async lookupBarcode(actor: CatalogActor, barcode: string) {
    const code = normalizeBarcode(barcode);
    if (code.length === 0 || code.length > 64) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Barcode is invalid.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.transactions.run(actor, async (tx) => {
      const row = await tx.productBarcode.findFirst({
        where: { tenantId: actor.tenantId, barcode: code },
        select: { product: { select: productSelect } },
      });
      if (!row) {
        throw notFound();
      }
      if (!row.product.isActive) {
        throw new AppException(
          ErrorCode.PRODUCT_INACTIVE,
          "This product is inactive.",
          HttpStatus.CONFLICT,
        );
      }
      return presentProduct(row.product, actor.role, false);
    });
  }

  async setActive(actor: CatalogActor, id: string, isActive: boolean) {
    return this.update(actor, id, { isActive });
  }

  async listBarcodes(actor: CatalogActor, productId: string) {
    assertUuid(productId, "Product id");
    return this.transactions.run(actor, async (tx) => {
      await this.requireProduct(tx, actor.tenantId, productId);
      return tx.productBarcode.findMany({
        where: { tenantId: actor.tenantId, productId },
        select: { id: true, barcode: true, barcodeType: true, isPrimary: true },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      });
    });
  }

  async addBarcode(
    actor: CatalogActor,
    productId: string,
    input: { barcode: string; barcodeType?: string; isPrimary?: boolean },
  ) {
    assertUuid(productId, "Product id");
    const barcode = normalizeBarcode(input.barcode);
    if (barcode.length === 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Enter a barcode.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.transactions.run(actor, async (tx) => {
      await this.requireProduct(tx, actor.tenantId, productId);
      const existingCount = await tx.productBarcode.count({
        where: { tenantId: actor.tenantId, productId },
      });
      const primary = input.isPrimary === true || existingCount === 0;
      const created = await this.insertBarcode(
        tx,
        actor,
        productId,
        barcode,
        input.barcodeType?.trim() || null,
        primary,
      );
      return created;
    });
  }

  async updateBarcode(actor: CatalogActor, productId: string, barcodeId: string, isPrimary: boolean) {
    assertUuid(productId, "Product id");
    assertUuid(barcodeId, "Barcode id");
    return this.transactions.run(actor, async (tx) => {
      const barcode = await tx.productBarcode.findFirst({
        where: { id: barcodeId, productId, tenantId: actor.tenantId },
      });
      if (!barcode) {
        throw new AppException(
          ErrorCode.NOT_FOUND,
          "Barcode was not found.",
          HttpStatus.NOT_FOUND,
        );
      }
      if (isPrimary) {
        await tx.productBarcode.updateMany({
          where: { tenantId: actor.tenantId, productId, isPrimary: true, NOT: { id: barcodeId } },
          data: { isPrimary: false },
        });
      }
      const updated = await tx.productBarcode.update({
        where: { id: barcodeId },
        data: { isPrimary },
        select: { id: true, barcode: true, barcodeType: true, isPrimary: true },
      });
      await this.audit.write(tx, {
        action: "barcode.changed",
        entityType: "barcode",
        entityId: barcodeId,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
      });
      return updated;
    });
  }

  async removeBarcode(actor: CatalogActor, productId: string, barcodeId: string) {
    assertUuid(productId, "Product id");
    assertUuid(barcodeId, "Barcode id");
    await this.transactions.run(actor, async (tx) => {
      const barcode = await tx.productBarcode.findFirst({
        where: { id: barcodeId, productId, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!barcode) {
        throw new AppException(
          ErrorCode.NOT_FOUND,
          "Barcode was not found.",
          HttpStatus.NOT_FOUND,
        );
      }
      await tx.productBarcode.delete({ where: { id: barcodeId } });
      await this.audit.write(tx, {
        action: "barcode.changed",
        entityType: "barcode",
        entityId: barcodeId,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
      });
    });
  }

  async priceHistory(actor: CatalogActor, productId: string) {
    assertUuid(productId, "Product id");
    return this.transactions.run(actor, async (tx) => {
      await this.requireProduct(tx, actor.tenantId, productId);
      const rows = await tx.productPriceHistory.findMany({
        where: {
          tenantId: actor.tenantId,
          productId,
          ...(canSeeCost(actor.role) ? {} : { priceType: PriceType.SELLING }),
        },
        select: {
          priceType: true,
          oldPrice: true,
          newPrice: true,
          source: true,
          changedBy: true,
          changedAt: true,
        },
        orderBy: { changedAt: "desc" },
        take: 100,
      });
      return rows.map(presentPriceHistory);
    });
  }

  private async exactMatch(
    tx: ShopDb,
    actor: CatalogActor,
    search: string,
    query: { categoryId?: string; brandId?: string; isActive?: boolean | null },
  ): Promise<string | null> {
    const barcode = normalizeBarcode(search);
    const scanned = await tx.productBarcode.findFirst({
      where: {
        tenantId: actor.tenantId,
        barcode,
        product: {
          tenantId: actor.tenantId,
          ...(query.isActive === null || query.isActive === undefined ? {} : { isActive: query.isActive }),
          categoryId: query.categoryId,
          brandId: query.brandId,
        },
      },
      select: { productId: true },
    });
    if (scanned) {
      return scanned.productId;
    }
    const sku = normalizeSku(search);
    if (sku.length === 0) {
      return null;
    }
    const product = await tx.product.findFirst({
      where: {
        tenantId: actor.tenantId,
        sku,
        ...(query.isActive === null || query.isActive === undefined ? {} : { isActive: query.isActive }),
        categoryId: query.categoryId,
        brandId: query.brandId,
      },
      select: { id: true },
    });
    return product?.id ?? null;
  }

  private async searchIds(
    tx: ShopDb,
    tenantId: string,
    search: string,
    query: { categoryId?: string; brandId?: string; isActive?: boolean | null; page: number; limit: number },
  ): Promise<{ ids: string[]; total: number }> {
    const active = query.isActive === undefined ? true : query.isActive;
    const categoryId = query.categoryId ?? null;
    const brandId = query.brandId ?? null;
    const like = search.length > 0 ? `%${escapeLike(search)}%` : null;
    const text = search.length > 0 ? search : null;
    const where = Prisma.sql`
      p.tenant_id = ${tenantId}::uuid
      AND (${active}::boolean IS NULL OR p.is_active = ${active})
      AND (${categoryId}::uuid IS NULL OR p.category_id = ${categoryId}::uuid)
      AND (${brandId}::uuid IS NULL OR p.brand_id = ${brandId}::uuid)
      AND (
        ${text}::text IS NULL
        OR p.name ILIKE ${like} ESCAPE '\\'
        OR p.name_en ILIKE ${like} ESCAPE '\\'
        OR p.name_hi ILIKE ${like} ESCAPE '\\'
        OR p.name_mr ILIKE ${like} ESCAPE '\\'
      )
    `;
    const counted = await tx.$queryRaw<Array<{ total: number }>>(Prisma.sql`
      SELECT count(*)::int AS total
      FROM products p
      WHERE ${where}
    `);
    const offset = (query.page - 1) * query.limit;
    const ids = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT p.id
      FROM products p
      WHERE ${where}
      ORDER BY
        CASE
          WHEN ${text}::text IS NOT NULL AND (
            lower(p.name) = lower(${text})
            OR lower(coalesce(p.name_en, '')) = lower(${text})
            OR p.name_hi = ${text}
            OR p.name_mr = ${text}
          ) THEN 0
          ELSE 1
        END,
        p.name
      LIMIT ${query.limit}
      OFFSET ${offset}
    `);
    return { ids: ids.map((row) => row.id), total: counted[0]?.total ?? 0 };
  }

  private async loadMany(tx: ShopDb, tenantId: string, ids: string[]): Promise<ProductRow[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await tx.product.findMany({
      where: { tenantId, id: { in: ids } },
      select: {
        ...productSelect,
        barcodes: {
          select: { id: true, barcode: true, barcodeType: true, isPrimary: true },
          orderBy: [{ isPrimary: "desc" as const }, { createdAt: "asc" as const }],
          take: 1,
        },
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  }

  private async load(tx: ShopDb, tenantId: string, id: string): Promise<ProductRow> {
    const row = await this.findRow(tx, tenantId, id);
    if (!row) {
      throw notFound();
    }
    return row;
  }

  private findRow(tx: ShopDb, tenantId: string, id: string) {
    return tx.product.findFirst({
      where: { id, tenantId },
      select: productSelect,
    });
  }

  private async requireProduct(tx: ShopDb, tenantId: string, id: string) {
    const product = await tx.product.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!product) {
      throw notFound();
    }
  }

  private async requireUnit(tx: ShopDb, tenantId: string, id: string) {
    const unit = await tx.unit.findFirst({
      where: { id, tenantId },
      select: { isActive: true },
    });
    if (!unit) {
      throw new AppException(ErrorCode.UNIT_NOT_FOUND, "Unit was not found.", HttpStatus.NOT_FOUND);
    }
    if (!unit.isActive) {
      throw new AppException(
        ErrorCode.UNIT_INACTIVE,
        "That unit is inactive.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  private async requireCategory(tx: ShopDb, tenantId: string, id: string) {
    const category = await tx.category.findFirst({
      where: { id, tenantId },
      select: { isActive: true },
    });
    if (!category) {
      throw new AppException(
        ErrorCode.CATEGORY_NOT_FOUND,
        "Category was not found.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (!category.isActive) {
      throw new AppException(
        ErrorCode.CATEGORY_INACTIVE,
        "That category is inactive.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  private async requireBrand(tx: ShopDb, tenantId: string, id: string) {
    const brand = await tx.brand.findFirst({
      where: { id, tenantId },
      select: { isActive: true },
    });
    if (!brand) {
      throw new AppException(ErrorCode.BRAND_NOT_FOUND, "Brand was not found.", HttpStatus.NOT_FOUND);
    }
    if (!brand.isActive) {
      throw new AppException(
        ErrorCode.BRAND_INACTIVE,
        "That brand is inactive.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  private async insertProduct(
    tx: ShopDb,
    data: {
      tenantId: string;
      name: string;
      nameEn: string | null;
      nameHi: string | null;
      nameMr: string | null;
      sku: string | null;
      unitId: string;
      categoryId: string | null;
      brandId: string | null;
      defaultPurchasePrice: Prisma.Decimal | null;
      defaultSellingPrice: Prisma.Decimal | null;
      minimumStockLevel: Prisma.Decimal | null;
    },
  ) {
    try {
      return await tx.product.create({
        data,
        select: { id: true },
      });
    } catch (error) {
      throw skuConflict(error);
    }
  }

  private async insertBarcode(
    tx: ShopDb,
    actor: CatalogActor,
    productId: string,
    barcode: string,
    barcodeType: string | null,
    isPrimary: boolean,
  ) {
    if (isPrimary) {
      await tx.productBarcode.updateMany({
        where: { tenantId: actor.tenantId, productId, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    try {
      const created = await tx.productBarcode.create({
        data: {
          tenantId: actor.tenantId,
          productId,
          barcode,
          barcodeType,
          isPrimary,
        },
        select: { id: true, barcode: true, barcodeType: true, isPrimary: true },
      });
      await this.audit.write(tx, {
        action: "barcode.added",
        entityType: "barcode",
        entityId: created.id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
      });
      return created;
    } catch (error) {
      const mapped = mapDatabaseError(error);
      if (mapped?.code === ErrorCode.CONFLICT) {
        throw new AppException(
          ErrorCode.BARCODE_ALREADY_EXISTS,
          "This barcode is already used in the shop.",
          HttpStatus.CONFLICT,
        );
      }
      throw mapped ?? error;
    }
  }
}

function requiredName(value: string | undefined): string {
  const name = normalizeName(value ?? "");
  if (name.length === 0 || name.length > 200) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      "Enter a product name.",
      HttpStatus.BAD_REQUEST,
    );
  }
  return name;
}

function optionalLabel(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const name = normalizeName(value);
  return name.length === 0 ? null : name;
}

function optionalSku(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const sku = normalizeSku(value);
  if (sku.length > 64) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      "SKU is too long.",
      HttpStatus.BAD_REQUEST,
    );
  }
  return sku.length === 0 ? null : sku;
}

function optionalMoney(value: string | number | null | undefined): Prisma.Decimal | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    throw new AppException(
      ErrorCode.INVALID_PRODUCT_PRICE,
      "A catalog price cannot be cleared.",
      HttpStatus.BAD_REQUEST,
    );
  }
  return parseMoney(value);
}

function optionalStock(value: string | number | null | undefined): Prisma.Decimal | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return parseStock(value);
}

function priceChanges(
  oldPurchase: Prisma.Decimal | null,
  oldSelling: Prisma.Decimal | null,
  nextPurchase: Prisma.Decimal | null,
  nextSelling: Prisma.Decimal | null,
) {
  const changes = [];
  if (nextPurchase && !sameMoney(oldPurchase, nextPurchase)) {
    changes.push({ priceType: PriceType.PURCHASE, oldPrice: oldPurchase, newPrice: nextPurchase });
  }
  if (nextSelling && !sameMoney(oldSelling, nextSelling)) {
    changes.push({ priceType: PriceType.SELLING, oldPrice: oldSelling, newPrice: nextSelling });
  }
  return changes;
}

function notFound(): AppException {
  return new AppException(ErrorCode.PRODUCT_NOT_FOUND, "Product was not found.", HttpStatus.NOT_FOUND);
}

function skuConflict(error: unknown): unknown {
  const mapped = mapDatabaseError(error);
  if (mapped?.code === ErrorCode.CONFLICT) {
    return new AppException(
      ErrorCode.SKU_ALREADY_EXISTS,
      "This SKU is already used in the shop.",
      HttpStatus.CONFLICT,
    );
  }
  return mapped ?? error;
}

function lifecycle(
  actor: CatalogActor,
  productId: string,
  action: "product.updated" | "product.deactivated" | "product.reactivated",
) {
  return {
    action,
    entityType: "product",
    entityId: productId,
    tenantId: actor.tenantId,
    actorUserId: actor.userId,
  };
}
