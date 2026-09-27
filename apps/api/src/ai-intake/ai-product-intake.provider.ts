/**
 * Vision providers only analyze media. They do not receive a database client
 * and they do not create products, stock, purchases, or payments.
 *
 * Field-level confidence is not stored. `ai_intake_items.confidence` is one
 * score for the whole suggestion.
 */
export interface AiDetectedItem {
  name: string;
  brand?: string;
  category?: string;
  barcode?: string;
  sku?: string;
  unit?: string;
  quantity?: string;
  purchasePrice?: string;
  sellingPrice?: string;
  confidence: number;
}

export interface AiProductAnalysis {
  items: AiDetectedItem[];
}

export interface AiProductIntakeInput {
  mediaType: string;
  objectKey: string;
}

export interface AiProductIntakeProvider {
  analyze(input: AiProductIntakeInput): Promise<AiProductAnalysis>;
}

export const AI_PRODUCT_INTAKE_PROVIDER = Symbol("AI_PRODUCT_INTAKE_PROVIDER");

/** A safe analysis failure. The message is shown to the shop. It must not include secrets. */
export class AiAnalysisError extends Error {
  constructor(message = "The image could not be read.") {
    super(message);
    this.name = "AiAnalysisError";
  }
}
