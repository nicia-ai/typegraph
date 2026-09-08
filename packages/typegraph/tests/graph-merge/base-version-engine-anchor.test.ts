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
 * ONLY — never falls back to the root — and passes that same handle as the
 * `session` argument to both `revision`/`changesSince`, so the read runs on
 * the exact connection the open commit transaction holds. A separate small
 * suite below (not this scripting) proves this directly: that
 * `assertTargetUnchanged`'s calls carry the transaction handle as their
 * session while `branch()`/`staging.ts`'s planning-time calls carry the
 * root backend they hold, and that a transaction handle with no `lineage`
 * of its own refuses the commit rather than silently reading a different
 * connection's answer.
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

import {
  deriveBackend,
  isBackendDerivedFrom,
} from "../../src/backend/derive-backend";
import { generateSqliteMigrationSQL } from "../../src/backend/drizzle/ddl";
import { createSqlBackend } from "../../src/backend/drizzle/engine";
import { buildSqliteEngineProfile } from "../../src/backend/drizzle/sqlite";
import type {
  EngineRevision,
  GraphBackend,
  LineageDelta,
  LineageMembers,
  LineageSession,
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
    changesSince: (_session, since, graphId) =>
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
 * `changesSince()` each issue a REAL read against the ROOT backend —
 * ignoring the `session` argument they are actually given, exactly the
 * defect {@link LineageMembers}' own doc comment warns against — before
 * returning the scripted value. `assertTargetUnchanged` (`merge.ts`)
 * consults `lineage` from strictly INSIDE the target's own open commit
 * transaction and passes the pinned TRANSACTION HANDLE as the session; a
 * well-behaved implementation would read on that handle and see no
 * reentrancy at all (see `tests/backends/integration/lineage-conformance.ts`'s
 * matching positive case). This fixture deliberately does the opposite —
 * it reads through the ROOT backend it closed over instead — so on the
 * bundled caller-serialized SQLite backend the read collides with the open
 * transaction's own execution slot: the reentrancy guard
 * (`serialized-execution-queue.ts`) detects it and refuses with a typed
 * `ConfigurationError` rather than actually hanging. The test that uses
 * this fixture pins that concrete, fail-loud shape for a `lineage` that
 * ignores its session. The closure reads `backend` through a cell filled in
 * right after construction, since the scripted `lineage` must be attached
 * (for the root's own bake) before `createSqlBackend` returns the object
 * the closure needs to call `execute` on.
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
    changesSince: async (_session, since, graphId) => {
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
    // The engine anchor embeds the store's durable per-graph origin ahead
    // of the scripted revision (`engine:<origin>:<revision>`, see
    // `base-version.ts`'s `engineComponent`), so every assertion in this
    // suite matches the revision suffix rather than a literal `engine:r0`.
    expect(forkBranch.base).toMatch(/\0engine:[^:]+:r0$/);
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

  // Every other case in this suite uses `scriptedLineage`, which ignores
  // whatever `session` it is given — so nothing here exercises the hazard a
  // `lineage` that IGNORES its session risks. `assertTargetUnchanged` passes
  // the pinned TRANSACTION HANDLE as the session to a commit-time engine-
  // anchor check — the FIRST base@V call site to consult `lineage` from
  // strictly INSIDE the target's own open commit transaction (no advisory
  // lock pins an engine-anchored store's write path). This case uses
  // `scriptedLineageBackendWithRealRead`, whose `revision()`/`changesSince()`
  // ignore that session and instead issue a real query against the ROOT
  // backend they closed over — exactly the "reads through a connection it
  // closed over instead of the argument" defect `LineageMembers`' own doc
  // comment names. That query lands on the SAME caller-serialized SQLite
  // backend the open transaction already holds the execution slot for, and
  // the backend's own reentrancy guard (`serialized-execution-queue.ts`'s
  // `rejectReentrantQueueSubmission`, also exercised by
  // `tests/caller-serialized-queue.test.ts`) detects this and refuses
  // immediately with a typed `ConfigurationError` — a fast, diagnosable
  // failure, never the silent hang the naive call pattern would otherwise
  // risk. This test pins the CONCRETE, typed shape that failure takes today
  // when a `lineage` ignores the session it is handed on the bundled SQLite
  // backend; contrast `tests/backends/integration/lineage-conformance.ts`'s
  // matching case, where reading on the session it is given lets the SAME
  // call pattern succeed with no reentrancy at all.
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
    expect(forkBranch.base).toMatch(/\0engine:[^:]+:r0$/);
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
        expect(anchors.forkPoint.baseVersion).toMatch(/\0engine:[^:]+:r1$/);
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
    expect(forkBranch.base).toMatch(/\0engine:[^:]+:r0$/);
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

// Regression coverage for the P1 finding this suite's other cases could not
// have caught: every one of them scripts ONE backend's `lineage` and forks
// from it, so the branch's engine anchor and the target it merges into
// always share the same physical database (and, before this fix, the same
// BARE revision number was the only thing the anchor compared). These cases
// build TWO physically INDEPENDENT scripted-lineage backends whose engines
// coincidentally report the identical revision string "r1" — a fresh
// per-database counter would do exactly this — and prove the anchor no
// longer treats that coincidence as proof of a shared fork point.
describe("engine anchor: origin binding across independent databases", () => {
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

  function makePlainBackend(): Promise<GraphBackend> {
    const fixture = createSqliteMergeBackend();
    cleanups.push(fixture.cleanup);
    return Promise.resolve(fixture.backend);
  }

  it("refuses a branch forked from one database against an unrelated database whose engine coincidentally reports the same bare revision", async () => {
    const stateA = initialState();
    stateA.revision = "r1" as EngineRevision;
    const [storeA] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(stateA),
    );
    await storeA.nodes.Widget.bulkCreate([
      { id: "base-1", props: { label: "base", group: "g1" } },
    ]);

    const forkBranch = unwrap(
      await branch<WidgetGraph>(storeA, makePlainBackend, { id: BRANCH }),
    );
    await forkBranch.store.nodes.Widget.create({
      label: "from fork",
      group: "g1",
    });

    // A COMPLETELY SEPARATE database, never forked from or written through
    // `storeA` — its scripted lineage just happens to report the exact same
    // bare "r1" revision string.
    const stateB = initialState();
    stateB.revision = "r1" as EngineRevision;
    const [storeB] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(stateB),
    );
    await storeB.nodes.Widget.bulkCreate([
      { id: "base-1", props: { label: "base", group: "g1" } },
    ]);

    const result = await merge<WidgetGraph>(
      storeB,
      [forkBranch],
      engineAnchorMergeOptions(fakeEmbedder),
    );

    // Mutation-proof: reverting `engineComponent` to embed the bare
    // revision alone (dropping the origin) makes this assertion fail — both
    // sides mint an identical `engine:r1` anchor and the merge wrongly
    // succeeds.
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    }
    expect(await widgetLabels(storeB)).toEqual(["base"]);
  });

  it("merges the same branch into its real origin store without issue", async () => {
    const stateA = initialState();
    stateA.revision = "r1" as EngineRevision;
    const [storeA] = await createStoreWithSchema(
      widgetGraph,
      makeBackend(stateA),
    );
    await storeA.nodes.Widget.bulkCreate([
      { id: "base-1", props: { label: "base", group: "g1" } },
    ]);

    const forkBranch = unwrap(
      await branch<WidgetGraph>(storeA, makePlainBackend, { id: BRANCH }),
    );
    await forkBranch.store.nodes.Widget.create({
      label: "from fork",
      group: "g1",
    });

    const result = await merge<WidgetGraph>(
      storeA,
      [forkBranch],
      engineAnchorMergeOptions(fakeEmbedder),
    );

    expect(isOk(result)).toBe(true);
    expect(await widgetLabels(storeA)).toEqual(["base", "from fork"]);
  });
});

