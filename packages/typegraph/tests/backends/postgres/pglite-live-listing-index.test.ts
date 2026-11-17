/**
 * PostgreSQL reads a kind's live rows in `created_at` order from the partial
 * `live_created_idx` indexes (typegraph#859), with no Sort.
 *
 * `kind_created_idx (graph_id, kind, deleted_at, created_at)` cannot serve
 * `ORDER BY created_at DESC, id DESC` on PostgreSQL: PostgreSQL does not treat
 * `deleted_at IS NULL` as an ordering equality, so before the partial indexes
 * every listing page sorted the whole live kind. These cases run the
 * library's own statements, captured at the PGlite client from a real store, under a plain
 * `EXPLAIN` on PGlite, which is PostgreSQL's planner. The fixture is sized so
 * the planner prefers the ordered index scan to a scan plus top-N sort.
 *
 * Each case is its own revert check: it then drops both partial indexes and
 * asserts that the identical statement needs a Sort node.
 *
 * The predicate is part of the index's shape, so it is part of its drift
 * signature: the last case holds that an index recorded without it surfaces
 * as drift rather than as already materialized.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import { createLocalPgliteBackend } from "../../../src/backend/postgres/pglite";
import { type GraphBackend } from "../../../src/backend/types";
import { SYSTEM_INDEX_DECLARATIONS } from "../../../src/indexes";
import { computeSystemIndexSignature } from "../../../src/store/materialize-indexes";
import { requireDefined } from "../../../src/utils/presence";

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const Other = defineNode("Other", { schema: z.object({ name: z.string() }) });
const links = defineEdge("links");

const graph = defineGraph({
  id: "live_listing_plan",
  nodes: { Item: { type: Item }, Other: { type: Other } },
  edges: { links: { type: links, from: [Item], to: [Item] } },
});

const ROWS_PER_KIND = 20_000;
const PAGE_SIZE = 50;

/**
 * Rows shaped as the library writes them, 10% soft-deleted, `created_at`
 * shared by blocks of 1000. Loaded with one statement per relation so the
 * fixture costs milliseconds, not twenty thousand round trips.
 */
const SEED_SQL = `
INSERT INTO typegraph_nodes (graph_id, kind, id, props, version, valid_from, created_at, updated_at, deleted_at)
SELECT 'live_listing_plan', kinds.kind, kinds.kind || '-' || i, jsonb_build_object('name', 'n' || i), 1,
       timestamptz '2026-01-01' + (i / 1000) * interval '1 second',
       timestamptz '2026-01-01' + (i / 1000) * interval '1 second',
       timestamptz '2026-01-01' + (i / 1000) * interval '1 second',
       CASE WHEN i % 10 = 0 THEN timestamptz '2026-02-01' END
FROM (VALUES ('Item'), ('Other')) AS kinds(kind), generate_series(1, ${ROWS_PER_KIND}) AS i;
INSERT INTO typegraph_edges (graph_id, id, kind, from_kind, from_id, to_kind, to_id, props, valid_from, created_at, updated_at, deleted_at)
SELECT 'live_listing_plan', 'links-' || i, 'links', 'Item', 'Item-' || i, 'Item', 'Item-' || (1 + i % ${ROWS_PER_KIND}), '{}'::jsonb,
       timestamptz '2026-01-01' + (i / 1000) * interval '1 second',
       timestamptz '2026-01-01' + (i / 1000) * interval '1 second',
       timestamptz '2026-01-01' + (i / 1000) * interval '1 second',
       CASE WHEN i % 10 = 0 THEN timestamptz '2026-02-01' END
FROM generate_series(1, ${ROWS_PER_KIND}) AS i;
ANALYZE typegraph_nodes;
ANALYZE typegraph_edges;
`;

const LIVE_LISTING_INDEXES = [
  "typegraph_nodes_live_created_idx",
  "typegraph_edges_live_created_idx",
] as const;

type CapturedStatement = Readonly<{ sql: string; params: readonly unknown[] }>;

type PgliteClient = Awaited<
  ReturnType<typeof createLocalPgliteBackend>
>["client"];

/**
 * Records every parameterized statement the store sends through the PGlite
 * client, whichever layer built it: backend operations such as `find` render
 * their own SQL, and query-builder reads arrive as cached templates.
 */
function captureClientQueries(
  client: PgliteClient,
  captured: CapturedStatement[],
): void {
  const query = client.query.bind(client);
  vi.spyOn(client, "query").mockImplementation(
    (sqlText: string, params?: unknown[], options?: object) => {
      captured.push({ sql: sqlText, params: params ?? [] });
      return query(sqlText, params, options);
    },
  );
}

