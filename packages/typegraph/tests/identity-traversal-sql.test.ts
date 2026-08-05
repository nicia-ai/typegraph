/**
 * Structural guards on the SQL an identity-expanded traversal compiles to.
 *
 * The performance property #310 and #270 ask for is not "the traversal is fast"
 * but "the identity class relation is emitted once, from a position a planner
 * cannot re-evaluate per row, and the candidate edge is reached by an equality
 * the engine can drive an index from". Timings drift with machine and data; the
 * shape does not, so it is pinned here — and pinned for both dialects, because a
 * single compiler path is what keeps the two backends equivalent.
 *
 * Both read coordinates are covered. They differ only in where the class
 * relation's rows come from — the materialized closure now, a reconstruction
 * from the assertion ledger at a past instant — and that difference is asserted
 * explicitly, because everything downstream of it is deliberately identical.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import { type QueryAst } from "../src/query/ast";
import { createQueryBuilder } from "../src/query/builder";
import { compileQuery, type CompileQueryOptions } from "../src/query/compiler";
import { IDENTITY_CLASS_CTE_ALIAS } from "../src/query/compiler/identity-traversal";
import { buildKindRegistry } from "../src/registry";
import { toSqlString } from "./sql-test-utils";

const SqlPerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const SqlCompany = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const sqlLink = defineEdge("link", { schema: z.object({}) });

const SqlGraph = defineGraph({
  id: "identity_traversal_sql",
  nodes: { Company: { type: SqlCompany }, Person: { type: SqlPerson } },
  edges: {
    link: { type: sqlLink, from: [SqlPerson, SqlCompany], to: [SqlPerson] },
  },
  identity: { sameIdAcrossKinds: "fold" },
});

const DIALECTS = ["sqlite", "postgres"] as const;
const AS_OF = "2026-01-01T00:00:00.000Z";
const CLOSURE_TABLE = "typegraph_identity_closure";

function builder() {
  return createQueryBuilder<typeof SqlGraph>(
    SqlGraph.id,
    buildKindRegistry(SqlGraph),
  );
}

type TraversalShape = "chained" | "recursive" | "single";

/** Identity-expanded traversal steps each shape compiles. */
const EXPANDED_STEPS: Readonly<Record<TraversalShape, number>> = {
  chained: 2,
  recursive: 1,
  single: 1,
};

function compileIdentityTraversalSql(
  input: Readonly<{
    asOf?: string;
    dialect: (typeof DIALECTS)[number];
    shape: TraversalShape;
  }>,
): string {
  const identityOptions = {
    expand: "none",
    includeIdentityMembers: true,
  } as const;
  const base = builder().from("Person", "person");
  const query =
    input.shape === "single" ?
      base
        .traverse("link", "edge", identityOptions)
        .to("Person", "friend")
        .select((ctx) => ctx.friend.id)
    : input.shape === "chained" ?
      base
        .traverse("link", "first", identityOptions)
        .to("Person", "middle")
        .traverse("link", "second", identityOptions)
        .to("Person", "friend")
        .select((ctx) => ctx.friend.id)
    : base
        .traverse("link", "edge", identityOptions)
        .recursive({ maxHops: 3 })
        .to("Person", "friend")
        .select((ctx) => ctx.friend.id);
  const options: CompileQueryOptions = {
    dialect: input.dialect,
    identitySameIdAcrossKinds: "fold",
  };
  return toSqlString(
    compileQuery(atCoordinate(query.toAst(), input.asOf), SqlGraph.id, options),
    input.dialect,
  );
}

