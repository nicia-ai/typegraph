import { describe, expect, it } from "vitest";

import { postgresDialect } from "../src/query/dialect/postgres";
import { sqliteDialect } from "../src/query/dialect/sqlite";
import { renderPostgres, sql } from "../src/query/sql-fragment";
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
    expect(renderPostgres(postgresStatement).sql).toBe(
      'ANALYZE "typegraph_iterative_test"',
    );
    expect(sqliteDialect.analyzeTemporaryTable(workingTable)).toBeUndefined();
  });
});

describe("iterative graph working-memory dialect seam", () => {
  it("emits a parameterized, transaction-local work_mem override on PostgreSQL only", () => {
    const workingMemory = "64MB";
    const postgresStatement =
      postgresDialect.setTransactionWorkingMemory(workingMemory);

    if (postgresStatement === undefined) {
      throw new Error("PostgreSQL must emit a work_mem override");
    }
    const compiled = renderPostgres(postgresStatement);
    // set_config(..., is_local => true) is the parameterizable form of
    // SET LOCAL: it reverts at transaction end and binds the value instead
    // of splicing it into the statement text.
    expect(compiled.sql).toBe("SELECT set_config('work_mem', $1, true)");
    expect(compiled.params).toEqual([workingMemory]);

    expect(
      sqliteDialect.setTransactionWorkingMemory(workingMemory),
    ).toBeUndefined();
  });
});
