/**
 * Cross-backend contract for the whole contribution health ladder:
 * `store.probeContributions()` (#377), `store.verifyContributions()` /
 * `store.repairContributions()` (#324), and
 * `store.rebuildContribution()` (#337).
 *
 * A durable contribution marker that says "initialized" is trusted by
 * every hot path without the catalog ever being consulted, so a database
 * whose strategy-owned tables were dropped out of band opens completely
 * clean and fails at the first read. These tests pin the diagnostics and
 * repairs that close that gap — and they belong in the shared suite
 * because the verdicts are query-layer semantics, not per-dialect wiring:
 * only the same case run on both backends proves the catalog probe, the
 * repair, and the rebuild agree.
 *
 * All three rungs live in one file because they share one detection pass
 * and one restore contract. The escalation tests are the point: a probe
 * that reports `degraded` is only useful if the rung it points at
 * actually resolves it, and that is a claim about two operations
 * together.
 *
 * The fulltext contribution carries the cross-backend cases (every
 * backend in the suite owns one). The vector cases run only where the
 * backend advertises vector support.
 *
 * Every test here corrupts durable state on purpose, so the suite
 * restores it in `afterEach`: the fulltext table is database-global, and
 * one backend in the lane (PGlite) shares a single engine across tests
 * rather than building a fresh database per test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ContributionRebuildUnsupportedError,
  ContributionUnavailableError,
  defineGraph,
  defineNode,
  resolveGraphVectorSlots,
  searchable,
} from "../../../src";
import type { StrategyTableContribution } from "../../../src/backend/table-contribution";
import type {
  AdapterBackend,
  ContributionDiagnostic,
  ContributionMaterializationRow,
  ContributionProbeContribution,
  ContributionProbeEntry,
  ContributionProbeResult,
  GraphBackend,
} from "../../../src/backend/types";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationStore, integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

const ARTICLE_KIND = "Article";
const ARTICLE_EMBEDDING_FIELD = "embedding";

/**
 * A second graph living in the SAME database as the suite's graph.
 *
 * The fulltext table is one physical table whose rows are keyed by
 * `graph_id`, so this is the neighbor whose searchable content a per-graph
 * rebuild must never be able to destroy. Its own kind, because the point is
 * that the two graphs share storage, not declarations.
 */
const NEIGHBOR_GRAPH_ID = "contribution-neighbor-graph";
const NeighborNote = defineNode("Note", {
  schema: z.object({ body: searchable({ language: "english" }) }),
});
const neighborGraph = defineGraph({
  id: NEIGHBOR_GRAPH_ID,
  nodes: { Note: { type: NeighborNote } },
  edges: {},
});
/** Term only the neighbor graph's content matches. */
const NEIGHBOR_QUERY = "unshareable";
/** A signature no `createDdl` can ever hash to. */
const IMPOSSIBLE_SIGNATURE = "0000000000000000";

/**
 * Every runtime contribution boot materialized for this graph — the
 * fulltext slot plus, where the backend supports vectors, each declared
 * embedding slot. Derived from the same declarations boot used, so the
 * idempotent `createDdl` restore recreates the exact provisioned shape.
 */
function ownedContributions(
  backend: GraphBackend,
): readonly StrategyTableContribution[] {
  const fulltextTable = requireDefined(
    backend.tableNames?.fulltext,
    "backend must resolve a fulltext table name",
  );
  const fulltext = backend.fulltextStrategy?.ownedTables(fulltextTable) ?? [];
  const vectorStrategy = backend.vectorStrategy;
  const vector =
    backend.capabilities.vector?.supported === true && vectorStrategy ?
      resolveGraphVectorSlots(integrationTestGraph).flatMap((slot) =>
        vectorStrategy.ownedTables(slot),
      )
    : [];
  return [...fulltext, ...vector].filter(
    (contribution) => contribution.runtimeEnsure,
  );
}

function entryFor(
  diagnostics: readonly ContributionDiagnostic[],
  physicalName: string,
): ContributionDiagnostic | undefined {
  return diagnostics.find((entry) => entry.physicalName === physicalName);
}

/** One projection's probe entry, or `undefined` when it was not assessed. */
function probeEntry(
  result: ContributionProbeResult,
  contribution: ContributionProbeContribution,
): ContributionProbeEntry | undefined {
  return result.entries.find((entry) => entry.contribution === contribution);
}

/** The error a rejected promise carries, or `undefined` when it resolves. */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

// Postgres returns COUNT(*) as a string/bigint, SQLite as a number, so the
// value is genuinely not statically a number.
type CountRow = Readonly<{ cnt: unknown }>;

/**
 * Content rows in the fulltext table right now. The probe's read-only
 * claim and the rebuild's refill claim are both about this number, and
 * neither can be checked through the search API alone: an empty index and
 * a refused one look the same from the outside.
 */
