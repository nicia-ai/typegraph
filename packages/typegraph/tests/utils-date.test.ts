/**
 * Unit tests for date encoding utilities.
 */
import { describe, expect, it } from "vitest";

import { ValidationError } from "../src/errors";
import {
  canonicalDatabaseTimestampText,
  canonicalizeDatabaseTimestamp,
  decodeDate,
  encodeDate,
  isCanonicalIsoDate,
  isValidIsoDate,
  nowIso,
  validateCanonicalIsoDate,
  validateIsoDate,
} from "../src/utils/date";

describe("date utilities", () => {
  describe("canonicalizeDatabaseTimestamp", () => {
    it("interprets zoneless driver timestamps as UTC", () => {
      expect(canonicalizeDatabaseTimestamp("2026-06-25 12:00:00")).toBe(
        "2026-06-25T12:00:00.000Z",
      );
      expect(canonicalizeDatabaseTimestamp("2026-06-25T12:30")).toBe(
        "2026-06-25T12:30:00.000Z",
      );
      expect(canonicalizeDatabaseTimestamp("2026-06-25T12:00:00.123")).toBe(
        "2026-06-25T12:00:00.123Z",
      );
    });

    it("normalizes explicit database-driver offsets", () => {
      expect(canonicalizeDatabaseTimestamp("2026-06-25 12:00:00+00")).toBe(
        "2026-06-25T12:00:00.000Z",
      );
      expect(canonicalizeDatabaseTimestamp("2026-06-25 12:00:00+0000")).toBe(
        "2026-06-25T12:00:00.000Z",
      );
      expect(canonicalizeDatabaseTimestamp("2026-06-25 12:00:00-0230")).toBe(
        "2026-06-25T14:30:00.000Z",
      );
    });

    it("normalizes an offset with seconds, a zone's local mean time", () => {
      // PostgreSQL in Europe/Paris renders 1900-01-01T00:00:00Z this way.
      expect(
        canonicalizeDatabaseTimestamp("1900-01-01 00:09:21+00:09:21"),
      ).toBe("1900-01-01T00:00:00.000Z");
      expect(
        canonicalizeDatabaseTimestamp("1900-01-01T00:09:21.500+00:09:21"),
      ).toBe("1900-01-01T00:00:00.500Z");
      expect(
        canonicalizeDatabaseTimestamp("1880-06-01 23:58:45-00:01:15"),
      ).toBe("1880-06-02T00:00:00.000Z");
      expect(
        canonicalDatabaseTimestampText("1900-01-01T00:09:21+00:09:21"),
      ).toBe("1900-01-01T00:00:00.000Z");
      expect(
        canonicalizeDatabaseTimestamp("1900-01-01 00:09:21+00:09:60"),
      ).toBeUndefined();
      expect(
        canonicalizeDatabaseTimestamp("1900-01-01 00:09:21+0009:21"),
      ).toBeUndefined();
    });

    it("rejects unsupported and unrepresentable values", () => {
      expect(
        canonicalizeDatabaseTimestamp(new Date("not a date")),
      ).toBeUndefined();
      expect(canonicalizeDatabaseTimestamp("not a date")).toBeUndefined();
      expect(
        canonicalizeDatabaseTimestamp("June 25 2026 12:00:00"),
      ).toBeUndefined();
      expect(canonicalizeDatabaseTimestamp(42)).toBeUndefined();
    });
  });

  describe("canonicalDatabaseTimestampText", () => {
    it("decides the year on the UTC instant, not on the local text", () => {
      // PostgreSQL in Pacific/Kiritimati (+14) renders the last hours of 9999
      // in year 10000, and in a zone west of UTC the first hours of year 1 as
      // year 1 BC (year 0).
      expect(canonicalDatabaseTimestampText("10000-01-01T10:00:00+14:00")).toBe(
        "9999-12-31T20:00:00.000Z",
      );
      expect(
        canonicalDatabaseTimestampText("10000-01-01 13:59:59.999+14"),
      ).toBe("9999-12-31T23:59:59.999Z");
      expect(
        canonicalDatabaseTimestampText("0001-12-31T21:00:00-08:00 BC"),
      ).toBe("0001-01-01T05:00:00.000Z");
      expect(canonicalDatabaseTimestampText("0001-12-31 16:00:00-08 BC")).toBe(
        "0001-01-01T00:00:00.000Z",
      );
      // The same local texts an hour further out are outside 0001 to 9999.
      expect(
        canonicalDatabaseTimestampText("10000-01-01T14:00:00+14:00"),
      ).toBeUndefined();
      expect(
        canonicalDatabaseTimestampText("0001-12-31T15:59:59.999-08:00 BC"),
      ).toBeUndefined();
      expect(
        canonicalDatabaseTimestampText("0002-12-31T21:00:00-08:00 BC"),
      ).toBeUndefined();
    });

    it("reads a local date by the calendar of its own year", () => {
      // Leap days: 400 and 1 BC (year 0) have one, 100 and 2 BC do not.
      expect(canonicalDatabaseTimestampText("0400-02-29T00:00:00Z")).toBe(
        "0400-02-29T00:00:00.000Z",
      );
      expect(canonicalDatabaseTimestampText("0100-02-29T00:00:00Z")).toBe(
        undefined,
      );
      expect(
        canonicalDatabaseTimestampText("10000-02-29T00:00:00+14:00"),
      ).toBeUndefined();
      expect(
        canonicalDatabaseTimestampText("0001-02-29T00:00:00-08:00 BC"),
      ).toBeUndefined();
      expect(
        canonicalDatabaseTimestampText("10000-01-01T10:00:00.1234+14:00"),
      ).toBeUndefined();
    });
  });

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

  describe("isCanonicalIsoDate", () => {
    it("accepts canonical fixed-width millisecond timestamps", () => {
      expect(isCanonicalIsoDate("2024-01-15T10:30:00.000Z")).toBe(true);
      expect(isCanonicalIsoDate("2024-12-31T23:59:59.999Z")).toBe(true);
      expect(isCanonicalIsoDate(nowIso())).toBe(true);
    });

    it("rejects variable-width or missing milliseconds", () => {
      // These pass the lenient isValidIsoDate but break text ordering:
      // "...00.1Z" sorts AFTER "...00.101Z", so they are not canonical.
      expect(isCanonicalIsoDate("2024-01-15T10:30:00.1Z")).toBe(false);
      expect(isCanonicalIsoDate("2024-01-15T10:30:00.12Z")).toBe(false);
      expect(isCanonicalIsoDate("2024-01-15T10:30:00Z")).toBe(false);
      expect(isValidIsoDate("2024-01-15T10:30:00.1Z")).toBe(true); // contrast
    });

    it("rejects offsets, date-only, and natural-language strings", () => {
      expect(isCanonicalIsoDate("2024-01-15T10:30:00.000+02:00")).toBe(false);
      expect(isCanonicalIsoDate("2024-01-15")).toBe(false);
      expect(isCanonicalIsoDate("January 15, 2024")).toBe(false);
      expect(isCanonicalIsoDate("2024-01-15T25:00:00.000Z")).toBe(false);
      expect(isCanonicalIsoDate("2024-01-15T24:00:00.000Z")).toBe(false);
      expect(isCanonicalIsoDate("2024-02-30T00:00:00.000Z")).toBe(false);
    });
  });

  describe("validateCanonicalIsoDate", () => {
    it("returns the value if canonical", () => {
      const date = "2024-01-15T10:30:00.000Z";
      expect(validateCanonicalIsoDate(date, "asOf")).toBe(date);
    });

    it("throws ValidationError for non-canonical millisecond widths", () => {
      expect(() =>
        validateCanonicalIsoDate("2024-01-15T10:30:00.1Z", "asOf"),
      ).toThrow(ValidationError);
      expect(() =>
        validateCanonicalIsoDate("2024-01-15T10:30:00Z", "asOf"),
      ).toThrow(/Invalid canonical ISO 8601 datetime for "asOf"/);
    });

    it("throws ValidationError for rollover dates", () => {
      expect(() =>
        validateCanonicalIsoDate("2024-02-30T00:00:00.000Z", "asOf"),
      ).toThrow(ValidationError);
      expect(() =>
        validateCanonicalIsoDate("2024-01-15T24:00:00.000Z", "asOf"),
      ).toThrow(ValidationError);
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

describe("canonicalDatabaseTimestampText", () => {
  it("reads a driver's rendering of a millisecond instant, with any offset or none, as its canonical UTC text", () => {
    expect(
      [
        "2024-01-01T19:04:05.678-08:00",
        "2024-01-02T03:04:05.678+00:00",
        "2024-01-02 03:04:05.678+00",
        "2024-01-02T08:34:05.678+05:30",
        "2024-01-02T03:04:05.678+0000",
        "2024-01-02T03:04:05.678Z",
        "2024-01-02T03:04:05Z",
        "2024-01-02 03:04:05.678",
        "2024-01-01T19:04:05-08:00",
        "2024-01-01T19:04:05.6-08:00",
        "1999-12-31T15:59:59.999-08:00",
      ].map((text) => canonicalDatabaseTimestampText(text)),
    ).toEqual([
      "2024-01-02T03:04:05.678Z",
      "2024-01-02T03:04:05.678Z",
      "2024-01-02T03:04:05.678Z",
      "2024-01-02T03:04:05.678Z",
      "2024-01-02T03:04:05.678Z",
      "2024-01-02T03:04:05.678Z",
      "2024-01-02T03:04:05.000Z",
      "2024-01-02T03:04:05.678Z",
      "2024-01-02T03:04:05.000Z",
      "2024-01-02T03:04:05.600Z",
      "1999-12-31T23:59:59.999Z",
    ]);
  });

  it("refuses text without a full date and time, past millisecond precision, with an invalid field, or outside 0001 to 9999", () => {
    expect(
      [
        "2024-01-02T03:04:05.678912+00:00",
        "2024-01-02T03:04:05.6780+00:00",
        "2024-13-02T03:04:05.678+00:00",
        "2024-02-30T03:04:05.678+00:00",
        "2024-01-02T24:04:05.678+00:00",
        "2024-01-02T03:04:05.678+00:60",
        "2024-01-02T03:04Z",
        "2024-01-02",
        "9999-12-31T20:00:00.000-08:00",
        "0001-01-01T03:00:00.000+08:00",
        "not a timestamp",
      ].filter((text) => canonicalDatabaseTimestampText(text) !== undefined),
    ).toEqual([]);
  });
});
