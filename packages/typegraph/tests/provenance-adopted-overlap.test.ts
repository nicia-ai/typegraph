/**
 * Two retraction verbs overlapping on one native transaction that two
 * adoptions share without proof.
 *
 * A caller-begun better-sqlite3 transaction is identified only by its
 * connection, and a connection proves nothing about which transaction is
 * open on it, so each `withRecordedTransaction` adoption of it gets a native
 * transaction state of its own (`src/backend/native-transaction-handle.ts`)
 * and the transition's exclusive section cannot see the other verb. Each
 * verb's support read can then predate the other's flag: retracting the two
 * sources of `shared` at once left both flags set and `shared` live with no
 * support.
 *
 * Overlap on unproven adoptions is unsupported: verbs and provenance reads on
 * one native transaction must be sequenced. This case is the one the verb's
 * re-read and reconcile pass (`transitionInExclusiveSection`,
 * `src/provenance/transition.ts`) closes and the section does not, and it is
 * why that pass is kept: both verbs flip a flag, so whichever re-reads last
 * sees the other's flag and closes `shared`. The shared provenance suite pins
 * an overlap it does not close (a restoration that flips no flag beside a
 * retraction), as a known defect on better-sqlite3.
 *
 * Revert check: return the first pass's report without re-reading the
 * flags, and `shared` stays live with both flags set.
 *
 * The second adoption still rejects: its recorded-time capture allocates the
 * same revision as the first's on the one transaction, and its flush fails
 * on `typegraph_recorded_anchors`. That is a hazard of two history captures
 * on one transaction, not of the verbs (pinned as a known defect in
 * `recorded-adoption-revision-collision.test.ts`), and an adopted caller rolls back
 * after a rejected callback. The rows are checked after the caller commits
 * anyway, the worst case: what a caller that ignores the rejection keeps.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { tables } from "../src/backend/sqlite";
import { createRetractionCapability } from "../src/provenance";
import type { AdapterHistoryStore } from "../src/store/store";

const Source = defineNode("Source", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});
const Fact = defineNode("Fact", { schema: z.object({ label: z.string() }) });
const Justification = defineNode("Justification", {
  schema: z.object({ label: z.string() }),
});
const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");
const graph = defineGraph({
  id: "provenance_adopted_overlap",
  nodes: {
    Source: { type: Source },
    Fact: { type: Fact },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: { type: premiseOf, from: [Source], to: [Justification] },
    derives: { type: derives, from: [Justification], to: [Fact] },
  },
});
const config = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

type OverlapStore = AdapterHistoryStore<typeof graph, never>;
type AdoptedTransaction = Parameters<
  Parameters<OverlapStore["withRecordedTransaction"]>[1]
>[0];

const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

it("two verbs on two unproven adoptions of one better-sqlite3 transaction leave no fact live without support", async () => {
  const connection = new Database(":memory:");
  closers.push(() => {
    connection.close();
  });
  for (const statement of generateSqliteDDL(tables)) connection.exec(statement);
  const connectionDb = drizzle(connection);
  const backend = createSqliteBackend(connectionDb, {
    executionProfile: { isSync: true },
    tables,
  });
  const [created] = await createAdapterStoreWithSchema(graph, backend, {
    history: true,
  });
  const store = created as unknown as OverlapStore;
  for (const id of ["a", "b"]) {
    await store.nodes.Source.create({ label: id, retracted: false }, { id });
    await store.nodes.Fact.create(
      { label: `${id}-only` },
      { id: `${id}-only` },
    );
  }
  await store.nodes.Fact.create({ label: "shared" }, { id: "shared" });
  for (const [justification, source, fact] of [
    ["a-only-j", "a", "a-only"],
    ["b-only-j", "b", "b-only"],
    ["shared-a-j", "a", "shared"],
    ["shared-b-j", "b", "shared"],
  ] as const) {
    await store.nodes.Justification.create(
      { label: justification },
      { id: justification },
    );
    await store.edges.premiseOf.create(
      { kind: "Source", id: source },
      { kind: "Justification", id: justification },
      {},
    );
    await store.edges.derives.create(
      { kind: "Justification", id: justification },
      { kind: "Fact", id: fact },
      {},
    );
  }
  const provenance = createRetractionCapability(store, config);

  connection.exec("BEGIN");
  const outcomes = await Promise.allSettled(
    ["a", "b"].map((id) =>
      store.withRecordedTransaction(
        connectionDb as never,
        (tx: AdoptedTransaction) =>
          provenance.retract({ kind: "Source", id }, tx),
      ),
    ),
  );
  connection.exec("COMMIT");

  // Neither adoption was refused as overlapping: they share no state.
  const refusals = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [String(outcome.reason)] : [],
  );
  expect(
    refusals.filter((reason) =>
      reason.includes("PROVENANCE_TRANSITION_OVERLAPPING"),
    ),
  ).toEqual([]);
  const flags = await store.nodes.Source.find();
  expect(
    flags.map((source) => [source.id, source.retracted]).toSorted(),
  ).toEqual([
    ["a", true],
    ["b", true],
  ]);
  const live = await store.nodes.Fact.find();
  expect(live.map((fact) => fact.id)).toEqual([]);
  expect(await provenance.holding()).toEqual([]);
  expect(await store.verifyConstraintFences()).toEqual([]);
});