async function countFulltextRows(store: IntegrationStore): Promise<number> {
  const backend = store.backend;
  const table = requireDefined(
    backend.tableNames?.fulltext,
    "backend must resolve a fulltext table name",
  );
  const rows = await backend.execute<CountRow>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS cnt
      FROM ${sql.identifier(table)}
      WHERE graph_id = ${store.graphId}
    `),
  );
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Whether this backend can serve a destructive rebuild, skipping the test
 * when it cannot. A skip rather than a conditional assertion: a backend
 * with no schema fence has nothing to verify here, and the refusal it
 * gives instead is pinned by the dialect-free unit suite.
 */
function requireRebuild(
  context: IntegrationTestContext,
  ctx: Readonly<{ skip: () => void }>,
): boolean {
  if (context.getStore().backend.capabilities.contributions?.rebuild === true) {
    return true;
  }
  ctx.skip();
  return false;
}

/**
 * Materialization instant `markStale` records. Far enough in the past that
 * a rebuild's own stamp is unambiguously distinguishable from it, which is
 * what pins the transaction-scoped writer's "state the row outright" rule:
 * carrying this timestamp forward would misdate storage that was just
 * recreated.
 */
const STALE_MATERIALIZED_AT = "2020-01-02T03:04:05.000Z";

/**
 * Marks a contribution's marker at a signature the current `createDdl` can
 * never hash to, leaving the table itself untouched — the `stale` state,
 * which is the one incremental repair cannot finish.
 */
async function markStale(
  context: IntegrationTestContext,
  contribution: StrategyTableContribution,
): Promise<void> {
  await requireDefined(
    context.getBackend().recordContributionMaterialization,
    "backend must record contribution markers",
  )({
    graphId: integrationTestGraph.id,
    logicalName: contribution.logicalName,
    owner: contribution.owner,
    tableName: contribution.tableName,
    signature: IMPOSSIBLE_SIGNATURE,
    attemptedAt: new Date().toISOString(),
    materializedAt: STALE_MATERIALIZED_AT,
    error: undefined,
  });
}

/** The durable marker row for one contribution, or `undefined`. */
async function markerFor(
  context: IntegrationTestContext,
  contribution: StrategyTableContribution,
): Promise<ContributionMaterializationRow | undefined> {
  return requireDefined(
    context.getBackend().getContributionMaterialization,
    "backend must read contribution markers",
  )({
    graphId: integrationTestGraph.id,
    logicalName: contribution.logicalName,
    owner: contribution.owner,
    tableName: contribution.tableName,
  });
}

/** Run one raw DDL statement, refusing on a backend that cannot. */
async function executeDdl(
  backend: AdapterBackend<unknown>,
  statement: string,
): Promise<void> {
  await requireDefined(
    backend.executeDdl,
    "backend must support DDL for these tests",
  )(statement);
}

export function registerContributionDiagnosticIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Contribution diagnostics", () => {
    let contributions: readonly StrategyTableContribution[] = [];
    let snapshots: readonly (ContributionMaterializationRow | undefined)[] = [];

    /** The fulltext contribution — the one every backend in the lane owns. */
    function fulltextContribution(): StrategyTableContribution {
      return requireDefined(
        contributions[0],
        "fulltext strategy must declare a runtime contribution",
      );
    }

    beforeEach(async () => {
      // One backend reference throughout: `contributions` and `snapshots`
      // must describe the same object the restore writes back to, or a
      // future divergence between the two accessors would silently restore
      // a different set than was captured.
      const backend = context.getBackend();
      contributions = ownedContributions(backend);
      const read = requireDefined(
        backend.getContributionMaterialization,
        "backend must read contribution markers",
      );
      snapshots = await Promise.all(
        contributions.map((contribution) =>
          read({
            graphId: integrationTestGraph.id,
            logicalName: contribution.logicalName,
            owner: contribution.owner,
            tableName: contribution.tableName,
          }),
        ),
      );
    });

    /**
     * Restore both halves of the state one test corrupted: re-run the
     * idempotent contribution DDL (a no-op when the table survived) and
     * re-record the marker exactly as it was found.
     */
    async function restoreContribution(
      backend: AdapterBackend<unknown>,
      contribution: StrategyTableContribution,
      snapshot: ContributionMaterializationRow | undefined,
    ): Promise<void> {
      for (const ddl of contribution.createDdl) {
        await executeDdl(backend, ddl);
      }
      // No snapshot means no marker existed at capture time, so there is
      // nothing to put back. A test that CREATES a marker where none was
      // would leak it past this hook — not reachable today (boot
      // materializes the fulltext contribution for every graph, so every
      // contribution this suite touches is already marked), but the day a
      // test provisions a new slot, this branch needs a delete.
      if (snapshot === undefined) return;
      await requireDefined(
        backend.recordContributionMaterialization,
        "backend must record contribution markers",
      )({
        graphId: snapshot.graphId,
        logicalName: snapshot.logicalName,
        owner: snapshot.owner,
        tableName: snapshot.tableName,
        signature: snapshot.signature,
        attemptedAt: snapshot.lastAttemptedAt,
        materializedAt: snapshot.materializedAt,
        error: snapshot.lastError,
      });
    }

    // This hook exists because an unrestored drop of the database-global
    // fulltext table once broke every later test in the shared-engine
    // lane. It must therefore not fail PARTIALLY: one contribution that
    // cannot be restored must not abort the restore of the others. Every
    // restore is attempted in turn — serially, because these are DDL
    // statements and concurrent DDL is its own hazard — and the first
    // failure is rethrown once they have all had their chance.
    afterEach(async () => {
      const backend = context.getBackend();
      let failure: unknown;
      for (const [index, contribution] of contributions.entries()) {
        try {
          await restoreContribution(backend, contribution, snapshots[index]);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
    });

    it("reports nothing on a database whose markers match the catalog", async () => {
      await expect(context.getStore().verifyContributions()).resolves.toEqual(
        [],
      );
    });

    it("reports a dropped contribution table with a live marker as orphaned-marker", async () => {
      const store = context.getStore();
      const contribution = fulltextContribution();

      // Boot already cached this contribution as initialized on this
      // backend instance — the diagnostic must not ride that cache.
      expect(await store.verifyContributions()).toEqual([]);

      await executeDdl(
        context.getBackend(),
        `DROP TABLE IF EXISTS ${contribution.tableName}`,
      );

      const diagnostics = await store.verifyContributions();
      expect(entryFor(diagnostics, contribution.tableName)).toEqual({
        owner: contribution.owner,
        logicalName: contribution.logicalName,
        physicalName: contribution.tableName,
        state: "orphaned-marker",
      });
    });

    it("reports signature drift against a live table as stale", async () => {
      const store = context.getStore();
      const contribution = fulltextContribution();
      const now = new Date().toISOString();

      // Overwrite the marker at a signature the current DDL can never
      // produce: the table is untouched, only the recorded shape drifted.
      await requireDefined(
        context.getBackend().recordContributionMaterialization,
        "backend must record contribution markers",
      )({
        graphId: integrationTestGraph.id,
        logicalName: contribution.logicalName,
        owner: contribution.owner,
        tableName: contribution.tableName,
        signature: IMPOSSIBLE_SIGNATURE,
        attemptedAt: now,
        materializedAt: now,
        error: undefined,
      });

      const diagnostics = await store.verifyContributions();
      expect(entryFor(diagnostics, contribution.tableName)?.state).toBe(
        "stale",
      );

      const repair = await store.repairContributions();
      expect(repair.results).toMatchObject([
        {
          diagnostic: { physicalName: contribution.tableName, state: "stale" },
          status: "requires-rebuild",
        },
      ]);
      expect(entryFor(repair.remaining, contribution.tableName)?.state).toBe(
        "stale",
      );
    });

    it("repairs a missing marker on a warm Store without replacing its table", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const contribution = fulltextContribution();
      const snapshot = requireDefined(
        snapshots[0],
        "boot must record the fulltext contribution marker",
      );

      // Warm the backend's positive signature cache before corrupting durable
      // state. Repair must re-read the marker instead of trusting this cache.
      expect(await store.verifyContributions()).toEqual([]);
      await requireDefined(
        backend.recordContributionMaterialization,
        "backend must record contribution markers",
      )({
        graphId: snapshot.graphId,
        logicalName: snapshot.logicalName,
        owner: snapshot.owner,
        tableName: snapshot.tableName,
        signature: snapshot.signature,
        attemptedAt: new Date().toISOString(),
        materializedAt: undefined,
        error: "simulated marker failure",
      });

      const result = await store.repairContributions();
      expect(result.results).toMatchObject([
        {
          diagnostic: {
            physicalName: contribution.tableName,
            state: "missing-marker",
            lastError: "simulated marker failure",
          },
          status: "repaired",
        },
      ]);
      expect(result.remaining).toEqual([]);

      // The same table remains usable and a second pass is a true no-op.
      const created = await store.nodes.Person.create({ name: "Repaired" });
      expect(await store.nodes.Person.getById(created.id)).toMatchObject({
        name: "Repaired",
      });
      await expect(store.repairContributions()).resolves.toEqual({
        results: [],
        remaining: [],
      });
    });

    it("reports a live table whose marker records no success as missing-marker", async () => {
      const store = context.getStore();
      const contribution = fulltextContribution();
      const snapshot = requireDefined(
        snapshots[0],
        "boot must record the fulltext contribution marker",
      );

      // Record a failed attempt: storage is present but the marker no
      // longer attests it, so every read is refused as uninitialized.
      // (The upsert's COALESCE may keep an earlier `materializedAt`; the
      // recorded error is what makes the marker non-attesting.)
      await requireDefined(
        context.getBackend().recordContributionMaterialization,
        "backend must record contribution markers",
      )({
        graphId: integrationTestGraph.id,
        logicalName: contribution.logicalName,
        owner: contribution.owner,
        tableName: contribution.tableName,
        signature: snapshot.signature,
        attemptedAt: new Date().toISOString(),
        materializedAt: undefined,
        error: "simulated materialization failure",
      });

      const diagnostics = await store.verifyContributions();
      // The recorded reason survives the state fold — it is the only
      // thing distinguishing this from a marker row that never existed.
      expect(entryFor(diagnostics, contribution.tableName)).toMatchObject({
        state: "missing-marker",
        lastError: "simulated materialization failure",
      });
    });

    it("reports a live table with no marker row at all as missing-marker", async (ctx) => {
      const store = context.getStore();
      const strategy = store.backend.vectorStrategy;
      const deleteMarker = context.getBackend().deleteVectorSlotContribution;
      if (
        store.backend.capabilities.vector?.supported !== true ||
        strategy === undefined ||
        deleteMarker === undefined
      ) {
        // Deleting a marker while leaving its table standing is only
        // expressible for vector slots; the dialect-free unit suite covers
        // the same branch for every owner.
        ctx.skip();
        return;
      }

      // The no-row case — what a freshly bootstrapped marker table looks
      // like against storage that already exists. Distinct from the
      // recorded-failure case above, which collapses to the same state but
      // carries a `lastError`.
      const slot = requireDefined(
        resolveGraphVectorSlots(integrationTestGraph).find(
          (candidate) =>
            candidate.nodeKind === ARTICLE_KIND &&
            candidate.fieldPath === ARTICLE_EMBEDDING_FIELD,
        ),
        "fixture graph must declare the Article embedding slot",
      );
      await deleteMarker(slot);

      const tableName = strategy.tableName(
        integrationTestGraph.id,
        ARTICLE_KIND,
        ARTICLE_EMBEDDING_FIELD,
      );
      const entry = entryFor(await store.verifyContributions(), tableName);
      expect(entry).toMatchObject({ state: "missing-marker" });
      expect(entry?.lastError).toBeUndefined();
    });

    it("reports a failed attempt that produced no table as failed-materialization", async (ctx) => {
      const store = context.getStore();
      const backend = context.getBackend();
      const strategy = store.backend.vectorStrategy;
      const deleteMarker = backend.deleteVectorSlotContribution;
      if (
        store.backend.capabilities.vector?.supported !== true ||
        strategy === undefined ||
        deleteMarker === undefined
      ) {
        // Needs a marker with NO prior success, which the upsert's COALESCE
        // will not produce over boot's successful row — so the row must be
        // deleted first, and only vector slots expose that. The dialect-free
        // unit suite covers this branch for every owner.
        ctx.skip();
        return;
      }

      const slot = requireDefined(
        resolveGraphVectorSlots(integrationTestGraph).find(
          (candidate) =>
            candidate.nodeKind === ARTICLE_KIND &&
            candidate.fieldPath === ARTICLE_EMBEDDING_FIELD,
        ),
        "fixture graph must declare the Article embedding slot",
      );
      const tableName = strategy.tableName(
        integrationTestGraph.id,
        ARTICLE_KIND,
        ARTICLE_EMBEDDING_FIELD,
      );
      const failure = 'extension "vector" is not available';

      // Reproduce a genuine first-attempt failure: no marker row, then a
      // recorded failure, and no table to show for it.
      await deleteMarker(slot);
      await executeDdl(backend, `DROP TABLE IF EXISTS ${tableName}`);
      for (const contribution of strategy.ownedTables(slot)) {
        await requireDefined(
          backend.recordContributionMaterialization,
          "backend must record contribution markers",
        )({
          graphId: integrationTestGraph.id,
          logicalName: contribution.logicalName,
          owner: contribution.owner,
          tableName: contribution.tableName,
          signature: IMPOSSIBLE_SIGNATURE,
          attemptedAt: new Date().toISOString(),
          materializedAt: undefined,
          error: failure,
        });
      }

      // Marker and catalog agree that nothing is there — and it is still
      // broken. Reporting clean here is the one answer this must never give.
      expect(
        entryFor(await store.verifyContributions(), tableName),
      ).toMatchObject({
        physicalName: tableName,
        kind: ARTICLE_KIND,
        fieldPath: ARTICLE_EMBEDDING_FIELD,
        state: "failed-materialization",
        lastError: failure,
      });
    });

    it("changes nothing it observes — repeated calls report identically", async () => {
      const store = context.getStore();
      const contribution = fulltextContribution();

      await executeDdl(
        context.getBackend(),
        `DROP TABLE IF EXISTS ${contribution.tableName}`,
      );

      const first = await store.verifyContributions();
      const second = await store.verifyContributions();
      // A diagnostic that had repaired (or re-marked) anything would come
      // back clean on the second call.
      expect(second).toEqual(first);
      expect(entryFor(second, contribution.tableName)?.state).toBe(
        "orphaned-marker",
      );
    });

    it("leaves a healthy store fully usable", async () => {
      const store = context.getStore();
      await store.verifyContributions();

      const created = await store.nodes.Person.create({ name: "Verifier" });
      expect(await store.nodes.Person.getById(created.id)).toMatchObject({
        name: "Verifier",
      });
    });

    it("reports a dropped vector table with kind and fieldPath", async (ctx) => {
      const store = context.getStore();
      const strategy = store.backend.vectorStrategy;
      if (
        store.backend.capabilities.vector?.supported !== true ||
        strategy === undefined
      ) {
        ctx.skip();
        return;
      }

      // The Article fixture declares `embedding(4)`, so boot provisioned
      // exactly this slot.
      const tableName = strategy.tableName(
        integrationTestGraph.id,
        ARTICLE_KIND,
        ARTICLE_EMBEDDING_FIELD,
      );
      await executeDdl(
        context.getBackend(),
        `DROP TABLE IF EXISTS ${tableName}`,
      );

      const diagnostics = await store.verifyContributions();
      expect(entryFor(diagnostics, tableName)).toMatchObject({
        physicalName: tableName,
        kind: ARTICLE_KIND,
        fieldPath: ARTICLE_EMBEDDING_FIELD,
        state: "orphaned-marker",
      });
    });

    it("stays silent about declared embeddings on a backend without vector support", async (ctx) => {
      const store = context.getStore();
      if (store.backend.capabilities.vector?.supported === true) {
        ctx.skip();
        return;
      }

      // The fixture graph declares `Article.embedding`, and no per-field
      // table exists for it here — but this backend never materialized
      // one, so there is nothing to disagree about. Reporting it would be
      // a false positive on every store this backend ever opens.
      await expect(store.verifyContributions()).resolves.toEqual([]);
    });

    /**
     * `store.probeContributions()` — the read-only bottom rung of the
     * ladder. Nested here so these share the diagnostics suite's restore
     * hook: the fulltext table is database-global, and one backend in the
     * lane reuses a single engine across tests.
     */
    describe("readiness probe", () => {
      it("reports every declared projection as ready on a healthy database", async () => {
        const store = context.getStore();
        const result = await store.probeContributions();

        // The fixture declares searchable fields, so fulltext is always
        // assessed; the vector projection appears only where the backend
        // materialized the declared embedding slot.
        const expected =
          store.backend.capabilities.vector?.supported === true ?
            [
              { contribution: "fulltext", state: "ready" },
              { contribution: "vector", state: "ready" },
            ]
          : [{ contribution: "fulltext", state: "ready" }];
        expect(result.entries).toEqual(expected);
      });

      it("refuses a searchable write with a typed error after fulltext storage disappears", async () => {
        const store = context.getStore();
        const contribution = fulltextContribution();
        const nodeId = "orphaned-fulltext-write";

        await executeDdl(
          context.getBackend(),
          `DROP TABLE IF EXISTS ${contribution.tableName}`,
        );

        const error = await captureRejection(
          store.nodes.Article.create(
            {
              title: "Orphaned write",
              body: "This node insert must roll back.",
              category: "health",
              published: true,
            },
            { id: nodeId },
          ),
        );

        expect(error).toBeInstanceOf(ContributionUnavailableError);
        if (!(error instanceof ContributionUnavailableError)) {
          throw new Error("Expected ContributionUnavailableError");
        }
        expect(error).toMatchObject({
          code: "CONTRIBUTION_UNAVAILABLE",
          details: {
            graphId: integrationTestGraph.id,
            logicalName: "fulltext",
            physicalName: contribution.tableName,
            state: "physical-storage-missing",
          },
        });
        expect(error.cause).toBeDefined();
        expect(
          await store.nodes.Article.getById(nodeId as never),
        ).toBeUndefined();
      });

      it("refuses fulltext search with a typed error after its storage disappears", async () => {
        const store = context.getStore();
        const contribution = fulltextContribution();
        await store.nodes.Article.create({
          title: "Orphaned search",
          body: "Warm the fulltext write path before dropping its storage.",
          category: "health",
          published: true,
        });
        await executeDdl(
          context.getBackend(),
          `DROP TABLE IF EXISTS ${contribution.tableName}`,
        );

        const error = await captureRejection(
          store.search.fulltext("Article", {
            query: "orphaned",
            limit: 10,
          }),
        );

        expect(error).toBeInstanceOf(ContributionUnavailableError);
        if (!(error instanceof ContributionUnavailableError)) {
          throw new Error("Expected ContributionUnavailableError");
        }
        expect(error).toMatchObject({
          code: "CONTRIBUTION_UNAVAILABLE",
          details: {
            graphId: integrationTestGraph.id,
            logicalName: "fulltext",
            physicalName: contribution.tableName,
            state: "physical-storage-missing",
          },
        });
        expect(error.cause).toBeDefined();
      });

      it("escalates a dropped fulltext table through repair to rebuild", async (ctx) => {
        const store = context.getStore();
        const backend = context.getBackend();
        const contribution = fulltextContribution();

        // Boot cached this contribution as initialized on this backend
        // instance — the probe must not ride that cache.
        expect(
          probeEntry(await store.probeContributions(), "fulltext"),
        ).toEqual({ contribution: "fulltext", state: "ready" });

        const article = await store.nodes.Article.create({
          title: "Probe escalation",
          body: "Content that must survive the ladder.",
          category: "health",
          published: true,
        });
        await executeDdl(
          backend,
          `DROP TABLE IF EXISTS ${contribution.tableName}`,
        );

        const degraded = await store.probeContributions();
        const fulltextEntry = degraded.entries.find(
          (entry) => entry.contribution === "fulltext",
        );
        expect(fulltextEntry?.state).toBe("degraded");
        // The detail names the table an operator would go looking for and
        // the diagnostic state that decides which repair applies.
        expect(fulltextEntry?.detail).toContain(contribution.tableName);
        expect(fulltextEntry?.detail).toContain("orphaned-marker");

        // The middle rung cannot finish this one, and says so rather than
        // re-stamping a marker over storage that is gone.
        const repair = await store.repairContributions();
        expect(repair.results).toMatchObject([
          {
            diagnostic: {
              physicalName: contribution.tableName,
              state: "orphaned-marker",
            },
            status: "requires-rebuild",
          },
        ]);
        expect(
          probeEntry(await store.probeContributions(), "fulltext")?.state,
        ).toBe("degraded");

        if (store.backend.capabilities.contributions?.rebuild !== true) {
          ctx.skip();
          return;
        }

        // The top rung: recreate the storage and reconstruct its content
        // from the node rows that were never lost.
        const rebuilt = await store.rebuildContribution("fulltext");
        expect(rebuilt.rebuilt).toEqual([contribution.tableName]);
        expect(rebuilt.repopulated).toBeGreaterThanOrEqual(1);

        expect(
          probeEntry(await store.probeContributions(), "fulltext"),
        ).toEqual({ contribution: "fulltext", state: "ready" });
        await expect(store.verifyContributions()).resolves.toEqual([]);

        // Ready means usable, not merely attested.
        const hits = await store.search.fulltext("Article", {
          query: "escalation",
          limit: 10,
        });
        expect(hits.map((hit) => hit.node.id)).toContain(article.id);
      });

      it("reports a repairable marker failure as degraded and ready again after repair", async () => {
        const store = context.getStore();
        const contribution = fulltextContribution();
        const snapshot = requireDefined(
          snapshots[0],
          "boot must record the fulltext contribution marker",
        );

        // Storage intact, bookkeeping wrong — the state the middle rung
        // exists for. The projection is still degraded, because the
        // hot-path gate refuses every fulltext read while it holds.
        await requireDefined(
          context.getBackend().recordContributionMaterialization,
          "backend must record contribution markers",
        )({
          graphId: snapshot.graphId,
          logicalName: snapshot.logicalName,
          owner: snapshot.owner,
          tableName: snapshot.tableName,
          signature: snapshot.signature,
          attemptedAt: new Date().toISOString(),
          materializedAt: undefined,
          error: "simulated marker failure",
        });

        const before = await store.probeContributions();
        const entry = before.entries.find(
          (candidate) => candidate.contribution === "fulltext",
        );
        expect(entry?.state).toBe("degraded");
        expect(entry?.detail).toContain("missing-marker");

        const repair = await store.repairContributions();
        expect(repair.remaining).toEqual([]);
        expect(
          probeEntry(await store.probeContributions(), "fulltext"),
        ).toEqual({ contribution: "fulltext", state: "ready" });
        expect(contribution.tableName).toBe(snapshot.tableName);
      });

      it("reports a dropped vector slot as degraded and names its coordinates", async (ctx) => {
        const store = context.getStore();
        const strategy = store.backend.vectorStrategy;
        if (
          store.backend.capabilities.vector?.supported !== true ||
          strategy === undefined
        ) {
          ctx.skip();
          return;
        }

        const tableName = strategy.tableName(
          integrationTestGraph.id,
          ARTICLE_KIND,
          ARTICLE_EMBEDDING_FIELD,
        );
        await executeDdl(
          context.getBackend(),
          `DROP TABLE IF EXISTS ${tableName}`,
        );

        const degraded = await store.probeContributions();
        const vectorEntry = degraded.entries.find(
          (entry) => entry.contribution === "vector",
        );
        expect(vectorEntry?.state).toBe("degraded");
        // A vector slot is named by the coordinates a caller declared it
        // with, not by the physical table they never chose.
        expect(vectorEntry?.detail).toContain(
          `${ARTICLE_KIND}.${ARTICLE_EMBEDDING_FIELD}`,
        );
        // Fulltext is a separate projection and is unaffected.
        expect(
          degraded.entries.find((entry) => entry.contribution === "fulltext"),
        ).toEqual({ contribution: "fulltext", state: "ready" });

        // The sanctioned repair for vector storage: recreate it and
        // re-stamp. Not a rebuild — see the rebuild refusal below.
        await store.reembedVectorField(ARTICLE_KIND, ARTICLE_EMBEDDING_FIELD);
        expect(probeEntry(await store.probeContributions(), "vector")).toEqual({
          contribution: "vector",
          state: "ready",
        });
      });

      it("writes nothing — marker rows and content are byte-identical across probes", async () => {
        const store = context.getStore();
        const backend = context.getBackend();
        const read = requireDefined(
          backend.getContributionMaterialization,
          "backend must read contribution markers",
        );

        await store.nodes.Article.create({
          title: "Read-only probe",
          body: "Probing must not touch a single row.",
          category: "health",
          published: true,
        });

        async function markerRows(): Promise<
          readonly (ContributionMaterializationRow | undefined)[]
        > {
          return Promise.all(
            contributions.map((contribution) =>
              read({
                graphId: integrationTestGraph.id,
                logicalName: contribution.logicalName,
                owner: contribution.owner,
                tableName: contribution.tableName,
              }),
            ),
          );
        }

        const markersBefore = await markerRows();
        const fulltextBefore = await countFulltextRows(store);
        expect(fulltextBefore).toBeGreaterThan(0);

        // Repeat, because a single call could plausibly be read-only while
        // an "ensure on first use" path fires once.
        const first = await store.probeContributions();
        const second = await store.probeContributions();
        const third = await store.probeContributions();

        // `last_attempted_at` moves on any marker write, so equality here
        // rules out a re-stamp as well as a state change.
        expect(await markerRows()).toEqual(markersBefore);
        expect(await countFulltextRows(store)).toBe(fulltextBefore);
        expect(second).toEqual(first);
        expect(third).toEqual(first);
      });

      it("keeps reporting ready while graph writes interleave with probes", async () => {
        const store = context.getStore();

        for (let round = 0; round < 3; round += 1) {
          await store.nodes.Article.create({
            title: `Interleaved ${round}`,
            body: `Body for round ${round}.`,
            category: "health",
            published: true,
          });
          const probed = await store.probeContributions();
          expect(
            probed.entries.find((entry) => entry.contribution === "fulltext"),
          ).toEqual({ contribution: "fulltext", state: "ready" });
        }

        // The writes are all searchable, so "ready" was not a claim about
        // an index that had quietly stopped tracking them.
        const hits = await store.search.fulltext("Article", {
          query: "Interleaved",
          limit: 10,
        });
        expect(hits.length).toBe(3);
      });

      it("stamps the graph revision only on a revision-tracked store", async () => {
        const store = context.getStore();
        // The suite's store is not revision-tracked, so there is no durable
        // revision to stamp — and inventing one would be a weaker
        // guarantee wearing a stronger name.
        expect(store.revisionTrackingEnabled).toBe(false);
        expect(await store.probeContributions()).not.toHaveProperty(
          "graphRevision",
        );

        const tracked = await context.createStore(integrationTestGraph, {
          revisionTracking: true,
        });
        // The revision clock has no anchor until the first tracked write,
        // so a probe before one honestly has nothing to stamp.
        expect(await tracked.probeContributions()).not.toHaveProperty(
          "graphRevision",
        );

        await tracked.nodes.Person.create({ name: "Revision anchor" });
        const probed = await tracked.probeContributions();
        expect(typeof probed.graphRevision).toBe("string");
        expect(probed.graphRevision).toBe(await tracked.revisionNow());
      });
    });

    /**
     * `store.rebuildContribution()` — the destructive top rung, and the
     * only repair for storage provisioned at a shape the current DDL no
     * longer produces.
     */
    describe("destructive rebuild", () => {
      it("finishes a stale fulltext contribution that incremental repair cannot", async (ctx) => {
        if (!requireRebuild(context, ctx)) return;
        const store = context.getStore();
        const contribution = fulltextContribution();

        const article = await store.nodes.Article.create({
          title: "Stale rebuild",
          body: "Reconstructed from the node row, not from the index.",
          category: "health",
          published: true,
        });
        await markStale(context, contribution);

        // The state #337 opened for: the table exists at the old shape, so
        // the ordinary ensure path's idempotent CREATE is a no-op and
        // re-stamping would bless the wrong shape.
        expect(
          entryFor(await store.verifyContributions(), contribution.tableName)
            ?.state,
        ).toBe("stale");
        const repair = await store.repairContributions();
        expect(repair.results).toMatchObject([{ status: "requires-rebuild" }]);
        expect(entryFor(repair.remaining, contribution.tableName)?.state).toBe(
          "stale",
        );

        const result = await store.rebuildContribution("fulltext");
        expect(result.rebuilt).toEqual([contribution.tableName]);
        expect(result.processed).toBeGreaterThanOrEqual(1);
        expect(result.repopulated).toBeGreaterThanOrEqual(1);
        expect(result.skipped).toBe(0);

        // The transaction-scoped stamp states the row outright rather than
        // preserving what was there: the storage is new, so a
        // `materialized_at` carried forward from the shape it replaced
        // would misdate it.
        const stamped = await markerFor(context, contribution);
        expect(stamped?.materializedAt).toBeDefined();
        expect(stamped?.materializedAt).not.toBe(STALE_MATERIALIZED_AT);
        expect(stamped?.signature).not.toBe(IMPOSSIBLE_SIGNATURE);
        expect(stamped?.lastError).toBeUndefined();

        await expect(store.verifyContributions()).resolves.toEqual([]);
        expect(
          probeEntry(await store.probeContributions(), "fulltext"),
        ).toEqual({ contribution: "fulltext", state: "ready" });

        // Content reconstructed, not merely storage recreated.
        const hits = await store.search.fulltext("Article", {
          query: "Reconstructed",
          limit: 10,
        });
        expect(hits.map((hit) => hit.node.id)).toEqual([article.id]);
      });

      it("refuses a vector rebuild with the exact typed error and drops nothing", async (ctx) => {
        const store = context.getStore();
        const strategy = store.backend.vectorStrategy;
        if (
          store.backend.capabilities.vector?.supported !== true ||
          strategy === undefined
        ) {
          ctx.skip();
          return;
        }

        const before = await store.probeContributions();
        const error = await captureRejection(
          store.rebuildContribution("vector"),
        );

        expect(error).toBeInstanceOf(ContributionRebuildUnsupportedError);
        expect(error).toMatchObject({
          code: "CONTRIBUTION_REBUILD_UNSUPPORTED",
          reason: "vector-source-unavailable",
        });
        // The suggestion is the whole point of refusing: there IS a
        // destructive path for vectors, and it takes the callback that can
        // regenerate what the drop destroys.
        expect((error as Error & { suggestion?: string }).suggestion).toContain(
          "reembedVectorField",
        );

        // A refusal, not a partial attempt.
        expect(await store.probeContributions()).toEqual(before);
        await expect(store.verifyContributions()).resolves.toEqual([]);
      });

      it("is not reachable from repairContributions", async (ctx) => {
        if (!requireRebuild(context, ctx)) return;
        const store = context.getStore();
        const contribution = fulltextContribution();

        const article = await store.nodes.Article.create({
          title: "Untouched by repair",
          body: "Repair must not drop this index.",
          category: "health",
          published: true,
        });
        await markStale(context, contribution);

        // Repair reports the rebuild as required and then does nothing
        // destructive: the existing rows are still in the existing table.
        const rowsBefore = await countFulltextRows(store);
        await store.repairContributions();
        expect(await countFulltextRows(store)).toBe(rowsBefore);

        // And the marker still records the stale shape — repair did not
        // quietly re-stamp it at the current signature.
        expect(
          entryFor(await store.verifyContributions(), contribution.tableName)
            ?.state,
        ).toBe("stale");
        expect(article.id).toBeTruthy();
      });

      it("reconstructs content the drop destroys", async (ctx) => {
        if (!requireRebuild(context, ctx)) return;
        const store = context.getStore();
        const backend = context.getBackend();
        const contribution = fulltextContribution();

        const created = await Promise.all([
          store.nodes.Article.create({
            title: "Alpha reconstruction",
            body: "First body.",
            category: "health",
            published: true,
          }),
          store.nodes.Article.create({
            title: "Beta reconstruction",
            body: "Second body.",
            category: "health",
            published: true,
          }),
        ]);

        // Lose every content row, the way a partial restore would.
        await executeDdl(
          backend,
          `DROP TABLE IF EXISTS ${contribution.tableName}`,
        );

        const result = await store.rebuildContribution("fulltext", {
          pageSize: 1,
        });
        expect(result.repopulated).toBe(created.length);
        expect(await countFulltextRows(store)).toBe(created.length);

        const hits = await store.search.fulltext("Article", {
          query: "reconstruction",
          limit: 10,
        });
        expect(new Set(hits.map((hit) => hit.node.id))).toEqual(
          new Set(created.map((article) => article.id)),
        );
      });

      it("rolls the whole rebuild back when the refill fails part-way", async (ctx) => {
        if (!requireRebuild(context, ctx)) return;
        const store = context.getStore();
        const contribution = fulltextContribution();

        const article = await store.nodes.Article.create({
          title: "Atomic rebuild",
          body: "Must survive a refill that throws.",
          category: "health",
          published: true,
        });
        const rowsBefore = await countFulltextRows(store);
        const markerBefore = await markerFor(context, contribution);
        expect(rowsBefore).toBeGreaterThan(0);

        // Driven through the port so the failure lands after the drop and
        // recreate have already run — the window the single transaction
        // exists to close. Nothing else can force it: the Store's own
        // refill only fails on a database fault.
        await expect(
          requireDefined(
            context.getBackend().rebuildContribution,
            "backend must implement rebuildContribution",
          )(integrationTestGraph.id, "fulltext", () => {
            throw new Error("refill failed part-way through the rebuild");
          }),
        ).rejects.toThrow(/refill failed part-way/);

        // Everything is exactly as it was: the storage the drop removed is
        // back with its content, and the marker was never re-stamped. The
        // state this rules out is the one the atomicity is for — storage
        // attested by a fresh marker and answering every query with
        // nothing.
        expect(await countFulltextRows(store)).toBe(rowsBefore);
        expect(await markerFor(context, contribution)).toEqual(markerBefore);
        await expect(store.verifyContributions()).resolves.toEqual([]);
        expect(
          probeEntry(await store.probeContributions(), "fulltext"),
        ).toEqual({ contribution: "fulltext", state: "ready" });
        const hits = await store.search.fulltext("Article", {
          query: "Atomic",
          limit: 10,
        });
        expect(hits.map((hit) => hit.node.id)).toContain(article.id);

        // And the rollback left nothing that blocks a retry.
        await expect(
          store.rebuildContribution("fulltext"),
        ).resolves.toMatchObject({ rebuilt: [contribution.tableName] });
      });

      it("advertises the rebuild capability it can actually serve", () => {
        const capabilities =
          context.getStore().backend.capabilities.contributions;
        expect(capabilities).toMatchObject({ supported: true, probe: true });
        // Every backend in this lane has both a transactional schema fence
        // and a fulltext strategy declaring teardown DDL.
        expect(capabilities?.rebuild).toBe(true);
      });

      /**
       * The rebuild is fenced per GRAPH, but the storage it rebuilds is one
       * table shared by every graph in the database. These are the cases
       * where those two scopes disagree — the ones a single-graph test can
       * never see, because with one graph a `DROP TABLE` and a
       * `DELETE WHERE graph_id` are indistinguishable.
       */
      describe("shared storage", () => {
        let neighbor:
          | Awaited<
              ReturnType<typeof context.createStore<typeof neighborGraph>>
            >
          | undefined;

        /**
         * A second graph on this database with one searchable node, so the
         * shared fulltext table holds rows the suite's graph does not own.
         */
        async function createNeighborWithContent(): Promise<
          NonNullable<typeof neighbor>
        > {
          const store = await context.createStore(neighborGraph);
          neighbor = store;
          await store.nodes.Note.create({
            body: `Neighbor content that is ${NEIGHBOR_QUERY} by another graph.`,
          });
          return store;
        }

        async function neighborHits(
          store: NonNullable<typeof neighbor>,
        ): Promise<readonly string[]> {
          const hits = await store.search.fulltext("Note", {
            query: NEIGHBOR_QUERY,
            limit: 10,
          });
          return hits.map((hit) => hit.node.id);
        }

        // The neighbor's rows live in the database-global fulltext table,
        // so leaving them behind would change what every later test in a
        // shared-engine lane sees.
        afterEach(async () => {
          const store = neighbor;
          neighbor = undefined;
          if (store === undefined) return;
          await store.clear();
        });

        it("rebuilds this graph's content without touching another graph's", async (ctx) => {
          if (!requireRebuild(context, ctx)) return;
          const store = context.getStore();
          const neighborStore = await createNeighborWithContent();
          const article = await store.nodes.Article.create({
            title: "Neighborly rebuild",
            body: "Rebuilt while another graph shares the table.",
            category: "health",
            published: true,
          });

          const before = await neighborHits(neighborStore);
          expect(before.length).toBe(1);

          const result = await store.rebuildContribution("fulltext");
          expect(result.repopulated).toBeGreaterThanOrEqual(1);

          // The whole defect in one assertion: a rebuild fenced on this
          // graph must not be able to empty another graph's index. A
          // `DROP TABLE` here leaves the neighbor with zero hits and a
          // marker that still reports `ready`.
          expect(await neighborHits(neighborStore)).toEqual(before);
          expect(
            probeEntry(await neighborStore.probeContributions(), "fulltext"),
          ).toEqual({ contribution: "fulltext", state: "ready" });

          // And this graph got the rebuild it asked for.
          const hits = await store.search.fulltext("Article", {
            query: "Neighborly",
            limit: 10,
          });
          expect(hits.map((hit) => hit.node.id)).toContain(article.id);
          expect(
            probeEntry(await store.probeContributions(), "fulltext"),
          ).toEqual({ contribution: "fulltext", state: "ready" });
        });

        it("refuses a stale rebuild it could only finish by destroying another graph's content", async (ctx) => {
          if (!requireRebuild(context, ctx)) return;
          const store = context.getStore();
          const contribution = fulltextContribution();
          const neighborStore = await createNeighborWithContent();
          await store.nodes.Article.create({
            title: "Stale beside a neighbor",
            body: "The repair for this state is a drop that is not available.",
            category: "health",
            published: true,
          });
          const rowsBefore = await countFulltextRows(store);
          const neighborBefore = await neighborHits(neighborStore);

          // `stale` is the one state only a recreate repairs — and the
          // recreate would take the neighbor's rows with it.
          await markStale(context, contribution);
          const error = await captureRejection(
            store.rebuildContribution("fulltext"),
          );

          expect(error).toBeInstanceOf(ContributionRebuildUnsupportedError);
          expect(error).toMatchObject({
            code: "CONTRIBUTION_REBUILD_UNSUPPORTED",
            reason: "shared-storage-in-use",
            details: {
              physicalName: contribution.tableName,
              otherGraphIds: [NEIGHBOR_GRAPH_ID],
            },
          });

          // A refusal, not a partial attempt: neither graph's rows were
          // touched, and the marker still records the stale shape rather
          // than a fresh stamp over storage nothing verified.
          expect(await countFulltextRows(store)).toBe(rowsBefore);
          expect(await neighborHits(neighborStore)).toEqual(neighborBefore);
          expect(
            entryFor(await store.verifyContributions(), contribution.tableName)
              ?.state,
          ).toBe("stale");
        });
      });
    });
  });
}
