/**
 * Unit tests for temporal filter compilation.
 *
 * Tests the compileTemporalFilter function across all temporal modes.
 */
import { describe, expect, it } from "vitest";

import {
  compileTemporalFilter,
  extractTemporalOptions,
  type TemporalFilterOptions,
} from "../src/query/compiler/temporal";
import { toSqlString } from "./sql-test-utils";

// ============================================================
// Test Helpers
// ============================================================

function getSqlString(options: TemporalFilterOptions): string {
  const result = compileTemporalFilter(options);
  return toSqlString(result);
}

// ============================================================
// compileTemporalFilter
// ============================================================

describe("compileTemporalFilter", () => {
  describe("current mode", () => {
    it("generates filter without table alias", () => {
      const sql = getSqlString({ mode: "current" });

      expect(sql).toContain("deleted_at IS NULL");
      expect(sql).toContain("valid_from IS NULL OR");
      expect(sql).toContain("valid_to IS NULL OR");
    });

    it("generates filter with table alias", () => {
      const sql = getSqlString({ mode: "current", tableAlias: "n" });

      expect(sql).toContain("n.deleted_at IS NULL");
      expect(sql).toContain("n.valid_from");
      expect(sql).toContain("n.valid_to");
    });

    it("generates filter with edge table alias", () => {
      const sql = getSqlString({ mode: "current", tableAlias: "e" });

      expect(sql).toContain("e.deleted_at IS NULL");
      expect(sql).toContain("e.valid_from");
      expect(sql).toContain("e.valid_to");
    });

    it("binds an application-clock instant, not the database clock", () => {
      const sql = getSqlString({ mode: "current" });

      // The current-read "now" is the application clock — an ISO instant bound
      // at build time — NOT the database `CURRENT_TIMESTAMP` / `NOW()`. This
      // keeps valid-time visibility on the same clock that stamps `valid_from`,
      // so a freshly-created row can't be hidden by app/database clock skew
      // (issue #242).
      expect(sql).not.toContain("CURRENT_TIMESTAMP");
      expect(sql).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe("asOf mode", () => {
    it("generates filter with timestamp", () => {
      const timestamp = "2024-01-15T10:30:00Z";
      const sql = getSqlString({ mode: "asOf", asOf: timestamp });

      expect(sql).toContain("deleted_at IS NULL");
      expect(sql).toContain("valid_from IS NULL OR");
      expect(sql).toContain("valid_to IS NULL OR");
      expect(sql).toContain(timestamp);
    });

    it("generates filter with table alias", () => {
      const timestamp = "2024-06-01T00:00:00Z";
      const sql = getSqlString({
        mode: "asOf",
        asOf: timestamp,
        tableAlias: "n",
      });

      expect(sql).toContain("n.deleted_at IS NULL");
      expect(sql).toContain(timestamp);
    });

    it("uses provided timestamp in validity comparisons", () => {
      const timestamp = "2023-12-31T23:59:59Z";
      const sql = getSqlString({ mode: "asOf", asOf: timestamp });

      // Should use the timestamp for both valid_from and valid_to comparisons
      const timestampCount = (sql.match(new RegExp(timestamp, "g")) ?? [])
        .length;
      expect(timestampCount).toBe(2);
    });
  });

  describe("includeEnded mode", () => {
    it("only filters deleted records", () => {
      const sql = getSqlString({ mode: "includeEnded" });

      expect(sql).toContain("deleted_at IS NULL");
      // Should NOT include valid_from/valid_to checks
      expect(sql).not.toContain("valid_from");
      expect(sql).not.toContain("valid_to");
    });

    it("applies table alias correctly", () => {
      const sql = getSqlString({ mode: "includeEnded", tableAlias: "e" });

      expect(sql).toContain("e.deleted_at IS NULL");
      expect(sql).not.toContain("e.valid_from");
    });
  });

  describe("includeTombstones mode", () => {
    it("generates no-op filter", () => {
      const sql = getSqlString({ mode: "includeTombstones" });

      expect(sql).toBe("1=1");
    });

    it("ignores table alias since no columns are referenced", () => {
      const sql = getSqlString({
        mode: "includeTombstones",
        tableAlias: "ignored",
      });

      expect(sql).toBe("1=1");
      expect(sql).not.toContain("ignored");
    });
  });

  describe("recorded predicate", () => {
    const recordedAsOf = "r1:0000000000000007:2024-03-04T05:06:07.000Z";

    it("omits the recorded predicate when recordedAsOf is absent", () => {
      const sql = getSqlString({ mode: "asOf", asOf: "2024-01-01T00:00:00Z" });

      expect(sql).not.toContain("recorded_from");
      expect(sql).not.toContain("recorded_to");
    });

    it("composes a half-open recorded interval onto the valid filter", () => {
      const sql = getSqlString({
        mode: "asOf",
        asOf: "2024-01-01T00:00:00Z",
        recordedAsOf,
      });

      // The valid filter is wrapped so the recorded conjunction binds correctly.
      expect(sql.trim().startsWith("(")).toBe(true);
      expect(sql).toContain("recorded_from <=");
      expect(sql).toContain("< recorded_to");
      // Half-open: `recorded_from <= R AND R < recorded_to`, so R appears twice.
      const occurrences = (sql.match(new RegExp(recordedAsOf, "g")) ?? [])
        .length;
      expect(occurrences).toBe(2);
    });

    it("prefixes the recorded columns with the table alias", () => {
      const sql = getSqlString({
        mode: "current",
        recordedAsOf,
        tableAlias: "n",
      });

      expect(sql).toContain("n.recorded_from <=");
      expect(sql).toContain("< n.recorded_to");
    });

    it("applies the recorded predicate even in includeTombstones mode", () => {
      const sql = getSqlString({ mode: "includeTombstones", recordedAsOf });

      expect(sql).toContain("1=1");
      expect(sql).toContain("recorded_from <=");
      expect(sql).toContain("< recorded_to");
    });
  });
});

// ============================================================
// extractTemporalOptions
// ============================================================

describe("extractTemporalOptions", () => {
  it("extracts current mode options", () => {
    const ast = { temporalMode: { mode: "current" as const } };

    const options = extractTemporalOptions(ast);

    expect(options).toEqual({
      mode: "current",
      asOf: undefined,
      tableAlias: undefined,
    });
  });

  it("extracts asOf mode options with timestamp", () => {
    const ast = {
      temporalMode: { mode: "asOf" as const, asOf: "2024-01-01T00:00:00.000Z" },
    };

    const options = extractTemporalOptions(ast);

    expect(options).toEqual({
      mode: "asOf",
      asOf: "2024-01-01T00:00:00.000Z",
      tableAlias: undefined,
    });
  });

  it("extracts includeEnded mode options", () => {
    const ast = { temporalMode: { mode: "includeEnded" as const } };

    const options = extractTemporalOptions(ast);

    expect(options).toEqual({
      mode: "includeEnded",
      asOf: undefined,
      tableAlias: undefined,
    });
  });

  it("extracts includeTombstones mode options", () => {
    const ast = { temporalMode: { mode: "includeTombstones" as const } };

    const options = extractTemporalOptions(ast);

    expect(options).toEqual({
      mode: "includeTombstones",
      asOf: undefined,
      tableAlias: undefined,
    });
  });

  it("includes table alias when provided", () => {
    const ast = { temporalMode: { mode: "current" as const } };

    const options = extractTemporalOptions(ast, "n");

    expect(options).toEqual({
      mode: "current",
      asOf: undefined,
      tableAlias: "n",
    });
  });

  it("includes both asOf and table alias", () => {
    const ast = {
      temporalMode: { mode: "asOf" as const, asOf: "2024-06-15T12:00:00.000Z" },
    };

    const options = extractTemporalOptions(ast, "e");

    expect(options).toEqual({
      mode: "asOf",
      asOf: "2024-06-15T12:00:00.000Z",
      tableAlias: "e",
    });
  });

  it("passes through recordedAsOf from the ast", () => {
    const ast = {
      temporalMode: { mode: "asOf" as const, asOf: "2024-06-15T12:00:00.000Z" },
      recordedAsOf: "r1:0000000000000009:2024-07-01T00:00:00.000Z",
    };

    const options = extractTemporalOptions(ast, "n");

    expect(options.recordedAsOf).toBe(
      "r1:0000000000000009:2024-07-01T00:00:00.000Z",
    );
    expect(options.mode).toBe("asOf");
    expect(options.tableAlias).toBe("n");
  });
});
