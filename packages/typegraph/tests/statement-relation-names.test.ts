import { describe, expect, it } from "vitest";

import { statementRelationNames } from "../src/backend/drizzle/operations/statement-relation-names";
import { createPostgresTables } from "../src/backend/drizzle/schema/postgres";
import { createSqliteTables } from "../src/backend/drizzle/schema/sqlite";

const PREFERRED = ["tg_keys", "tg_selected", "tg_candidates"] as const;

describe("statementRelationNames", () => {
  it("keeps every preferred name under the default table names", () => {
    expect(statementRelationNames(createSqliteTables(), PREFERRED)).toEqual({
      tg_keys: "tg_keys",
      tg_selected: "tg_selected",
      tg_candidates: "tg_candidates",
    });
  });

  it.each([
    ["nodes", { nodes: "tg_keys" }],
    ["edges", { edges: "tg_keys" }],
    ["uniques", { uniques: "tg_keys" }],
    ["fulltext", { fulltext: "tg_keys" }],
  ] as const)(
    "moves a name off a clashing %s table on both dialects",
    (_relation, names) => {
      for (const tables of [
        createSqliteTables(names),
        createPostgresTables(names),
      ]) {
        expect(statementRelationNames(tables, PREFERRED).tg_keys).toBe(
          "tg_keys_1",
        );
      }
    },
  );

  it("folds identifier case, as SQLite resolves quoted names", () => {
    expect(
      statementRelationNames(createSqliteTables({ nodes: "TG_KEYS" }), [
        "tg_keys",
      ]),
    ).toEqual({ tg_keys: "tg_keys_1" });
  });

  it("skips alternatives that are themselves configured or already chosen", () => {
    const tables = createSqliteTables({
      nodes: "tg_keys",
      edges: "tg_keys_1",
    });

    // `tg_keys_1` is a table, so `tg_keys` takes `tg_keys_2`; the preferred
    // `tg_keys_2` then has to move off that choice.
    expect(statementRelationNames(tables, ["tg_keys", "tg_keys_2"])).toEqual({
      tg_keys: "tg_keys_2",
      tg_keys_2: "tg_keys_2_1",
    });
  });
});
