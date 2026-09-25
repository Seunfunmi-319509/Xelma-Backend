import { describe, expect, it } from "@jest/globals";
import { BackpressureError } from "../utils/errors";
import { createConcurrencyLimiter } from "../utils/backpressure";

describe("createConcurrencyLimiter (#500)", () => {
  it("allows up to maxInFlight concurrent operations", async () => {
    const limiter = createConcurrencyLimiter({
      name: "test-rpc",
      maxInFlight: 2,
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = limiter.execute(() => gate.then(() => "one"));
    const second = limiter.execute(() => gate.then(() => "two"));

    expect(limiter.getInFlight()).toBe(2);

    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["one", "two"]);
    expect(limiter.getInFlight()).toBe(0);
  });

  it("rejects immediately when the cap is full", async () => {
    const limiter = createConcurrencyLimiter({
      name: "test-rpc",
      maxInFlight: 1,
      retryAfterSeconds: 2,
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const held = limiter.execute(() => gate.then(() => "held"));

    await expect(limiter.execute(async () => "should-not-run")).rejects.toBeInstanceOf(
      BackpressureError,
    );

    try {
      await limiter.execute(async () => "should-not-run");
    } catch (error) {
      expect(error).toBeInstanceOf(BackpressureError);
      expect((error as BackpressureError).retryAfterSeconds).toBe(2);
      expect((error as BackpressureError).statusCode).toBe(503);
    }

    release();
    await expect(held).resolves.toBe("held");
  });

  it("does not call the operation when rejecting", async () => {
    const limiter = createConcurrencyLimiter({
      name: "test-rpc",
      maxInFlight: 1,
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const held = limiter.execute(() => gate.then(() => "held"));
    const operation = jest.fn(async () => "nope");

    await expect(limiter.execute(operation)).rejects.toBeInstanceOf(BackpressureError);
    expect(operation).not.toHaveBeenCalled();

    release();
    await held;
  });
});
