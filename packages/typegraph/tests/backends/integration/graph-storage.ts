/**
 * Cross-backend contract for the graph storage inventory: `listGraphIds` and
 * `inspectGraphStorage`.
 *
 * These belong in the shared suite because both reads compile one statement
 * shape for every dialect, and the properties they promise are exactly the ones
 * a dialect can quietly break: byte-order paging (PostgreSQL collations order
 * mixed case differently from SQLite), prefix matching that must stay
 * case-sensitive and wildcard-free (SQLite `LIKE` is neither), and counts that
 * treat a never-provisioned table as empty instead of an error.
 *
 * The clear cases are the load-bearing half. A graph is populated so that it
 * holds rows in as many relations as the lane supports; the inventory must see
 * them, and `store.clear()` must then leave every relation empty (bar the ones
 * the caller asked to preserve) while a second graph in
 * the same database stays untouched. Removing one DELETE from the clear
 * sequence, or one relation from the inventory, turns these red.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
  defineNodeIndex,
  embedding,
  type GraphBackend,
  type GraphDef,
  type GraphStorageInspection,
  inspectGraphStorage,
  listGraphIds,
  searchable,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { GRAPH_RELATIONS } from "../../../src/backend/graph-relations";
import { sql } from "../../../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../../../src/query/sql-intent";
import type { LiveStoreOptions } from "../../../src/store/types";
import { compareCodePoints } from "../../../src/utils/compare";
import { requireDefined } from "../../../src/utils/presence";
import { refuseRecursiveTraversal } from "./capability-refusals";
import { integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

type ClearOptions = Readonly<{
  preserveContributionMaterializations?: boolean;
}>;

const PRIMARY_GRAPH_ID = "storage_inventory_primary";
const NEIGHBOR_GRAPH_ID = "storage_inventory_neighbor";
const EMAIL_UNIQUE = {
  name: "inventory_person_email",
  fields: ["email"],
  scope: "kind",
  collation: "binary",
} as const;

const Article = defineNode("Article", {
  schema: z.object({
    title: searchable({ language: "english" }),
    vector: embedding(3).optional(),
  }),
});
const Person = defineNode("Person", {
  schema: z.object({ email: z.string() }),
});
const Team = defineNode("Team", { schema: z.object({ name: z.string() }) });
const memberOf = defineEdge("memberOf", { schema: z.object({}) });

const personEmailIndex = defineNodeIndex(Person, {
  name: "inventory_person_email_idx",
  fields: ["email"],
});

const primaryGraph = defineGraph({
  id: PRIMARY_GRAPH_ID,
  nodes: {
    Article: { type: Article },
    Person: { type: Person, unique: [EMAIL_UNIQUE] },
    Team: { type: Team },
  },
  edges: {
    memberOf: {
      type: memberOf,
      from: [Person],
      to: [Team],
      cardinality: "one",
    },
  },
  indexes: [personEmailIndex],
  identity: { sameIdAcrossKinds: "fold" },
});

const Note = defineNode("Note", {
  schema: z.object({ body: searchable({ language: "english" }) }),
});
const neighborGraph = defineGraph({
  id: NEIGHBOR_GRAPH_ID,
  nodes: { Note: { type: Note } },
  edges: {},
});

const trackedGraph = defineGraph({
  id: "storage_inventory_tracked",
  nodes: { Note: { type: Note } },
  edges: {},
});

const widgetExtension = defineGraphExtension({
  nodes: { Widget: { properties: { label: { type: "string" } } } },
});

/**
 * The relations whose rows legitimately survive a clear, stated here rather
 * than read from the inventory: a check that derived its allowance from the
 * declaration under test would pass whatever the declaration said. Graph-local
 * contribution markers are kept unless the caller asks otherwise.
 */
function retainedAfterClear(
  preserveContributionMaterializations: boolean,
): ReadonlySet<string> {
  return new Set(
    preserveContributionMaterializations ?
      ["contributionMaterializations"]
    : [],
  );
}

function rowsByRelation(
  inspection: GraphStorageInspection,
): ReadonlyMap<string, number> {
  return new Map(
    inspection.relations.map((relation) => [relation.relation, relation.rows]),
  );
}

