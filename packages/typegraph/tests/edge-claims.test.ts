/**
 * Unit pins for the edge cardinality decision layer (issue #610).
 *
 * `edgeCardinalityAxisReferences` is THE fold every layer that decides "is
 * this write constrained, and by what" shares; `edgeCardinalityAxis` is THE
 * axis string every claim row and every fence statement reads. A change to
 * either that this file does not catch is a change no other layer can catch
 * either, since they all read through these two functions.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import {
  type ClaimTarget,
  compareClaimTargets,
  edgeCardinalityAxis,
} from "../src/store/claims/axis";
import {
  activeOnlyAxisReferences,
  type EdgeCardinalityAxisRef,
  edgeCardinalityAxisReferences,
  edgeCardinalityClaims,
  edgeCardinalityClaimTarget,
} from "../src/store/claims/edge-claims";
import { createTestBackend } from "./test-utils";

async function claimRowCount(
  backend: ReturnType<typeof createTestBackend>,
  edgeId: string,
): Promise<number> {
  const schema = createSqlSchema(backend.tableNames);
  const rows = await backend.execute<{ count: number }>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) as count
      FROM ${sql.identifier(schema.tables.edgeClaims)}
      WHERE edge_id = ${edgeId}
    `),
  );
  return rows[0]?.count ?? 0;
}

describe("edgeCardinalityAxisReferences", () => {
  it("returns [] when both options are many or absent", () => {
    expect(edgeCardinalityAxisReferences({})).toEqual([]);
    expect(
      edgeCardinalityAxisReferences({
        cardinality: "many",
        targetCardinality: "many",
      }),
    ).toEqual([]);
  });

  it("declares source before target when both are constrained", () => {
    expect(
      edgeCardinalityAxisReferences({
        cardinality: "one",
        targetCardinality: "oneActive",
      }),
    ).toEqual([
      { direction: "source", cardinality: "one" },
      { direction: "target", cardinality: "oneActive" },
    ]);
  });

  // All twelve `cardinality` x `targetCardinality` combinations from the
  // plan's composition matrix (§1.2).
  const sourceValues = ["many", "one", "unique", "oneActive"] as const;
  const targetValues = ["many", "one", "oneActive"] as const;
  for (const cardinality of sourceValues) {
    for (const targetCardinality of targetValues) {
      it(`accepts cardinality=${cardinality}, targetCardinality=${targetCardinality}`, () => {
        const references = edgeCardinalityAxisReferences({
          cardinality,
          targetCardinality,
        });
        const expected: EdgeCardinalityAxisRef[] = [];
        if (cardinality !== "many") {
          expected.push({ direction: "source", cardinality });
        }
        if (targetCardinality !== "many") {
          expected.push({
            direction: "target",
            cardinality: targetCardinality,
          });
        }
        expect(references).toEqual(expected);
      });
    }
  }
});

describe("activeOnlyAxisReferences", () => {
  // The single owner of "does this declaration carry an active-only axis?"
  // (review finding D1-R2-01): the update path's reentry probe/claim split
  // and the write-fence eligibility gate both fold through this function
  // instead of re-spelling `claimsWhenBornEnded === false` inline. `oneActive`
  // is the only cardinality (on either side) with `claimsWhenBornEnded:
  // false`, so the expected set below is independent of the spec table's own
  // internals — it would fail exactly the same way whether the bug lived in
  // this function or in either of its two call sites.
  const sourceValues = ["many", "one", "unique", "oneActive"] as const;
  const targetValues = ["many", "one", "oneActive"] as const;
  for (const cardinality of sourceValues) {
    for (const targetCardinality of targetValues) {
      it(`cardinality=${cardinality}, targetCardinality=${targetCardinality}`, () => {
        const expected: EdgeCardinalityAxisRef[] = [];
        if (cardinality === "oneActive") {
          expected.push({ direction: "source", cardinality });
        }
        if (targetCardinality === "oneActive") {
          expected.push({
            direction: "target",
            cardinality: targetCardinality,
          });
        }
        expect(
          activeOnlyAxisReferences({ cardinality, targetCardinality }),
        ).toEqual(expected);
      });
    }
  }

  it("is always a subset of edgeCardinalityAxisReferences, in the same order", () => {
    const declarations = {
      cardinality: "oneActive",
      targetCardinality: "oneActive",
    } as const;
    expect(activeOnlyAxisReferences(declarations)).toEqual(
      edgeCardinalityAxisReferences(declarations),
    );
  });
});

describe("edgeCardinalityAxis", () => {
  it("keeps source axis strings byte-identical to the pre-D.1 spelling (no migration)", () => {
    // These three literals are the actual bytes stored in
    // `typegraph_edge_claims.axis` for every pre-existing source claim.
    // Changing them orphans every row a live database already holds.
    expect(
      edgeCardinalityAxis({ direction: "source", cardinality: "one" }, "knows"),
    ).toBe("one:knows");
    expect(
      edgeCardinalityAxis(
        { direction: "source", cardinality: "unique" },
        "knows",
      ),
    ).toBe("unique:knows");
    expect(
      edgeCardinalityAxis(
        { direction: "source", cardinality: "oneActive" },
        "knows",
      ),
    ).toBe("oneActive:knows");
  });

  it("prefixes a target axis with the reserved U+001E device, never colliding with a source axis", () => {
    const targetOne = edgeCardinalityAxis(
      { direction: "target", cardinality: "one" },
      "knows",
    );
    const targetActive = edgeCardinalityAxis(
      { direction: "target", cardinality: "oneActive" },
      "knows",
    );
    expect(targetOne).toBe("\u001Eto\u001Eone:knows");
    expect(targetActive).toBe("\u001Eto\u001EoneActive:knows");
    // No source axis literal — for ANY cardinality/edge-kind spelling — can
    // begin with the reserved separator, so the two namespaces cannot
    // collide.
    expect(targetOne.startsWith("\u001E")).toBe(true);
    expect(targetOne).not.toBe("one:knows");
  });
});

describe("edgeCardinalityClaims claim order", () => {
  const subject = {
    graphId: "g",
    id: "e1",
    kind: "knows",
    fromKind: "Person",
    fromId: "alice",
    toKind: "Person",
    toId: "bob",
  };

  it("orders a two-axis claim set by compareClaimTargets, not declaration order", () => {
    const claims = edgeCardinalityClaims(
      edgeCardinalityAxisReferences({
        cardinality: "one",
        targetCardinality: "one",
      }),
      subject,
    );
    expect(claims).toHaveLength(2);
    const targets: ClaimTarget[] = claims.map((claim) =>
      edgeCardinalityClaimTarget(claim),
    );
    const sorted = targets.toSorted((left, right) =>
      compareClaimTargets(left, right),
    );
    expect(targets).toEqual(sorted);
  });

  it("is stable across two independent calls for the same declaration and subject", () => {
    const declarations = {
      cardinality: "unique",
      targetCardinality: "one",
    } as const;
    const axisReferences = edgeCardinalityAxisReferences(declarations);
    const first = edgeCardinalityClaims(axisReferences, subject).map(
      (claim) => claim.direction,
    );
    const second = edgeCardinalityClaims(axisReferences, subject).map(
      (claim) => claim.direction,
    );
    expect(first).toEqual(second);
  });
});

describe("claim housekeeping reaps both axes of a two-axis kind", () => {
  const Housekeeping = defineNode("HousekeepingPerson", {
    schema: z.object({}),
  });
  const both = defineEdge("housekeepingBoth", { schema: z.object({}) });
  const housekeepingGraph = defineGraph({
    id: "edge_claim_housekeeping",
    nodes: { HousekeepingPerson: { type: Housekeeping } },
    edges: {
      housekeepingBoth: {
        type: both,
        from: [Housekeeping],
        to: [Housekeeping],
        cardinality: "one",
        targetCardinality: "one",
      },
    },
  });

  it("hard-deleting a two-axis edge purges both its claim rows", async () => {
    const backend = createTestBackend();
    const { createStoreWithSchema } = await import("../src/store");
    const [store] = await createStoreWithSchema(housekeepingGraph, backend);
    const alice = await store.nodes.HousekeepingPerson.create({});
    const bob = await store.nodes.HousekeepingPerson.create({});
    const edge = await store.edges.housekeepingBoth.create(alice, bob, {});

    expect(await claimRowCount(backend, edge.id)).toBe(2);

    await store.edges.housekeepingBoth.delete(edge.id);
    await store.edges.housekeepingBoth.hardDelete(edge.id);

    expect(await claimRowCount(backend, edge.id)).toBe(0);
  });
  // MUTATION CHECK (verified): hardcode `holdsCardinalityClaim: false` at
  // its computation site in `executeEdgeHardDelete`
  // (`src/store/operations/edge-operations.ts`), blind to
  // `edgeCardinalityAxisReferences`. The purge is then skipped entirely and
  // both rows survive — `claimRowCount` reads 2, not 0.
});
