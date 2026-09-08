/**
 * The engine-anchor form of `base@V`: when a store has no TypeGraph revision
 * tracking but its backend answers the optional `lineage` capability,
 * `computeBaseVersion` anchors on the engine's own revision instead of the
 * O(graph) content fingerprint. Every base@V call site applies the SAME
 * tolerance for an engine-wide bump that lands on an UNRELATED graph: the
 * outer plan-time precondition (`validateBaseVersions`/
 * `validateForkPointVersions`) and the in-transaction re-validation
 * (`assertTargetUnchanged`/`assertForkPointUnchanged`) all consult
 * `changesSince` on a raw mismatch, and empty keys mean the bump is not a
 * real divergence; non-empty keys or an `unbounded` delta still refuse with
 * `BaseVersionMismatchError`, as does any schema drift underneath the
 * anchor (the engine revision alone cannot vouch for the schema).
 *
 * No bundled backend implements `lineage` yet, so this suite scripts one (a
 * mutable revision plus a scripted delta) through `EngineProvisioning.lineage`
 * on a real SQLite profile — the same route `buildSqliteEngineProfile`'s own
 * profile takes, so both the root backend AND a `transaction()` handle it
 * builds resolve the SAME `LineageMembers` object, exactly like a real
 * profile-supplied `lineage` (`tests/lineage-transaction-threading.test.ts`
 * proves the general threading; this suite exercises what graph-merge's
 * guards do with it). `assertTargetUnchanged` reads `lineage` off the pinned
 * transaction handle specifically — a separate small suite below (not this
 * scripting) proves that with a fixture where the root and the transaction
 * handle resolve DIFFERENT `lineage` objects. Revision drift is injected
 * deterministically through the `embedder` callback, invoked during
 * planning, strictly after the outer `base@V` precondition and strictly
 * before the commit transaction — exactly the technique
 * `tests/graph-merge/commit-revalidation.test.ts` uses to land a concurrent
 * write in that same window — or, for the outer precondition's own
 * tolerance, by mutating the scripted state directly before `merge()` is
 * even called.
 *
 * `assertTargetUnchanged` reads `lineage` off the pinned transaction handle
 * only when it is the IDENTICAL object `resolveLineage(target)` resolves
 * off the root, and falls back to that root object otherwise — a separate
 * small suite below (not this scripting) proves both halves: that the two
 * really are identical in the sanctioned `EngineProvisioning`-only wiring
 * this file's own scripting otherwise relies on, that a transaction-only
 * `lineage` which DIFFERS from the root's is never trusted for the
 * comparison, and that the root's is used when the transaction handle
 * carries none at all.
 */
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { deriveBackend } from "../../src/backend/derive-backend";
import { generateSqliteMigrationSQL } from "../../src/backend/drizzle/ddl";
import { createSqlBackend } from "../../src/backend/drizzle/engine";
import { buildSqliteEngineProfile } from "../../src/backend/drizzle/sqlite";
import type {
  EngineRevision,
  GraphBackend,
  LineageDelta,
  LineageMembers,
} from "../../src/backend/types";
import { ConfigurationError } from "../../src/errors";
import {
  computeBaseVersion,
  engineAnchorOf,
  hasRevisionAnchor,
} from "../../src/graph-merge/base-version";
import { branch } from "../../src/graph-merge/branch";
import { BaseVersionMismatchError } from "../../src/graph-merge/errors";
import {
  merge,
  mergeIncremental,
  planMergeIncremental,
} from "../../src/graph-merge/merge";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import type { Embedder, MergeOptions } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { sql } from "../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../src/query/sql-intent";
import { getCommittedSchemaVersion, migrateSchema } from "../../src/schema";
import { resolveLineage } from "../../src/store/recorded-capture/lineage";
import { storeBackend } from "../../src/store/runtime-port";
import { requireDefined } from "../../src/utils/presence";
import { createSqliteMergeBackend, fakeEmbedder } from "./test-utils";

const Widget = defineNode("Widget", {
  schema: z.object({ label: z.string(), group: z.string() }),
});

const widgetGraph = defineGraph({
  id: "engine-anchor-widget",
  nodes: { Widget: { type: Widget } },
  edges: {},
});
type WidgetGraph = typeof widgetGraph;

const BRANCH = asBranchId("engine-anchor-branch");

/**
 * `Widget.similarity` runs `hybrid` (so the embedder always fires, unlike
 * `fulltext`), blocked into one shared group so the base and branch widgets
 * are always compared. The threshold sits well above what the fake
 * character-frequency embedder gives two unrelated labels, so nothing
 * actually clusters — this suite's guard is orthogonal to entity
 * resolution, exactly like `commit-revalidation.test.ts`'s.
 */
function engineAnchorMergeOptions(
  embedder: Embedder,
): MergeOptions<WidgetGraph> {
  return {
    resolve: {
      Widget: {
        block: (node) => (node as unknown as { group: string }).group,
        similarity: { kind: "hybrid", fields: ["label"] },
        threshold: 0.95,
      },
    },
    embedder,
    onPropertyConflict: "flag",
    branchOrder: [BRANCH],
  };
}

/** Mutable state a test configures and the scripted `lineage` reads live. */
interface ScriptedLineageState {
  revision: EngineRevision;
  delta: (since: EngineRevision, graphId: string) => LineageDelta;
}

function initialState(): ScriptedLineageState {
  return {
    revision: "r0" as EngineRevision,
    delta: () => ({ kind: "keys", nodes: [], edges: [] }),
  };
}

