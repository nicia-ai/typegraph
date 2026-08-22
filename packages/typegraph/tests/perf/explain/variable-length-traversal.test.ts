/**
 * Pins the #391 shape: a bounded recursive (`maxHops`) traversal must drive
 * each recursive step from the edges index, not a scan of the whole edges
 * table — and the visited-row bound must degrade with the walk, not with an
 * unrelated decoy population sharing the edge kind.
 *
 * These are plan-shape suites, not query-semantics suites (AGENTS.md "Backend
 * parity"): plan language is per-engine by nature, so they are not registered
 * into `createIntegrationTestSuite` — `forEachExplainEngine` is this batch's
 * parity seam instead.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, type Store } from "../../../src";
import { forEachExplainEngine } from "./explain-engines";
import { assertPlanShape, assertRowCeiling } from "./explain-harness";

const VariableLengthPerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const variableLengthKnows = defineEdge("knows", { schema: z.object({}) });

const variableLengthGraph = defineGraph({
  id: "explain_variable_length_traversal",
  nodes: { Person: { type: VariableLengthPerson } },
  edges: {
    knows: {
      type: variableLengthKnows,
      from: [VariableLengthPerson],
      to: [VariableLengthPerson],
    },
  },
});

/** `chain-0` through `chain-CHAIN_LENGTH`, linked in one direction. */
const CHAIN_LENGTH = 8;

/**
 * Decoy `knows` population, reachable from nothing in the walk (distinct node
 * ids from the chain and from the depth-cap trap below). Sized so
 * PostgreSQL's planner prefers an index-driven nested loop over hashing the
 * whole edges relation per recursive step — at the size this suite started
 * with (400 edges over 40 nodes), the planner reasonably chose a Hash Join
 * with a Seq Scan on the inner side, which would have made the "Seq Scan on
 * typegraph_edges" forbidden term assert something false about a
 * correctly-functioning planner (AGENTS.md Load-Bearing Tests: fixture
 * enrichment, not a softened assertion).
 */
const DECOY_NODE_COUNT = 200;
const DECOY_EDGE_COUNT = 4000;

/**
 * A two-node ring reachable ONLY past `chain-CHAIN_LENGTH` (see
 * `seedVariableLength`'s `chainToTrapEdge`), with a huge per-hop edge
 * multiplicity. A bounded (`maxHops: 4`) walk never reaches it — the chain
 * alone is that long. `RECURSIVE-DEPTH-CAP` silently extends the walk to
 * `MAX_RECURSIVE_DEPTH` (10), of which the chain absorbs 8 hops, leaving
 * exactly ONE hop (`chain-CHAIN_LENGTH` → `trap-0`) plus one ring hop
 * (`trap-0` → `trap-1`, `DEPTH_CAP_TRAP_MULTIPLICITY` duplicate edges) before
 * the depth condition cuts recursion off. That one ring hop is what has to
 * carry the whole degradation signal, which is why its multiplicity is huge
 * rather than merely large — a smaller multiplicity (verified in this tree at
 * 20×, and again at 80× spread over the DECOY ring above) left the mutation's
 * measured visited-rows comfortably under `RECURSIVE_ROW_CEILING` (AGENTS.md
 * Load-Bearing Tests: fixture enrichment, not a softened mutation).
 */
const DEPTH_CAP_TRAP_MULTIPLICITY = 4000;

/**
 * Rows a bounded (`maxHops: 4`) walk visits on PostgreSQL over this fixture,
 * at HEAD: measured 448. Set from the measured actual ×5, rounded up — see
 * the commit body's mutation-check log for the measured value under
 * `RECURSIVE-DEPTH-CAP` (which needed the `DEPTH_CAP_TRAP_MULTIPLICITY`
 * fixture enrichment above before it bit).
 *
 * `RECURSIVE-WORKTABLE-JOIN` (blinding `compileWorktableJoinClauses`'s
 * `edgeId = previousIdColumn` conjunct, so a recursive step no longer ties a
 * candidate edge to the worktable row it is expanding from) is caught two
 * ways, not one, because this fixture's own edge population (~8,000 edges
 * once `DECOY_EDGE_COUNT` and `DEPTH_CAP_TRAP_MULTIPLICITY` are both at their
 * committed size) makes the postgres case's own row count unmeasurable under
 * that mutation:
 *
 * - SQLite's case (`EXPLAIN QUERY PLAN`, which plans but never executes the
 *   query) goes red immediately regardless of edge count: the required
 *   `SEARCH ... USING INDEX typegraph_edges_from_idx` term is replaced by a
 *   bare `SCAN r` / `SCAN n` / `SCAN recursive_cte` plan.
 * - Postgres's case runs `EXPLAIN (ANALYZE, ...)`, which executes the
 *   mutated query for real. With the join conjunct gone, every recursive step
 *   cross-joins the whole worktable against every edge; over 4 bounded hops
 *   against this fixture's committed ~8,000 edges that blows up combinatorially
 *   far enough that `EXPLAIN ANALYZE` does not complete within 60+ seconds —
 *   confirmed by direct measurement, not assumed. That is a stronger failure
 *   signal than a ceiling breach, but not a row count. The mechanism was
 *   confirmed to trip `assertRowCeiling` itself by reproducing the identical
 *   mutation and fixture-construction code at a reduced scale
 *   (`DECOY_NODE_COUNT` 5, `DECOY_EDGE_COUNT` 10, `DEPTH_CAP_TRAP_MULTIPLICITY`
 *   5 — ~24 total edges): measured 852,419 visited rows against this same
 *   2,250 ceiling, 379× over. See the commit body's mutation-check log for
 *   both figures.
 */