/** One recorded `LineageMembers` call: which member, and the session it ran on. */
interface RecordedLineageCall {
  member: "revision" | "changesSince";
  session: LineageSession;
}

/**
 * A `lineage` whose `revision`/`changesSince` record the exact `session`
 * object each call received into `calls`, then answer from `state` —
 * the direct evidence for "session facts come from the session that
 * enforces them": every caller in this suite passes a DIFFERENT session,
 * and a bag that ignored the argument (reading its own closed-over
 * connection instead) would be indistinguishable from one by its answers
 * alone, only by what it recorded.
 */
function sessionRecordingLineage(
  state: ScriptedLineageState,
  calls: RecordedLineageCall[],
): LineageMembers {
  return {
    revision: (session) => {
      calls.push({ member: "revision", session });
      return Promise.resolve(state.revision);
    },
    changesSince: (session, since, graphId) => {
      calls.push({ member: "changesSince", session });
      return Promise.resolve(state.delta(since, graphId));
    },
  };
}

describe("assertTargetUnchanged reads lineage on its pinned session", () => {
  it("passes the transaction handle as the session to the commit-time engine-anchor check, and the root backend to branch()/staging's planning-time reads", async () => {
    // Two independent scripted-lineage backends — one per side of the merge
    // — each with its OWN call recorder, so the assertions below can tell
    // "which store's lineage, on which session" apart cleanly.
    const targetState = initialState();
    const targetCalls: RecordedLineageCall[] = [];
    const targetSqlite = new Database(":memory:");
    targetSqlite.exec(generateSqliteMigrationSQL());
    const targetProfile = buildSqliteEngineProfile(
      drizzleSqlite(targetSqlite),
      {
        executionProfile: { isSync: true },
      },
    );
    attachLineage(
      targetProfile.provisioning,
      sessionRecordingLineage(targetState, targetCalls),
    );
    const targetBackend = createSqlBackend(targetProfile);
    // Observe every transaction handle this backend hands to a callback,
    // so the commit-time session can be compared to the pinned handle BY
    // IDENTITY (or derivation from it) rather than merely "not the root".
    const observedHandles: object[] = [];
    const observedTarget = deriveBackend(targetBackend, {
      transaction: (callback, options) =>
        targetBackend.transaction((handle) => {
          observedHandles.push(handle);
          return callback(handle);
        }, options),
    });

    const forkState = initialState();
    const forkCalls: RecordedLineageCall[] = [];
    const forkSqlite = new Database(":memory:");
    forkSqlite.exec(generateSqliteMigrationSQL());
    const forkProfile = buildSqliteEngineProfile(drizzleSqlite(forkSqlite), {
      executionProfile: { isSync: true },
    });
    attachLineage(
      forkProfile.provisioning,
      sessionRecordingLineage(forkState, forkCalls),
    );
    const forkBackend = createSqlBackend(forkProfile);

    try {
      const [baseStore] = await createStoreWithSchema(
        widgetGraph,
        observedTarget,
      );
      await baseStore.nodes.Widget.bulkCreate([
        { id: "base-1", props: { label: "base", group: "g1" } },
      ]);

      const forkBranch = unwrap(
        await branch<WidgetGraph>(
          baseStore,
          () => Promise.resolve(forkBackend),
          { id: BRANCH },
        ),
      );
      const forkWidget = await forkBranch.store.nodes.Widget.create({
        label: "from fork",
        group: "g1",
      });
      // The fork's own scripted delta must actually name the row it just
      // created — a scripted `lineage` is disconnected from the real
      // database, so nothing updates this automatically the way
      // `recordedRelationsLineage` would. Left at `initialState()`'s empty
      // default, `branchPruneTo` would prune the fork side to nothing and
      // the new row would never reach entity resolution at all.
      forkState.delta = () => ({
        kind: "keys",
        nodes: [{ kind: "Widget", id: forkWidget.id }],
        edges: [],
      });
      // `branch()`'s fork-time capture (`captureBranchForkState`) already
      // ran above, strictly outside any transaction, on the working copy's
      // own root backend — the only session available to it.
      const forkRootBackend = storeBackend(forkBranch.store);
      expect(forkCalls).toEqual([
        { member: "revision", session: forkRootBackend },
      ]);

      const embedder = driftingEmbedder(() => {
        targetState.revision = "r1" as EngineRevision;
      });
      const result = await merge<WidgetGraph>(
        baseStore,
        [forkBranch],
        engineAnchorMergeOptions(embedder),
      );
      expect(isOk(result)).toBe(true);
      expect(await widgetLabels(baseStore)).toEqual(["base", "from fork"]);

      // `staging.ts`'s `branchPruneTo` also ran at planning time, on that
      // same fork root backend — never a transaction handle, since the
      // fork's own store has no open transaction of its own here.
      expect(forkCalls).toContainEqual({
        member: "changesSince",
        session: forkRootBackend,
      });
      expect(forkCalls.every((call) => call.session === forkRootBackend)).toBe(
        true,
      );

      // The commit-time guard's calls (`assertTargetUnchanged`, inside
      // `commitPlan`'s `target.transaction(...)`) are on a DIFFERENT
      // session than the target's own root backend — the pinned
      // transaction handle. MUTATION-PROOF: revert
      // `assertTargetUnchanged`'s engine-anchor branch to pass
      // `storeBackend(target)` instead of `txBackend` as the session to
      // `requireLineage`/`engineAnchorMismatch`, and every entry's
      // `session` becomes the store's root (`observedTarget`), failing
      // this assertion.
      const commitTimeCalls = targetCalls.filter(
        (call) => call.session !== observedTarget,
      );
      expect(commitTimeCalls.map((call) => call.member)).toEqual([
        "revision",
        "changesSince",
      ]);
      // Every commit-time call ran on the pinned transaction handle the
      // backend handed to the commit callback (or a handle derived from
      // it) — not the root, and not some third object either.
      const pinnedHandle = requireDefined(
        observedHandles.at(-1),
        "the commit ran inside a transaction",
      );
      for (const call of commitTimeCalls) {
        expect(
          call.session === pinnedHandle ||
            isBackendDerivedFrom(call.session, pinnedHandle),
        ).toBe(true);
      }
    } finally {
      targetSqlite.close();
      forkSqlite.close();
    }
  });

  it("throws LINEAGE_UNAVAILABLE at commit when the pinned transaction handle carries no lineage of its own, rather than silently reading a different connection", async () => {
    const state = initialState();

    // No `EngineProvisioning.lineage` is attached to this profile — the
    // ONLY `lineage` this backend has is the `deriveBackend` overlay below,
    // applied to the already-constructed root object. A `transaction()`
    // handle this backend builds never carries an overlay applied to the
    // root after construction, so `assertTargetUnchanged` — which reads
    // `lineage` off the PINNED TRANSACTION HANDLE ONLY, with no fallback to
    // the root — finds nothing there even though `resolveLineage(target)`
    // (the SAME read `computeBaseVersion` used to anchor the token at plan
    // time) finds one on the root every time. This is the "vanished
    // source" case `requireLineage`'s own refusal exists for: an
    // engine anchor was minted at plan time, but the session the commit
    // guard is pinned to no longer supplies the capability that minted it.
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

      // Mutation-prove by reverting `assertTargetUnchanged` to
      // `resolveLineage(target)` (the root read) instead of
      // `requireLineage(txBackend, …)`: the merge would then succeed
      // (finding the root-only overlay) and both assertions below fail.
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.cause).toBeInstanceOf(ConfigurationError);
        expect((result.error.cause as ConfigurationError).details).toEqual(
          expect.objectContaining({
            code: "LINEAGE_UNAVAILABLE",
            operation: "assertTargetUnchanged",
          }),
        );
      }
      // Nothing committed from the refused attempt.
      expect(await widgetLabels(baseStore)).toEqual(["base"]);
    } finally {
      await forkFixture.cleanup();
      sqlite.close();
    }
  });
});
