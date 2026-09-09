/**
 * The atomic claim statements drive from a `proposed` VALUES relation, not one
 * predicate arm per proposed row (#648).
 *
 * The defect these tests guard is a PLAN SHAPE, so they assert the shape
 * directly: the rendered statement's subquery count must not grow with the
 * chunk. Under the arm-per-row spelling each proposed row contributed its own
 * two `EXISTS` and one `NOT EXISTS`, so a 2000-row chunk — one the bind budget
 * permits — initialized ~6000 subplans, took minutes, grew past 2 GB, and ran
 * long stretches without reaching a cancellation check. Counting subqueries at
 * three chunk sizes is what fails if that spelling ever returns; asserting only
 * that the statements run would not.
 */
import { type SQL, sql as drizzleSql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import {
  ATOMIC_EDGE_CLAIM_PROPOSED_COLUMN_COUNT,
  buildAcquireAtomicEdgeClaims,
  buildAssertAtomicEdgeClaimsOwned,
  buildDeleteStaleAtomicEdgeClaims,
} from "../src/backend/drizzle/operations/edge-claims";
import type { Tables } from "../src/backend/drizzle/operations/shared";
import { tables as postgresTables } from "../src/backend/drizzle/schema/postgres";
import { tables as sqliteTables } from "../src/backend/drizzle/schema/sqlite";
import type { ClaimEdgeCardinalityParams } from "../src/backend/types";

const SCHEMA_FENCE = { graphId: "graph-1", expectedVersion: 1 } as const;
const LOCK_CLAUSE = drizzleSql`FOR SHARE`;
const TIMESTAMP = "2026-09-09T00:00:00.000Z";

/** The fence's two parameters plus the claim timestamp. */
const FIXED_PARAM_COUNT = 3;

/** The DELETE carries no timestamp — it only releases. */
const DELETE_FIXED_PARAM_COUNT = 2;

function claim(
  index: number,
  cardinality: ClaimEdgeCardinalityParams["cardinality"],
): ClaimEdgeCardinalityParams {
  return {
    graphId: "graph-1",
    cardinality,
    edgeKind: "worksAt",
    edgeId: `edge-${index}`,
    fromKind: "Person",
    fromId: `person-${index}`,
    toKind: "Company",
    toId: `company-${index}`,
  };
}

function claims(
  count: number,
  cardinality: ClaimEdgeCardinalityParams["cardinality"],
): readonly ClaimEdgeCardinalityParams[] {
  return Array.from({ length: count }, (_unused, index) =>
    claim(index, cardinality),
  );
}

const DIALECTS = [
  ["PostgreSQL", postgresTables, new PgDialect()],
  ["SQLite", sqliteTables, new SQLiteSyncDialect()],
] as const;

function render(
  dialect: PgDialect | SQLiteSyncDialect,
  statement: SQL,
): Readonly<{ sql: string; params: readonly unknown[] }> {
  const compiled = dialect.sqlToQuery(statement);
  return { sql: compiled.sql, params: compiled.params };
}

function subqueryCount(statementSql: string): number {
  return statementSql.match(/EXISTS\s*\(/g)?.length ?? 0;
}

type ClaimStatementBuilder = (
  tables: Tables,
  entries: readonly ClaimEdgeCardinalityParams[],
) => readonly SQL[];

const BUILDERS: readonly (readonly [string, ClaimStatementBuilder, number])[] =
  [
    [
      "buildDeleteStaleAtomicEdgeClaims",
      (tables, entries) =>
        buildDeleteStaleAtomicEdgeClaims(
          tables,
          entries,
          SCHEMA_FENCE,
          LOCK_CLAUSE,
        ),
      DELETE_FIXED_PARAM_COUNT,
    ],
    [
      "buildAcquireAtomicEdgeClaims",
      (tables, entries) =>
        buildAcquireAtomicEdgeClaims(
          tables,
          entries,
          TIMESTAMP,
          SCHEMA_FENCE,
          LOCK_CLAUSE,
        ),
      FIXED_PARAM_COUNT,
    ],
    [
      "buildAssertAtomicEdgeClaimsOwned",
      (tables, entries) =>
        buildAssertAtomicEdgeClaimsOwned(
          tables,
          entries,
          TIMESTAMP,
          SCHEMA_FENCE,
          LOCK_CLAUSE,
        ),
      FIXED_PARAM_COUNT,
    ],
  ];

describe.each(DIALECTS)(
  "atomic edge claim statements on %s",
  (_dialectName, tables, dialect) => {
    describe.each(BUILDERS)("%s", (_builderName, build, fixedParamCount) => {
      it("renders one statement whose subquery count does not grow with the chunk", () => {
        const renderings = [1, 2, 50].map((size) => {
          const statements = build(tables, claims(size, "one"));
          expect(statements).toHaveLength(1);
          const [statement] = statements;
          if (statement === undefined) throw new Error("no statement");
          return { size, ...render(dialect, statement) };
        });

        const [first] = renderings;
        if (first === undefined) throw new Error("no rendering");
        const baseline = subqueryCount(first.sql);
        expect(baseline).toBeGreaterThan(0);
        for (const rendering of renderings) {
          expect({
            size: rendering.size,
            subqueries: subqueryCount(rendering.sql),
          }).toEqual({ size: rendering.size, subqueries: baseline });
        }
      });

      it("binds exactly one proposed row's columns per entry", () => {
        for (const size of [1, 2, 50]) {
          const statements = build(tables, claims(size, "one"));
          const [statement] = statements;
          if (statement === undefined) throw new Error("no statement");
          expect(render(dialect, statement).params).toHaveLength(
            fixedParamCount + size * ATOMIC_EDGE_CLAIM_PROPOSED_COLUMN_COUNT,
          );
        }
      });

      it("renders one statement per cardinality group, keyed by its own spec", () => {
        const statements = build(tables, [
          claim(0, "one"),
          claim(1, "unique"),
          claim(2, "one"),
          claim(3, "oneActive"),
        ]);
        expect(statements).toHaveLength(3);

        const rendered = statements.map((statement) =>
          render(dialect, statement),
        );
        const [oneGroup, uniqueGroup, oneActiveGroup] = rendered;
        if (
          oneGroup === undefined ||
          uniqueGroup === undefined ||
          oneActiveGroup === undefined
        ) {
          throw new Error("missing group");
        }

        // First-appearance order, and every entry lands in exactly one group.
        expect(oneGroup.params).toContain("one:worksAt");
        expect(oneGroup.params).toContain("edge-0");
        expect(oneGroup.params).toContain("edge-2");
        expect(uniqueGroup.params).toContain("unique:worksAt");
        expect(oneActiveGroup.params).toContain("oneActive:worksAt");
      });
    });

    /**
     * WHY the groups are split rather than folded into guard columns: each
     * spec asks for a different set of terms against the edges relation, and a
     * term that rides in the relation as `(NOT p.guard OR e.col = p.col)` is a
     * term the planner can no longer seek on — the exact cost this rewrite
     * removes. Only the two statements that read the edges relation carry
     * these; the ownership assertion reads only the claims relation.
     */
    describe.each([
      [
        "buildDeleteStaleAtomicEdgeClaims",
        (entries: readonly ClaimEdgeCardinalityParams[]) =>
          buildDeleteStaleAtomicEdgeClaims(
            tables,
            entries,
            SCHEMA_FENCE,
            LOCK_CLAUSE,
          ),
      ],
      [
        "buildAcquireAtomicEdgeClaims",
        (entries: readonly ClaimEdgeCardinalityParams[]) =>
          buildAcquireAtomicEdgeClaims(
            tables,
            entries,
            TIMESTAMP,
            SCHEMA_FENCE,
            LOCK_CLAUSE,
          ),
      ],
    ] as const)("%s spells each group's own spec", (_name, build) => {
      it.each([
        ["one", false, false],
        ["unique", true, false],
        ["oneActive", false, true],
      ] as const)(
        "%s keys on the target endpoint: %s, requires an active holder: %s",
        (cardinality, keyedOnTarget, activeOnly) => {
          const [statement] = build(claims(2, cardinality));
          if (statement === undefined) throw new Error("no statement");
          const { sql: statementSql } = render(dialect, statement);
          expect({
            keyedOnTarget: statementSql.includes(
              '"to_kind" = "proposed"."to_kind"',
            ),
            activeOnly: statementSql.includes('"valid_to" IS NULL'),
          }).toEqual({ keyedOnTarget, activeOnly });
        },
      );
    });
  },
);
