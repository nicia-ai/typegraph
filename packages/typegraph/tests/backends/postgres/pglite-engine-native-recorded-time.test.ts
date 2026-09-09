/**
 * Engine-native recorded time — PostgreSQL SIMULATION, PGlite lane.
 *
 * See `engine-native-recorded-time-simulation.ts` for what "simulation"
 * means here, why it is trustworthy evidence for the real
 * `GraphBackend.recordedTime` contract, and why the scenario is shared with
 * the server-lane counterpart (`engine-native-recorded-time.test.ts`, gated
 * on `POSTGRES_URL`).
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import {
  type EngineRecordedRevision,
  type EngineRecordedTimeMembers,
} from "../../../src/backend/capabilities/recorded-time";
import { generateVectorlessPostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createSqlBackend } from "../../../src/backend/drizzle/engine";
import { buildPostgresEngineProfile } from "../../../src/backend/drizzle/postgres";
import {
  type EngineRevision,
  type LineageMembers,
  type TransactionBackend,
} from "../../../src/backend/types";
import { sql } from "../../../src/query/sql-fragment";
import { createMutationWitness } from "../../../src/store/recorded-capture";
import { attachEngineNativeRecordedTime } from "../../engine-native-recorded-time-fixture";
import {
  buildEngineNativeSimulation,
  runEngineNativeSimulationScenario,
} from "./engine-native-recorded-time-simulation";

describe("engine-native recorded time (PostgreSQL simulation, PGlite)", () => {
  let pglite: PGlite | undefined;

  afterEach(async () => {
    await pglite?.close();
    pglite = undefined;
  });

  it("reconstructs a capturing store's recorded history through a simulated engine-native profile on the SAME database", async () => {
    pglite = await PGlite.create();
    await pglite.exec(generateVectorlessPostgresMigrationSQL());
    const simulation = await buildEngineNativeSimulation(drizzle(pglite));
    await runEngineNativeSimulationScenario(simulation);
  });
});

const Widget = defineNode("Widget", {
  schema: z.object({ label: z.string() }),
});
const knows = defineEdge("knows", { schema: z.object({}) });
const receiptGraph = defineGraph({
  id: "engine_native_recorded_time_receipts_pglite",
  nodes: { Widget: { type: Widget } },
  edges: { knows: { type: knows, from: [Widget], to: [Widget] } },
});

// A separate node/graph, scoped to the `getOrCreateByConstraint` receipt
// case below: the uniqueness constraint that case needs is irrelevant (and
// a small collision risk) for the other cases, which share `receiptGraph`/
// `Widget` freely.
const UniqueWidget = defineNode("UniqueWidget", {
  schema: z.object({ label: z.string() }),
});
const uniqueReceiptGraph = defineGraph({
  id: "engine_native_recorded_time_receipts_pglite_unique",
  nodes: {
    UniqueWidget: {
      type: UniqueWidget,
      unique: [
        {
          name: "label_key",
          fields: ["label"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

// A separate node/graph, scoped to the identity-only receipt case below:
// `store.identity` exists only when `defineGraph` declares `identity`, and
// a cross-kind fold needs two node kinds.
const PersonRecord = defineNode("PersonRecord", {
  schema: z.object({ name: z.string() }),
});
const AuthorRecord = defineNode("AuthorRecord", {
  schema: z.object({ penName: z.string() }),
});
const identityReceiptGraph = defineGraph({
  id: "engine_native_recorded_time_receipts_pglite_identity",
  nodes: {
    PersonRecord: { type: PersonRecord },
    AuthorRecord: { type: AuthorRecord },
  },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

const ENGINE_REVISION: EngineRecordedRevision = {
  revision: "engine-r1",
  recordedAt: "2026-01-01T00:00:00.000Z",
};

function scriptedLineage(): LineageMembers {
  return {
    revision: () => Promise.resolve("engine-r0" as EngineRevision),
    changesSince: () => Promise.resolve({ kind: "unbounded" }),
  };
}

/**
 * A SCRIPTED (not simulated) engine-native profile over a fresh in-process
 * PGlite database — the PostgreSQL-family counterpart to
 * `engine-native-recorded-time.test.ts`'s `createEngineNativeBackend`, built
 * the same way for the same reason: these receipt cases need only a
 * `revisionNow` that records which session called it and answers a fixed
 * revision, not `engine-native-recorded-time-simulation.ts`'s full
 * recorded-relations-backed temporal source.
 */
