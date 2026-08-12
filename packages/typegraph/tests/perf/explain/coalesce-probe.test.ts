/**
 * Plan/statement shape for the coalesce-unchanged-upsert path
 * (`coalesceUnchangedUpserts`, see `src/store/collections/coalesce.ts`): the
 * probe that decides whether an upsert is a value-identical replay must seek
 * the target row by primary key, not scan the table, and must not turn into
 * a per-item probe for a batch.
 *
 * `tests/coalesce-upsert-freshness.test.ts` owns coalesce SEMANTICS
 * (outcome); this suite owns the plan/statement-count half only (AGENTS.md
 * "one predicate, one owner" — DO NOT re-add semantic assertions here).
 *
 * The plan-shape cases below measure the BULK path (`bulkUpsertById`), not
 * the single-row path: verified in this tree, `buildGetNodes` (the batched,
 * `IN (...)`-keyed seek `COALESCE-PROBE-KEY` mutates) is what the bulk path's
 * probe compiles to, while the single-row path's probe is the unrelated
 * `buildGetNode` equality seek. Measuring the bulk path is also what keeps
 * `onlyStatementMatching` literally correct: `createStoreWithSchema` routes
 * `upsertById` through the typed write pipeline (#491), whose own
 * resurrection-bookkeeping re-read means even a genuinely unchanged single
 * upsert issues TWO probe SELECTs, never one (see
 * `UNCHANGED_SINGLE_UPSERT_PROBE_COUNT`'s doc comment) — `bulkUpsertById` has
 * no such second read, so its probe is unambiguous.
 *
 * These are plan-shape suites, not query-semantics suites (AGENTS.md "Backend
 * parity"): plan language is per-engine by nature, so they are not registered
 * into `createIntegrationTestSuite` — `forEachExplainEngine` is this batch's
 * parity seam instead.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, type Store } from "../../../src";
import { forEachExplainEngine } from "./explain-engines";
import {
  assertPlanShape,
  assertRowCeiling,
  onlyStatementMatching,
  statementsMatching,
} from "./explain-harness";

const CoalescePerson = defineNode("Person", {
  schema: z.object({ name: z.string(), note: z.string().optional() }),
});

const coalesceGraph = defineGraph({
  id: "explain_coalesce_probe",
  nodes: { Person: { type: CoalescePerson } },
  edges: {},
});

const PROBE_POPULATION = 5000;
const BULK_PROBE_BATCH = 50;

function isNodesSelect(sql: string): boolean {
  return /select/i.test(sql) && sql.includes("typegraph_nodes");
}

function isNodesWrite(sql: string): boolean {
  return (
    /^\s*(insert|update|delete)/i.test(sql) && sql.includes("typegraph_nodes")
  );
}

/**
 * `upsertById`'s coalesce decision, verified in this tree
 * (`src/store/collections/node-collection.ts`'s documented INVARIANT):
 * an initial autocommit read decides whether the row is a candidate, and —
 * only when it is — a SECOND read re-confirms inside the transaction that
 * decides the skip, so the decision and the skip are the same atomic unit.
 * A genuinely unchanged single upsert therefore issues exactly TWO probe
 * SELECTs against `typegraph_nodes`, not one; measured on both engines in
 * this tree (SQLite: two `SEARCH ... USING INDEX
 * sqlite_autoindex_typegraph_nodes_1` reads, one before `BEGIN IMMEDIATE` and
 * one inside it; Postgres: identical shape, visible only once statement
 * capture follows PGlite's own transaction-scoped client — see
 * `explain-engines.ts`'s doc comment). `bulkUpsertById` has no such second
 * read (the whole batch decision runs inside one transaction off one batched
 * `getNodes` read), which is why its own case below asserts exactly one.
 */
const UNCHANGED_SINGLE_UPSERT_PROBE_COUNT = 2;

/** `bulkUpsertById`'s coalesce probe: one batched `getNodes` read, always — see above. */
const UNCHANGED_BULK_UPSERT_PROBE_COUNT = 1;

/**
 * Rows a coalesce probe's `id IN (...)` seek visits on PostgreSQL over this
 * fixture, at HEAD: measured 2 (one per probed id). Mutation
 * `COALESCE-PROBE-KEY` (dropping the `id` term from `buildGetNodes`'s
 * predicate) turns the seek into a full-table filter: measured 5,000 — the
 * whole `PROBE_POPULATION` — under the mutation. `assertPlanShape`'s required
 * term (no `Index Scan` survives; a bare `Seq Scan on typegraph_nodes` plan
 * is what the mutated query produces) is what actually catches this
 * mutation; the row ceiling below never gets evaluated for it because the
 * shape assertion throws first, but 5,000 is 625× the ceiling regardless. See
 * the commit body's mutation-check log for this measured value.
 *
 * `PROBE_POPULATION` is 5,000, not 300, for this case specifically: PostgreSQL
 * only preferred an index scan over a sequential scan for a 2-id `IN (...)`
 * once the table was large enough to make the seq-scan alternative clearly
 * more expensive — verified in this tree, 300 rows left the planner correctly
 * choosing `Seq Scan on typegraph_nodes` for two ids, which the `Seq Scan on
 * typegraph_nodes` forbidden term below would have (correctly) failed on. A
 * bigger batch does not substitute: a 50-id batch just visits ~50 rows either
 * way, which the ceiling cannot distinguish from a scan (AGENTS.md
 * Load-Bearing Tests: fixture enrichment, not a softened assertion).
 */
