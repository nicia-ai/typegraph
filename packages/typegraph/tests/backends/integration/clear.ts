/**
 * Cross-backend contract for `store.clear()` and the durable
 * contribution-materialization bookkeeping.
 *
 * `clear()` hard-deletes all data for one graph. Its status-table deletes
 * (index materializations, kind removals, reconciliation markers) have their
 * own per-dialect coverage; this suite pins the durable contribution markers,
 * which have an extra scope a plain `DELETE ... WHERE graph_id` must respect:
 * a deployment-scoped contribution keeps its physical marker under the
 * reserved deployment graph id — the shared storage it attests survives the
 * clear — while the graph-local rows (full markers for graph-scoped
 * contributions, activation markers for deployment-scoped ones) must go.
 *
 * These tests belong in the shared suite because the scoping is query-layer
 * semantics, not per-dialect wiring: only the same case run on both backends
 * proves that the marker delete is complete on SQLite and PostgreSQL alike
 * and never reaches another graph sharing the database.
 *
 * Clearing the fixture graph deletes its markers on purpose, so the suite
 * cleans the neighbor store up in `afterEach`: one backend in the lane
 * (PGlite) shares a single engine across tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  DEPLOYMENT_CONTRIBUTION_GRAPH_ID,
  resolveGraphVectorSlots,
  searchable,
} from "../../../src";
import type { StrategyTableContribution } from "../../../src/backend/table-contribution";
import type {
  ContributionMaterializationIdentity,
  GraphBackend,
} from "../../../src/backend/types";
import { sql } from "../../../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../../../src/query/sql-intent";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationStore, integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

const ARTICLE_KIND = "Article";
const CONTRIBUTION_MARKER_TABLE = "typegraph_contribution_materializations";

/**
 * A second graph living in the SAME database as the suite's graph. The
 * fulltext table is one physical table whose rows are keyed by `graph_id`,
 * and the marker table is keyed by `graph_id` too, so this is the neighbor
 * whose bookkeeping a per-graph clear must never be able to destroy.
 */
const NEIGHBOR_GRAPH_ID = "clear-neighbor-graph";
const NeighborNote = defineNode("Note", {
  schema: z.object({ body: searchable({ language: "english" }) }),
});
const neighborGraph = defineGraph({
  id: NEIGHBOR_GRAPH_ID,
  nodes: { Note: { type: NeighborNote } },
  edges: {},
});
/** Term only the neighbor graph's content matches. */
const NEIGHBOR_QUERY = "unmistakable";

/** The runtime fulltext contribution — the one every backend in the lane owns. */
function fulltextContribution(
  backend: GraphBackend,
): StrategyTableContribution {
  const fulltextTable = requireDefined(
    backend.tableNames?.fulltext,
    "backend must resolve a fulltext table name",
  );
  const contribution = requireDefined(
    backend.fulltextStrategy
      ?.ownedTables(fulltextTable)
      .find((candidate) => candidate.runtimeEnsure),
    "fulltext strategy must declare a runtime contribution",
  );
  return contribution;
}

/** Vector-slot contributions, empty on a backend without vector support. */
function vectorContributions(
  backend: GraphBackend,
): readonly StrategyTableContribution[] {
  if (
    backend.capabilities.vector?.supported !== true ||
    backend.vectorStrategy === undefined
  ) {
    return [];
  }
  return resolveGraphVectorSlots(integrationTestGraph).flatMap(
    (slot) => backend.vectorStrategy?.ownedTables(slot) ?? [],
  );
}

/** Graph-local marker identity for one contribution on one graph. */
function graphMarkerIdentity(
  graphId: string,
  contribution: StrategyTableContribution,
): ContributionMaterializationIdentity {
  return {
    graphId,
    logicalName: contribution.logicalName,
    owner: contribution.owner,
    tableName: contribution.tableName,
  };
}

/** The deployment-scoped physical marker identity for one contribution. */
function deploymentMarkerIdentity(
  contribution: StrategyTableContribution,
): ContributionMaterializationIdentity {
  return graphMarkerIdentity(DEPLOYMENT_CONTRIBUTION_GRAPH_ID, contribution);
}

// Postgres returns COUNT(*) as a string/bigint, SQLite as a number, so the
// value is genuinely not statically a number.
type CountRow = Readonly<{ cnt: unknown }>;

