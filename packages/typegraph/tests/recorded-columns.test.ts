/**
 * The recorded INSERT column lists (`RECORDED_NODE_COLUMNS` /
 * `RECORDED_EDGE_COLUMNS`) are hand-maintained next to the Drizzle DDL for the
 * recorded relations. These tests link the two so adding or renaming a recorded
 * column in one place without the other fails loudly here instead of producing
 * a silent column/INSERT mismatch at runtime — on both dialects.
 */
import { getTableColumns, type Table } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  recordedEdges as pgRecordedEdges,
  recordedNodes as pgRecordedNodes,
} from "../src/backend/drizzle/schema/postgres";
import {
  recordedEdges as sqliteRecordedEdges,
  recordedNodes as sqliteRecordedNodes,
} from "../src/backend/drizzle/schema/sqlite";
import {
  RECORDED_EDGE_COLUMNS,
  RECORDED_NODE_COLUMNS,
} from "../src/store/recorded-capture";

function ddlColumnNames(table: Table): readonly string[] {
  return Object.values(getTableColumns(table))
    .map((column) => column.name)
    .toSorted();
}

function sorted(columns: readonly string[]): readonly string[] {
  return columns.toSorted();
}

describe("recorded relation column constants", () => {
  it("RECORDED_NODE_COLUMNS matches the SQLite recorded_nodes DDL", () => {
    expect(sorted(RECORDED_NODE_COLUMNS)).toEqual(
      ddlColumnNames(sqliteRecordedNodes),
    );
  });

  it("RECORDED_NODE_COLUMNS matches the Postgres recorded_nodes DDL", () => {
    expect(sorted(RECORDED_NODE_COLUMNS)).toEqual(
      ddlColumnNames(pgRecordedNodes),
    );
  });

  it("RECORDED_EDGE_COLUMNS matches the SQLite recorded_edges DDL", () => {
    expect(sorted(RECORDED_EDGE_COLUMNS)).toEqual(
      ddlColumnNames(sqliteRecordedEdges),
    );
  });

  it("RECORDED_EDGE_COLUMNS matches the Postgres recorded_edges DDL", () => {
    expect(sorted(RECORDED_EDGE_COLUMNS)).toEqual(
      ddlColumnNames(pgRecordedEdges),
    );
  });
});
