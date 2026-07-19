import { describe, expect, it } from "vitest";

import {
  isSqlFragment,
  isSqlPlaceholder,
  Placeholder,
  renderPostgres,
  renderSqlInline,
  renderSqlite,
  sql,
} from "../src/query/sql-fragment";
import {
  annIndexScanTypes,
  markAnnIndexScan,
  markForceCustomPlan,
  shouldForceCustomPlan,
} from "../src/query/sql-intent";
import { toSqlString } from "./sql-test-utils";

describe("SQL fragments", () => {
  it("renders nested SQLite fragments with escaped identifiers", () => {
    const fields = sql.join(
      [sql.identifier('person"name'), sql.identifier("age")],
      sql`, `,
    );
    const query = sql`SELECT ${fields} FROM ${sql.identifier(
      "people",
    )} WHERE ${sql.identifier("age")} > ${21}`;

    expect(renderSqlite(query)).toEqual({
      sql: 'SELECT "person""name", "age" FROM "people" WHERE "age" > ?',
      params: [21],
    });
  });

  it("numbers PostgreSQL parameters across nesting and append", () => {
    const predicate = sql`${sql.identifier("name")} = ${"Ada"}`;
    const base = sql`SELECT * FROM ${sql.identifier("people")}`;
    const query = base.append(sql` WHERE ${predicate} AND active = ${true}`);

    expect(renderPostgres(query)).toEqual({
      sql: 'SELECT * FROM "people" WHERE "name" = $1 AND active = $2',
      params: ["Ada", true],
    });
    expect(renderPostgres(base)).toEqual({
      sql: 'SELECT * FROM "people"',
      params: [],
    });
  });

  it("preserves or resolves named placeholders", () => {
    const query = sql`SELECT ${sql.placeholder("value")}, ${sql.placeholder(
      "value",
    )}`;
    const template = renderPostgres(query);

    expect(template.sql).toBe("SELECT $1, $2");
    expect(template.params).toHaveLength(2);
    expect(template.params[0]).toBeInstanceOf(Placeholder);
    expect(template.params[1]).toBeInstanceOf(Placeholder);
    expect(renderPostgres(query, { value: "resolved" })).toEqual({
      sql: "SELECT $1, $2",
      params: ["resolved", "resolved"],
    });
    expect(renderPostgres(query, { value: undefined })).toEqual({
      sql: "SELECT $1, $2",
      params: [undefined, undefined],
    });
    expect(() => renderPostgres(query, {})).toThrow(
      'Missing binding for parameter "value"',
    );
  });

  it("maps eagerly resolved placeholder values through the dialect profile", () => {
    const query = sql`SELECT ${sql.placeholder("active")}, ${sql.placeholder(
      "createdAt",
    )}`;

    expect(
      renderSqlite(query, {
        active: true,
        createdAt: new Date("2025-01-02T03:04:05.000Z"),
      }),
    ).toEqual({
      sql: "SELECT ?, ?",
      params: [1, "2025-01-02T03:04:05.000Z"],
    });
  });

  it("maps direct parameter values through the dialect profile", () => {
    const createdAt = new Date("2025-01-02T03:04:05.000Z");
    const query = sql`SELECT ${true}, ${createdAt}`;

    expect(renderSqlite(query)).toEqual({
      sql: "SELECT ?, ?",
      params: [1, "2025-01-02T03:04:05.000Z"],
    });
    expect(renderPostgres(query)).toEqual({
      sql: "SELECT $1, $2",
      params: [true, "2025-01-02T03:04:05.000Z"],
    });
  });

  it("recognizes globally branded fragments from another module instance", () => {
    const source = sql`SELECT ${1}`;
    const foreignFragment = {
      [Symbol.for("@nicia-ai/typegraph/sql-fragment")]: true,
      append(fragment: typeof source) {
        return fragment;
      },
      chunks: source.chunks,
    };

    expect(isSqlFragment(foreignFragment)).toBe(true);
    expect(
      renderPostgres(sql`WITH foreign AS (${foreignFragment}) SELECT 1`),
    ).toEqual({
      sql: "WITH foreign AS (SELECT $1) SELECT 1",
      params: [1],
    });
    expect(
      isSqlFragment({
        [Symbol.for("@nicia-ai/typegraph/sql-fragment")]: true,
        chunks: [],
      }),
    ).toBe(false);
    expect(
      isSqlFragment({
        [Symbol.for("@nicia-ai/typegraph/sql-fragment")]: false,
        append: () => source,
        chunks: [],
      }),
    ).toBe(false);
    expect(isSqlFragment({ chunks: source.chunks })).toBe(false);
  });

  it("interpolates public Placeholder instances as named placeholders", () => {
    const placeholder = new Placeholder("direct");
    const query = sql`SELECT ${placeholder}`;

    expect(isSqlPlaceholder(placeholder)).toBe(true);
    expect(renderPostgres(query)).toEqual({
      sql: "SELECT $1",
      params: [placeholder],
    });
  });

  it("preserves execution intent through immutable composition", () => {
    const customPlan = sql`SELECT 1`;
    const ann = sql`SELECT 2`;
    markForceCustomPlan(customPlan);
    markAnnIndexScan(ann, ["hnsw"]);

    const appended = customPlan.append(ann);
    const nested = sql`(${customPlan}) UNION (${ann})`;
    const joined = sql.join([customPlan, ann], sql` UNION `);

    for (const fragment of [appended, nested, joined]) {
      expect(shouldForceCustomPlan(fragment)).toBe(true);
      expect(annIndexScanTypes(fragment)).toEqual(["hnsw"]);
    }
  });

  it("renders safe inline DDL literals and rejects unsupported values", () => {
    const instant = new Date("2025-01-02T03:04:05.000Z");
    // SQL NULL is a supported inline literal even though application data uses
    // `undefined` by convention.
    // eslint-disable-next-line unicorn/no-null
    const sqlNull: unknown = null;
    const fragment = sql`${undefined}, ${sqlNull}, ${"O'Reilly"}, ${12}, ${13n}, ${true}, ${instant}`;

    expect(renderSqlInline(fragment, "sqlite")).toBe(
      "NULL, NULL, 'O''Reilly', 12, 13, 1, '2025-01-02T03:04:05.000Z'",
    );
    expect(renderSqlInline(sql`${false}`, "postgres")).toBe("FALSE");
    expect(
      renderSqlInline(sql`${String.raw`C:\temp\O'Reilly`}`, "postgres"),
    ).toBe(String.raw`E'C:\\temp\\O''Reilly'`);
    expect(() => renderSqlInline(sql`${Number.NaN}`, "sqlite")).toThrow(
      "Cannot inline a non-finite SQL number",
    );
    expect(() =>
      renderSqlInline(sql`${Number.POSITIVE_INFINITY}`, "postgres"),
    ).toThrow("Cannot inline a non-finite SQL number");
    expect(() => renderSqlInline(sql`${{ nested: true }}`, "sqlite")).toThrow(
      "Cannot inline this SQL parameter value",
    );
    expect(() =>
      renderSqlInline(sql`${sql.placeholder("late")}`, "sqlite"),
    ).toThrow('Cannot inline unresolved SQL placeholder "late"');
  });

  it("keeps binary and array parameters as single bound values", () => {
    const binary = new Uint8Array([1, 2, 3]);
    const array = ["a", "b"];

    expect(renderPostgres(sql`SELECT ${binary}, ${array}`)).toEqual({
      sql: "SELECT $1, $2",
      params: [binary, array],
    });
  });

  it("lets SQL assertion helpers select the PostgreSQL inline profile", () => {
    expect(toSqlString(sql`${true}`, "postgres")).toBe("TRUE");
    expect(toSqlString(sql`${true}`, "sqlite")).toBe("1");
  });

  it("provides immutable empty and raw fragments", () => {
    const empty = sql.empty();
    const raw = sql.raw("CURRENT_TIMESTAMP");

    expect(isSqlFragment(empty)).toBe(true);
    expect(isSqlFragment(raw)).toBe(true);
    expect(renderSqlite(sql`SELECT ${raw}${empty}`)).toEqual({
      sql: "SELECT CURRENT_TIMESTAMP",
      params: [],
    });
  });
});
