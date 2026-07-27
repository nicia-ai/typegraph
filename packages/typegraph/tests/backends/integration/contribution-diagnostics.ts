/**
 * Cross-backend contract for `store.verifyContributions()` (#324).
 *
 * A durable contribution marker that says "initialized" is trusted by
 * every hot path without the catalog ever being consulted, so a database
 * whose strategy-owned tables were dropped out of band opens completely
 * clean and fails at the first read. These tests pin the diagnostic that
 * closes that gap — and they belong in the shared suite because the
 * verdicts are query-layer semantics, not per-dialect wiring: only the
 * same case run on both backends proves the catalog probe agrees.
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

import { resolveGraphVectorSlots } from "../../../src";
import type { StrategyTableContribution } from "../../../src/backend/table-contribution";
import type {
  AdapterBackend,
  ContributionDiagnostic,
  ContributionMaterializationRow,
  GraphBackend,
} from "../../../src/backend/types";
import { requireDefined } from "../../../src/utils/presence";
import { integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

const ARTICLE_KIND = "Article";
const ARTICLE_EMBEDDING_FIELD = "embedding";
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
      const backend = context.getBackend();
      contributions = ownedContributions(context.getStore().backend);
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

    // Restore both halves of the state these tests corrupt: re-run the
    // idempotent contribution DDL (a no-op when the table survived) and
    // re-record each marker exactly as it was found.
    afterEach(async () => {
      const backend = context.getBackend();
      const record = requireDefined(
        backend.recordContributionMaterialization,
        "backend must record contribution markers",
      );
      for (const [index, contribution] of contributions.entries()) {
        for (const ddl of contribution.createDdl) {
          await executeDdl(backend, ddl);
        }
        const snapshot = snapshots[index];
        if (snapshot === undefined) continue;
        await record({
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
    });

    it("reports a live table whose marker records no success as missing-marker", async () => {
      const store = context.getStore();
      const contribution = fulltextContribution();

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
        signature: IMPOSSIBLE_SIGNATURE,
        attemptedAt: new Date().toISOString(),
        materializedAt: undefined,
        error: "simulated materialization failure",
      });

      const diagnostics = await store.verifyContributions();
      expect(entryFor(diagnostics, contribution.tableName)?.state).toBe(
        "missing-marker",
      );
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
  });
}
