import assert from "node:assert/strict";
import { describe, it } from "@jest/globals";
import { AiIntakeRateLimiter } from "../src/ai-intake/ai-intake-rate-limiter";
import { AI_CLIENT_FAILURE, AiAnalysisError } from "../src/ai-intake/ai-product-intake.provider";
import { validateProviderPayload } from "../src/ai-intake/ai-output";
import { assertTenantObjectKey, imageSignatureSample, matchesImageSignature } from "../src/ai-intake/intake-media";
import { MockAiProductIntakeProvider } from "../src/ai-intake/mock-ai-product-intake.provider";
import { OpenAiVisionIntakeProvider } from "../src/ai-intake/openai-vision-intake.provider";

const visible = {
  name: "Parle-G Biscuits",
  nameEn: "Parle-G Biscuits",
  nameHi: null,
  nameMr: null,
  barcode: "8901234567890",
  sku: null,
  quantity: 12,
  unitName: "packet",
  purchasePrice: null,
  sellingPrice: 12,
  brandName: "Parle",
  categoryName: "Biscuits",
  confidence: 0.94,
  evidence: { labelVisible: true, priceVisible: false, barcodeVisible: true, quantityVisible: true },
};

describe("ai intake provider contract", () => {
  it("accepts a structured vision payload and keeps missing prices null", () => {
    const items = validateProviderPayload({ items: [visible] });
    assert.equal(items[0]?.name, "Parle-G Biscuits");
    assert.equal(items[0]?.purchasePrice, null);
    assert.equal(items[0]?.sellingPrice, "12.00");
    assert.equal(items[0]?.quantity, "12");
    assert.equal(items[0]?.evidence?.barcodeVisible, true);
  });

  it("rejects an invented or invalid provider payload", () => {
    assert.throws(() => validateProviderPayload({ items: [{ ...visible, confidence: 2 }] }), AiAnalysisError);
    assert.throws(() => validateProviderPayload({ items: [{ ...visible, quantity: -1 }] }), AiAnalysisError);
    assert.throws(() => validateProviderPayload({ items: [{ ...visible, purchasePrice: -5 }] }), AiAnalysisError);
    assert.throws(() => validateProviderPayload({ items: [{ ...visible, barcode: "12" }] }), AiAnalysisError);
    assert.throws(() => validateProviderPayload({ note: "not items" }), AiAnalysisError);
  });

  it("reads the same validated shape from the mock and the production provider", async () => {
    const mock = new MockAiProductIntakeProvider();
    const mockItems = validateProviderPayload({
      items: (await mock.analyze({ mediaType: "image/jpeg", objectKey: "tenants/a/ai-intake/b/file.jpg", fileName: "shop.jpg" })).items,
    });
    const provider = new OpenAiVisionIntakeProvider({
      apiKey: "test-ai-key-value",
      model: "gpt-4o-mini",
      baseUrl: "https://example.test/v1",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ items: [visible] }) } }],
            usage: { prompt_tokens: 10, completion_tokens: 4 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const real = await provider.analyze({
      mediaType: "image/jpeg",
      objectKey: "tenants/a/ai-intake/b/file.jpg",
      downloadUrl: "https://example.test/private",
    });
    assert.equal(real.items[0]?.name, mockItems[0]?.name);
    assert.equal(real.items[0]?.purchasePrice, null);
    assert.equal(real.usage?.inputTokens, 10);
    assert.equal(provider.name, "openai");
    assert.equal(mock.name, "mock");
  });

  it("classifies provider failures without returning the response body", async () => {
    const secret = "sk-live-secret-value";
    const provider = new OpenAiVisionIntakeProvider({
      apiKey: secret,
      model: "gpt-4o-mini",
      baseUrl: "https://example.test/v1",
      fetchImpl: async () => new Response(JSON.stringify({ error: secret }), { status: 500 }),
    });
    await assert.rejects(
      () => provider.analyze({ mediaType: "image/jpeg", objectKey: "k", downloadUrl: "https://example.test/private" }),
      (error: unknown) => {
        assert.ok(error instanceof AiAnalysisError);
        assert.equal(error.code, "AI_PROVIDER_UNAVAILABLE");
        assert.equal(error.retryable, true);
        assert.equal(error.message, AI_CLIENT_FAILURE);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  });

  it("rejects a forged object key and checks image signatures", () => {
    assert.doesNotThrow(() => assertTenantObjectKey("shop-a", "intake-a", "tenants/shop-a/ai-intake/intake-a/file.jpg"));
    assert.throws(() => assertTenantObjectKey("shop-a", "intake-a", "tenants/shop-b/ai-intake/intake-a/file.jpg"));
    assert.throws(() => assertTenantObjectKey("shop-a", "intake-a", "tenants/shop-a/ai-intake/intake-a/../file.jpg"));
    assert.equal(matchesImageSignature(imageSignatureSample("image/jpeg", 16), "image/jpeg"), true);
    assert.equal(matchesImageSignature(imageSignatureSample("image/png", 16), "image/jpeg"), false);
    assert.equal(matchesImageSignature(imageSignatureSample("image/webp", 16), "image/webp"), true);
  });

  it("stops a caller after the per-minute cap", () => {
    const limiter = new AiIntakeRateLimiter();
    limiter.assertAllowed({ tenantId: "shop", userId: "user", ip: "127.0.0.1" }, 1);
    assert.throws(
      () => limiter.assertAllowed({ tenantId: "shop", userId: "other", ip: "10.0.0.8" }, 1),
      /Too many intake requests/,
    );
  });
});
