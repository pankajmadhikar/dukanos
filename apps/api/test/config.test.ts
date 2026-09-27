import assert from "node:assert/strict";
import { describe, it } from "@jest/globals";
import { loadAppConfig } from "../src/common/config/load-app-config";

const appUrl = "postgresql://dukaan_app:dukaan_app_dev_only@localhost:5432/dukaanos";

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DATABASE_URL: appUrl,
    SESSION_SECRET: "test-session-secret-value",
    OTP_PEPPER: "test-otp-pepper-value",
    ...overrides,
  };
}

describe("loadAppConfig", () => {
  it("rejects a missing database url without echoing secrets", () => {
    const input = env();
    delete input.DATABASE_URL;
    assert.throws(() => loadAppConfig(input), /DATABASE_URL is required/);
  });

  it("rejects the postgres superuser and does not echo the password", () => {
    let thrown: Error | undefined;
    try {
      loadAppConfig(
        env({
          DATABASE_URL: "postgresql://postgres:super-secret@localhost:5432/dukaanos",
        }),
      );
    } catch (error) {
      thrown = error as Error;
    }
    assert.ok(thrown);
    assert.equal(thrown.message.includes("super-secret"), false);
    assert.match(thrown.message, /dukaan_app/);
  });

  it("rejects a wildcard CORS origin", () => {
    assert.throws(
      () => loadAppConfig(env({ NODE_ENV: "production", CORS_ORIGINS: "*" })),
      /wildcard/i,
    );
  });

  it("requires explicit production origins", () => {
    assert.throws(
      () => loadAppConfig(env({ NODE_ENV: "production" })),
      /CORS_ORIGINS is required/,
    );
  });

  it("accepts an explicit production origin and disables swagger", () => {
    const loaded = loadAppConfig(
      env({
        NODE_ENV: "production",
        CORS_ORIGINS: "https://shop.example",
        AI_PROVIDER: "openai",
        AI_VISION_MODEL: "gpt-4o-mini",
        AI_API_KEY: "test-ai-key-value",
        AI_API_BASE_URL: "https://api.openai.com/v1",
        OBJECT_STORAGE_PROVIDER: "s3",
        OBJECT_STORAGE_BUCKET: "intake-private",
        OBJECT_STORAGE_REGION: "ap-south-1",
        OBJECT_STORAGE_ACCESS_KEY: "test-access-key",
        OBJECT_STORAGE_SECRET_KEY: "test-secret-key",
      }),
    );
    assert.deepEqual(loaded.corsOrigins, ["https://shop.example"]);
    assert.equal(loaded.swaggerEnabled, false);
    assert.equal(loaded.apiPrefix, "api");
    assert.equal(loaded.databaseAppRole, "dukaan_app");
    assert.equal(loaded.ai.provider, "openai");
    assert.equal(loaded.storage.provider, "s3");
  });

  it("uses localhost origins in development when CORS_ORIGINS is unset", () => {
    const loaded = loadAppConfig({
      NODE_ENV: "development",
      DATABASE_URL: appUrl,
      SESSION_SECRET: "test-session-secret-value",
      OTP_PEPPER: "test-otp-pepper-value",
    });
    assert.deepEqual(loaded.corsOrigins, [
      "http://localhost:5173",
      "http://localhost:3000",
    ]);
    assert.equal(loaded.swaggerEnabled, true);
    assert.equal(loaded.otpProvider, "console");
    assert.equal(loaded.ai.provider, "mock");
    assert.equal(loaded.storage.provider, "mock");
  });

  it("refuses a development OTP provider in production", () => {
    assert.throws(
      () =>
        loadAppConfig(
          env({
            NODE_ENV: "production",
            CORS_ORIGINS: "https://shop.example",
            OTP_PROVIDER: "console",
          }),
        ),
      /OTP_PROVIDER/,
    );
  });

  it("refuses mock intake in production and does not echo a provider secret", () => {
    const secret = "super-secret-ai-key";
    assert.throws(
      () =>
        loadAppConfig(
          env({
            NODE_ENV: "production",
            CORS_ORIGINS: "https://shop.example",
            AI_PROVIDER: "mock",
            AI_API_KEY: secret,
          }),
        ),
      (error: Error) => {
        assert.match(error.message, /AI_PROVIDER must be openai/);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  });

  it("keeps tests on the mock provider even when a real provider is configured", () => {
    const loaded = loadAppConfig(
      env({
        AI_PROVIDER: "openai",
        AI_VISION_MODEL: "gpt-4o-mini",
        AI_API_KEY: "test-ai-key-value",
        AI_API_BASE_URL: "https://api.openai.com/v1",
        OBJECT_STORAGE_PROVIDER: "s3",
        OBJECT_STORAGE_BUCKET: "intake-private",
        OBJECT_STORAGE_REGION: "ap-south-1",
        OBJECT_STORAGE_ACCESS_KEY: "test-access-key",
        OBJECT_STORAGE_SECRET_KEY: "test-secret-key",
      }),
    );
    assert.equal(loaded.ai.provider, "mock");
    assert.equal(loaded.ai.apiKey, "");
    assert.equal(loaded.storage.provider, "mock");
    assert.equal(loaded.storage.secretAccessKey, "");
  });
});