function scriptedLineage(state: ScriptedLineageState): LineageMembers {
  return {
    revision: () => Promise.resolve(state.revision),
    changesSince: (since, graphId) =>
      Promise.resolve(state.delta(since, graphId)),
  };
}

/** A constructed scripted-lineage backend paired with its disposer. */
interface ScriptedLineageFixture {
  backend: GraphBackend;
  cleanup: () => Promise<void>;
}

/**
 * Attaches `lineage` to `profile.provisioning` IN PLACE, mutating the same
 * mutable object every `EngineProvisioning`-reading closure — the root
 * backend's own conditional spread AND every `transaction()` handle's —
 * reads by reference (`tests/lineage-transaction-threading.test.ts`'s own
 * doc comment explains why this, rather than `deriveEngineProfile`, is the
 * way to script a bundled profile's `lineage` for a test). Must run BEFORE
 * `createSqlBackend(profile)`: the root backend's own `.lineage` is baked
 * onto the assembled object once, at construction time, from whatever
 * `provisioning.lineage` held then.
 */
function attachLineage(provisioning: object, lineage: LineageMembers): void {
  (provisioning as { lineage?: LineageMembers }).lineage = lineage;
}

/** Closes a raw better-sqlite3 connection, discarding its non-`void` return. */
function closeSqlite(sqlite: Database.Database): () => Promise<void> {
  return () => {
    sqlite.close();
    return Promise.resolve();
  };
}

/**
 * A real SQLite session whose `EngineProvisioning.lineage` is the scripted
 * one built from `state` — the ONE way this suite gives a backend a
 * `lineage` that a `transaction()` handle actually carries (`deriveBackend`
 * decorates the root object only; see
 * `tests/lineage-transaction-threading.test.ts`). Both the root backend and
 * every `tx` it builds resolve the SAME `LineageMembers` object, exactly
 * like a real profile-supplied `lineage` would.
 */
function scriptedLineageBackend(
  state: ScriptedLineageState,
): ScriptedLineageFixture {
  const sqlite = new Database(":memory:");
  sqlite.exec(generateSqliteMigrationSQL());
  const db = drizzleSqlite(sqlite);
  const profile = buildSqliteEngineProfile(db, {
    executionProfile: { isSync: true },
  });
  attachLineage(profile.provisioning, scriptedLineage(state));
  const backend = createSqlBackend(profile);
  return { backend, cleanup: closeSqlite(sqlite) };
}

/**
 * Same as {@link scriptedLineageBackend}, except `revision()`/
 * `changesSince()` each issue a REAL read against the backend — through the
 * ordinary `backend.execute` path a `lineage` with no connection of its own
 * would use — before returning the scripted value. `assertTargetUnchanged`
 * (`merge.ts`) consults `lineage` from strictly INSIDE the target's own
 * open commit transaction, on the pinned transaction handle; on the bundled
 * caller-serialized SQLite backend, this call pattern is exactly what
 * {@link LineageMembers}' own doc comment warns against: the backend's
 * reentrancy guard (`serialized-execution-queue.ts`) detects the read
 * reentering the open transaction's execution slot and refuses it with a
 * typed `ConfigurationError` rather than actually hanging. The test that
 * uses this fixture pins that concrete, fail-loud shape. The closure reads
 * `backend` through a cell filled in right after construction, since the
 * scripted `lineage` must be attached (for the root's own bake) before
 * `createSqlBackend` returns the object the closure needs to call
 * `execute` on.
 */
function scriptedLineageBackendWithRealRead(
  state: ScriptedLineageState,
): ScriptedLineageFixture {
  const sqlite = new Database(":memory:");
  sqlite.exec(generateSqliteMigrationSQL());
  const db = drizzleSqlite(sqlite);
  const profile = buildSqliteEngineProfile(db, {
    executionProfile: { isSync: true },
  });
  const backendCell: { current?: GraphBackend } = {};
  async function probe(): Promise<void> {
    await requireDefined(backendCell.current).execute(
      asCompiledRowsSql(sql`SELECT 1 AS probe`),
    );
  }
  attachLineage(profile.provisioning, {
    revision: async () => {
      await probe();
      return state.revision;
    },
    changesSince: async (since, graphId) => {
      await probe();
      return state.delta(since, graphId);
    },
  });
  const backend = createSqlBackend(profile);
  backendCell.current = backend;
  return { backend, cleanup: closeSqlite(sqlite) };
}

/**
 * Wraps an embedder so its FIRST invocation also runs `bump` — the
 * deterministic stand-in for an unrelated engine-wide commit (or, in the
 * schema-drift tests, a schema migration) landing in the plan→commit
 * window. This drift has no Widget row of its own to write, so `bump` acts
 * on the scripted lineage's state or the backend directly rather than the
 * target store's own collections. `bump` may itself be async (a schema
 * migration is), so its result is always awaited.
 */
function driftingEmbedder(bump: () => void | Promise<void>): Embedder {
  let injected = false;
  return async (texts) => {
    if (!injected) {
      injected = true;
      await bump();
    }
    return fakeEmbedder(texts);
  };
}

/** Live `label`s of every Widget in the store, sorted. */
async function widgetLabels(
  store: Awaited<ReturnType<typeof createStoreWithSchema<WidgetGraph>>>[0],
): Promise<readonly string[]> {
  return (await store.nodes.Widget.find())
    .map((widget) => (widget as unknown as { label: string }).label)
    .sort();
}

