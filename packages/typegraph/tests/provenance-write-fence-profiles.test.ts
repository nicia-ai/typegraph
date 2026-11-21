/**
 * Provenance's freshness check on the two in-process write-fence profiles that
 * run no PostgreSQL server: a PostgreSQL pool declaring `caller-serialized`
 * (PGlite) and a SQLite backend declaring a keyed `row` fence.
 *
 * The check refuses exactly where a second writer can commit between a
 * transaction's snapshot and its graph write lock
 * (`refuseWriterBetweenSnapshotAndGraphLock`). A `caller-serialized`
 * deployment runs every write unit alone, so it needs no isolation evidence
 * and every verb runs. A `row` fence is a keyed exclusion for an engine with no
 * writer slot of its own; on SQLite its acquisition cannot report the session's
 * isolation (`unknown`), so the verbs are refused before their first read,
 * exactly as the store already refuses an edge-acyclicity probe there. The
 * PostgreSQL snapshot-isolation cases live in
 * `tests/backends/postgres/provenance-stale-snapshot.test.ts`.
 *
 * `tx.assertUnchangedSince()` shares the evidence judgement
 * (`requireFreshSnapshotAfterGraphLock`) but not the declared-serialization
 * admission: it refuses both profiles, as it did before provenance used it.
 *
 * Revert check: make `refuseWriterBetweenSnapshotAndGraphLock` call
 * `requireFreshSnapshotAfterGraphLock` without the `serializesWriters`
 * admission; every caller-serialized case fails with
 * `observedReadCommittedIsolation`. Make it return without a check; every
 * row-fence refusal case fails because the verb runs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import type { BackendCapabilities } from "../src/backend/types";
import { UnsupportedBackendCapabilityError } from "../src/errors-entry";
import { createRetractionCapability } from "../src/provenance";
import { requireDefined } from "../src/utils/presence";
import {
  createLoggedPostgresBackend,
  createLoggedSqliteBackend,
  type LoggedBackend,
} from "./lock-fence-test-utils";

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
  id: "provenance_write_fence_profiles",
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

const FACT = { kind: "Fact", id: "fact" } as const;
const OTHER_FACT = { kind: "Fact", id: "other-fact" } as const;

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const CALLER_SERIALIZED_POSTGRES: Partial<BackendCapabilities> = {
  writeFence: { mechanism: "caller-serialized" },
};

const SQLITE_ROW_FENCE: Partial<BackendCapabilities> = {
  writeFence: { mechanism: "row", drain: "quiescent", conflict: "wait" },
};

async function seed(create: () => Promise<LoggedBackend>) {
  const logged = await create();
  closers.push(() => logged.close());
  const [store] = await createStoreWithSchema(graph, logged.backend, {
    history: true,
  });
  async function supported(id: string, factId: string) {
    const source = await store.nodes.Source.create(
      { label: id, retracted: false },
      { id },
    );
    const fact = await store.nodes.Fact.create(
      { label: factId },
      { id: factId },
    );
    const justification = await store.nodes.Justification.create(
      { label: `${id}-j` },
      { id: `${id}-j` },
    );
    await store.edges.premiseOf.create(source, justification);
    await store.edges.derives.create(justification, fact);
    return source;
  }
  const source = await supported("source", FACT.id);
  const otherSource = await supported("other-source", OTHER_FACT.id);
  return {
    store,
    source,
    otherSource,
    provenance: createRetractionCapability(store, config),
  };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function liveFact(store: Seeded["store"], id: string) {
  return store.nodes.Fact.getById(asNodeId<typeof Fact>(id));
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: unknown) => error,
  );
}

function expectFreshnessRefusal(error: unknown, operation: string): void {
  expect(error).toBeInstanceOf(UnsupportedBackendCapabilityError);
  expect((error as UnsupportedBackendCapabilityError).details).toMatchObject({
    operation,
    capability: "observedReadCommittedIsolation",
  });
}

async function assertUnchangedSinceRefusal(seeded: Seeded): Promise<unknown> {
  const anchor = requireDefined(
    await seeded.store.lineageRevisionNow(),
    "a history store mints a lineage anchor",
  );
  return rejection(
    seeded.store.transaction((tx) =>
      tx.assertUnchangedSince(anchor, [{ nodeKind: "Fact" }]),
    ),
  );
}

function seedCallerSerialized() {
  return seed(() => createLoggedPostgresBackend(CALLER_SERIALIZED_POSTGRES));
}

function seedRowFence() {
  return seed(() =>
    Promise.resolve(createLoggedSqliteBackend(SQLITE_ROW_FENCE)),
  );
}

describe("provenance on a caller-serialized PostgreSQL write fence (PGlite)", () => {
  it("retract(source) closes the fact it supported", async () => {
    const { store, source, provenance } = await seedCallerSerialized();

    await provenance.retract(source);

    await expect(liveFact(store, FACT.id)).resolves.toBeUndefined();
    await expect(liveFact(store, OTHER_FACT.id)).resolves.toBeDefined();
  });

  it("retract(source, tx), assertHolds(tx) and holding(tx) run in a caller's transaction", async () => {
    const { store, source, provenance } = await seedCallerSerialized();

    const outcome = await store.transaction(async (tx) => {
      await provenance.assertHolds(tx, [FACT, OTHER_FACT]);
      const before = await provenance.holding(tx);
      await provenance.retract(source, tx);
      return { before, after: await provenance.holding(tx) };
    });

    expect(outcome.before).toEqual([FACT, OTHER_FACT]);
    expect(outcome.after).toEqual([OTHER_FACT]);
    await expect(liveFact(store, FACT.id)).resolves.toBeUndefined();
  });

  it("tx.assertUnchangedSince() still refuses it (control: unchanged by this rule)", async () => {
    const seeded = await seedCallerSerialized();

    expectFreshnessRefusal(
      await assertUnchangedSinceRefusal(seeded),
      "tx.assertUnchangedSince()",
    );
  });
});

describe("provenance on a SQLite backend declaring a keyed row write fence", () => {
  it("refuses retract(source) before writing, naming the unobserved isolation", async () => {
    const { store, source, provenance } = await seedRowFence();

    const error = await rejection(provenance.retract(source));

    expectFreshnessRefusal(error, "provenance retraction transition");
    expect((error as UnsupportedBackendCapabilityError).details).toMatchObject({
      isolation: "unknown",
    });
    await expect(
      store.nodes.Source.getById(asNodeId<typeof Source>(source.id)),
    ).resolves.toMatchObject({ retracted: false });
    await expect(liveFact(store, FACT.id)).resolves.toBeDefined();
  });

  it("refuses retract(source, tx), assertHolds(tx) and holding(tx) in a caller's transaction before any read, leaving it usable", async () => {
    const { store, source, provenance } = await seedRowFence();

    const outcome = await store.transaction(async (tx) => {
      const retract = await rejection(provenance.retract(source, tx));
      const assertHolds = await rejection(provenance.assertHolds(tx, [FACT]));
      const holding = await rejection(provenance.holding(tx));
      const stillUsable = await tx.nodes.Fact.getById(
        asNodeId<typeof Fact>(FACT.id),
      );
      return { retract, assertHolds, holding, stillUsable };
    });

    expectFreshnessRefusal(outcome.retract, "provenance.retract(source, tx)");
    expectFreshnessRefusal(outcome.assertHolds, "provenance.assertHolds()");
    expectFreshnessRefusal(outcome.holding, "provenance.holding(tx)");
    expect(outcome.stillUsable).toMatchObject({ id: FACT.id });
    await expect(liveFact(store, FACT.id)).resolves.toBeDefined();
  });

  it("holding(tx) in a read-only transaction still answers (control: read-only reads take no freshness check)", async () => {
    const { store, provenance } = await seedRowFence();

    const held = await store.transaction(async (tx) => provenance.holding(tx), {
      accessMode: "read_only",
    });

    expect(held).toEqual([FACT, OTHER_FACT]);
  });

  it("tx.assertUnchangedSince() refuses it as before (control: unchanged by this rule)", async () => {
    const seeded = await seedRowFence();

    expectFreshnessRefusal(
      await assertUnchangedSinceRefusal(seeded),
      "tx.assertUnchangedSince()",
    );
  });
});
