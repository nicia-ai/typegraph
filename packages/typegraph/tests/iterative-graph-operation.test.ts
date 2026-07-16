import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { postgresDialect } from "../src/query/dialect/postgres";
import { sqliteDialect } from "../src/query/dialect/sqlite";
import {
  shouldRefreshWorkingTableStatistics,
  WORKING_TABLE_ANALYZE_GROWTH_FACTOR,
  WORKING_TABLE_ANALYZE_MINIMUM_ROWS,
} from "../src/store/algorithms/iterative-graph-operation";

describe("iterative graph working-table statistics", () => {
  it("refreshes after a bulk seed reaches the minimum size", () => {
    expect(
      shouldRefreshWorkingTableStatistics(
        WORKING_TABLE_ANALYZE_MINIMUM_ROWS - 1,
      ),
    ).toBe(false);
    expect(
      shouldRefreshWorkingTableStatistics(WORKING_TABLE_ANALYZE_MINIMUM_ROWS),
    ).toBe(true);
  });

  it("refreshes again only after multiplicative table growth", () => {
    const analyzedRowCount = WORKING_TABLE_ANALYZE_MINIMUM_ROWS;
    expect(
      shouldRefreshWorkingTableStatistics(
        analyzedRowCount * WORKING_TABLE_ANALYZE_GROWTH_FACTOR - 1,
        analyzedRowCount,
      ),
    ).toBe(false);
    expect(
      shouldRefreshWorkingTableStatistics(
        analyzedRowCount * WORKING_TABLE_ANALYZE_GROWTH_FACTOR,
        analyzedRowCount,
      ),
    ).toBe(true);
  });

  it("keeps a stable whole-graph working table on one refresh", () => {
    const workingTableSize = 31;
    expect(shouldRefreshWorkingTableStatistics(workingTableSize)).toBe(true);
    expect(
      shouldRefreshWorkingTableStatistics(workingTableSize, workingTableSize),
    ).toBe(false);
  });

  it("uses a dialect seam so only PostgreSQL emits ANALYZE", () => {
    const workingTable = sql.identifier("typegraph_iterative_test");
    const postgresStatement =
      postgresDialect.analyzeTemporaryTable(workingTable);

    if (postgresStatement === undefined) {
      throw new Error("PostgreSQL must emit a temporary-table ANALYZE");
    }
    expect(new PgDialect().sqlToQuery(postgresStatement).sql).toBe(
      'ANALYZE "typegraph_iterative_test"',
    );
    expect(sqliteDialect.analyzeTemporaryTable(workingTable)).toBeUndefined();
  });
});