function populatedRelations(inspection: GraphStorageInspection): string[] {
  return inspection.relations
    .filter((relation) => relation.rows > 0)
    .map((relation) => relation.relation)
    .toSorted(compareCodePoints);
}

/**
 * Wraps `backend` so the text of every statement its transactions execute is
 * recorded, to see which arm of the listing query ran.
 */
function recordingStatements(
  backend: GraphBackend,
  statements: string[],
): GraphBackend {
  return deriveBackend(backend, {
    transaction: (run, options) =>
      backend.transaction(
        (target) =>
          run(
            deriveBackend(target, {
              async execute<T>(
                query: Parameters<typeof target.execute>[0],
              ): Promise<readonly T[]> {
                const compiled = target.compileSql?.(query);
                if (compiled) statements.push(compiled.sql);
                return target.execute<T>(query);
              },
            }),
          ),
        options,
      ),
  });
}

function listingStatements(statements: readonly string[]): string[] {
  return statements.filter((statement) => statement.includes("graph_ids"));
}

const MAX_PAGES = 500;

/** Walks every page with the given size, asserting each stays bounded. */
async function pageAll(
  backend: GraphBackend,
  limit: number,
): Promise<readonly string[]> {
  const paged: string[] = [];
  let after: string | undefined;
  // A cursor that failed to advance would otherwise page forever.
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = await listGraphIds(backend, { after, limit });
    if (page.length === 0) return paged;
    expect(page.length).toBeLessThanOrEqual(limit);
    paged.push(...page);
    after = page.at(-1);
  }
  throw new Error(
    `listGraphIds did not reach an empty page in ${MAX_PAGES} pages`,
  );
}

