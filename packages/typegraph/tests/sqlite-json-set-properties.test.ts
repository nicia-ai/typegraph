import { describe, expect, it } from "vitest";

import { sqliteDialect } from "../src/query/dialect/sqlite";
import { renderSql, sql } from "../src/query/sql-fragment";

describe("SQLite JSON property replacement", () => {
  it("quotes numeric names as object properties", () => {
    const compiled = renderSql(
      sqliteDialect.jsonSetProperties(sql.identifier("props"), {
        "0": "zero",
        "01": "zero-one",
      }),
      "sqlite",
    );

    expect(compiled.sql).toContain(`'$."0"'`);
    expect(compiled.sql).toContain(`'$."01"'`);
    expect(compiled.sql).not.toContain("$[0]");
  });

  it("bounds each json_set call below SQLite's legacy argument limit", () => {
    const patch = Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [`field${index}`, index]),
    );
    const compiled = renderSql(
      sqliteDialect.jsonSetProperties(sql.identifier("props"), patch),
      "sqlite",
    );

    expect(compiled.sql.match(/json_set\(/g)).toHaveLength(2);
    expect(compiled.params).toHaveLength(70);
  });
});
