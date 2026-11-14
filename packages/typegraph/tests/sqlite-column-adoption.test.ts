import { describe, expect, it } from "vitest";

import {
  adoptSqliteColumns,
  adoptSqliteColumnsSync,
  type SqliteColumnAdoptionPlan,
} from "../src/backend/drizzle/sqlite-column-adoption";

function duplicateColumn(column: string): Error {
  return Object.assign(new Error(`duplicate column name: ${column}`), {
    code: "SQLITE_ERROR",
  });
}

describe.each(["sync", "async"] as const)(
  "SQLite additive adoption (%s)",
  (mode) => {
    it("re-inventories after each column race and ignores non-string column names", async () => {
      const columns = new Set<string>(["id"]);
      let inventories = 0;
      const plan: SqliteColumnAdoptionPlan = {
        addedColumns: ["a", "b"],
        statements: (present) =>
          ["a", "b"].filter((column) => !present.has(column)),
      };
      const readColumns = () => {
        inventories += 1;
        return [...[...columns].map((name) => ({ name })), { name: 42 }];
      };
      const execute = (column: string) => {
        columns.add(column);
        throw duplicateColumn(column);
      };
      if (mode === "sync") {
        adoptSqliteColumnsSync(plan, { readColumns, execute });
      } else {
        await adoptSqliteColumns(plan, {
          readColumns: () => Promise.resolve(readColumns()),
          execute: (column) => {
            execute(column);
            return Promise.resolve();
          },
        });
      }
      expect(inventories).toBe(3);
      expect([...columns]).toEqual(["id", "a", "b"]);
    });

    it("bounds a non-progressing race by the declared additive columns", async () => {
      let inventories = 0;
      const failure = duplicateColumn("a");
      const plan: SqliteColumnAdoptionPlan = {
        addedColumns: ["a"],
        statements: () => ["a"],
      };
      const readColumns = () => {
        inventories += 1;
        return [{ name: "id" }];
      };
      const execute = () => {
        throw failure;
      };
      const run = async () => {
        if (mode === "sync") {
          adoptSqliteColumnsSync(plan, { readColumns, execute });
          return;
        }
        await adoptSqliteColumns(plan, {
          readColumns: () => Promise.resolve(readColumns()),
          execute: () => Promise.reject(failure),
        });
      };
      await expect(run()).rejects.toBe(failure);
      expect(inventories).toBe(2);
    });
  },
);
