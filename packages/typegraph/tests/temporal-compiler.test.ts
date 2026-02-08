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
      temporalMode: { mode: "asOf" as const, asOf: "2024-01-01T00:00:00Z" },
    };

    const options = extractTemporalOptions(ast);

    expect(options).toEqual({
      mode: "asOf",
      asOf: "2024-01-01T00:00:00Z",
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
      temporalMode: { mode: "asOf" as const, asOf: "2024-06-15T12:00:00Z" },
    };

    const options = extractTemporalOptions(ast, "e");

    expect(options).toEqual({
      mode: "asOf",
      asOf: "2024-06-15T12:00:00Z",
      tableAlias: "e",
    });
  });
});
