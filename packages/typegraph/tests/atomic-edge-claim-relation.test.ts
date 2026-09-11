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
import type {
  ClaimEdgeCardinalityParams,
  CompositionClaimScope,
} from "../src/backend/types";

const SCHEMA_FENCE = { graphId: "graph-1", expectedVersion: 1 } as const;
const LOCK_CLAUSE = drizzleSql`FOR SHARE`;
const TIMESTAMP = "2026-09-09T00:00:00.000Z";

/** The fence's two parameters plus the claim timestamp. */
const FIXED_PARAM_COUNT = 3;

/** The DELETE carries no timestamp — it only releases. */
const DELETE_FIXED_PARAM_COUNT = 2;

type SourceCardinality = Extract<
  ClaimEdgeCardinalityParams,
  Readonly<{ direction: "source" }>
>["cardinality"];

function claim(
  index: number,
  cardinality: SourceCardinality,
  scope?: CompositionClaimScope,
): ClaimEdgeCardinalityParams {
  return {
    graphId: "graph-1",
    direction: "source",
    cardinality,
    edgeKind: "worksAt",
    edgeId: `edge-${index}`,
    fromKind: "Person",
    fromId: `person-${index}`,
    toKind: "Company",
    toId: `company-${index}`,
    ...(scope === undefined ? {} : { scope }),
  };
}

/** The same claim on the TARGET population: a different predicate shape. */
function targetClaim(index: number): ClaimEdgeCardinalityParams {
  return { ...claim(index, "one"), direction: "target", cardinality: "one" };
}

/**
 * A composition claim's scope: the oriented realizing edge kinds whose live
 * rows can hold the relation-wide axis.
 */
const COMPOSITION_SCOPE: CompositionClaimScope = {
  kind: "composition",
  holders: [
    { edgeKind: "worksAt", partSide: "from" },
    { edgeKind: "includedIn", partSide: "to" },
  ],
};

function claims(
  count: number,
  cardinality: SourceCardinality,
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

      it("renders one statement per predicate shape, keyed by its own spec", () => {
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

      /**
       * The spec is read off the axis NAME, so the same cardinality on the two
       * populations asks for different endpoint terms. Grouping on the bare
       * cardinality would put both in one statement and fence the target
       * population on the source endpoint.
       */
      it("splits the same cardinality on the two populations", () => {
        const statements = build(tables, [claim(0, "one"), targetClaim(1)]);
        expect(statements).toHaveLength(2);
      });

      /**
       * A composition claim's holders are predicate shape, not values, so a
       * composition-scoped row cannot share a statement with an ordinary one —
       * and two rows carrying the same scope must still share ONE.
       */
      it("splits a composition scope from the ordinary shape and folds its peers", () => {
        const statements = build(tables, [
          claim(0, "one"),
          claim(1, "one", COMPOSITION_SCOPE),
          claim(2, "one", COMPOSITION_SCOPE),
        ]);
        expect(statements).toHaveLength(2);

        const [ordinary, composition] = statements.map((statement) =>
          render(dialect, statement),
        );
        if (ordinary === undefined || composition === undefined) {
          throw new Error("missing group");
        }
        expect(ordinary.params).toContain("edge-0");
        expect(composition.params).toContain("edge-1");
        expect(composition.params).toContain("edge-2");
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

      /**
       * A composition group's holder predicate is the oriented two-arm OR, the
       * one `claimHolderTerms` renders for every layer, and it is rendered ONCE
       * for the group rather than per row — the whole point of carrying the
       * scope in the group key instead of in a guard column.
       */
      it("renders the composition scope's oriented arms once per group", () => {
        const [statement] = build([
          claim(0, "one", COMPOSITION_SCOPE),
          claim(1, "one", COMPOSITION_SCOPE),
        ]);
        if (statement === undefined) throw new Error("no statement");
        const { sql: statementSql, params } = render(dialect, statement);
        expect({
          fromArm: statementSql.includes(
            '"from_kind" = "proposed"."from_kind"',
          ),
          toArm: statementSql.includes('"to_kind" = "proposed"."from_kind"'),
          armPairs: statementSql.match(/"kind" IN \(/g)?.length ?? 0,
          holderKinds: params.filter((parameter) => parameter === "includedIn")
            .length,
        }).toEqual({
          fromArm: true,
          toArm: true,
          armPairs: 2,
          holderKinds: 1,
        });
      });
    });
  },
);
