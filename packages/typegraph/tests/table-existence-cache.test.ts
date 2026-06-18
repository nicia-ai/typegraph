import { describe, expect, it } from "vitest";

import { createCachedTableExistence } from "../src/backend/drizzle/operations/strategy";

describe("createCachedTableExistence", () => {
  it("caches positive results by default and re-probes missing tables", async () => {
    const present = new Set(["ready"]);
    const calls: string[] = [];
    const exists = createCachedTableExistence((tableName) => {
      calls.push(tableName);
      return Promise.resolve(
        present.has(tableName) ? { table_name: tableName } : undefined,
      );
    });

    await expect(exists("ready")).resolves.toBe(true);
    await expect(exists("ready")).resolves.toBe(true);
    expect(calls).toEqual(["ready"]);

    await expect(exists("late")).resolves.toBe(false);
    present.add("late");
    await expect(exists("late")).resolves.toBe(true);
    expect(calls).toEqual(["ready", "late", "late"]);
  });

  it("can disable positive caching for search-path-sensitive probes", async () => {
    let visible = true;
    const calls: string[] = [];
    const exists = createCachedTableExistence(
      (tableName) => {
        calls.push(tableName);
        return Promise.resolve(visible ? { table_name: tableName } : undefined);
      },
      { cacheExisting: false },
    );

    await expect(exists("typegraph_recorded_nodes")).resolves.toBe(true);
    visible = false;
    await expect(exists("typegraph_recorded_nodes")).resolves.toBe(false);
    expect(calls).toEqual([
      "typegraph_recorded_nodes",
      "typegraph_recorded_nodes",
    ]);
  });
});