describe("base@V engine anchor", () => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });

  function makeBackend(state: ScriptedLineageState): GraphBackend {
    const fixture = scriptedLineageBackend(state);
    cleanups.push(fixture.cleanup);
    return fixture.backend;
  }

  function makeBackendWithRealRead(state: ScriptedLineageState): GraphBackend {
    const fixture = scriptedLineageBackendWithRealRead(state);
    cleanups.push(fixture.cleanup);
    return fixture.backend;
  }

  function makePlainBackend(): Promise<GraphBackend> {
    const fixture = createSqliteMergeBackend();
    cleanups.push(fixture.cleanup);
    return Promise.resolve(fixture.backend);
  }

  it("anchors the token on the engine revision when tracking is off and the backend has lineage", async () => {
    const state = initialState();
    const [store] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(state),
    );

    const token = await computeBaseVersion(store);

    expect(hasRevisionAnchor(token)).toBe(false);
    expect(engineAnchorOf(token)).toBe("r0");
  });

  it("keeps the TypeGraph revision anchor when tracking is on, even though the backend has lineage", async () => {
    const state = initialState();
    const [store] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(state),
      { revisionTracking: true },
    );

    const token = await computeBaseVersion(store);

    expect(hasRevisionAnchor(token)).toBe(true);
    expect(engineAnchorOf(token)).toBeUndefined();
  });

  it("merges through an engine-wide revision bump that names no row of this graph", async () => {
    const state = initialState();
    const [baseStore] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(state),
    );
    await baseStore.nodes.Widget.bulkCreate([
      { id: "base-1", props: { label: "base", group: "g1" } },
    ]);

    const forkBranch = unwrap(
      await branch<WidgetGraph>(baseStore, makePlainBackend, { id: BRANCH }),
    );
    expect(forkBranch.base).toContain("\0engine:r0");
    await forkBranch.store.nodes.Widget.create({
      label: "from fork",
      group: "g1",
    });

    const embedder = driftingEmbedder(() => {
      state.revision = "r1" as EngineRevision;
    });
    const result = await merge<WidgetGraph>(
      baseStore,
      [forkBranch],
      engineAnchorMergeOptions(embedder),
    );

    expect(isOk(result)).toBe(true);
    expect(state.revision).toBe("r1");
    expect(await widgetLabels(baseStore)).toEqual(["base", "from fork"]);
  });

  it("refuses the merge when the bumped revision's delta names a row of this graph", async () => {
    const state = initialState();
    const [baseStore] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(state),
    );
    await baseStore.nodes.Widget.bulkCreate([
      { id: "base-1", props: { label: "base", group: "g1" } },
    ]);

    const forkBranch = unwrap(
      await branch<WidgetGraph>(baseStore, makePlainBackend, { id: BRANCH }),
    );
    await forkBranch.store.nodes.Widget.create({
      label: "from fork",
      group: "g1",
    });

    const embedder = driftingEmbedder(() => {
      state.revision = "r1" as EngineRevision;
      state.delta = () => ({
        kind: "keys",
        nodes: [{ kind: "Widget", id: "base-1" }],
        edges: [],
      });
    });
    const result = await merge<WidgetGraph>(
      baseStore,
      [forkBranch],
      engineAnchorMergeOptions(embedder),
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
      expect(result.error.details).toMatchObject({
        expectedRevision: "r0",
        liveRevision: "r1",
        // Bounded shape (`merge.ts`'s `boundedChangedKeys`): the first 20
        // keys per list plus each list's own total count, not the raw
        // `LineageDelta` — an unbounded engine delta must not embed
        // thousands of keys in a single thrown error.
        changedKeys: {
          nodes: [{ kind: "Widget", id: "base-1" }],
          nodesTotal: 1,
          edges: [],
          edgesTotal: 0,
        },
      });
    }
    // Nothing committed from the stale plan.
    expect(await widgetLabels(baseStore)).toEqual(["base"]);
  });

  it("caps a large changesSince delta's changedKeys detail to the first 20 per list plus a count", async () => {
    const state = initialState();
    const [baseStore] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(state),
    );
    await baseStore.nodes.Widget.bulkCreate([
      { id: "base-1", props: { label: "base", group: "g1" } },
    ]);

    const forkBranch = unwrap(
      await branch<WidgetGraph>(baseStore, makePlainBackend, { id: BRANCH }),
    );
    await forkBranch.store.nodes.Widget.create({
      label: "from fork",
      group: "g1",
    });

    const manyNodes = Array.from({ length: 25 }, (_, index) => ({
      kind: "Widget",
      id: `changed-${index}`,
    }));
    const embedder = driftingEmbedder(() => {
      state.revision = "r1" as EngineRevision;
      state.delta = () => ({
        kind: "keys",
        nodes: manyNodes,
        edges: [{ kind: "knows", id: "e0" }],
      });
    });
    const result = await merge<WidgetGraph>(
      baseStore,
      [forkBranch],
      engineAnchorMergeOptions(embedder),
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      const details = result.error.details as {
        changedKeys: { nodes: unknown[]; nodesTotal: number };
      };
      expect(details.changedKeys.nodes).toHaveLength(20);
      expect(details.changedKeys.nodes).toEqual(manyNodes.slice(0, 20));
      expect(details.changedKeys.nodesTotal).toBe(25);
    }
  });

  it("refuses the merge when changesSince cannot bound the delta", async () => {
    const state = initialState();
    const [baseStore] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(state),
    );
    await baseStore.nodes.Widget.bulkCreate([
      { id: "base-1", props: { label: "base", group: "g1" } },
    ]);

    const forkBranch = unwrap(
      await branch<WidgetGraph>(baseStore, makePlainBackend, { id: BRANCH }),
    );
    await forkBranch.store.nodes.Widget.create({
      label: "from fork",
      group: "g1",
    });

    const embedder = driftingEmbedder(() => {
      state.revision = "r1" as EngineRevision;
      state.delta = () => ({ kind: "unbounded" });
    });
    const result = await merge<WidgetGraph>(
      baseStore,
      [forkBranch],
      engineAnchorMergeOptions(embedder),
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
      expect(result.error.details).toMatchObject({
        expectedRevision: "r0",
        liveRevision: "r1",
      });
      expect(result.error.details["changedKeys"]).toBeUndefined();
    }
    expect(await widgetLabels(baseStore)).toEqual(["base"]);
  });

  it("commits normally when the revision does not move (control)", async () => {
    const state = initialState();
    const [baseStore] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(state),
    );
    await baseStore.nodes.Widget.bulkCreate([
      { id: "base-1", props: { label: "base", group: "g1" } },
    ]);

    const forkBranch = unwrap(
      await branch<WidgetGraph>(baseStore, makePlainBackend, { id: BRANCH }),
    );
    await forkBranch.store.nodes.Widget.create({
      label: "from fork",
      group: "g1",
    });

    const result = await merge<WidgetGraph>(
      baseStore,
      [forkBranch],
      engineAnchorMergeOptions(fakeEmbedder),
    );

    expect(isOk(result)).toBe(true);
    expect(await widgetLabels(baseStore)).toEqual(["base", "from fork"]);
  });

  // Every other case in this suite uses `scriptedLineage`, which never
  // touches `backend` — so nothing here exercises the hazard
  // `assertTargetUnchanged`'s own doc comment names: it is the FIRST base@V
  // call site to consult `lineage` from strictly INSIDE the target's own
  // open commit transaction (on the target's root backend, since no
  // advisory lock pins an engine-anchored store's write path). This case
  // uses `scriptedLineageWithBackendRead`, whose `revision()` issues a real
  // query THROUGH THE ORDINARY BACKEND PATH — exactly what a `lineage` that
  // has no connection of its own would do. That query lands on the SAME
  // caller-serialized SQLite backend the open transaction already holds
  // the execution slot for, and the backend's own reentrancy guard
  // (`serialized-execution-queue.ts`'s `rejectReentrantQueueSubmission`,
  // also exercised by `tests/caller-serialized-queue.test.ts`) detects this
  // and refuses immediately with a typed `ConfigurationError` — a fast,
  // diagnosable failure, never the silent hang the naive call pattern would
  // otherwise risk. This is exactly the failure `LineageMembers`' doc
  // comment warns a real implementation must avoid by using a connection
  // independent of the caller's open transaction; this test pins the
  // CONCRETE, typed shape that failure takes today when a `lineage`
  // ignores that warning on the bundled SQLite backend.
  it("refuses (not hangs) when a lineage's real backend read reenters the open commit transaction", async () => {
    const state = initialState();
    const [baseStore] = await createStoreWithSchema(
      widgetGraph,
      makeBackendWithRealRead(state),
    );
    await baseStore.nodes.Widget.bulkCreate([
      { id: "base-1", props: { label: "base", group: "g1" } },
    ]);

    const forkBranch = unwrap(
      await branch<WidgetGraph>(baseStore, makePlainBackend, { id: BRANCH }),
    );
    await forkBranch.store.nodes.Widget.create({
      label: "from fork",
      group: "g1",
    });

    const embedder = driftingEmbedder(() => {
      state.revision = "r1" as EngineRevision;
    });
    const result = await merge<WidgetGraph>(
      baseStore,
      [forkBranch],
      engineAnchorMergeOptions(embedder),
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.cause).toBeInstanceOf(ConfigurationError);
      expect((result.error.cause as ConfigurationError).details).toEqual(
        expect.objectContaining({
          code: "SERIALIZED_QUEUE_REENTRANT_SUBMISSION",
        }),
      );
    }
    // Nothing committed from the aborted attempt.
    expect(await widgetLabels(baseStore)).toEqual(["base"]);
  });

  // `assertForkPointUnchanged` mirrors `assertTargetUnchanged`'s engine-anchor
  // tolerance for `mergeIncremental()`'s fork point. Fork point and target are
  // separate backends here (as `tests/graph-merge/incremental-toctou.test.ts`
  // also keeps them) — `assertForkPointUnchanged` reads the fork point's OWN
  // root backend, and a same-backend fork point/target would deadlock this
  // read against the commit transaction's serialized execution slot, exactly
  // the hazard that function's own doc comment says the two-backend split
  // avoids. Both start empty and identical, so the ordinary "target advanced
  // independently" diff is empty and the guard under test is isolated.
  it("mergeIncremental() tolerates an engine-wide revision bump at the fork point with an empty delta", async () => {
    const state = initialState();
    const [forkPoint] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(state),
    );
    const [target] = await createStoreWithSchema(
      widgetGraph,
      await makePlainBackend(),
    );

    const forkBranch = unwrap(
      await branch<WidgetGraph>(forkPoint, makePlainBackend, { id: BRANCH }),
    );
    await forkBranch.store.nodes.Widget.create({
      label: "from fork",
      group: "g1",
    });

    const embedder = driftingEmbedder(() => {
      state.revision = "r1" as EngineRevision;
    });
    const result = await mergeIncremental<WidgetGraph>({
      forkPoint,
      target,
      branches: [forkBranch],
      options: {
        ...engineAnchorMergeOptions(embedder),
        onBasePropertyConflict: "flag",
      },
    });

    expect(isOk(result)).toBe(true);
    expect(state.revision).toBe("r1");
    expect(await widgetLabels(target)).toEqual(["from fork"]);
  });

  it("mergeIncremental() refuses when the fork point's bumped revision names a changed row", async () => {
    const state = initialState();
    const [forkPoint] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(state),
    );
    const [target] = await createStoreWithSchema(
      widgetGraph,
      await makePlainBackend(),
    );

    const forkBranch = unwrap(
      await branch<WidgetGraph>(forkPoint, makePlainBackend, { id: BRANCH }),
    );
    await forkBranch.store.nodes.Widget.create({
      label: "from fork",
      group: "g1",
    });

    const embedder = driftingEmbedder(() => {
      state.revision = "r1" as EngineRevision;
      state.delta = () => ({
        kind: "keys",
        nodes: [{ kind: "Widget", id: "elsewhere" }],
        edges: [],
      });
    });
    const result = await mergeIncremental<WidgetGraph>({
      forkPoint,
      target,
      branches: [forkBranch],
      options: {
        ...engineAnchorMergeOptions(embedder),
        onBasePropertyConflict: "flag",
      },
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    }
    expect(await widgetLabels(target)).toEqual([]);
  });

  // The tests above all inject the engine-wide bump DURING planning (via the
  // embedder), which only exercises the IN-TRANSACTION guards
  // (`assertTargetUnchanged`/`assertForkPointUnchanged`). The outer
  // plan-time preconditions (`validateBaseVersions`/
  // `validateForkPointVersions`) run BEFORE planning starts and compare the
  // branch's captured token against a FRESH `computeBaseVersion` read right
  // there — so a bump that lands before `merge()`/`mergeIncremental()` is
  // even called must be tolerated by that comparison directly, not by
  // reaching the commit transaction at all.
  it("merge() tolerates an engine-wide revision bump that happened before merge() was even called", async () => {
    const state = initialState();
    const [baseStore] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(state),
    );
    await baseStore.nodes.Widget.bulkCreate([
      { id: "base-1", props: { label: "base", group: "g1" } },
    ]);

    const forkBranch = unwrap(
      await branch<WidgetGraph>(baseStore, makePlainBackend, { id: BRANCH }),
    );
    await forkBranch.store.nodes.Widget.create({
      label: "from fork",
      group: "g1",
    });

    // The bump (and the empty delta it leaves behind) is already in place
    // before merge() is called — validateBaseVersions's own precondition,
    // not just assertTargetUnchanged, must tolerate it.
    state.revision = "r1" as EngineRevision;

    const result = await merge<WidgetGraph>(
      baseStore,
      [forkBranch],
      engineAnchorMergeOptions(fakeEmbedder),
    );

    expect(isOk(result)).toBe(true);
    expect(await widgetLabels(baseStore)).toEqual(["base", "from fork"]);
  });

  it("refuses merge() when a pre-call engine-wide bump's delta names a row of this graph", async () => {
    const state = initialState();
    const [baseStore] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(state),
    );
    await baseStore.nodes.Widget.bulkCreate([
      { id: "base-1", props: { label: "base", group: "g1" } },
    ]);

    const forkBranch = unwrap(
      await branch<WidgetGraph>(baseStore, makePlainBackend, { id: BRANCH }),
    );
    await forkBranch.store.nodes.Widget.create({
      label: "from fork",
      group: "g1",
    });

    state.revision = "r1" as EngineRevision;
    state.delta = () => ({
      kind: "keys",
      nodes: [{ kind: "Widget", id: "base-1" }],
      edges: [],
    });

    const result = await merge<WidgetGraph>(
      baseStore,
      [forkBranch],
      engineAnchorMergeOptions(fakeEmbedder),
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    }
    expect(await widgetLabels(baseStore)).toEqual(["base"]);
  });

  it("mergeIncremental() tolerates an engine-wide revision bump at the fork point that happened before the call", async () => {
    const state = initialState();
    const [forkPoint] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(state),
    );
    const [target] = await createStoreWithSchema(
      widgetGraph,
      await makePlainBackend(),
    );

    const forkBranch = unwrap(
      await branch<WidgetGraph>(forkPoint, makePlainBackend, { id: BRANCH }),
    );
    await forkBranch.store.nodes.Widget.create({
      label: "from fork",
      group: "g1",
    });

    state.revision = "r1" as EngineRevision;

    const result = await mergeIncremental<WidgetGraph>({
      forkPoint,
      target,
      branches: [forkBranch],
      options: {
        ...engineAnchorMergeOptions(fakeEmbedder),
        onBasePropertyConflict: "flag",
      },
    });

    expect(isOk(result)).toBe(true);
    expect(await widgetLabels(target)).toEqual(["from fork"]);
  });

  // `planMergeIncremental()`'s durable `MergePlanArtifact` records each
  // branch's anchor alongside the fork point's — and a branch tolerated here
  // by `toleratedByEngineAnchor` (an engine-wide bump that named none of
  // this graph's rows) captured its OWN `base` token before the bump, so it
  // no longer textually equals the fork point's current token. A stored
  // review built on this plan (`candidate-review.ts`'s `validateReview`,
  // reached through `planCandidateWriteSetReview`/
  // `revalidateCandidateWriteSetReview`, which always plan with
  // `forkPoint === target`) compares `anchors.branches[0].baseVersion` to
  // `anchors.forkPoint.baseVersion` for exact equality and throws
  // `MergeReviewError("incompatible-plan")` on any difference — so the
  // recorded branch anchor MUST be normalized to the live fork version
  // whenever tolerance accepted a mismatch, or a plan `mergeIncremental()`
  // itself would go on to accept becomes unreviewable. Mutation-proven:
  // recording the raw `branch.base` instead of `forkVersion` in the
  // anchors' `branches` map made this test fail (the two anchors differed);
  // restoring the normalization made it pass again.
  //
  // `planMergeIncremental()` is a PUBLIC durable plan, so
  // `assertPublicPlanCapability` requires the TARGET to carry TypeGraph
  // revision tracking — which forecloses an engine anchor on the target
  // itself (precedence picks the revision anchor whenever tracking is on).
  // The fork point is a SEPARATE store from the target in the general
  // `planMergeIncremental` API (only `planCandidateWriteSet` collapses
  // them), and only the fork point's own `revisionTrackingEnabled` decides
  // ITS anchor form — so this case gives the fork point the scripted
  // engine-anchored backend and the target an ordinary revision-tracked
  // one, the combination that keeps the scenario reachable.
  it("planMergeIncremental() normalizes a tolerated branch anchor to the fork point's live token", async () => {
    const state = initialState();
    const [forkPoint] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(state),
    );
    await forkPoint.nodes.Widget.bulkCreate([
      { id: "base-1", props: { label: "base", group: "g1" } },
    ]);
    const [target] = await createStoreWithSchema(
      widgetGraph,
      await makePlainBackend(),
      { revisionTracking: true },
    );
    await target.nodes.Widget.bulkCreate([
      { id: "base-1", props: { label: "base", group: "g1" } },
    ]);

    const forkBranch = unwrap(
      await branch<WidgetGraph>(forkPoint, makePlainBackend, { id: BRANCH }),
    );
    expect(forkBranch.base).toContain("\0engine:r0");
    await forkBranch.store.nodes.Widget.create({
      label: "from fork",
      group: "g1",
    });

    // An unrelated engine-wide bump lands after the fork but before
    // planning — no row of THIS graph moves, so the outer precondition
    // tolerates the branch's now-stale-looking `base` token.
    state.revision = "r1" as EngineRevision;

    const planned = await planMergeIncremental<WidgetGraph>({
      forkPoint,
      target,
      branches: [forkBranch],
      options: {
        ...engineAnchorMergeOptions(fakeEmbedder),
        onBasePropertyConflict: "flag",
      },
    });

    expect(isOk(planned)).toBe(true);
    if (isOk(planned)) {
      const anchors = planned.data.anchors;
      expect(anchors.kind).toBe("incremental");
      if (anchors.kind === "incremental") {
        expect(anchors.forkPoint.baseVersion).toContain("\0engine:r1");
        expect(anchors.branches).toEqual([
          { branchId: BRANCH, baseVersion: anchors.forkPoint.baseVersion },
        ]);
      }
    }
  });

  // Reproduces the finding this guard closes: deleting the schema-half
  // comparison in `assertForkPointUnchanged` (comparing raw
  // `liveVersion !== precondition.version` alone, without also requiring
  // `schemaComponentOf(liveVersion) === schemaComponentOf(precondition.version)`
  // before consulting `changesSince`) leaves this test green, because the
  // engine revision here never moves at all — `engineAnchorMismatch`'s
  // equal-revision fast path would accept the plan outright. Mutation-proven:
  // reverting the schema check made this test fail with `isOk(result) ===
  // true` and a committed "from fork" row; restoring it (re-adding the
  // `schemaComponentOf` comparison) made it pass again.
  //
  // The migration runs inside the `embedder` callback so it lands strictly
  // between `validateForkPointVersions`'s own plan-time precondition
  // (computed from the fork point BEFORE this call) and the commit
  // transaction where `assertForkPointUnchanged` runs — migrating the fork
  // point before calling `mergeIncremental()` at all would let the OUTER
  // precondition refuse first, leaving `assertForkPointUnchanged`'s own
  // schema check untested.
  it("mergeIncremental() refuses when the fork point's schema version changes even with an unmoved engine revision", async () => {
    const state = initialState();
    const [forkPoint] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(state),
    );
    const [target] = await createStoreWithSchema(
      widgetGraph,
      await makePlainBackend(),
    );

    const forkBranch = unwrap(
      await branch<WidgetGraph>(forkPoint, makePlainBackend, { id: BRANCH }),
    );
    await forkBranch.store.nodes.Widget.create({
      label: "from fork",
      group: "g1",
    });

    // Re-committing the IDENTICAL graph definition bumps the fork point's
    // active schema version (monotonic) while leaving the document hash —
    // and every Widget row — untouched, so `changesSince` for this graph
    // stays empty and the engine revision never moves.
    const embedder = driftingEmbedder(async () => {
      const forkPointBackend = storeBackend(forkPoint);
      await migrateSchema(
        forkPointBackend,
        widgetGraph,
        requireDefined(
          await getCommittedSchemaVersion(forkPointBackend, widgetGraph.id),
        ),
      );
    });

    const result = await mergeIncremental<WidgetGraph>({
      forkPoint,
      target,
      branches: [forkBranch],
      options: {
        ...engineAnchorMergeOptions(embedder),
        onBasePropertyConflict: "flag",
      },
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    }
    expect(await widgetLabels(target)).toEqual([]);
  });

  // Reproduces the finding this guard closes: without the fresh
  // `readActiveSchemaVersion` re-check in `assertTargetUnchanged`'s engine
  // branch, a schema commit racing the plan→commit window is invisible to
  // `engineAnchorMismatch` (the revision never moves, so its fast path
  // accepts) — the merge would wrongly commit a plan resolved against a
  // schema that no longer matches the live target. Mutation-proven:
  // removing the active-version comparison made this test fail with
  // `isOk(result) === true` and a committed "from fork" row; restoring the
  // check made it pass again.
  it("refuses the merge when the target's schema version changes before the commit transaction, even though the revision does not move", async () => {
    const state = initialState();
    const [baseStore] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(state),
    );
    await baseStore.nodes.Widget.bulkCreate([
      { id: "base-1", props: { label: "base", group: "g1" } },
    ]);

    const forkBranch = unwrap(
      await branch<WidgetGraph>(baseStore, makePlainBackend, { id: BRANCH }),
    );
    await forkBranch.store.nodes.Widget.create({
      label: "from fork",
      group: "g1",
    });

    const embedder = driftingEmbedder(async () => {
      const backend = storeBackend(baseStore);
      await migrateSchema(
        backend,
        widgetGraph,
        requireDefined(
          await getCommittedSchemaVersion(backend, widgetGraph.id),
        ),
      );
    });
    const result = await merge<WidgetGraph>(
      baseStore,
      [forkBranch],
      engineAnchorMergeOptions(embedder),
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    }
    // Nothing committed from the schema-stale plan.
    expect(await widgetLabels(baseStore)).toEqual(["base"]);
  });

  it("refuses the engine-anchor tolerance when the live target's own base@V has moved to a different anchor FORM, even with a real lineage and a matching schema", async () => {
    // Two `Store`s share the SAME backend and graph, one WITHOUT revision
    // tracking (what `forkBranch` forks from — an engine-anchored base@V,
    // since the backend has a real `lineage`) and one WITH it (`target`,
    // whose OWN base@V is revision-anchored regardless of `backend.lineage`
    // still being present — see `computeBaseVersion`'s precedence). Nothing
    // about `resolveLineage(target)` fails here: `backend.lineage` answers
    // `state.revision` unchanged, so a `toleratedByEngineAnchor` that
    // skipped checking the LIVE token's own anchor form would compare that
    // unmoved revision against the branch's stale engine anchor and
    // wrongly call this "unchanged" — even though the target's real
    // anchor (its TypeGraph revision) is a completely different axis this
    // comparison never looked at.
    const state = initialState();
    const backend = makeBackend(state);
    const [engineStore] = await createStoreWithSchema(widgetGraph, backend);
    await engineStore.nodes.Widget.bulkCreate([
      { id: "base-1", props: { label: "base", group: "g1" } },
    ]);

    const forkBranch = unwrap(
      await branch<WidgetGraph>(engineStore, makePlainBackend, {
        id: BRANCH,
      }),
    );
    expect(forkBranch.base).toContain("\0engine:r0");
    await forkBranch.store.nodes.Widget.create({
      label: "from fork",
      group: "g1",
    });

    const [target] = await createStoreWithSchema(widgetGraph, backend, {
      revisionTracking: true,
    });
    const targetVersion = await computeBaseVersion(target);
    expect(hasRevisionAnchor(targetVersion)).toBe(true);
    expect(engineAnchorOf(targetVersion)).toBeUndefined();

    const result = await merge<WidgetGraph>(
      target,
      [forkBranch],
      engineAnchorMergeOptions(fakeEmbedder),
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    }
  });
});

