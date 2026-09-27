/**
 * Vision providers only analyze media. They do not receive a database client
 * and they do not create products, stock, purchases, or payments.
 *
 * Field-level confidence is not stored. `ai_intake_items.confidence` is one
 * score for the whole suggestion. Missing values stay null. The provider must
 * not guess barcode, SKU, quantity, or prices.
 */
export interface AiEvidence {
  barcodeVisible?: boolean;
  labelVisible?: boolean;
  priceVisible?: boolean;
  quantityVisible?: boolean;
}

export interface AiDetectedItem {
  name: string | null;
  nameEn?: string | null;
  nameHi?: string | null;
  nameMr?: string | null;
  brand?: string | null;
  category?: string | null;
  barcode?: string | null;
  sku?: string | null;
  unit?: string | null;
  quantity?: string | null;
  purchasePrice?: string | null;
  sellingPrice?: string | null;
  confidence: number;
  evidence?: AiEvidence;
}

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface AiProductAnalysis {
  items: AiDetectedItem[];
  usage?: AiUsage;
}

export interface AiProductIntakeInput {
  mediaType: string;
  objectKey: string;
  mimeType?: string;
  fileName?: string;
  downloadUrl?: string;
}

export interface AiProductIntakeProvider {
  readonly name: string;
  readonly model: string;
  analyze(input: AiProductIntakeInput): Promise<AiProductAnalysis>;
}

export const AI_PRODUCT_INTAKE_PROVIDER = Symbol("AI_PRODUCT_INTAKE_PROVIDER");

export const AI_CLIENT_FAILURE = "We could not process this image. Please try again.";

export type AiProviderFailureCode =
  | "AI_PROVIDER_TIMEOUT"
  | "AI_PROVIDER_RATE_LIMITED"
  | "AI_PROVIDER_UNAVAILABLE"
  | "AI_PROVIDER_INVALID_RESPONSE"
  | "AI_PROVIDER_AUTH_ERROR"
  | "AI_PROVIDER_BAD_REQUEST"
  | "AI_PROVIDER_UNKNOWN";

/** A safe analysis failure. The message shown to the shop must not include secrets. */
export class AiAnalysisError extends Error {
  readonly code: AiProviderFailureCode;
  readonly retryable: boolean;

  constructor(
    message = AI_CLIENT_FAILURE,
    options?: { code?: AiProviderFailureCode; retryable?: boolean },
  ) {
    super(message);
    this.name = "AiAnalysisError";
    this.code = options?.code ?? "AI_PROVIDER_INVALID_RESPONSE";
    this.retryable = options?.retryable ?? false;
  }
}
