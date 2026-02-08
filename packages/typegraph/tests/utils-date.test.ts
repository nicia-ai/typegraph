/**
 * Unit tests for date encoding utilities.
 */
import { describe, expect, it } from "vitest";

import { ValidationError } from "../src/errors";
import {
  decodeDate,
  encodeDate,
  isValidIsoDate,
  nowIso,
  validateIsoDate,
  validateOptionalIsoDate,
} from "../src/utils/date";

describe("date utilities", () => {
  describe("isValidIsoDate", () => {
    it("accepts valid ISO 8601 dates with milliseconds", () => {
      expect(isValidIsoDate("2024-01-15T10:30:00.000Z")).toBe(true);
      expect(isValidIsoDate("2024-12-31T23:59:59.999Z")).toBe(true);
    });

    it("accepts valid ISO 8601 dates without milliseconds", () => {
      expect(isValidIsoDate("2024-01-15T10:30:00Z")).toBe(true);
    });

    it("accepts dates with 1-3 millisecond digits", () => {
      expect(isValidIsoDate("2024-01-15T10:30:00.1Z")).toBe(true);
      expect(isValidIsoDate("2024-01-15T10:30:00.12Z")).toBe(true);
      expect(isValidIsoDate("2024-01-15T10:30:00.123Z")).toBe(true);
    });

    it("rejects dates with timezone offset instead of Z", () => {
      expect(isValidIsoDate("2024-01-15T10:30:00+00:00")).toBe(false);
      expect(isValidIsoDate("2024-01-15T10:30:00-05:00")).toBe(false);
    });

    it("rejects dates without time component", () => {
      expect(isValidIsoDate("2024-01-15")).toBe(false);
    });

    it("rejects invalid date formats", () => {
      expect(isValidIsoDate("not-a-date")).toBe(false);
      expect(isValidIsoDate("")).toBe(false);
      expect(isValidIsoDate("2024/01/15T10:30:00Z")).toBe(false);
    });

    it("rejects dates with invalid hour (25)", () => {
      // Note: JavaScript Date is lenient with day overflow (Feb 30 -> Mar 2)
      // and month overflow (month 13 -> January next year), but rejects hour 25
      expect(isValidIsoDate("2024-01-15T25:00:00Z")).toBe(false);
    });
  });

  describe("validateIsoDate", () => {
    it("returns the value if valid", () => {
      const date = "2024-01-15T10:30:00.000Z";
      expect(validateIsoDate(date, "testField")).toBe(date);
    });

    it("throws ValidationError for invalid dates", () => {
      expect(() => validateIsoDate("invalid", "testField")).toThrow(
        ValidationError,
      );
      expect(() => validateIsoDate("invalid", "testField")).toThrow(
        /Invalid ISO 8601 datetime for "testField"/,
      );
    });

    it("includes field name in error message", () => {
      expect(() => validateIsoDate("bad", "validFrom")).toThrow(/validFrom/);
    });
  });

  describe("validateOptionalIsoDate", () => {
    it("returns undefined for undefined input", () => {
      expect(validateOptionalIsoDate(undefined, "testField")).toBeUndefined();
    });

    it("returns the value if valid", () => {
      const date = "2024-01-15T10:30:00.000Z";
      expect(validateOptionalIsoDate(date, "testField")).toBe(date);
    });

    it("throws ValidationError for invalid dates", () => {
      expect(() => validateOptionalIsoDate("invalid", "testField")).toThrow(
        ValidationError,
      );
    });
  });

  describe("encodeDate", () => {
    it("encodes Date to ISO string", () => {
      const date = new Date("2024-01-15T10:30:00.000Z");
      expect(encodeDate(date)).toBe("2024-01-15T10:30:00.000Z");
    });

    it("always uses UTC", () => {
      const date = new Date("2024-01-15T10:30:00.000Z");
      const encoded = encodeDate(date);
      expect(encoded.endsWith("Z")).toBe(true);
    });
  });

  describe("decodeDate", () => {
    it("decodes valid ISO string to Date", () => {
      const date = decodeDate("2024-01-15T10:30:00.000Z");
      expect(date.getTime()).toBe(
        new Date("2024-01-15T10:30:00.000Z").getTime(),
      );
    });

    it("throws for invalid ISO strings", () => {
      expect(() => decodeDate("not-a-date")).toThrow(ValidationError);
    });
  });

  describe("nowIso", () => {
    it("returns a valid ISO string", () => {
      const now = nowIso();
      expect(isValidIsoDate(now)).toBe(true);
    });

    it("returns UTC time", () => {
      const now = nowIso();
      expect(now.endsWith("Z")).toBe(true);
    });
  });
});
