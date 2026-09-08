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
  ConfigurationError,
  createAdapterStoreWithSchema,
  createStoreWithSchema,
  defineGraph,
  defineGraphExtension,
  defineNode,
  type GraphDef,
} from "../src";
import {
  batchPointReadVerdict,
  statementExecutionVerdict,
} from "../src/backend/capabilities/resolve";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import {
  type RecordedInstant,
  recordedInstantRevision,
} from "../src/core/temporal";
import { applyIdentityChangesForContext } from "../src/identity/service-interchange-write";
import { type IdentityServiceContext } from "../src/identity/service-types";
import {
  pruneIdentityTransitions,
  pruneIdentityTransitionsForContext,
  readIdentityTransitions,
} from "../src/identity/transition-log";
import { createSqlSchema } from "../src/query/compiler/schema";
import {
  createRecordedTransactionScope,
  runRecordedTransactionSavepoint,
  withRecordedIdentityMutationTarget,
} from "../src/store/recorded-capture";
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

function requireRecordedNow(
  recordedNow: RecordedInstant | undefined,
): RecordedInstant {
  if (recordedNow === undefined) {
    throw new Error("expected a recorded instant");
  }
  return recordedNow;
}

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

  it("checkpoints and restores buffered identity-transition notes exactly like every other touch", async () => {
    // §2.5: `noteIdentityTransition` "buffers alongside `touched`, is included
    // in `checkpoint()` / `restore()` exactly as `touched` is". The only
    // shipped rollback seam over a capture session is
    // `runRecordedTransactionSavepoint` (used today by the archival import's
    // per-edge retry, which never touches identity) — so this drives it
    // directly, through `createRecordedTransactionScope` (both exported for
    // exactly this kind of capture-session test; see
    // `recorded-capture-write-parity.test.ts`), to prove a note taken inside
    // a savepoint that rolls back never reaches the flushed table, while one
    // taken inside a savepoint that releases does.
    const backend = createTestBackend();
    const statementExecution = statementExecutionVerdict(backend);
    expect(statementExecution.supported).toBe(true);
    if (!statementExecution.supported) return;
    const schema = createSqlSchema(backend.tableNames);
    const graphId = "identity_transition_log_checkpoint";
    const rolledBackDraft = {
      cause: "fold",
      classRef: { kind: "Person", id: "rolled-back" },
      assertionIds: [],
      validAt: new Date().toISOString(),
    } as const;
    const releasedDraft = {
      cause: "fold",
      classRef: { kind: "Person", id: "released" },
      assertionIds: [],
      validAt: new Date().toISOString(),
    } as const;

    await backend.transaction(async (target) => {
      const scope = createRecordedTransactionScope(
        target,
        batchPointReadVerdict(backend),
        schema,
      );
      await runRecordedTransactionSavepoint(
        scope.backend,
        statementExecution,
        "typegraph_identity_transition_checkpoint_test",
        async () => {
          await withRecordedIdentityMutationTarget(
            scope.backend,
            (_rawTarget, _touch, noteTransition) => {
              noteTransition(graphId, rolledBackDraft);
              return Promise.resolve();
            },
          );
          return {
            action: "rollback",
            value: undefined,
            cause: new Error("expected test rollback"),
          };
        },
      );
      await withRecordedIdentityMutationTarget(
        scope.backend,
        (_rawTarget, _touch, noteTransition) => {
          noteTransition(graphId, releasedDraft);
          return Promise.resolve();
        },
      );
      await scope.flush();
    });

    const rows = await readIdentityTransitions(backend, schema, graphId, {
      classRefs: [rolledBackDraft.classRef, releasedDraft.classRef],
      limit: 200,
    });
    expect(rows.map((row) => row.class_id)).toEqual(["released"]);
  });

  it("throws the sealed-session ConfigurationError for a note taken after flush", async () => {
    // §2.5: `noteIdentityTransition` "throws the same already-sealed
    // `ConfigurationError` after `flush`" — `noteIdentityTransition`
    // (`RecordedCaptureSession`) carries its own copy of that check (with
    // `{ entity: "identity-transition", graphId }` details), but
    // `withRecordedIdentityMutationTarget` calls `session.assertOpen()`
    // BEFORE handing the caller its `noteTransition` callback, so a
    // synchronous note-after-flush attempt through the shipped seam observes
    // that generic sealed error first — the SAME error class and message the
    // design promises, whichever of the two checks actually fires.
    const backend = createTestBackend();
    const statementExecution = statementExecutionVerdict(backend);
    expect(statementExecution.supported).toBe(true);
    if (!statementExecution.supported) return;
    const schema = createSqlSchema(backend.tableNames);
    const graphId = "identity_transition_log_sealed";

    await backend.transaction(async (target) => {
      const scope = createRecordedTransactionScope(
        target,
        batchPointReadVerdict(backend),
        schema,
      );
      await scope.flush();
      let caught: unknown;
      try {
        await withRecordedIdentityMutationTarget(
          scope.backend,
          (_rawTarget, _touch, noteTransition) => {
            noteTransition(graphId, {
              cause: "fold",
              classRef: { kind: "Person", id: "too-late" },
              assertionIds: [],
              validAt: new Date().toISOString(),
            });
            return Promise.resolve();
          },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigurationError);
      expect((caught as ConfigurationError).message).toMatch(/sealed/i);
    });
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

  it("a rebuild writes no transition and advances no revision; a prune writes none and ALSO advances no revision", async () => {
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
    const beforeRebuildRevision = recordedInstantRevision(
      requireRecordedNow(await store.recordedNow()),
    );
    await storeRuntime(store).rebuildIdentityClosure();
    const afterRebuild = await readTransitions(ctx);
    expect(afterRebuild.length).toBe(before.length);
    // A rebuild follows the SAME non-advancing contract as a prune: it
    // recomputes derived state from unchanged truth and never advances the
    // content revision — pinned here in the same direction pruning is pinned
    // below, so a regression that starts advancing EITHER one fails loudly.
    expect(
      recordedInstantRevision(requireRecordedNow(await store.recordedNow())),
    ).toBe(beforeRebuildRevision);

    // beforeRecorded prunes rows strictly BEFORE that revision, so the
    // watermark must be advanced past the assert's own commit — one more
    // write, then read the new high-water mark.
    await store.nodes.Person.create({ name: "C" }, { id: "c" });
    const recordedNow = requireRecordedNow(await store.recordedNow());
    const revisionBeforePrune = recordedInstantRevision(recordedNow);
    const pruneResult = await pruneIdentityTransitionsForContext(ctx, {
      beforeRecorded: recordedNow,
    });
    expect(pruneResult.pruned).toBe(before.length);
    const afterPrune = await readTransitions(ctx);
    expect(afterPrune.length).toBe(0);

    // The Lead's BINDING ruling (the design note's top-of-file "Lead
    // rulings", which supersedes §3.5's original draft text further down the
    // SAME document): "a prune does NOT advance the content revision (same
    // as rebuildIdentityClosure)." Pinned in the SAME direction as the
    // rebuild above — a prune that started advancing the revision would fail
    // here, exactly as a rebuild that started would fail above.
    const revisionAfterPrune = recordedInstantRevision(
      requireRecordedNow(await store.recordedNow()),
    );
    expect(revisionAfterPrune).toBe(revisionBeforePrune);

    // The OTHER direction of the pin: an ORDINARY write, unlike either
    // maintenance operation, unambiguously DOES advance the revision — proof
    // this assertion methodology can actually detect an advance, so the two
    // "no advance" checks above are not vacuously trivial.
    await store.nodes.Person.create({ name: "D" }, { id: "d" });
    const revisionAfterOrdinaryWrite = recordedInstantRevision(
      requireRecordedNow(await store.recordedNow()),
    );
    expect(revisionAfterOrdinaryWrite).toBeGreaterThan(revisionAfterPrune);
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

  it("notes a schema-transition cause when first enablement folds a pre-existing same-id pair", async () => {
    // §2.3: `schema-transition` is `identitySchemaCommitPreflight`'s cause
    // whenever the closure changed and NO node kind was dropped —
    // distinguishing it from `kind-drop`, the other cause the same preflight
    // can emit. First enablement on a database that already holds a same-id
    // pair across kinds is the simplest reachable case: the enablement
    // rebuild folds Person/shared and Author/shared into one class with
    // nothing dropped.
    //
    // Previously skipped: `prepareStoreWithSchema` (src/store/store.ts) runs
    // the FIRST schema commit — including a first enablement — against the
    // RAW constructor-argument `backend`, before `StoreImplementation`'s own
    // constructor wraps it with `createRecordedBackend` (history capture).
    // `identitySchemaCommitPreflight` now binds a capture session directly
    // to its OWN schema-commit transaction target when the caller threads
    // `historyEnabled` (via `SchemaManagerOptions.historyEnabled`,
    // `prepareStoreWithSchema`'s `ensureOptions`) — the same
    // `createRecordedTransactionScope` pattern
    // `Store#removeIdentityKindsInSchemaPreflight` already used for its own
    // schema-commit transaction — so this no longer depends on a Store
    // object existing yet.
    const GRAPH_ID = "identity_transition_log_schema_transition";
    const Author = defineNode("Author", {
      schema: z.object({ penName: z.string() }),
    });
    const disabledGraph = defineGraph({
      id: GRAPH_ID,
      nodes: { Person: { type: Person }, Author: { type: Author } },
      edges: {},
    });
    const enabledGraph = defineGraph({
      id: GRAPH_ID,
      nodes: { Person: { type: Person }, Author: { type: Author } },
      edges: {},
      identity: { sameIdAcrossKinds: "fold" },
    });
    const { backend } = createLocalSqliteBackend();
    try {
      const [disabledStore] = await createStoreWithSchema(
        disabledGraph,
        backend,
        { history: true },
      );
      await disabledStore.nodes.Person.create(
        { name: "Alice" },
        { id: "shared" },
      );
      await disabledStore.nodes.Author.create(
        { penName: "A." },
        { id: "shared" },
      );

      const [enabledStore] = await createStoreWithSchema(
        enabledGraph,
        backend,
        { history: true },
      );
      const ctx = storeRuntime(enabledStore).identityContext();
      const rows = await readTransitions(ctx, [
        { kind: "Person", id: "shared" },
        { kind: "Author", id: "shared" },
      ]);
      const schemaTransitionRows = rows.filter(
        (row) => row.cause === "schema-transition",
      );
      expect(schemaTransitionRows.length).toBeGreaterThanOrEqual(1);
      // The other droppedNodeKinds branch of the SAME site must not have
      // fired instead.
      expect(rows.some((row) => row.cause === "kind-drop")).toBe(false);
    } finally {
      await backend.close();
    }
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