const COALESCE_PROBE_ROW_CEILING = 8;

/** The exact two ids the plan-shape cases probe (small on purpose — see `COALESCE_PROBE_ROW_CEILING`'s doc comment). */
const PLAN_SHAPE_PROBE_IDS = ["person-0", "person-1"];

async function seedCoalesce(store: Store<typeof coalesceGraph>): Promise<void> {
  const people = Array.from({ length: PROBE_POPULATION }, (unused, index) => ({
    id: `person-${index}`,
    props: { name: `person-${index}` },
  }));
  await store.nodes.Person.bulkCreate(people);
}

/** `upsertById` of an existing row with its own current (unchanged) props. */
async function upsertUnchanged(
  store: Store<typeof coalesceGraph>,
): Promise<void> {
  await store.nodes.Person.upsertById("person-0", { name: "person-0" });
}

/** `bulkUpsertById` of a small existing batch, all unchanged. */
async function bulkUpsertUnchanged(
  store: Store<typeof coalesceGraph>,
  ids: readonly string[],
): Promise<void> {
  await store.nodes.Person.bulkUpsertById(
    ids.map((id) => ({ id, props: { name: id } })),
  );
}

describe("coalesce probe (unchanged upsert)", () => {
  forEachExplainEngine((harness) => {
    if (harness.engine === "sqlite") {
      it("probes the coalesce candidate by primary key", async () => {
        const subject = await harness.provision(coalesceGraph, seedCoalesce, {
          storeOptions: { coalesceUnchangedUpserts: true },
        });
        await bulkUpsertUnchanged(subject.store, PLAN_SHAPE_PROBE_IDS);
        const probe = onlyStatementMatching(
          subject.captured,
          "coalesce probe",
          isNodesSelect,
        );
        const plan = await subject.explainRead("coalesce probe", probe);
        assertPlanShape({
          plan,
          required: [
            "SEARCH typegraph_nodes USING INDEX sqlite_autoindex_typegraph_nodes_1",
          ],
          forbidden: ["SCAN typegraph_nodes"],
        });
      });
    }

    if (harness.engine === "postgres") {
      it("probes the coalesce candidate through an index scan", async () => {
        const subject = await harness.provision(coalesceGraph, seedCoalesce, {
          storeOptions: { coalesceUnchangedUpserts: true },
        });
        await bulkUpsertUnchanged(subject.store, PLAN_SHAPE_PROBE_IDS);
        const probe = onlyStatementMatching(
          subject.captured,
          "coalesce probe",
          isNodesSelect,
        );
        const plan = await subject.explainRead("coalesce probe", probe);
        assertPlanShape({
          plan,
          required: [/Index (Only )?Scan on typegraph_nodes/],
          forbidden: ["Seq Scan on typegraph_nodes"],
        });
        assertRowCeiling({ plan, ceiling: COALESCE_PROBE_ROW_CEILING });
      });
    }

    it("issues one probe and no write for an unchanged upsert", async () => {
      const subject = await harness.provision(coalesceGraph, seedCoalesce, {
        storeOptions: { coalesceUnchangedUpserts: true },
      });
      await upsertUnchanged(subject.store);
      const probes = statementsMatching(subject.captured, isNodesSelect);
      const writes = statementsMatching(subject.captured, isNodesWrite);
      expect(probes).toHaveLength(UNCHANGED_SINGLE_UPSERT_PROBE_COUNT);
      expect(writes).toHaveLength(0);
    });

    it("probes once for a whole unchanged bulk batch", async () => {
      const subject = await harness.provision(coalesceGraph, seedCoalesce, {
        storeOptions: { coalesceUnchangedUpserts: true },
      });
      const ids = Array.from(
        { length: BULK_PROBE_BATCH },
        (unused, index) => `person-${index}`,
      );
      await bulkUpsertUnchanged(subject.store, ids);
      const probes = statementsMatching(subject.captured, isNodesSelect);
      const writes = statementsMatching(subject.captured, isNodesWrite);
      expect(probes).toHaveLength(UNCHANGED_BULK_UPSERT_PROBE_COUNT);
      expect(writes).toHaveLength(0);
    });
  });
});