async function explain(
  client: PgliteClient,
  statement: CapturedStatement,
): Promise<string> {
  const result = await client.query<Readonly<{ "QUERY PLAN": string }>>(
    `EXPLAIN (COSTS OFF) ${statement.sql}`,
    [...statement.params],
  );
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

function orderedRead(
  captured: readonly CapturedStatement[],
  table: string,
): CapturedStatement {
  return requireDefined(
    captured.findLast(
      (statement) =>
        statement.sql.includes(`"${table}"`) &&
        /ORDER BY/iu.test(statement.sql) &&
        statement.sql.includes("created_at"),
    ),
    `no ordered read of ${table} was captured`,
  );
}

describe("PostgreSQL live listing order from the partial live_created_idx", () => {
  let client: PgliteClient;
  let backend: GraphBackend;
  const captured: CapturedStatement[] = [];

  beforeEach(async () => {
    const pglite = await createLocalPgliteBackend({ vector: false });
    client = pglite.client;
    backend = pglite.backend;
    await createStoreWithSchema(graph, backend);
    await client.exec(SEED_SQL);
    captureClientQueries(client, captured);
    captured.length = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await backend.close();
  });

  async function expectServedOnlyWithIndex(
    statement: CapturedStatement,
    index: string,
  ): Promise<void> {
    const served = await explain(client, statement);
    expect(served).toContain(`Index Scan Backward using ${index}`);
    expect(served).not.toMatch(/Sort/u);

    await client.exec(
      LIVE_LISTING_INDEXES.map((name) => `DROP INDEX "${name}"`).join(";\n"),
    );
    const unserved = await explain(client, statement);
    expect(unserved).toMatch(/Sort/u);
  }

  it("serves nodes.find page 1 without a sort", async () => {
    const [store] = await createStoreWithSchema(graph, backend);
    captured.length = 0;
    const page = await store.nodes.Item.find({ limit: PAGE_SIZE });
    expect(page).toHaveLength(PAGE_SIZE);

    await expectServedOnlyWithIndex(
      orderedRead(captured, "typegraph_nodes"),
      "typegraph_nodes_live_created_idx",
    );
  });

  it("serves edges.find page 1 without a sort", async () => {
    const [store] = await createStoreWithSchema(graph, backend);
    captured.length = 0;
    const page = await store.edges.links.find({ limit: PAGE_SIZE });
    expect(page).toHaveLength(PAGE_SIZE);

    await expectServedOnlyWithIndex(
      orderedRead(captured, "typegraph_edges"),
      "typegraph_edges_live_created_idx",
    );
  });

  it("serves the query builder's orderBy meta.createdAt limited read without a sort", async () => {
    const [store] = await createStoreWithSchema(graph, backend);
    captured.length = 0;
    const rows = await store
      .query()
      .from("Item", "item")
      .orderBy("item", "meta.createdAt", "desc")
      .limit(PAGE_SIZE)
      .select((ctx) => ({ name: ctx.item.name }))
      .execute();
    expect(rows).toHaveLength(PAGE_SIZE);

    await expectServedOnlyWithIndex(
      orderedRead(captured, "typegraph_nodes"),
      "typegraph_nodes_live_created_idx",
    );
  });

  it("reports a partial index recorded under its predicate-less signature as drift", async () => {
    const { backend, client } = await createLocalPgliteBackend({
      vector: false,
    });
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const declaration = requireDefined(
        SYSTEM_INDEX_DECLARATIONS.find(
          (candidate) =>
            candidate.table === "nodes" &&
            candidate.suffix === "live_created_idx",
        ),
      );
      const { predicate, ...unpredicated } = declaration;
      expect(predicate).toEqual({ isNull: "deleted_at" });
      const withPredicate = await computeSystemIndexSignature(
        "postgres",
        "typegraph_nodes",
        declaration,
      );
      const withoutPredicate = await computeSystemIndexSignature(
        "postgres",
        "typegraph_nodes",
        unpredicated,
      );
      expect(withoutPredicate).not.toBe(withPredicate);

      // The row an in-place build without the predicate would have left.
      await client.exec('DROP INDEX "typegraph_nodes_live_created_idx"');
      await client.exec(
        'CREATE INDEX "typegraph_nodes_live_created_idx" ON "typegraph_nodes" ("graph_id", "kind", "created_at", "id")',
      );
      await requireDefined(backend.recordIndexMaterialization)({
        indexName: "typegraph_nodes_live_created_idx",
        graphId: "live_listing_plan",
        entity: "system",
        kind: "nodes",
        signature: withoutPredicate,
        schemaVersion: 1,
        attemptedAt: new Date().toISOString(),
        materializedAt: new Date().toISOString(),
        error: undefined,
      });

      const { results } = await store.materializeSystemIndexes();
      const target = results.find(
        (result) => result.indexName === "typegraph_nodes_live_created_idx",
      );
      expect(target?.status).toBe("failed");
      expect(target?.error?.message).toContain("different signature");
    } finally {
      await backend.close();
    }
  });
});
