import { describe, expect, it } from "vitest";

import {
  generatePostgresDDL,
  generatePostgresDropSQL,
} from "../src/backend/drizzle/ddl";
import { createPostgresTables } from "../src/backend/postgres";

function createdTableNames(statements: readonly string[]): string[] {
  return statements.flatMap((statement) => {
    const match = /^CREATE TABLE IF NOT EXISTS ("(?:[^"]|"")+")/u.exec(
      statement,
    );
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

describe("generatePostgresDropSQL", () => {
  it("drops every installed base and fulltext table exactly once", () => {
    const tables = createPostgresTables({
      nodes: 'copy_"nodes',
      edges: "copy_edges",
      fulltext: "copy_fulltext",
    });
    const created = createdTableNames(generatePostgresDDL(tables));
    expect(created.length).toBeGreaterThan(2);
    expect(new Set(created).size).toBe(created.length);
    expect(generatePostgresDropSQL(tables)).toBe(
      `DROP TABLE IF EXISTS ${created.toReversed().join(", ")};`,
    );
  });

  it("omits the fulltext table when that strategy is disabled", () => {
    const tables = createPostgresTables({ fulltext: "copy_fulltext" });
    const created = createdTableNames(generatePostgresDDL(tables, false));
    expect(created).not.toContain('"copy_fulltext"');
    expect(generatePostgresDropSQL(tables, false)).toBe(
      `DROP TABLE IF EXISTS ${created.toReversed().join(", ")};`,
    );
  });
});
