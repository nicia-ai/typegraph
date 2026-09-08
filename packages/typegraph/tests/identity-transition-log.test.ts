/**
 * The transition log's write plumbing: one note per structural cause, buffered
 * through recorded-capture checkpoint/restore exactly like every other touch,
 * sealed with the session, and absent entirely with `history: false`.
 *
 * `readIdentityTransitions` reads by module path — internal, PR-1 (no public
 * `store.identity.transitionsOf` yet).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createAdapterStoreWithSchema,
  defineGraph,
  defineGraphExtension,
  defineNode,
  type GraphDef,
} from "../src";
import { applyIdentityChangesForContext } from "../src/identity/service-interchange-write";
import { type IdentityServiceContext } from "../src/identity/service-types";
import {
  pruneIdentityTransitions,
  pruneIdentityTransitionsForContext,
  readIdentityTransitions,
} from "../src/identity/transition-log";
import { storeRuntime } from "../src/store/runtime-port";
import { generateId } from "../src/utils/id";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "identity_transition_log",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

const PERSON_CLASS_REFS = [
  { kind: "Person", id: "a" },
  { kind: "Person", id: "b" },
  { kind: "Person", id: "c" },
];

function readTransitions<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  classReferences: readonly Readonly<{
    kind: string;
    id: string;
  }>[] = PERSON_CLASS_REFS,
) {
  return readIdentityTransitions(ctx.backend, ctx.schema, ctx.graphId, {
    classRefs: classReferences,
    limit: 200,
  });
}

describe("identity transition log", () => {
  it("notes an assert transition when assertSame fuses two singletons", async () => {
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
      { history: true },
    );
    await store.nodes.Person.create({ name: "A" }, { id: "a" });
    await store.nodes.Person.create({ name: "B" }, { id: "b" });
    await store.identity.assertSame(
      { kind: "Person", id: "a" },
      { kind: "Person", id: "b" },
    );
    const ctx = storeRuntime(store).identityContext();
    const rows = await readTransitions(ctx);
    const assertRows = rows.filter((row) => row.cause === "assert");
    expect(assertRows.length).toBeGreaterThanOrEqual(1);
    expect(assertRows[0]?.assertion_ids.length).toBe(1);
  });

  it("notes a retract transition when a same assertion is retracted", async () => {
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
      { history: true },
    );
    await store.nodes.Person.create({ name: "A" }, { id: "a" });
    await store.nodes.Person.create({ name: "B" }, { id: "b" });
    const asserted = await store.identity.assertSame(
      { kind: "Person", id: "a" },
      { kind: "Person", id: "b" },
    );
    await store.identity.retractAssertion(asserted.assertion.id);
    const ctx = storeRuntime(store).identityContext();
    const rows = await readTransitions(ctx);
    const retractRows = rows.filter((row) => row.cause === "retract");
    // A 2-member class fully dissolving into two singletons produces TWO
    // records — one per departing member, since NEITHER retains the other as
    // a class-mate to carry the reverse-lineage hop (see diffClosureTransitions'
    // same-canonical-but-shrunk-membership rule, proven load-bearing by the
    // exhaustiveness property test). Every record still names the retracted
    // assertion.
    expect(retractRows.length).toBe(2);
    for (const row of retractRows) {
      expect(row.assertion_ids).toEqual([asserted.assertion.id]);
    }
  });

  it("notes a fold transition for a same-id cross-kind create, and a restore transition on resurrection", async () => {
    const Org = defineNode("Org", { schema: z.object({ name: z.string() }) });
    const foldGraph = defineGraph({
      id: "identity_transition_log_fold",
      nodes: { Person: { type: Person }, Org: { type: Org } },
      edges: {},
      identity: { sameIdAcrossKinds: "fold" },
    });
    const [store] = await createAdapterStoreWithSchema(
      foldGraph,
      createTestBackend(),
      { history: true },
    );
    await store.nodes.Person.create({ name: "A" }, { id: "shared" });
    await store.nodes.Org.create({ name: "A Org" }, { id: "shared" });
    const ctx = storeRuntime(store).identityContext();
    const sharedReferences = [
      { kind: "Person", id: "shared" },
      { kind: "Org", id: "shared" },
    ];
    const rows = await readTransitions(ctx, sharedReferences);
    const foldRows = rows.filter((row) => row.cause === "fold");
    expect(foldRows.length).toBeGreaterThanOrEqual(1);

    await store.nodes.Org.delete(asNodeId("shared"));
    await store.nodes.Org.create({ name: "A Org 2" }, { id: "shared" });
    const afterRestore = await readTransitions(ctx, sharedReferences);
    const restoreRows = afterRestore.filter((row) => row.cause === "restore");
    expect(restoreRows.length).toBeGreaterThanOrEqual(1);
  });

  it("notes a detach transition when a member of a class is soft-deleted", async () => {
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
      { history: true },
    );
    await store.nodes.Person.create({ name: "A" }, { id: "a" });
    await store.nodes.Person.create({ name: "B" }, { id: "b" });
    await store.identity.assertSame(
      { kind: "Person", id: "a" },
      { kind: "Person", id: "b" },
    );
    await store.nodes.Person.delete(asNodeId("a"));
    const ctx = storeRuntime(store).identityContext();
    const rows = await readTransitions(ctx);
    const detachRows = rows.filter((row) => row.cause === "detach");
    expect(detachRows.length).toBeGreaterThanOrEqual(1);
  });

  it("writes zero transition rows with history: false", async () => {
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
      { history: false },
    );
    await store.nodes.Person.create({ name: "A" }, { id: "a" });
    await store.nodes.Person.create({ name: "B" }, { id: "b" });
    await store.identity.assertSame(
      { kind: "Person", id: "a" },
      { kind: "Person", id: "b" },
    );
    const ctx = storeRuntime(store).identityContext();
    const rows = await readTransitions(ctx, [{ kind: "Person", id: "a" }]);
    expect(rows.length).toBe(0);
  });

  it("a rebuild writes no transition; a prune writes none and advances the watermark", async () => {
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
      { history: true },
    );
    await store.nodes.Person.create({ name: "A" }, { id: "a" });
    await store.nodes.Person.create({ name: "B" }, { id: "b" });
    await store.identity.assertSame(
      { kind: "Person", id: "a" },
      { kind: "Person", id: "b" },
    );
    const ctx = storeRuntime(store).identityContext();
    const before = await readTransitions(ctx);
    await storeRuntime(store).rebuildIdentityClosure();
    const afterRebuild = await readTransitions(ctx);
    expect(afterRebuild.length).toBe(before.length);

    // beforeRecorded prunes rows strictly BEFORE that revision, so the
    // watermark must be advanced past the assert's own commit — one more
    // write, then read the new high-water mark.
    await store.nodes.Person.create({ name: "C" }, { id: "c" });
    const recordedNow = await store.recordedNow();
    if (recordedNow === undefined) {
      throw new Error("expected a recorded instant");
    }
    const pruneResult = await pruneIdentityTransitionsForContext(ctx, {
      beforeRecorded: recordedNow,
    });
    expect(pruneResult.pruned).toBe(before.length);
    const afterPrune = await readTransitions(ctx);
    expect(afterPrune.length).toBe(0);
  });

  it("pruneIdentityTransitions(store, options) — the Store-based public shape — prunes through the same path", async () => {
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
      { history: true },
    );
    await store.nodes.Person.create({ name: "A" }, { id: "a" });
    await store.nodes.Person.create({ name: "B" }, { id: "b" });
    await store.identity.assertSame(
      { kind: "Person", id: "a" },
      { kind: "Person", id: "b" },
    );
    await store.nodes.Person.create({ name: "C" }, { id: "c" });
    const recordedNow = await store.recordedNow();
    if (recordedNow === undefined) {
      throw new Error("expected a recorded instant");
    }
    const pruneResult = await pruneIdentityTransitions(store, {
      beforeRecorded: recordedNow,
    });
    expect(pruneResult.pruned).toBeGreaterThanOrEqual(1);
    const ctx = storeRuntime(store).identityContext();
    const afterPrune = await readTransitions(ctx);
    expect(afterPrune.length).toBe(0);
  });

  it("notes a window-end transition when a class member's validity window is narrowed", async () => {
    // Fold-based class, not an explicit assertion: an assertion's own valid-time
    // window would have to end BEFORE the node's proposed validTo, or
    // requireNodeValidityEndCompatible refuses the write outright (correctly —
    // that refusal is the guard this note site sits behind). Same-id folding
    // carries no assertion window to conflict with.
    const Org = defineNode("Org", { schema: z.object({ name: z.string() }) });
    const foldGraph = defineGraph({
      id: "identity_transition_log_window_end",
      nodes: { Person: { type: Person }, Org: { type: Org } },
      edges: {},
      identity: { sameIdAcrossKinds: "fold" },
    });
    const [store] = await createAdapterStoreWithSchema(
      foldGraph,
      createTestBackend(),
      { history: true },
    );
    await store.nodes.Person.create({ name: "A" }, { id: "shared" });
    await store.nodes.Org.create({ name: "A Org" }, { id: "shared" });
    const farFuture = new Date(Date.now() + 1_000_000_000).toISOString();
    await store.nodes.Person.update(
      asNodeId("shared"),
      {},
      { validTo: farFuture },
    );
    const ctx = storeRuntime(store).identityContext();
    const rows = await readTransitions(ctx, [
      { kind: "Person", id: "shared" },
      { kind: "Org", id: "shared" },
    ]);
    const windowEndRows = rows.filter((row) => row.cause === "window-end");
    expect(windowEndRows.length).toBeGreaterThanOrEqual(1);
  });

  it("notes a kind-drop transition when Store.removeKinds() cascades a folded class", async () => {
    const extensionGraph = defineGraph({
      id: "identity_transition_log_kind_drop",
      nodes: { Person: { type: Person } },
      edges: {},
      identity: { sameIdAcrossKinds: "fold" },
    });
    const [store] = await createAdapterStoreWithSchema(
      extensionGraph,
      createTestBackend(),
      { history: true },
    );
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const person = await evolved.nodes.Person.create({ name: "Alice" });
    const tag = await evolved.getNodeCollectionOrThrow("Tag").create({
      label: "author",
    });
    await evolved.identity.assertSame(person, tag);

    const removed = await evolved.removeKinds(["Tag"]);
    const ctx = storeRuntime(removed).identityContext();
    const rows = await readIdentityTransitions(
      ctx.backend,
      ctx.schema,
      ctx.graphId,
      {
        classRefs: [
          { kind: "Person", id: person.id },
          { kind: "Tag", id: tag.id },
        ],
        limit: 200,
      },
    );
    const kindDropRows = rows.filter((row) => row.cause === "kind-drop");
    expect(kindDropRows.length).toBeGreaterThanOrEqual(1);
  });

  it("notes a reconcile transition, carrying decision provenance, for a governed apply", async () => {
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
      { history: true },
    );
    await store.nodes.Person.create({ name: "A" }, { id: "a" });
    await store.nodes.Person.create({ name: "B" }, { id: "b" });
    const ctx = storeRuntime(store).identityContext();
    const assertionId = generateId();
    const now = new Date().toISOString();
    await applyIdentityChangesForContext(
      ctx,
      [],
      [
        {
          id: assertionId,
          relation: "same",
          a: { kind: "Person", id: "a" },
          b: { kind: "Person", id: "b" },
          validFrom: now,
        },
      ],
      { policy: "test:reconcile", mergePlanDigest: "digest-abc" },
    );
    const rows = await readTransitions(ctx);
    const reconcileRows = rows.filter((row) => row.cause === "reconcile");
    expect(reconcileRows.length).toBeGreaterThanOrEqual(1);
    expect(reconcileRows[0]?.assertion_ids).toEqual([assertionId]);
    expect(reconcileRows[0]?.decision).toEqual({
      policy: "test:reconcile",
      mergePlanDigest: "digest-abc",
    });
  });
});
