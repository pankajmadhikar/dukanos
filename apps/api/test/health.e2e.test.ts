import "dotenv/config";
import "reflect-metadata";
import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "@jest/globals";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/configure-app";

describe("health endpoints", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports liveness, readiness, and a request id from context", async () => {
    const server = app.getHttpServer();
    const [first, second] = await Promise.all([
      request(server).get("/api/v1/health/live").set("x-request-id", "request-a1"),
      request(server).get("/api/v1/health/live").set("x-request-id", "request-b2"),
    ]);
    assert.equal(first.status, 200);
    assert.equal(first.body.status, "ok");
    assert.equal(first.body.service, "dukaanos-api");
    assert.equal(first.body.requestId, "request-a1");
    assert.equal(first.headers["x-request-id"], "request-a1");
    assert.equal(second.body.requestId, "request-b2");
    assert.equal(first.headers["x-content-type-options"], "nosniff");

    const replaced = await request(server)
      .get("/api/v1/health")
      .set("x-request-id", "bad");
    assert.equal(replaced.status, 200);
    assert.notEqual(replaced.headers["x-request-id"], "bad");

    const ready = await request(server).get("/api/v1/health/ready");
    assert.equal(ready.status, 200);
    assert.equal(ready.body.database, "up");
    assert.equal(typeof ready.body.requestId, "string");

    const allowed = await request(server)
      .get("/api/v1/health/live")
      .set("Origin", "http://localhost:5173");
    assert.equal(allowed.headers["access-control-allow-origin"], "http://localhost:5173");

    const denied = await request(server)
      .get("/api/v1/health/live")
      .set("Origin", "https://evil.example");
    assert.notEqual(denied.headers["access-control-allow-origin"], "https://evil.example");
  });

  it("returns the error envelope for an unknown route", async () => {
    const missing = await request(app.getHttpServer()).get("/api/v1/missing");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.success, false);
    assert.equal(missing.body.error.code, "NOT_FOUND");
    assert.equal(typeof missing.body.error.requestId, "string");
    assert.equal(missing.body.error.message.includes("prisma"), false);
  });

  it("serves the OpenAPI document", async () => {
    const spec = await request(app.getHttpServer()).get("/api/docs-json");
    assert.equal(spec.status, 200);
    assert.equal(spec.body.info.title, "DukaanOS API");
    const paths = Object.keys(spec.body.paths as Record<string, unknown>);
    assert.equal(
      paths.some((path) => path.endsWith("/health/live")),
      true,
    );
  });
});
