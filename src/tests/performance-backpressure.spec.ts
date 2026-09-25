/**
 * Overload / backpressure checks for #500.
 *
 * Uses the real `betRateLimiter` (not mocked) and the shared error handler so
 * we can prove money-path overload returns controlled 429/503 instead of 500s.
 * Handlers are stubs: this file measures backpressure, not bet-store internals.
 */
import { describe, expect, it } from "@jest/globals";
import express, { NextFunction, Request, Response } from "express";
import request from "supertest";
import { errorHandler } from "../middleware/errorHandler.middleware";
import { betRateLimiter } from "../middleware/rateLimiter.middleware";
import { requestIdMiddleware } from "../middleware/requestId.middleware";
import { CircuitBreakerOpenError } from "../utils/circuit-breaker";
import { BackpressureError } from "../utils/errors";
import {
  countStatusCodes,
  formatLoadTestReport,
  getLoadTestConfig,
  isControlledOverloadStatus,
  summarizeLoadTest,
} from "./load-test.harness";

function makeOverloadApp(
  handler: (req: Request, res: Response, next: NextFunction) => void,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.post("/api/bets/up-down", betRateLimiter, handler);
  app.use(errorHandler);
  return app;
}

const LOAD_CONFIG = getLoadTestConfig();

describe("Overload backpressure — 503 mapping (#500)", () => {
  it("maps an open circuit breaker to 503 with Retry-After", async () => {
    const app = makeOverloadApp((_req, _res, next) => {
      next(new CircuitBreakerOpenError("soroban-rpc", new Date(Date.now() + 30_000)));
    });

    const response = await request(app).post("/api/bets/up-down").send({});

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("EXTERNAL_SERVICE_ERROR");
    expect(response.headers["retry-after"]).toBeDefined();
    expect(response.body.retryAfter).toBeGreaterThan(0);
  });

  it("maps in-flight backpressure to 503 with Retry-After", async () => {
    const app = makeOverloadApp((_req, _res, next) => {
      next(new BackpressureError("Too many in-flight soroban-rpc operations.", 1));
    });

    const response = await request(app).post("/api/bets/up-down").send({});

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("EXTERNAL_SERVICE_ERROR");
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.body.retryAfter).toBe(1);
  });
});

describe("Overload backpressure — bet rate limit (#500)", () => {
  it("returns controlled 429 when bet submissions exceed the per-IP cap", async () => {
    const app = makeOverloadApp((_req, res) => {
      res.json({ success: true });
    });
    const burst = LOAD_CONFIG.overload.betBurst;
    const samples: Array<{
      success: boolean;
      latencyMs: number;
      statusCode: number;
    }> = [];

    for (let index = 0; index < burst; index += 1) {
      const startedAt = Date.now();
      const response = await request(app).post("/api/bets/up-down").send({});
      samples.push({
        success: isControlledOverloadStatus(response.status),
        latencyMs: Date.now() - startedAt,
        statusCode: response.status,
      });
    }

    const result = summarizeLoadTest(samples, samples.reduce((sum, s) => sum + s.latencyMs, 0) || 1);
    console.log(formatLoadTestReport("bet overload 429", result));

    const statuses = countStatusCodes(samples);
    expect(statuses[429] ?? 0).toBeGreaterThan(0);
    expect(samples.every((sample) => isControlledOverloadStatus(sample.statusCode))).toBe(true);
    expect(samples.some((sample) => sample.statusCode === 500)).toBe(false);

    const limited = await request(app).post("/api/bets/up-down").send({});
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("Too Many Requests");
    expect(limited.body.retryAfter).toBeGreaterThan(0);
  });
});
