/**
 * Unit tests for Result type utilities.
 */
import { describe, expect, it } from "vitest";

import {
  err,
  flatMap,
  isErr,
  isOk,
  map,
  mapErr,
  ok,
  orElse,
  unwrap,
  unwrapOr,
} from "../src/utils/result";

function divide(a: number, b: number) {
  if (b === 0) return err(new Error("division by zero"));
  return ok(a / b);
}

describe("result utilities", () => {
  describe("ok", () => {
    it("creates a successful result with data", () => {
      const result = ok(42);
      expect(result).toEqual({ success: true, data: 42 });
    });

    it("preserves complex data types", () => {
      const data = { name: "test", values: [1, 2, 3] };
      const result = ok(data);
      expect(result).toEqual({ success: true, data });
    });

    it("handles undefined as valid data", () => {
      const result = ok();
      expect(result).toEqual({ success: true, data: undefined });
    });
  });

  describe("err", () => {
    it("creates a failed result with error", () => {
      const error = new Error("test error");
      const result = err(error);
      expect(result).toEqual({ success: false, error });
    });

    it("accepts string errors", () => {
      const result = err("something went wrong");
      expect(result).toEqual({ success: false, error: "something went wrong" });
    });

    it("accepts custom error objects", () => {
      const customError = { code: "NOT_FOUND", message: "Resource missing" };
      const result = err(customError);
      expect(result).toEqual({ success: false, error: customError });
    });
  });

  describe("unwrap", () => {
    it("returns data from successful result", () => {
      const result = ok("success");
      expect(unwrap(result)).toBe("success");
    });

    it("throws error from failed result", () => {
      const error = new Error("test error");
      const result = err(error);
      expect(() => unwrap(result)).toThrow(error);
    });

    it("throws non-Error values directly", () => {
      const result = err("string error");
      expect(() => unwrap(result)).toThrow("string error");
    });
  });

  describe("unwrapOr", () => {
    it("returns data from successful result", () => {
      const result = ok(42);
      expect(unwrapOr(result, 0)).toBe(42);
    });

    it("returns default value from failed result", () => {
      const result = err(new Error("failed"));
      expect(unwrapOr(result, 0)).toBe(0);
    });

    it("uses provided default even when data is falsy", () => {
      const result = ok(0);
      expect(unwrapOr(result, 100)).toBe(0);
    });

    it("returns default for failed result with falsy error", () => {
      const result = err("");
      expect(unwrapOr(result, "default")).toBe("default");
    });
  });

  describe("isOk", () => {
    it("returns true for successful result", () => {
      const result = ok("data");
      expect(isOk(result)).toBe(true);
    });

    it("returns false for failed result", () => {
      const result = err(new Error("error"));
      expect(isOk(result)).toBe(false);
    });

    it("acts as type guard for success", () => {
      const result = ok(42) as
        | ReturnType<typeof ok<number>>
        | ReturnType<typeof err<Error>>;
      expect(isOk(result)).toBe(true);
      // TypeScript narrowing verified - access data after confirming success
      expect((result as { success: true; data: number }).data).toBe(42);
    });
  });

  describe("map", () => {
    it("transforms the success value", () => {
      const result = map(ok(2), (n) => n * 3);
      expect(result).toEqual({ success: true, data: 6 });
    });

    it("passes through errors unchanged", () => {
      const error = new Error("fail");
      const result = map(err(error), (n: number) => n * 3);
      expect(result).toEqual({ success: false, error });
    });

    it("can change the data type", () => {
      const result = map(ok(42), String);
      expect(result).toEqual({ success: true, data: "42" });
    });
  });

  describe("mapErr", () => {
    it("transforms the error value", () => {
      const result = mapErr(err("not found"), (message) => new Error(message));
      expect(result).toEqual({ success: false, error: new Error("not found") });
    });

    it("passes through successes unchanged", () => {
      const result = mapErr(ok(42), (message: string) => new Error(message));
      expect(result).toEqual({ success: true, data: 42 });
    });
  });

  describe("flatMap", () => {
    it("chains successful operations", () => {
      const result = flatMap(ok(10), (n) => divide(n, 2));
      expect(result).toEqual({ success: true, data: 5 });
    });

    it("short-circuits on initial error", () => {
      const error = new Error("earlier failure");
      const result = flatMap(err(error), (n: number) => divide(n, 2));
      expect(result).toEqual({ success: false, error });
    });

    it("propagates error from chained operation", () => {
      const result = flatMap(ok(10), (n) => divide(n, 0));
      expect(result).toEqual({
        success: false,
        error: new Error("division by zero"),
      });
    });
  });

  describe("orElse", () => {
    it("returns success unchanged", () => {
      const result = orElse(ok(42), () => ok(0));
      expect(result).toEqual({ success: true, data: 42 });
    });

    it("recovers from error with fallback result", () => {
      const result = orElse(err(new Error("fail")), () => ok(0));
      expect(result).toEqual({ success: true, data: 0 });
    });

    it("can produce a new error", () => {
      const result = orElse(err("not found"), (message) =>
        err(new Error(`wrapped: ${message}`)),
      );
      expect(result).toEqual({
        success: false,
        error: new Error("wrapped: not found"),
      });
    });

    it("receives the error value", () => {
      const result = orElse(err(404), (code) => ok(`fallback for ${code}`));
      expect(result).toEqual({ success: true, data: "fallback for 404" });
    });
  });

  describe("isErr", () => {
    it("returns true for failed result", () => {
      const result = err(new Error("error"));
      expect(isErr(result)).toBe(true);
    });

    it("returns false for successful result", () => {
      const result = ok("data");
      expect(isErr(result)).toBe(false);
    });

    it("acts as type guard for error", () => {
      const error = new Error("test");
      const result = err(error) as
        | ReturnType<typeof ok<number>>
        | ReturnType<typeof err<Error>>;
      expect(isErr(result)).toBe(true);
      // TypeScript narrowing verified - access error after confirming failure
      expect((result as { success: false; error: Error }).error).toBe(error);
    });
  });
});