describe("assertTargetUnchanged reads lineage off the pinned transaction handle", () => {
  it("carries the identical lineage object resolveLineage(target) resolves off the root, when a profile-supplied lineage reaches every transaction() handle", async () => {
    const state = initialState();

    const sqlite = new Database(":memory:");
    sqlite.exec(generateSqliteMigrationSQL());
    const db = drizzleSqlite(sqlite);
    const profile = buildSqliteEngineProfile(db, {
      executionProfile: { isSync: true },
    });
    // Threaded through `EngineProvisioning.lineage` — the sanctioned wiring
    // (`tests/lineage-transaction-threading.test.ts` proves the general
    // threading) — never a root-only `deriveBackend` overlay, so this is the
    // ONE configuration in which `assertTargetUnchanged`'s
    // `txBackend.lineage === planned` comparison (`planned` being
    // `resolveLineage(target)` off the root) can ever be true.
    attachLineage(profile.provisioning, scriptedLineage(state));
    const backend = createSqlBackend(profile);

    try {
      const [store] = await createStoreWithSchema(widgetGraph, backend);
      const planned = resolveLineage(store);
      expect(planned).toBeDefined();

      let handleLineage: LineageMembers | undefined;
      await backend.transaction((tx) => {
        handleLineage = tx.lineage;
        return Promise.resolve();
      });

      // Mutation-prove: gut the transaction-construction wiring in
      // `sqlite.ts`/`postgres.ts` to stop forwarding the root's own
      // `lineage` bag onto a `transaction()` handle by reference (build a
      // fresh bag instead), and this identity fails — exactly the
      // condition under which `assertTargetUnchanged`'s
      // `txBackend.lineage === planned` branch would silently stop being
      // reachable, so every engine-anchored merge would fall back to a
      // second root read on every commit instead of the pinned handle.
      expect(handleLineage).toBe(planned);
    } finally {
      sqlite.close();
    }
  });

  it("prefers the root's lineage over a transaction handle's DIFFERENT lineage, so a divergent transaction-only source cannot report a false mismatch", async () => {
    // Reproduces the configuration a prior fix round got wrong: a
    // profile-supplied `lineage` threaded through `EngineProvisioning` (so
    // it reaches every `transaction()` handle, never the root) alongside a
    // SEPARATE root-only `deriveBackend` overlay `lineage` (the sanctioned
    // way to decorate ANY backend). `computeBaseVersion` anchors the plan on
    // the ROOT overlay's revision (`resolveLineage(target)` finds it there
    // first, since the overlay shadows `.lineage` on the root object). If
    // the commit-time guard then consulted the transaction handle's
    // DIFFERENT `lineage` instead, it would compare that anchor against a
    // revision space the transaction-only source has never heard of and
    // report an `unbounded` delta — refusing the merge of a target nobody
    // touched.
    const rootRevision = "overlay-b" as EngineRevision;
    function rootLineage(): LineageMembers {
      return {
        revision: () => Promise.resolve(rootRevision),
        changesSince: () =>
          Promise.resolve({ kind: "keys", nodes: [], edges: [] }),
      };
    }

    // Recognizes none of the root's revisions — an engine that tracks its
    // own, unrelated revision space, exactly like `EngineRevision`'s own doc
    // says two backends' revisions never compare.
    function txLineage(): LineageMembers {
      return {
        revision: () => Promise.resolve("engine-a" as EngineRevision),
        changesSince: () => Promise.resolve({ kind: "unbounded" }),
      };
    }

    const sqlite = new Database(":memory:");
    sqlite.exec(generateSqliteMigrationSQL());
    const db = drizzleSqlite(sqlite);
    const profile = buildSqliteEngineProfile(db, {
      executionProfile: { isSync: true },
    });
    attachLineage(profile.provisioning, txLineage());
    const built = createSqlBackend(profile);
    const backend = deriveBackend(built, { lineage: rootLineage() });

    const forkFixture = createSqliteMergeBackend();
    try {
      const [baseStore] = await createStoreWithSchema(widgetGraph, backend);
      await baseStore.nodes.Widget.bulkCreate([
        { id: "base-1", props: { label: "base", group: "g1" } },
      ]);

      const forkBranch = unwrap(
        await branch<WidgetGraph>(
          baseStore,
          () => Promise.resolve(forkFixture.backend),
          { id: BRANCH },
        ),
      );
      await forkBranch.store.nodes.Widget.create({
        label: "from fork",
        group: "g1",
      });

      const result = await merge<WidgetGraph>(
        baseStore,
        [forkBranch],
        engineAnchorMergeOptions(fakeEmbedder),
      );

      // Mutation-prove by reverting `assertTargetUnchanged`'s engine-anchor
      // branch to `txBackend.lineage ?? resolveLineage(target)`: the
      // commit-time read then lands on `txLineage()`, whose `revision()`
      // ("engine-a") never equals the plan's anchor ("overlay-b"), so
      // `changesSince("overlay-b", ...)` is consulted on `txLineage()` and
      // answers `{ kind: "unbounded" }` — an unconditional refusal — and
      // this assertion fails.
      expect(isOk(result)).toBe(true);
    } finally {
      await forkFixture.cleanup();
      sqlite.close();
    }
  });

  it("falls back to the root's lineage when the transaction handle carries none (a root-only deriveBackend overlay, never threaded through EngineProvisioning)", async () => {
    const state = initialState();

    // No `EngineProvisioning.lineage` is attached to this profile — the
    // ONLY `lineage` this backend has is the `deriveBackend` overlay below,
    // applied to the already-constructed root object. A `transaction()`
    // handle this backend builds never carries it (the same fact the
    // previous test proves in the other direction), so `assertTargetUnchanged`
    // reaching the transaction handle alone would find no `lineage` at all
    // even though `resolveLineage(target)` — the SAME read
    // `computeBaseVersion` used to anchor the token at plan time — finds one
    // on the root every time.
    const sqlite = new Database(":memory:");
    sqlite.exec(generateSqliteMigrationSQL());
    const db = drizzleSqlite(sqlite);
    const profile = buildSqliteEngineProfile(db, {
      executionProfile: { isSync: true },
    });
    const built = createSqlBackend(profile);
    const backend = deriveBackend(built, { lineage: scriptedLineage(state) });

    const forkFixture = createSqliteMergeBackend();
    try {
      const [baseStore] = await createStoreWithSchema(widgetGraph, backend);
      await baseStore.nodes.Widget.bulkCreate([
        { id: "base-1", props: { label: "base", group: "g1" } },
      ]);

      const forkBranch = unwrap(
        await branch<WidgetGraph>(
          baseStore,
          () => Promise.resolve(forkFixture.backend),
          { id: BRANCH },
        ),
      );
      await forkBranch.store.nodes.Widget.create({
        label: "from fork",
        group: "g1",
      });

      const result = await merge<WidgetGraph>(
        baseStore,
        [forkBranch],
        engineAnchorMergeOptions(fakeEmbedder),
      );

      // Mutation-prove by reverting `assertTargetUnchanged` to a bare
      // `requireLineage(txBackend, "assertTargetUnchanged")` (no fallback to
      // `resolveLineage(target)`): the transaction handle here has no
      // `lineage` of its own, so the guard throws `LINEAGE_UNAVAILABLE`
      // instead of finding this root-only overlay, and BOTH assertions below
      // fail (an error result whose cause is not this shape, and a widget
      // list that never gained the fork's row).
      expect(isOk(result)).toBe(true);
      expect(await widgetLabels(baseStore)).toEqual(["base", "from fork"]);
    } finally {
      await forkFixture.cleanup();
      sqlite.close();
    }
  });
});