/** Content rows in the shared fulltext table for one graph. */
async function countFulltextRows(
  store: IntegrationStore,
  graphId: string,
): Promise<number> {
  const backend = store.backend;
  const table = requireDefined(
    backend.tableNames?.fulltext,
    "backend must resolve a fulltext table name",
  );
  const rows = await backend.execute<CountRow>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS cnt
      FROM ${sql.identifier(table)}
      WHERE graph_id = ${graphId}
    `),
  );
  return Number(rows[0]?.cnt ?? 0);
}

export function registerClearIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("store.clear() and contribution bookkeeping", () => {
    let neighbor:
      | Awaited<ReturnType<typeof context.createStore<typeof neighborGraph>>>
      | undefined;

    afterEach(async () => {
      const neighborStore = neighbor;
      neighbor = undefined;
      if (neighborStore === undefined) return;
      // The neighbor's rows and markers survive the suite graph's clear on
      // purpose, so only the neighbor's own clear can remove them — the
      // fulltext table is database-global, and one backend in the lane
      // (PGlite) shares a single engine across tests.
      await neighborStore.clear();
    });

    it("removes every graph-scoped marker and keeps the deployment physical marker", async () => {
      const store = context.getStore();
      const backend = store.backend;
      const read = requireDefined(
        backend.getContributionMaterialization,
        "backend must read contribution markers",
      );
      const fulltext = fulltextContribution(backend);

      // Boot recorded the graph-local activation marker and the deployment
      // physical marker; vector slots carry graph-scoped markers of their own
      // where the backend materializes them.
      const graphScopedIdentities = [
        fulltext,
        ...vectorContributions(backend),
      ].map((contribution) => graphMarkerIdentity(store.graphId, contribution));
      for (const identity of graphScopedIdentities) {
        await expect(read(identity)).resolves.toBeDefined();
      }
      const deploymentMarker = await read(deploymentMarkerIdentity(fulltext));
      expect(deploymentMarker).toBeDefined();

      await store.clear();

      for (const identity of graphScopedIdentities) {
        await expect(read(identity)).resolves.toBeUndefined();
      }
      // The physical marker attests shared storage the per-graph delete
      // never touches; the next privileged boot re-records the graph-local
      // rows from it.
      await expect(read(deploymentMarkerIdentity(fulltext))).resolves.toEqual(
        deploymentMarker,
      );
    });

    it("succeeds when contribution bookkeeping was never provisioned", async () => {
      const store = context.getStore();
      const backend = store.backend;
      const ensureMarkerTable = requireDefined(
        backend.ensureContributionMaterializationsTable,
        "backend must provision contribution markers",
      );
      const executeStatement = requireDefined(
        backend.executeStatement,
        "backend must execute statements",
      );

      await executeStatement(
        asCompiledStatementSql(
          sql`DROP TABLE ${sql.identifier(CONTRIBUTION_MARKER_TABLE)}`,
        ),
      );
      try {
        await expect(store.clear()).resolves.toBeUndefined();
      } finally {
        // The marker table is database-wide. Restore it and re-run privileged
        // store boot so later cases in a shared-engine lane see the normal
        // deployment and graph-local marker set.
        await ensureMarkerTable();
        await context.createStore(integrationTestGraph);
      }
    });

    it("rolls marker and content deletion back with a later transaction failure", async () => {
      const store = context.getStore();
      const backend = store.backend;
      if (!backend.capabilities.execution.interactiveTransactions) return;

      const read = requireDefined(
        backend.getContributionMaterialization,
        "backend must read contribution markers",
      );
      const markerIdentity = graphMarkerIdentity(
        store.graphId,
        fulltextContribution(backend),
      );
      const markerBefore = await read(markerIdentity);
      expect(markerBefore).toBeDefined();
      const article = await store.nodes.Article.create({
        title: "Survives rolled-back clear",
        body: "This content must remain after the transaction aborts.",
        category: "health",
        published: true,
      });

      await expect(
        backend.transaction(async (tx) => {
          await tx.clearGraph(store.graphId);
          throw new Error("injected failure after clearGraph");
        }),
      ).rejects.toThrow("injected failure after clearGraph");

      await expect(read(markerIdentity)).resolves.toEqual(markerBefore);
      await expect(
        store.nodes.Article.getById(article.id),
      ).resolves.toMatchObject({ id: article.id });
      expect(await countFulltextRows(store, store.graphId)).toBeGreaterThan(0);
    });

    it("does not touch another graph's markers or fulltext content", async () => {
      const store = context.getStore();
      const backend = store.backend;
      const read = requireDefined(
        backend.getContributionMaterialization,
        "backend must read contribution markers",
      );
      const fulltext = fulltextContribution(backend);

      const neighborStore = await context.createStore(neighborGraph);
      neighbor = neighborStore;
      const note = await neighborStore.nodes.Note.create({
        body: `Neighbor content that is ${NEIGHBOR_QUERY} by another graph.`,
      });
      const neighborMarker = await read(
        graphMarkerIdentity(NEIGHBOR_GRAPH_ID, fulltext),
      );
      expect(neighborMarker).toBeDefined();
      expect(await countFulltextRows(store, NEIGHBOR_GRAPH_ID)).toBe(1);

      await store.clear();

      await expect(
        read(graphMarkerIdentity(NEIGHBOR_GRAPH_ID, fulltext)),
      ).resolves.toEqual(neighborMarker);
      expect(await countFulltextRows(store, NEIGHBOR_GRAPH_ID)).toBe(1);
      await expect(
        neighborStore.nodes.Note.getById(note.id),
      ).resolves.toMatchObject({ id: note.id });
    });

    it("leaves the cleared store immediately usable for projected writes", async () => {
      const store = context.getStore();

      await store.clear();

      // A searchable write is the sharpest post-clear probe: it runs the
      // contribution gate and the fulltext projection in one statement.
      const article = await store.nodes.Article.create({
        title: "Fresh after clear",
        body: "Written after the graph was cleared.",
        category: "health",
        published: true,
      });
      const hits = await store.search.fulltext(ARTICLE_KIND, {
        query: "cleared",
        limit: 10,
      });
      expect(hits.map((hit) => hit.node.id)).toContain(article.id);
    });
  });
}
