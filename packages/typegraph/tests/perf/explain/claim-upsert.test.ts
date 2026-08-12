/**
 * Plan shape for Phase 1's constraint-claim writes (`withNodeCreateClaims` /
 * the edge-claim statements, #490): a node-uniqueness claim must resolve
 * through its declared arbiter index, a batch of edge-axis claims must
 * resolve in one statement over one values scan, and an axis takeover must
 * seek the claim row by its key, never scan the claims (or edges) relation.
 *
 * `tests/constraint-claim-inventory.test.ts` owns claim STATEMENT COUNTS
 * across every write path (do not re-add a count assertion here); this suite
 * owns the plan half only.
 *
 * Fact 4 (see the batch's design doc): SQLite's `EXPLAIN QUERY PLAN` of an
 * `INSERT … VALUES … ON CONFLICT` returns ZERO rows — the conflict probe is
 * invisible to EQP. The two INSERT-shaped cases below are defined once (each
 * runs its assertion body on Postgres) and their SQLite leg is explicitly
 * `it.skip`, carrying the same assertion body a future engine capability
 * would exercise: `assertPlanShape`'s empty-plan refusal is what would catch
 * a change that tried to make that leg pass vacuously instead of skipped —
 * never a silent omission.
 *
 * These are plan-shape suites, not query-semantics suites (AGENTS.md "Backend
 * parity"): plan language is per-engine by nature, so they are not registered
 * into `createIntegrationTestSuite` — `forEachExplainEngine` is this batch's
 * parity seam instead.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, type Store } from "../../../src";
import { type ExplainHarness, forEachExplainEngine } from "./explain-engines";
import {
  assertPlanShape,
  onlyStatementMatching,
  statementsMatching,
} from "./explain-harness";

const ClaimPerson = defineNode("Person", {
  schema: z.object({ email: z.string() }),
});
const claimReportsTo = defineEdge("reportsTo", { schema: z.object({}) });

const claimGraph = defineGraph({
  id: "explain_claim_upsert",
  nodes: {
    Person: {
      type: ClaimPerson,
      unique: [
        {
          name: "unique_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    reportsTo: {
      type: claimReportsTo,
      from: [ClaimPerson],
      to: [ClaimPerson],
      cardinality: "one",
    },
  },
});

/**
 * Pre-existing claim rows on both `typegraph_node_uniques` and
 * `typegraph_edge_claims`, so neither table is trivially small when the
 * measured operation's claim is taken.
 */
const CLAIM_POPULATION = 200;

/** Distinct-axis edges claimed in one `bulkCreate` batch. */
const CLAIM_BATCH = 25;

function isNodeUniquesInsert(sql: string): boolean {
  return /insert into "typegraph_node_uniques"/i.test(sql);
}

function isEdgeClaimsInsert(sql: string): boolean {
  return /insert into "typegraph_edge_claims"/i.test(sql);
}

function isEdgeClaimsUpdate(sql: string): boolean {
  return /^\s*update/i.test(sql) && sql.includes("typegraph_edge_claims");
}

async function seedClaims(store: Store<typeof claimGraph>): Promise<void> {
  const people = Array.from(
    { length: CLAIM_POPULATION + 60 },
    (unused, index) => ({
      id: `person-${index}`,
      props: { email: `person-${index}@example.com` },
    }),
  );
  await store.nodes.Person.bulkCreate(people);

  const edges = Array.from({ length: CLAIM_POPULATION }, (unused, index) => ({
    id: `edge-${index}`,
    from: { id: `person-${index}`, kind: "Person" as const },
    to: { id: `person-${index + 1}`, kind: "Person" as const },
    props: {},
  }));
  await store.edges.reportsTo.bulkCreate(edges);
}

/**
 * Case body for "resolves the node-uniqueness claim through its arbiter
 * index" — defined once (AGENTS.md "one predicate, one owner") so both the
 * live Postgres run and the SQLite `it.skip` below share exactly the same
 * assertion, per this file's fact-4 doc comment.
 */
