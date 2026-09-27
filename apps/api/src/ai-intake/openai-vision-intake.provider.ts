import {
  AI_CLIENT_FAILURE,
  AiAnalysisError,
  AiProductAnalysis,
  AiProductIntakeInput,
  AiProductIntakeProvider,
  AiUsage,
} from "./ai-product-intake.provider";
import { validateProviderPayload } from "./ai-output";
import { intakeSettings } from "./intake-settings";

const PROMPT = [
  "You read retail product photos for a shop inventory draft.",
  "Return JSON only, with an items array.",
  "Each item may include name, nameEn, nameHi, nameMr, barcode, sku, quantity, unitName,",
  "purchasePrice, sellingPrice, brandName, categoryName, confidence, and evidence.",
  "confidence is a number from 0 to 1.",
  "evidence may include barcodeVisible, labelVisible, priceVisible, and quantityVisible.",
  "Use null when a value is not visible.",
  "Never guess barcode, SKU, quantity, purchase price, or selling price.",
  "Never estimate a missing number.",
  "Read only labels, barcodes, and prices that are visible.",
  "Include every distinct product that is visible.",
  "If nothing readable is visible, return items as an empty array.",
].join(" ");

export interface OpenAiVisionOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/**
 * OpenAI-compatible vision provider. It returns validated suggestions only.
 * It does not write products, stock, or purchases.
 */
export class OpenAiVisionIntakeProvider implements AiProductIntakeProvider {
  readonly name = "openai";
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiVisionOptions) {
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async analyze(input: AiProductIntakeInput): Promise<AiProductAnalysis> {
    if (!input.downloadUrl) {
      throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_BAD_REQUEST", retryable: false });
    }
    const settings = intakeSettings();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(settings.providerTimeoutMs),
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: PROMPT },
            {
              role: "user",
              content: [
                { type: "text", text: "Read the products in this image. Missing values must be null." },
                { type: "image_url", image_url: { url: input.downloadUrl } },
              ],
            },
          ],
        }),
      });
    } catch (error) {
      throw networkFailure(error);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_AUTH_ERROR", retryable: false });
    }
    if (response.status === 429) {
      throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_RATE_LIMITED", retryable: true });
    }
    if (response.status === 400) {
      throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_BAD_REQUEST", retryable: false });
    }
    if (response.status >= 500) {
      throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_UNAVAILABLE", retryable: true });
    }
    if (!response.ok) {
      throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_UNKNOWN", retryable: true });
    }
    const text = await response.text();
    if (text.length > 100_000) {
      throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_INVALID_RESPONSE", retryable: false });
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_INVALID_RESPONSE", retryable: false });
    }
    const content = readContent(body);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_INVALID_RESPONSE", retryable: false });
    }
    return { items: validateProviderPayload(parsed), usage: readUsage(body) };
  }
}

function readContent(body: unknown): string {
  if (!body || typeof body !== "object") {
    throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_INVALID_RESPONSE", retryable: false });
  }
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") {
    throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_INVALID_RESPONSE", retryable: false });
  }
  const content = (choices[0] as { message?: { content?: unknown } }).message?.content;
  if (typeof content !== "string" || content.length === 0 || content.length > 100_000) {
    throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_INVALID_RESPONSE", retryable: false });
  }
  return content;
}

function readUsage(body: unknown): AiUsage | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const row = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const inputTokens = typeof row.prompt_tokens === "number" ? row.prompt_tokens : undefined;
  const outputTokens = typeof row.completion_tokens === "number" ? row.completion_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens };
}

function networkFailure(error: unknown): AiAnalysisError {
  if (error instanceof AiAnalysisError) {
    return error;
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_TIMEOUT", retryable: true });
  }
  return new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_UNAVAILABLE", retryable: true });
}