async function createEngineNativeReceiptBackend(
  db: PGlite,
  observedSessions: TransactionBackend[],
) {
  await db.exec(generateVectorlessPostgresMigrationSQL());
  const profile = buildPostgresEngineProfile(drizzle(db), { vector: false });
  const recordedTime: EngineRecordedTimeMembers = {
    source: (table) => sql.raw(`__engine_native_${table}__`),
    revisionNow: (session) => {
      observedSessions.push(session as TransactionBackend);
      return Promise.resolve(ENGINE_REVISION);
    },
  };
  attachEngineNativeRecordedTime(
    profile.provisioning,
    recordedTime,
    scriptedLineage(),
  );
  return createSqlBackend(profile);
}

describe("engine-native recorded time: transaction receipts (PGlite)", () => {
  let pglite: PGlite | undefined;

  afterEach(async () => {
    await pglite?.close();
    pglite = undefined;
  });

  /**
   * The three collection calls that always count as a write INTENT (the
   * collection-level counters `receipt.writes` is built from) even when
   * nothing changed: a delete of a missing id (`executeNodeDelete` gates on
   * existence before ever calling `backend.deleteNode`, so the collection
   * method resolves having called no write member at all), a
   * `getOrCreateByConstraint` that finds the row (`action: "found"` — its
   * intent counter fires the same whether it created or found, since the
   * count is pinned before the call resolves), and a
   * `coalesceUnchangedUpserts`-skipped upsert (the write pipeline never
   * calls any backend write member at all). Each must leave
   * `receipt.recorded` undefined and take no `revisionNow` round trip.
   * MUTATION-PROOF for all three: reverting the two `store.ts` receipt sites
   * from the mutation witness back to
   * `receiptRecorder?.snapshot().writes.total !== 0` makes every case in
   * this block fail — `receipt.recorded` becomes a defined `e1:` instant and
   * `observedSessions` gains an entry for a transaction that changed no
   * row.
   */
  it("stamps no recorded instant for a delete of a missing id", async () => {
    pglite = await PGlite.create();
    const observedSessions: TransactionBackend[] = [];
    const backend = await createEngineNativeReceiptBackend(
      pglite,
      observedSessions,
    );
    const [store] = await createStoreWithSchema(receiptGraph, backend, {
      history: true,
    });

    const outcome = await store.transactionWithReceipt(async (tx) => {
      await tx.nodes.Widget.delete("missing-id" as never);
    });

    expect(outcome.receipt.recorded).toBeUndefined();
    expect(observedSessions).toHaveLength(0);
  });

  it("stamps no recorded instant when getOrCreateByConstraint finds the row already occupied", async () => {
    pglite = await PGlite.create();
    const observedSessions: TransactionBackend[] = [];
    const backend = await createEngineNativeReceiptBackend(
      pglite,
      observedSessions,
    );
    const [store] = await createStoreWithSchema(uniqueReceiptGraph, backend, {
      history: true,
    });
    await store.transaction(async (tx) => {
      await tx.nodes.UniqueWidget.getOrCreateByConstraint("label_key", {
        label: "w1",
      });
    });
    const baselineSessions = observedSessions.length;

    const outcome = await store.transactionWithReceipt(async (tx) => {
      const result = await tx.nodes.UniqueWidget.getOrCreateByConstraint(
        "label_key",
        { label: "w1" },
      );
      expect(result.action).toBe("found");
    });

    expect(outcome.receipt.recorded).toBeUndefined();
    expect(observedSessions).toHaveLength(baselineSessions);
  });

  it("stamps no recorded instant for a coalesced unchanged upsert", async () => {
    pglite = await PGlite.create();
    const observedSessions: TransactionBackend[] = [];
    const backend = await createEngineNativeReceiptBackend(
      pglite,
      observedSessions,
    );
    const [store] = await createStoreWithSchema(receiptGraph, backend, {
      history: true,
      coalesceUnchangedUpserts: true,
    });
    await store.transaction(async (tx) => {
      await tx.nodes.Widget.upsertById("w1", { label: "same" });
    });
    const baselineSessions = observedSessions.length;

    const outcome = await store.transactionWithReceipt(async (tx) => {
      await tx.nodes.Widget.upsertById("w1", { label: "same" });
    });

    expect(outcome.receipt.recorded).toBeUndefined();
    expect(observedSessions).toHaveLength(baselineSessions);
  });

  it("stamps an e1: receipt for a real create", async () => {
    pglite = await PGlite.create();
    const observedSessions: TransactionBackend[] = [];
    const backend = await createEngineNativeReceiptBackend(
      pglite,
      observedSessions,
    );
    const [store] = await createStoreWithSchema(receiptGraph, backend, {
      history: true,
    });

    const outcome = await store.transactionWithReceipt(async (tx) => {
      await tx.nodes.Widget.create({ label: "hello" });
    });

    expect(outcome.receipt.recorded).toBeDefined();
    expect(observedSessions).toHaveLength(1);
  });

  /**
   * Identity assertions bypass `buildRecordedWriteMembers`'s overlay
   * entirely — `withRecordedIdentityMutationTarget` resolves the mutation
   * witness through the WeakMap binding `registerRecordedIdentityMutationWitness`
   * installs in store.ts, not through a wrapped write member. MUTATION-PROOF:
   * reverting `withRecordedIdentityMutationTarget` (`recorded-capture.ts`) to
   * read off a binding never registered for an engine-native transaction — or
   * removing the `registerRecordedIdentityMutationWitness` call at either
   * store.ts receipt site — makes this test fail: `receipt.recorded` comes
   * back `undefined` and `observedSessions` gains no entry, even though the
   * identity assertion committed.
   */
  it("stamps a recorded instant for a transaction whose only write is an identity assertion", async () => {
    pglite = await PGlite.create();
    const observedSessions: TransactionBackend[] = [];
    const backend = await createEngineNativeReceiptBackend(
      pglite,
      observedSessions,
    );
    const [store] = await createStoreWithSchema(identityReceiptGraph, backend, {
      history: true,
    });
    const person = await store.nodes.PersonRecord.create({ name: "Ada" });
    const author = await store.nodes.AuthorRecord.create({
      penName: "A. Lovelace",
    });
    const baselineSessions = observedSessions.length;

    const outcome = await store.transactionWithReceipt(async (tx) => {
      await tx.identity.assertSame(person, author);
    });

    expect(outcome.receipt.writes.identity.total).toBe(1);
    expect(outcome.receipt.recorded).toBeDefined();
    expect(observedSessions).toHaveLength(baselineSessions + 1);
  });

  /**
   * `createMutationWitness().wrap` uses `deriveBackend`, not
   * `deriveTransactionSessionBackend`, so wrapping a session that declared
   * `atomicBatch: "session"` (PostgreSQL-family backends inside an open
   * transaction) downgrades it to `"none"` on the wrapped object — a
   * deliberate choice documented on `createMutationWitness`'s doc comment:
   * an atomic batch program bypasses the overlay's individual write members,
   * so a write issued through it would commit unobserved by the witness.
   * MUTATION-PROOF: swapping `wrap`'s `deriveBackend` call for
   * `deriveTransactionSessionBackend` makes this test fail — the second
   * entry becomes `"session"` instead of `"none"`.
   */
  it("wrapping the committing session for the mutation witness downgrades session atomic-batch authority", async () => {
    pglite = await PGlite.create();
    const backend = await createEngineNativeReceiptBackend(pglite, []);

    const capabilitiesSeen: string[] = [];
    await backend.transaction((txBackend) => {
      capabilitiesSeen.push(txBackend.capabilities.execution.atomicBatch);
      const witness = createMutationWitness();
      const wrapped = witness.wrap(txBackend);
      capabilitiesSeen.push(wrapped.capabilities.execution.atomicBatch);
      return Promise.resolve();
    });

    expect(capabilitiesSeen).toEqual(["session", "none"]);
  });
});