const RECURSIVE_ROW_CEILING = 2250;

async function seedVariableLength(
  store: Store<typeof variableLengthGraph>,
): Promise<void> {
  const chainNodes = Array.from(
    { length: CHAIN_LENGTH + 1 },
    (unused, index) => ({
      id: `chain-${index}`,
      props: { name: `chain-${index}` },
    }),
  );
  const decoyNodes = Array.from(
    { length: DECOY_NODE_COUNT },
    (unused, index) => ({
      id: `decoy-${index}`,
      props: { name: `decoy-${index}` },
    }),
  );
  await store.nodes.Person.bulkCreate([...chainNodes, ...decoyNodes]);

  const chainEdges = Array.from({ length: CHAIN_LENGTH }, (unused, index) => ({
    id: `chain-edge-${index}`,
    from: { id: `chain-${index}`, kind: "Person" as const },
    to: { id: `chain-${index + 1}`, kind: "Person" as const },
    props: {},
  }));
  const decoyEdges = Array.from(
    { length: DECOY_EDGE_COUNT },
    (unused, index) => ({
      id: `decoy-edge-${index}`,
      from: {
        id: `decoy-${index % DECOY_NODE_COUNT}`,
        kind: "Person" as const,
      },
      to: {
        id: `decoy-${(index + 1) % DECOY_NODE_COUNT}`,
        kind: "Person" as const,
      },
      props: {},
    }),
  );

  const trapNodes = [
    { id: "trap-0", props: { name: "trap-0" } },
    { id: "trap-1", props: { name: "trap-1" } },
  ];
  await store.nodes.Person.bulkCreate(trapNodes);
  const chainToTrapEdge = {
    id: "chain-to-trap-edge",
    from: { id: `chain-${CHAIN_LENGTH}`, kind: "Person" as const },
    to: { id: "trap-0", kind: "Person" as const },
    props: {},
  };
  const trapRingEdges = Array.from(
    { length: DEPTH_CAP_TRAP_MULTIPLICITY },
    (unused, index) => ({
      id: `trap-ring-edge-${index}`,
      from: { id: "trap-0", kind: "Person" as const },
      to: { id: "trap-1", kind: "Person" as const },
      props: {},
    }),
  );
  await store.edges.knows.bulkCreate([
    ...chainEdges,
    ...decoyEdges,
    chainToTrapEdge,
    ...trapRingEdges,
  ]);
}

/**
 * The measured walk: pinned to `chain-0`, four bounded recursive hops.
 * Mirrors the builder chain in `tests/query-execution.test.ts`'s
 * "Variable-Length Paths" describe block (around line 926) rather than
 * inventing a new one.
 */
function walkQuery(store: Store<typeof variableLengthGraph>) {
  return store
    .query()
    .from("Person", "p")
    .whereNode("p", (node) => node.id.eq("chain-0"))
    .traverse("knows", "e", { expand: "none" })
    .recursive({ maxHops: 4, depth: true })
    .to("Person", "reached")
    .select((context) => context.reached.id);
}

describe("variable-length traversal (#391 shape)", () => {
  forEachExplainEngine((harness) => {
    it("reaches exactly the chain within four hops", async () => {
      const subject = await harness.provision(
        variableLengthGraph,
        seedVariableLength,
      );
      const results = await walkQuery(subject.store).execute();
      expect(results).toEqual(["chain-1", "chain-2", "chain-3", "chain-4"]);
    });

    if (harness.engine === "sqlite") {
      it("drives every recursive step from the edges index", async () => {
        const subject = await harness.provision(
          variableLengthGraph,
          seedVariableLength,
        );
        const statement = walkQuery(subject.store).toSQL();
        const plan = await subject.explainRead("bounded walk", statement);
        assertPlanShape({
          plan,
          required: [
            /SEARCH .* USING (COVERING )?INDEX typegraph_edges_from_idx/,
          ],
          forbidden: ["SCAN typegraph_edges"],
        });
      });
    }

    if (harness.engine === "postgres") {
      it("visits at most RECURSIVE_ROW_CEILING rows for a bounded walk", async () => {
        const subject = await harness.provision(
          variableLengthGraph,
          seedVariableLength,
        );
        const statement = walkQuery(subject.store).toSQL();
        const plan = await subject.explainRead("bounded walk", statement);
        assertRowCeiling({ plan, ceiling: RECURSIVE_ROW_CEILING });
        assertPlanShape({
          plan,
          required: [],
          forbidden: ["Seq Scan on typegraph_edges"],
        });
      });
    }
  });
});
