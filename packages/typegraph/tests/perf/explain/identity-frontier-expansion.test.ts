/**
 * Pins the #396 shape: identity expansion at the CURRENT read coordinate must
 * be bounded by the frontier, not by the identity population.
 *
 * `tests/identity-frontier-bounded.test.ts` already guards this with a
 * scaling (timing) check plus one plan-shape assertion on SQLite; this suite
 * is the deterministic EXPLAIN-shape half for BOTH engines (that file's own
 * doc comment explains why both run: the fix is one compilation path, so a
 * guard on one engine certifies half of it). Distinct fixture from that file
 * — smaller, because this suite pays no scaling-timing cost and only needs
 * "identity population that dwarfs the frontier", not two comparable sizes.
 *
 * These are plan-shape suites, not query-semantics suites (AGENTS.md "Backend
 * parity"): plan language is per-engine by nature, so they are not registered
 * into `createIntegrationTestSuite` — `forEachExplainEngine` is this batch's
 * parity seam instead.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, type Store } from "../../../src";
import { IDENTITY_CLASS_CTE_ALIAS } from "../../../src/query/compiler/identity-traversal";
import { forEachExplainEngine } from "./explain-engines";
import { assertPlanShape, assertRowCeiling } from "./explain-harness";

const FrontierPerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const frontierLink = defineEdge("link", { schema: z.object({}) });

const frontierGraph = defineGraph({
  id: "explain_identity_frontier_expansion",
  nodes: { Person: { type: FrontierPerson } },
  edges: {
    link: { type: frontierLink, from: [FrontierPerson], to: [FrontierPerson] },
  },
  identity: { sameIdAcrossKinds: "ignore" },
});

/** Classes the frontier row's own class shares nothing with. */
const UNRELATED_CLASS_COUNT = 8;
/** Members per unrelated class — 480 members across 8 classes, ~230,400 pairs under the removed shape. */
const UNRELATED_CLASS_SIZE = 60;

/**
 * Rows a frontier-bounded hop visits on PostgreSQL over this fixture, at HEAD:
 * measured 18. Set from the measured actual ×5, rounded up (same rule
 * `variable-length-traversal.test.ts`'s `RECURSIVE_ROW_CEILING` uses), not
 * from a round number picked without checking it against the mutation this
 * case exists to catch.
 *
 * Under mutation `FRONTIER-PIN` (dropping the `identity_peer` join's
 * `class_kind`/`class_id` equalities from
 * `planCurrentIdentityFrontierExpansion`), the join degenerates to every
 * closure row the graph_id predicate leaves, self-joined against the
 * frontier's own class row: measured 495 on this fixture (linear in the
 * identity population, not quadratic — the seed-class seek still narrows to
 * one row before the mutated join loses the class predicate). At a ceiling
 * of 500 that measured value does NOT trip `assertRowCeiling` on its own
 * (495 < 500); the case's `assertPlanShape` forbidden term (`Seq Scan on
 * typegraph_identity_closure`) was the half that actually caught the
 * mutation. 100 restores a real margin in both directions — comfortably
 * above the HEAD actual (18) and comfortably below the measured mutated
 * value (495) — so `assertRowCeiling` catches this mutation on its own
 * instead of relying on the shape check to carry it. See the commit body's
 * mutation-check log for both measured values.
 */
const FRONTIER_ROW_CEILING = 100;

async function seedFrontier(store: Store<typeof frontierGraph>): Promise<void> {
  const nodes = [
    { id: "start", props: { name: "start" } },
    { id: "start-peer", props: { name: "start-peer" } },
    { id: "start-peer-two", props: { name: "start-peer-two" } },
    { id: "target", props: { name: "target" } },
    ...Array.from(
      { length: UNRELATED_CLASS_COUNT * UNRELATED_CLASS_SIZE },
      (unused, index) => ({
        id: `unrelated-${index}`,
        props: { name: `unrelated-${index}` },
      }),
    ),
  ];
  await store.nodes.Person.bulkCreate(nodes);
  // The edge leaves the PEER, not the start row, so nothing is reachable
  // without identity expansion widening the frontier to it first.
  await store.edges.link.bulkCreate([
    {
      from: { id: "start-peer", kind: "Person" as const },
      id: "link-peer-target",
      props: {},
      to: { id: "target", kind: "Person" as const },
    },
  ]);
  const pairs = [
    {
      a: { id: "start", kind: "Person" as const },
      b: { id: "start-peer", kind: "Person" as const },
    },
    {
      a: { id: "start", kind: "Person" as const },
      b: { id: "start-peer-two", kind: "Person" as const },
    },
  ];
  for (
    let classIndex = 0;
    classIndex < UNRELATED_CLASS_COUNT;
    classIndex += 1
  ) {
    const first = classIndex * UNRELATED_CLASS_SIZE;
    for (let member = 1; member < UNRELATED_CLASS_SIZE; member += 1) {
      pairs.push({
        a: { id: `unrelated-${first}`, kind: "Person" as const },
        b: { id: `unrelated-${first + member}`, kind: "Person" as const },
      });
    }
  }
  await store.identity.bulkAssertSame(pairs);
}

/** The measured hop: one frontier row, reached through its identity class. */
function frontierHop(store: Store<typeof frontierGraph>) {
  return store
    .query()
    .from("Person", "person")
    .whereNode("person", (node) => node.id.eq("start"))
    .traverse("link", "edge", {
      expand: "none",
      includeIdentityMembers: true,
    })
    .to("Person", "friend")
    .select((queryContext) => queryContext.friend.id);
}

describe("identity frontier expansion (#396 shape)", () => {
  forEachExplainEngine((harness) => {
    it("reaches the target through an identity peer", async () => {
      const subject = await harness.provision(frontierGraph, seedFrontier);
      const rows = await frontierHop(subject.store).execute();
      expect(rows).toEqual(["target"]);
    });

    if (harness.engine === "sqlite") {
      it("seeks the identity closure from the frontier", async () => {
        const subject = await harness.provision(frontierGraph, seedFrontier);
        const statement = frontierHop(subject.store).toSQL();
        const plan = await subject.explainRead("frontier hop", statement);
        assertPlanShape({
          plan,
          required: [
            "SEARCH identity_seed_class USING INDEX sqlite_autoindex_typegraph_identity_closure_1",
            "SEARCH identity_peer USING INDEX typegraph_identity_closure_class_idx",
          ],
          forbidden: [
            `MATERIALIZE ${IDENTITY_CLASS_CTE_ALIAS}`,
            "SCAN typegraph_identity_closure",
            /SCAN identity_/,
          ],
        });
      });
    }

    if (harness.engine === "postgres") {
      it("visits at most FRONTIER_ROW_CEILING rows expanding the frontier", async () => {
        const subject = await harness.provision(frontierGraph, seedFrontier);
        const statement = frontierHop(subject.store).toSQL();
        const plan = await subject.explainRead("frontier hop", statement);
        assertRowCeiling({ plan, ceiling: FRONTIER_ROW_CEILING });
        assertPlanShape({
          plan,
          required: [],
          forbidden: [
            `CTE Scan on ${IDENTITY_CLASS_CTE_ALIAS}`,
            "Seq Scan on typegraph_identity_closure",
          ],
        });
      });
    }
  });
});
