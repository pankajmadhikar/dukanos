import { Prisma } from "@prisma/client";
import { escapeLike, normalizeBarcode, normalizeName, normalizeSku } from "../catalog/text";
import { ShopDb } from "../database/prisma.types";

export const MATCH_TYPES = [
  "EXACT_BARCODE_MATCH",
  "EXACT_SKU_MATCH",
  "EXACT_NAME_MATCH",
  "POSSIBLE_MATCH",
  "NEW_PRODUCT",
  "NEEDS_REVIEW",
  "SHOPKEEPER_MATCH",
] as const;

export type MatchType = (typeof MATCH_TYPES)[number];

export interface ProductMatch {
  matchType: MatchType;
  matchedProductId: string | null;
  possibleProductId: string | null;
  needsReview: boolean;
}

/**
 * Exact barcode, then exact SKU, then exact normalized name.
 * A fuzzy name stays a possible match and does not set matchedProductId.
 */
export async function matchCandidate(
  tx: ShopDb,
  tenantId: string,
  candidate: { name: string; barcode: string | null; sku: string | null; confidence: number },
  confidenceThreshold: number,
): Promise<ProductMatch> {
  const barcode = candidate.barcode ? normalizeBarcode(candidate.barcode) : "";
  if (barcode.length > 0) {
    const scanned = await tx.productBarcode.findFirst({
      where: {
        tenantId,
        barcode,
        product: { tenantId, isActive: true },
      },
      select: { productId: true },
    });
    if (scanned) {
      return finish("EXACT_BARCODE_MATCH", scanned.productId, null, candidate.confidence, confidenceThreshold);
    }
  }

  const sku = candidate.sku ? normalizeSku(candidate.sku) : "";
  if (sku.length > 0) {
    const product = await tx.product.findFirst({
      where: { tenantId, sku, isActive: true },
      select: { id: true },
    });
    if (product) {
      return finish("EXACT_SKU_MATCH", product.id, null, candidate.confidence, confidenceThreshold);
    }
  }

  const name = normalizeName(candidate.name);
  if (name.length > 0) {
    const exact = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM products
      WHERE tenant_id = ${tenantId}::uuid
        AND is_active = true
        AND lower(btrim(name)) = lower(${name})
      LIMIT 1
    `;
    if (exact[0]) {
      return finish("EXACT_NAME_MATCH", exact[0].id, null, candidate.confidence, confidenceThreshold);
    }
    const token = name.split(" ")[0] ?? "";
    if (token.length >= 4) {
      const like = `%${escapeLike(token)}%`;
      const possible = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM products
        WHERE tenant_id = ${tenantId}::uuid
          AND is_active = true
          AND name ILIKE ${like} ESCAPE '\\'
        ORDER BY name
        LIMIT 1
      `);
      if (possible[0]) {
        return finish("POSSIBLE_MATCH", null, possible[0].id, candidate.confidence, confidenceThreshold);
      }
    }
  }

  return finish("NEW_PRODUCT", null, null, candidate.confidence, confidenceThreshold);
}

function finish(
  matchType: MatchType,
  matchedProductId: string | null,
  possibleProductId: string | null,
  confidence: number,
  threshold: number,
): ProductMatch {
  const uncertain = confidence < threshold || matchType === "POSSIBLE_MATCH" || matchType === "NEW_PRODUCT";
  return {
    matchType,
    matchedProductId,
    possibleProductId,
    needsReview: uncertain,
  };
}
