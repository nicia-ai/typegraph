/**
 * Path Utilities Tests
 */
import { describe, expect, it } from "vitest";

import { isSqlitePath, normalizePath, parseSqlitePath } from "../src/utils";
import {
  IDENTITY_PATH_TOKEN_SEPARATOR,
  stripIdentityPathTokens,
} from "../src/utils/path";

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

describe("stripIdentityPathTokens", () => {
  const separator = IDENTITY_PATH_TOKEN_SEPARATOR;

  it("unwraps composite kind/id tokens to bare ids", () => {
    expect(
      stripIdentityPathTokens([
        `Person${separator}alice`,
        `Company${separator}alice`,
      ]),
    ).toEqual(["alice", "alice"]);
  });

  it("preserves an id that itself contains the separator", () => {
    // Split at the FIRST separator only: kinds cannot contain it, so
    // everything after the first one is the id verbatim.
    expect(
      stripIdentityPathTokens([`Person${separator}a${separator}b`]),
    ).toEqual([`a${separator}b`]);
  });

  it("returns tokens without a separator unchanged", () => {
    expect(stripIdentityPathTokens(["plain-id", ""])).toEqual(["plain-id", ""]);
  });

  it("returns an empty id for a token that is only a kind and separator", () => {
    expect(stripIdentityPathTokens([`Person${separator}`])).toEqual([""]);
  });

  it("returns an empty path unchanged", () => {
    expect(stripIdentityPathTokens([])).toEqual([]);
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
