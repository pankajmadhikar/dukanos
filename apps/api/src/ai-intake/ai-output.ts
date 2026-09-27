import { AI_CLIENT_FAILURE, AiAnalysisError, AiDetectedItem, AiEvidence } from "./ai-product-intake.provider";

const MAX_ITEMS = 50;
const MAX_PAYLOAD = 100_000;

/**
 * Rejects provider output before any draft row is written.
 * A single invalid item fails the whole analysis.
 */
export function validateProviderPayload(payload: unknown): AiDetectedItem[] {
  const encoded = JSON.stringify(payload);
  if (encoded.length > MAX_PAYLOAD) {
    throw invalid();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalid();
  }
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length > MAX_ITEMS) {
    throw invalid();
  }
  return items.map((item) => validateItem(item));
}

function validateItem(value: unknown): AiDetectedItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid();
  }
  const row = value as Record<string, unknown>;
  const confidence = row.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw invalid();
  }
  return {
    name: optionalText(row.name, 200),
    nameEn: optionalText(row.nameEn, 200),
    nameHi: optionalText(row.nameHi, 200),
    nameMr: optionalText(row.nameMr, 200),
    brand: optionalText(row.brandName ?? row.brand, 120),
    category: optionalText(row.categoryName ?? row.category, 120),
    barcode: optionalBarcode(row.barcode),
    sku: optionalText(row.sku, 64),
    unit: optionalText(row.unitName ?? row.unit, 80),
    quantity: optionalQuantity(row.quantity),
    purchasePrice: optionalPrice(row.purchasePrice),
    sellingPrice: optionalPrice(row.sellingPrice),
    confidence,
    evidence: optionalEvidence(row.evidence),
  };
}

function optionalText(value: unknown, max: number): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw invalid();
  }
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length === 0) {
    return null;
  }
  if (text.length > max) {
    throw invalid();
  }
  return text;
}

function optionalBarcode(value: unknown): string | null {
  const text = optionalText(value, 64);
  if (!text) {
    return null;
  }
  const compact = text.replace(/\s+/g, "");
  if (!/^[0-9A-Za-z]{4,64}$/.test(compact)) {
    throw invalid();
  }
  return compact;
}

function optionalQuantity(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number) || number <= 0) {
    throw invalid();
  }
  return String(number);
}

function optionalPrice(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number) || number < 0) {
    throw invalid();
  }
  return number.toFixed(2);
}

function optionalEvidence(value: unknown): AiEvidence | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw invalid();
  }
  const row = value as Record<string, unknown>;
  return {
    barcodeVisible: flag(row.barcodeVisible),
    labelVisible: flag(row.labelVisible),
    priceVisible: flag(row.priceVisible),
    quantityVisible: flag(row.quantityVisible),
  };
}

function flag(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw invalid();
  }
  return value;
}

function invalid(): AiAnalysisError {
  return new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_INVALID_RESPONSE", retryable: false });
}
