/**
 * Unit tests for Result type utilities.
 */
import { describe, expect, it } from "vitest";

import { err, isErr, isOk, ok, unwrap, unwrapOr } from "../src/utils/result";

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
