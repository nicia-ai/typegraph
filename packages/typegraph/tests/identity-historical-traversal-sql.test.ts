/**
 * Structural guards on the SQL an identity-expanded traversal compiles to.
 *
 * The performance property #310 asks for is not "the reconstruction is fast" but
 * "the reconstruction is emitted once, from a position a planner cannot
 * re-evaluate per row". Timings drift with machine and data; the shape does not,
 * so it is pinned here — and pinned for both dialects, because a single compiler
 * path is what keeps the two backends equivalent.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import { type QueryAst } from "../src/query/ast";
import { createQueryBuilder } from "../src/query/builder";
import { compileQuery, type CompileQueryOptions } from "../src/query/compiler";
import { HISTORICAL_IDENTITY_CLASS_CTE_ALIAS } from "../src/query/compiler/identity-traversal";
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

function builder() {
  return createQueryBuilder<typeof SqlGraph>(
    SqlGraph.id,
    buildKindRegistry(SqlGraph),
  );
}

type TraversalShape = "chained" | "recursive" | "single";

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

describe("historical identity traversal SQL shape", () => {
  for (const dialect of DIALECTS) {
    describe(`${dialect} dialect`, () => {
      for (const shape of ["single", "chained", "recursive"] as const) {
        it(`emits one materialized class relation for a ${shape} historical traversal`, () => {
          const sqlText = compileIdentityTraversalSql({
            asOf: AS_OF,
            dialect,
            shape,
          });

          // Exactly one reconstruction, declared as a materialized CTE.
          expect(countOccurrences(sqlText, "WITH RECURSIVE")).toBe(
            shape === "recursive" ? 2 : 1,
          );
          expect(sqlText).toContain(
            `"${HISTORICAL_IDENTITY_CLASS_CTE_ALIAS}"(seed_kind, seed_id, kind, id) AS MATERIALIZED (`,
          );
          expect(
            countOccurrences(sqlText, "seeds(seed_kind, seed_id) AS ("),
          ).toBe(1);

          // The step reads it through an outer join, not a correlated subquery:
          // a reference inside EXISTS is what SQLite rebuilds per candidate row.
          const references = countOccurrences(
            sqlText,
            `LEFT JOIN "${HISTORICAL_IDENTITY_CLASS_CTE_ALIAS}" "identity_peer"`,
          );
          expect(references).toBe(shape === "chained" ? 2 : 1);
          expect(sqlText).not.toMatch(/EXISTS \([^)]*identity_peer_class/);
        });
      }

      it("leaves a current-coordinate traversal on the closure path", () => {
        const sqlText = compileIdentityTraversalSql({
          dialect,
          shape: "single",
        });

        expect(sqlText).not.toContain(HISTORICAL_IDENTITY_CLASS_CTE_ALIAS);
        expect(sqlText).not.toContain("WITH RECURSIVE");
        expect(sqlText).toContain("typegraph_identity_closure");
      });

      it("emits no class relation when a historical query does not expand identity", () => {
        const sqlText = toSqlString(
          compileQuery(
            atCoordinate(
              builder()
                .from("Person", "person")
                .traverse("link", "edge", { expand: "none" })
                .to("Person", "friend")
                .select((ctx) => ctx.friend.id)
                .toAst(),
              AS_OF,
            ),
            SqlGraph.id,
            { dialect, identitySameIdAcrossKinds: "fold" },
          ),
          dialect,
        );

        expect(sqlText).not.toContain(HISTORICAL_IDENTITY_CLASS_CTE_ALIAS);
      });
    });
  }
});