export function registerGraphStorageIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("graph storage inventory", () => {
    /**
     * Every store a case opens, cleared afterwards: one backend in the lane
     * (PGlite) shares a single engine across tests, and this suite's whole
     * subject is what a database holds per graph.
     */
    const opened: { clear: (options: ClearOptions) => Promise<void> }[] = [];

    afterEach(async () => {
      for (const store of opened.splice(0)) {
        await store.clear({ preserveContributionMaterializations: false });
      }
    });

    async function openStore<G extends GraphDef>(
      graph: G,
      options?: LiveStoreOptions,
    ) {
      const store = await context.createStore(graph, options);
      opened.push(store);
      return store;
    }

    async function populatePrimary() {
      const store = await context.createHistoryStore(primaryGraph);
      opened.push(store);
      const backend = store.backend;
      const vectorSupported = backend.capabilities.vector?.supported === true;

      const ada = await store.nodes.Person.create({ email: "ada@example.com" });
      const grace = await store.nodes.Person.create({
        email: "grace@example.com",
      });
      const linus = await store.nodes.Person.create({
        email: "linus@example.com",
      });
      const team = await store.nodes.Team.create({ name: "core" });
      await store.nodes.Article.create({
        title: "Inventory of storage",
        ...(vectorSupported ? { vector: [0.1, 0.2, 0.3] } : {}),
      });
      await store.edges.memberOf.create(ada, team, {});
      await store.identity.assertSame(ada, grace);
      await store.identity.assertDifferent(ada, linus);
      await store.materializeIndexes();
      // The durable origin row is minted lazily, the first time a token that
      // carries it is asked for.
      await store.revisionOriginNow();
      const evolved = await store.evolve(widgetExtension);
      const removed = await evolved.removeKinds(["Widget"]);
      opened.push(removed);
      await removed.materializeRemovals();
      return { store: removed, vectorSupported };
    }

    async function populateNeighbor() {
      const store = await openStore(neighborGraph);
      await store.nodes.Note.create({ body: "Untouched by another graph." });
      return store;
    }

    it("counts every relation a populated graph touches", async () => {
      const { store, vectorSupported } = await populatePrimary();

      const inspection = await inspectGraphStorage(store);
      const rows = rowsByRelation(inspection);

      expect(inspection.graphId).toBe(PRIMARY_GRAPH_ID);
      const inventoryKeys = GRAPH_RELATIONS.map((relation) => relation.key);
      expect(
        inspection.relations
          .map((relation) => relation.relation)
          .filter((relation) => inventoryKeys.includes(relation as never)),
      ).toEqual(inventoryKeys);
      const populated = populatedRelations(inspection);
      const expectedPopulated: readonly string[] = [
        "nodes",
        "edges",
        "uniques",
        "edgeClaims",
        "identityAssertions",
        "identityClosure",
        "identitySeparation",
        "recordedNodes",
        "recordedEdges",
        "recordedIdentityAssertions",
        "recordedClock",
        "revisionOrigins",
        "schemaVersions",
        "fulltext",
        "indexMaterializations",
        "kindRemovals",
        "contributionMaterializations",
      ];
      for (const relation of expectedPopulated) {
        expect(rows.get(relation), `relation ${relation}`).toBeGreaterThan(0);
      }
      expect(populated).toEqual(expect.arrayContaining([...expectedPopulated]));
      const vectorRelations = inspection.relations.filter((relation) =>
        relation.relation.startsWith("vector:"),
      );
      expect(vectorRelations.length > 0).toBe(vectorSupported);
      for (const relation of vectorRelations) {
        expect(relation.rows).toBe(1);
      }
      expect(inspection.totalRows).toBe(
        inspection.relations.reduce((total, entry) => total + entry.rows, 0),
      );
      for (const relation of inspection.relations) {
        expect(relation.table).toMatch(/^[a-z_][a-z0-9_]*$/);
      }
    });

    for (const preserveContributionMaterializations of [true, false]) {
      it(`empties every relation on clear() (preserve contribution markers: ${String(preserveContributionMaterializations)}) and leaves another graph untouched`, async () => {
        const { store } = await populatePrimary();
        const neighbor = await populateNeighbor();
        const neighborBefore = await inspectGraphStorage(neighbor);
        expect(neighborBefore.totalRows).toBeGreaterThan(0);
        const populated = await inspectGraphStorage(store);
        expect(populated.totalRows).toBeGreaterThan(0);

        await store.clear({ preserveContributionMaterializations });

        const after = await inspectGraphStorage(store);
        const retained = retainedAfterClear(
          preserveContributionMaterializations,
        );
        const leftovers = after.relations.filter(
          (relation) => relation.rows > 0 && !retained.has(relation.relation),
        );
        expect(leftovers).toEqual([]);
        // Retention is asserted as well as tolerated: rows a clear was asked
        // to keep must still be there, and rows it was asked to remove must not.
        const markerRows = requireDefined(
          rowsByRelation(after).get("contributionMaterializations"),
        );
        expect(markerRows > 0).toBe(preserveContributionMaterializations);
        expect(await inspectGraphStorage(neighbor)).toEqual(neighborBefore);
        const graphIds = await listGraphIds(context.getBackend());
        expect(graphIds).toContain(NEIGHBOR_GRAPH_ID);
      });
    }

    it("counts the revision journal of a revision-tracked graph and empties it on clear()", async () => {
      const store = await openStore(trackedGraph, {
        revisionTracking: true,
      });
      await store.nodes.Note.create({ body: "Journaled." });
      await store.revisionOriginNow();

      const before = rowsByRelation(await inspectGraphStorage(store));
      expect(before.get("revisionChanges")).toBeGreaterThan(0);
      expect(before.get("recordedClock")).toBeGreaterThan(0);

      await store.clear({ preserveContributionMaterializations: false });

      const after = await inspectGraphStorage(store);
      // Live revision tracking reseeds its clock in the clear transaction, so
      // the clock row is rebuilt rather than left over.
      const retained = new Set<string>([
        ...retainedAfterClear(false),
        "recordedClock",
      ]);
      expect(
        after.relations.filter(
          (relation) => relation.rows > 0 && !retained.has(relation.relation),
        ),
      ).toEqual([]);
    });

    it("removes the revision origin a tracking store minted when a non-tracking store clears the graph", async () => {
      const tracking = await openStore(trackedGraph, {
        revisionTracking: true,
      });
      await tracking.nodes.Note.create({ body: "Origin minted here." });
      await tracking.revisionOriginNow();
      expect(
        rowsByRelation(await inspectGraphStorage(tracking)).get(
          "revisionOrigins",
        ),
      ).toBe(1);

      const plain = await openStore(trackedGraph);
      await plain.clear({ preserveContributionMaterializations: false });

      const after = rowsByRelation(await inspectGraphStorage(plain));
      expect(after.get("revisionOrigins")).toBe(0);
      expect(await listGraphIds(context.getBackend())).not.toContain(
        trackedGraph.id,
      );
    });

    it("stops listing a graph whose rows clear() removed in full", async () => {
      const store = await openStore(neighborGraph);
      await store.nodes.Note.create({ body: "Soon gone." });
      const backend = context.getBackend();
      expect(await listGraphIds(backend)).toContain(NEIGHBOR_GRAPH_ID);

      await store.clear({ preserveContributionMaterializations: false });

      const cleared = await inspectGraphStorage(store);
      expect(cleared.totalRows).toBe(0);
      expect(await listGraphIds(backend)).not.toContain(NEIGHBOR_GRAPH_ID);
    });

    it("stops listing a graph after a default clear() that keeps its contribution markers, and still lists an uncleared graph", async () => {
      const cleared = await openStore(neighborGraph);
      await cleared.nodes.Note.create({ body: "Cleared with defaults." });
      const kept = await openStore(trackedGraph);
      await kept.nodes.Note.create({ body: "Never cleared." });
      const backend = context.getBackend();
      expect(await listGraphIds(backend)).toEqual(
        expect.arrayContaining([NEIGHBOR_GRAPH_ID, trackedGraph.id]),
      );

      await cleared.clear();

      // The default clear keeps the graph's contribution markers, which is the
      // whole reason they cannot anchor a graph's presence.
      const remaining = rowsByRelation(await inspectGraphStorage(cleared));
      expect(remaining.get("contributionMaterializations")).toBeGreaterThan(0);
      expect(remaining.get("nodes")).toBe(0);
      const listed = await listGraphIds(backend);
      expect(listed).not.toContain(NEIGHBOR_GRAPH_ID);
      expect(listed).toContain(trackedGraph.id);
    });

    it("counts a lazily provisioned relation that does not exist as zero", async () => {
      const store = await openStore(neighborGraph);
      await store.nodes.Note.create({ body: "Marker table goes away." });
      const backend = context.getBackend();
      const markerTable = requireDefined(
        backend.tableNames?.contributionMaterializations,
        "backend must name its contribution marker table",
      );
      const executeStatement = requireDefined(
        backend.executeStatement,
        "backend must execute statements",
      );
      const ensureMarkerTable = requireDefined(
        backend.ensureContributionMaterializationsTable,
        "backend must provision contribution markers",
      );

      await executeStatement(
        asCompiledStatementSql(sql`DROP TABLE ${sql.identifier(markerTable)}`),
      );
      try {
        const inspection = await inspectGraphStorage(store);
        expect(
          inspection.relations.find(
            (relation) => relation.relation === "contributionMaterializations",
          ),
        ).toEqual({
          relation: "contributionMaterializations",
          table: markerTable,
          rows: 0,
        });
        expect(inspection.totalRows).toBeGreaterThan(0);
        expect(await listGraphIds(backend)).toContain(NEIGHBOR_GRAPH_ID);
      } finally {
        // The marker table is database-wide; restore it and re-run privileged
        // boot so later cases in a shared-engine lane see the normal markers.
        await ensureMarkerTable();
        await context.createStore(integrationTestGraph);
      }
    });

    describe("listGraphIds", () => {
      const MIXED_CASE_IDS = [
        "tenant-B",
        "tenant-a",
        "tenant-Z",
        "Tenant-x",
        "other-1",
        "tenant_%",
        "tenantXsuffix",
        // Above and below the surrogate range: UTF-16 code-unit order and
        // byte order disagree about these two.
        "tenant-\uFF21",
        "tenant-\u{1F600}",
      ] as const;

      async function seedMixedCaseGraphs(): Promise<void> {
        for (const id of MIXED_CASE_IDS) {
          const store = await openStore(
            defineGraph({
              id,
              nodes: { Note: { type: Note } },
              edges: {},
            }),
          );
          await store.nodes.Note.create({ body: id });
        }
      }

      it("pages every graph id in byte order, identically on every backend", async () => {
        const backend = context.getBackend();
        // Other cases may have left graphs behind in a shared database, so the
        // expectation is relative to what was listed before seeding.
        const before = await pageAll(backend, 1000);
        expect(before).toEqual(before.toSorted(compareCodePoints));
        await seedMixedCaseGraphs();
        const expected = [...before, ...MIXED_CASE_IDS].toSorted(
          compareCodePoints,
        );

        expect(await pageAll(backend, 1000)).toEqual(expected);
        const paged = await pageAll(backend, 3);
        expect(paged).toEqual(expected);
        // Uppercase sorts before lowercase: byte order, not a locale's.
        expect(paged.indexOf("Tenant-x")).toBeLessThan(
          paged.indexOf("other-1"),
        );
        expect(paged.indexOf("tenant-Z")).toBeLessThan(
          paged.indexOf("tenant-a"),
        );
      });

      it("lists the same graphs from a de-duplicating scan when the engine declares no recursive traversal", async () => {
        const backend = context.getBackend();
        await seedMixedCaseGraphs();
        const walked: string[] = [];
        const scanned: string[] = [];

        const withWalk = await pageAll(recordingStatements(backend, walked), 3);
        const withScan = await pageAll(
          recordingStatements(
            refuseRecursiveTraversal(
              backend,
              "test engine has no recursive CTE",
            ),
            scanned,
          ),
          3,
        );

        expect(withScan).toEqual(withWalk);
        expect(withScan).toEqual(expect.arrayContaining([...MIXED_CASE_IDS]));
        expect(listingStatements(walked).length).toBeGreaterThan(0);
        expect(listingStatements(scanned).length).toBeGreaterThan(0);
        for (const statement of listingStatements(walked)) {
          expect(statement).toContain("WITH RECURSIVE");
        }
        for (const statement of listingStatements(scanned)) {
          expect(statement).not.toContain("RECURSIVE");
        }
      });

      it("matches a prefix as case-sensitive literal text", async () => {
        await seedMixedCaseGraphs();
        const backend = context.getBackend();

        expect(await listGraphIds(backend, { prefix: "tenant-" })).toEqual(
          MIXED_CASE_IDS.filter((id) => id.startsWith("tenant-")).toSorted(
            compareCodePoints,
          ),
        );
        expect(
          await listGraphIds(backend, { prefix: "tenant-\u{1F600}" }),
        ).toEqual(["tenant-\u{1F600}"]);
        expect(await listGraphIds(backend, { prefix: "Tenant" })).toEqual([
          "Tenant-x",
        ]);
        // `_` and `%` are LIKE wildcards; as a prefix they must match only
        // themselves.
        expect(await listGraphIds(backend, { prefix: "tenant_" })).toEqual([
          "tenant_%",
        ]);
        expect(await listGraphIds(backend, { prefix: "tenant%" })).toEqual([]);
        expect(
          await listGraphIds(backend, { prefix: "tenant-", after: "tenant-Z" }),
        ).toEqual(["tenant-a", "tenant-\uFF21", "tenant-\u{1F600}"]);
        expect(await listGraphIds(backend, { prefix: "absent-" })).toEqual([]);
      });

      it("never lists the reserved deployment marker id", async () => {
        const backend = context.getBackend();
        const markerTable = requireDefined(
          backend.tableNames?.contributionMaterializations,
        );
        const [holder] = await backend.execute<{ cnt: unknown }>(
          asCompiledRowsSql(
            sql`SELECT COUNT(*) AS cnt FROM ${sql.identifier(markerTable)} WHERE graph_id = ${"__typegraph_deployment__"}`,
          ),
        );
        // The exclusion is only exercised while a deployment marker exists.
        expect(Number(holder?.cnt)).toBeGreaterThan(0);

        expect(await listGraphIds(backend)).not.toContain(
          "__typegraph_deployment__",
        );
      });

      it("refuses a page size outside 1 to 1000", async () => {
        const backend = context.getBackend();
        for (const limit of [0, -1, 1001, 1.5, Number.NaN]) {
          await expect(listGraphIds(backend, { limit })).rejects.toMatchObject({
            name: "ConfigurationError",
          });
        }
        await expect(listGraphIds(backend, { limit: 1 })).resolves.toHaveLength(
          1,
        );
        await expect(
          listGraphIds(backend, { limit: 1000 }),
        ).resolves.toBeDefined();
      });
    });
  });
}