/** Repoints a compiled AST at a valid-time coordinate. */
function atCoordinate(ast: QueryAst, asOf: string | undefined): QueryAst {
  if (asOf === undefined) return ast;
  return { ...ast, temporalMode: { mode: "asOf", asOf } };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("identity traversal SQL shape", () => {
  for (const dialect of DIALECTS) {
    describe(`${dialect} dialect`, () => {
      for (const coordinate of ["current", "historical"] as const) {
        describe(`${coordinate} coordinate`, () => {
          const asOf = coordinate === "historical" ? AS_OF : undefined;

          for (const shape of ["single", "chained", "recursive"] as const) {
            it(`emits one materialized class relation for a ${shape} traversal`, () => {
              const sqlText = compileIdentityTraversalSql({
                ...(asOf === undefined ? {} : { asOf }),
                dialect,
                shape,
              });

              // Exactly one class relation, declared as a materialized CTE.
              expect(
                countOccurrences(
                  sqlText,
                  `"${IDENTITY_CLASS_CTE_ALIAS}"(seed_kind, seed_id, kind, id) AS MATERIALIZED (`,
                ),
              ).toBe(1);

              // Every step reads it through an outer join, not a correlated
              // subquery: a reference inside EXISTS is what an engine rebuilds
              // per candidate row.
              expect(
                countOccurrences(
                  sqlText,
                  `LEFT JOIN "${IDENTITY_CLASS_CTE_ALIAS}" "identity_peer"`,
                ),
              ).toBe(EXPANDED_STEPS[shape]);
              expect(sqlText).not.toMatch(/EXISTS \([^)]*identity_peer_class/);

              // ...and reaches the candidate edge by an equality on the class
              // member, which is what lets the engine seek the edge index.
              expect(
                countOccurrences(sqlText, `COALESCE("identity_peer".id,`),
              ).toBe(EXPANDED_STEPS[shape]);
            });
          }

          it("pins the frontier ahead of the edge table only where the dialect needs it", () => {
            const sqlText = compileIdentityTraversalSql({
              ...(asOf === undefined ? {} : { asOf }),
              dialect,
              shape: "single",
            });

            // SQLite reads FROM order as a join-order directive and would
            // otherwise drive the loop from the edge table, rescanning every
            // candidate edge per frontier row (#270). PostgreSQL costs the
            // orderings itself and rejects `CROSS JOIN ... ON`.
            const pinsJoinOrder = dialect === "sqlite";
            expect({
              cross: countOccurrences(
                sqlText,
                `CROSS JOIN "typegraph_edges" e`,
              ),
              plain: countOccurrences(sqlText, `JOIN "typegraph_edges" e ON`),
            }).toEqual({
              cross: pinsJoinOrder ? 1 : 0,
              plain: pinsJoinOrder ? 0 : 1,
            });
          });
        });
      }

      it("builds the current-coordinate relation from the materialized closure", () => {
        const sqlText = compileIdentityTraversalSql({
          dialect,
          shape: "single",
        });

        // Two closure references: a class label per seed, joined to that
        // class's members. No ledger reconstruction — the closure already
        // encodes the graph's sameIdAcrossKinds profile.
        expect(countOccurrences(sqlText, `"${CLOSURE_TABLE}"`)).toBe(2);
        expect(sqlText).not.toContain("WITH RECURSIVE");
        expect(sqlText).not.toContain("seeds(seed_kind, seed_id) AS (");
      });

      it("reconstructs the historical-coordinate relation from the ledger", () => {
        const sqlText = compileIdentityTraversalSql({
          asOf: AS_OF,
          dialect,
          shape: "single",
        });

        expect(countOccurrences(sqlText, "WITH RECURSIVE")).toBe(1);
        expect(
          countOccurrences(sqlText, "seeds(seed_kind, seed_id) AS ("),
        ).toBe(1);
        expect(sqlText).not.toContain(`"${CLOSURE_TABLE}"`);
      });

      it("emits no class relation when a query does not expand identity", () => {
        for (const asOf of [undefined, AS_OF]) {
          const sqlText = toSqlString(
            compileQuery(
              atCoordinate(
                builder()
                  .from("Person", "person")
                  .traverse("link", "edge", { expand: "none" })
                  .to("Person", "friend")
                  .select((ctx) => ctx.friend.id)
                  .toAst(),
                asOf,
              ),
              SqlGraph.id,
              { dialect, identitySameIdAcrossKinds: "fold" },
            ),
            dialect,
          );

          expect(sqlText).not.toContain(IDENTITY_CLASS_CTE_ALIAS);
          expect(sqlText).not.toContain(`"${CLOSURE_TABLE}"`);
          // A plain traversal joins on the frontier's own columns, so it keeps
          // the planner's freedom on every dialect.
          expect(sqlText).toContain(`JOIN "typegraph_edges" e ON`);
          // ...and its statement is otherwise byte-for-byte what it was before
          // identity expansion needed a second FROM ordering. The two orderings
          // repeat the target join instead of interpolating one shared fragment,
          // because a fragment's own leading and trailing newlines would leave
          // stray whitespace-only lines around it here. Nothing downstream would
          // fail on that, which is why the exact text is pinned rather than left
          // to review.
          expect(sqlText).toContain(
            '\n      JOIN "typegraph_nodes" n ON n.graph_id = e.graph_id' +
              "\n        AND n.id = e.to_id" +
              "\n        AND n.kind = e.to_kind" +
              "\n      WHERE ",
          );
        }
      });
    });
  }
});
