/**
 * Path Utilities Tests
 */
import { describe, expect, it } from "vitest";

import { isSqlitePath, normalizePath, parseSqlitePath } from "../src/utils";

describe("parseSqlitePath", () => {
  it("parses a path with multiple IDs", () => {
    expect(parseSqlitePath("|abc|def|ghi|")).toEqual(["abc", "def", "ghi"]);
  });

  it("parses a single-element path", () => {
    expect(parseSqlitePath("|single|")).toEqual(["single"]);
  });

  it("returns empty array for empty path", () => {
    expect(parseSqlitePath("||")).toEqual([]);
    expect(parseSqlitePath("")).toEqual([]);
  });

  it("handles UUIDs in paths", () => {
    const result = parseSqlitePath(
      "|550e8400-e29b-41d4-a716-446655440000|6ba7b810-9dad-11d1-80b4-00c04fd430c8|",
    );
    expect(result).toEqual([
      "550e8400-e29b-41d4-a716-446655440000",
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    ]);
  });
});

describe("isSqlitePath", () => {
  it("returns true for valid SQLite paths", () => {
    expect(isSqlitePath("|id1|id2|")).toBe(true);
    expect(isSqlitePath("|single|")).toBe(true);
    expect(isSqlitePath("||")).toBe(true);
  });

  it("returns false for non-SQLite paths", () => {
    expect(isSqlitePath("not a path")).toBe(false);
    expect(isSqlitePath("|incomplete")).toBe(false);
    expect(isSqlitePath("incomplete|")).toBe(false);
    expect(isSqlitePath(["array"])).toBe(false);
  });
});

describe("normalizePath", () => {
  it("returns arrays unchanged", () => {
    expect(normalizePath(["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(normalizePath([])).toEqual([]);
  });

  it("parses SQLite path strings", () => {
    expect(normalizePath("|a|b|c|")).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for non-path values", () => {
    expect(normalizePath("not a path")).toEqual([]);
    expect(normalizePath(123)).toEqual([]);
  });
});
