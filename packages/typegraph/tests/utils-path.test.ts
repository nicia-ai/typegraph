/**
 * Path Utilities Tests
 */
import { describe, expect, it } from "vitest";

import { isSqlitePath, normalizePath, parseSqlitePath } from "../src/utils";
import {
  KIND_QUALIFIED_PATH_TOKEN_SEPARATOR,
  stripKindQualifiedPathTokens,
} from "../src/utils/path";

describe("parseSqlitePath", () => {
  it("parses a path with multiple IDs", () => {
    expect(parseSqlitePath("|abc|def|ghi|")).toEqual(["abc", "def", "ghi"]);
  });

  it("parses a single-element path", () => {
    expect(parseSqlitePath("|single|")).toEqual(["single"]);
  });

  it("reads an empty id from the one-token path and nothing from an empty string", () => {
    expect(parseSqlitePath("||")).toEqual([""]);
    expect(parseSqlitePath("|a||")).toEqual(["a", ""]);
    expect(parseSqlitePath("")).toEqual([]);
  });

  it("decodes escaped delimiters and escape characters back to the id", () => {
    expect(parseSqlitePath("|x%7Cy|50%25|lit%257C|")).toEqual([
      "x|y",
      "50%",
      "lit%7C",
    ]);
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

describe("stripKindQualifiedPathTokens", () => {
  const separator = KIND_QUALIFIED_PATH_TOKEN_SEPARATOR;

  it("unwraps composite kind/id tokens to bare ids", () => {
    expect(
      stripKindQualifiedPathTokens([
        `Person${separator}alice`,
        `Company${separator}alice`,
      ]),
    ).toEqual(["alice", "alice"]);
  });

  it("preserves an id that itself contains the separator", () => {
    // Split at the FIRST separator only: kinds cannot contain it, so
    // everything after the first one is the id verbatim.
    expect(
      stripKindQualifiedPathTokens([`Person${separator}a${separator}b`]),
    ).toEqual([`a${separator}b`]);
  });

  it("returns tokens without a separator unchanged", () => {
    expect(stripKindQualifiedPathTokens(["plain-id", ""])).toEqual([
      "plain-id",
      "",
    ]);
  });

  it("returns an empty id for a token that is only a kind and separator", () => {
    expect(stripKindQualifiedPathTokens([`Person${separator}`])).toEqual([""]);
  });

  it("returns an empty path unchanged", () => {
    expect(stripKindQualifiedPathTokens([])).toEqual([]);
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

  it("parses PostgreSQL text array literals, quoted elements included", () => {
    expect(normalizePath("{}")).toEqual([]);
    expect(normalizePath("{a,b}")).toEqual(["a", "b"]);
    expect(
      normalizePath(
        String.raw`{plain,"a,b","{x}","say \"hi\"","back\\slash","two words",""}`,
      ),
    ).toEqual([
      "plain",
      "a,b",
      "{x}",
      'say "hi"',
      String.raw`back\slash`,
      "two words",
      "",
    ]);
  });

  it("trims only PostgreSQL's ASCII whitespace around unquoted elements", () => {
    const nbsp = " ";
    expect(normalizePath(`{x${nbsp}}`)).toEqual([`x${nbsp}`]);
    expect(normalizePath(`{${nbsp}}`)).toEqual([nbsp]);
    expect(normalizePath(`{${nbsp}a,b${nbsp}}`)).toEqual([
      `${nbsp}a`,
      `b${nbsp}`,
    ]);
    expect(normalizePath("{ a ,\tb\n}")).toEqual(["a", "b"]);
    expect(normalizePath("{ \t\n\r\v\f}")).toEqual([]);
  });

  it("returns empty array for non-path values", () => {
    expect(normalizePath("not a path")).toEqual([]);
    expect(normalizePath(123)).toEqual([]);
  });
});