async function resolvesNodeUniquenessClaimThroughArbiterIndex(
  harness: ExplainHarness,
): Promise<void> {
  const subject = await harness.provision(claimGraph, seedClaims);
  await subject.store.nodes.Person.create({
    email: "explain-claim-new@example.com",
  });
  const claimInsert = onlyStatementMatching(
    subject.captured,
    "node-uniqueness claim insert",
    isNodeUniquesInsert,
  );
  const plan = await subject.explainWrite("node-uniqueness claim", claimInsert);
  assertPlanShape({
    plan,
    required: [
      "Conflict Resolution: UPDATE",
      "Conflict Arbiter Indexes: typegraph_node_uniques_pkey",
    ],
    forbidden: ["Seq Scan on typegraph_node_uniques"],
  });
}

/**
 * Case body for "claims a batch of edge axes in one statement over one
 * values scan" — same "defined once" rationale as the function above.
 */
async function claimsEdgeAxisBatchInOneStatement(
  harness: ExplainHarness,
): Promise<void> {
  const subject = await harness.provision(claimGraph, seedClaims);
  const batch = Array.from({ length: CLAIM_BATCH }, (unused, index) => ({
    id: `batch-edge-${index}`,
    from: {
      id: `person-${CLAIM_POPULATION + index}`,
      kind: "Person" as const,
    },
    to: {
      id: `person-${CLAIM_POPULATION + CLAIM_BATCH + index}`,
      kind: "Person" as const,
    },
    props: {},
  }));
  await subject.store.edges.reportsTo.bulkCreate(batch);
  const claimInserts = statementsMatching(subject.captured, isEdgeClaimsInsert);
  expect(claimInserts).toHaveLength(1);
  const plan = await subject.explainWrite(
    "edge claim batch",
    onlyStatementMatching(
      subject.captured,
      "edge claim batch insert",
      isEdgeClaimsInsert,
    ),
  );
  assertPlanShape({
    plan,
    required: ["Conflict Arbiter Indexes: typegraph_edge_claims_pkey"],
    forbidden: [],
  });
  const valuesScans = plan.text.match(/Values Scan on "\*VALUES\*"/g);
  expect(valuesScans).toHaveLength(1);
}

describe("claim upsert (constraint-claim plan shape)", () => {
  forEachExplainEngine((harness) => {
    // Defined once for both engines via one static call site
    // (`it.skipIf`, not a sibling `it`/`it.skip` pair — which trips
    // eslint-plugin-vitest's identical-title check, since it cannot see that
    // the two branches run in different `describe("sqlite" | "postgres")`
    // blocks): on Postgres this runs for real; on SQLite it is skipped for
    // the fact-4 reason above, carrying the same body so `assertPlanShape`'s
    // empty-plan refusal is what guards it, not a silent absence.
    it.skipIf(harness.engine === "sqlite")(
      "resolves the node-uniqueness claim through its arbiter index",
      () => resolvesNodeUniquenessClaimThroughArbiterIndex(harness),
    );
    it.skipIf(harness.engine === "sqlite")(
      "claims a batch of edge axes in one statement over one values scan",
      () => claimsEdgeAxisBatchInOneStatement(harness),
    );

    if (harness.engine === "sqlite") {
      it("seeks the claim row by key when taking an axis over", async () => {
        const subject = await harness.provision(claimGraph, seedClaims);
        const takeoverFrom = {
          id: `person-${CLAIM_POPULATION + 1}`,
          kind: "Person" as const,
        };
        const original = await subject.store.edges.reportsTo.create(
          takeoverFrom,
          { id: `person-${CLAIM_POPULATION + 2}`, kind: "Person" as const },
        );
        await subject.store.edges.reportsTo.delete(original.id);
        subject.reset();

        await subject.store.edges.reportsTo.create(takeoverFrom, {
          id: `person-${CLAIM_POPULATION + 3}`,
          kind: "Person" as const,
        });
        const takeoverUpdate = onlyStatementMatching(
          subject.captured,
          "edge-claim takeover update",
          isEdgeClaimsUpdate,
        );
        const plan = await subject.explainWrite(
          "edge-claim takeover",
          takeoverUpdate,
        );
        assertPlanShape({
          plan,
          required: [
            "SEARCH typegraph_edge_claims USING INDEX sqlite_autoindex_typegraph_edge_claims_1 (graph_id=? AND axis=? AND key=?)",
          ],
          forbidden: ["SCAN typegraph_edge_claims", "SCAN typegraph_edges"],
        });
      });
    }
  });
});
