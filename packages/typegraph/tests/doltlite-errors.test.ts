import { describe, expect, it } from "vitest";

import {
  isDuplicatePrimaryKeyError,
  isDuplicateUniqueIndexError,
  isSqliteStaleSnapshotError,
  isSqliteWriterSlotBusy,
} from "../src/utils/sql-errors";

function nativeError(errcode: number, message = "database is locked"): Error {
  return Object.assign(new Error(message), {
    code: "ERR_SQLITE_ERROR",
    errcode,
  });
}

describe("native node:sqlite-shaped errors", () => {
  it("distinguishes contention, stale snapshots, and unrelated failures through causes", () => {
    expect(isSqliteWriterSlotBusy(nativeError(5))).toBe(true);
    expect(isSqliteWriterSlotBusy(nativeError(6))).toBe(true);
    expect(isSqliteWriterSlotBusy(nativeError(261))).toBe(true);
    expect(isSqliteWriterSlotBusy(nativeError(773))).toBe(true);
    expect(isSqliteWriterSlotBusy(nativeError(262))).toBe(true);
    expect(isSqliteWriterSlotBusy(nativeError(-251))).toBe(false);
    expect(isSqliteWriterSlotBusy(nativeError(2067))).toBe(false);
    const stale = new Error("query failed", { cause: nativeError(517) });
    expect(isSqliteStaleSnapshotError(stale)).toBe(true);
    expect(isSqliteWriterSlotBusy(stale)).toBe(false);
    const both = Object.assign(nativeError(517), { rawCode: 5 });
    expect(isSqliteWriterSlotBusy(both)).toBe(false);
    expect(isSqliteStaleSnapshotError(new Error("database is locked"))).toBe(
      false,
    );
  });

  it("classifies primary keys separately from unique indexes", () => {
    const relation = {
      table: "items",
      constraintNames: [],
      sqliteColumns: ["id"],
    };
    expect(isDuplicatePrimaryKeyError(nativeError(1555), relation)).toBe(true);
    expect(isDuplicatePrimaryKeyError(nativeError(2067), relation)).toBe(false);
  });

  it("requires both a unique error code and the exact violated columns", () => {
    const relation = {
      table: "items",
      indexName: "items_name",
      sqliteColumns: ["name"],
    };
    expect(
      isDuplicateUniqueIndexError(
        nativeError(2067, "UNIQUE constraint failed: items.name"),
        relation,
      ),
    ).toBe(true);
    expect(
      isDuplicateUniqueIndexError(
        nativeError(2067, "UNIQUE constraint failed: other.name"),
        relation,
      ),
    ).toBe(false);
    expect(
      isDuplicateUniqueIndexError(
        new Error("UNIQUE constraint failed: items.name"),
        relation,
      ),
    ).toBe(false);
  });
});
