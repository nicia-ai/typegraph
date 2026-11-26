/**
 * A node `bulkHardDelete` reports every incident edge it removed, however
 * many one node has.
 *
 * One node is one id in the bind budget, but its cascade's edge DELETE can
 * return any number of rows. Collecting them by spreading one chunk's ids
 * into a single call exceeds the engine's argument limit for a high-degree
 * node and throws `RangeError` after the rows are gone. Backend wiring (an
 * engine argument limit, not query semantics), so it runs on better-sqlite3,
 * where 150,000 rows are cheap to write.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { requireDefined } from "../src/utils/presence";

const Hub = defineNode("HdHub", { schema: z.object({}) });
const links = defineEdge("hdLinks", { schema: z.object({}) });

const graph = defineGraph({
  id: "node-bulk-hard-delete-high-degree",
  nodes: { HdHub: { type: Hub, onDelete: "cascade" } },
  edges: { hdLinks: { type: links, from: [Hub], to: [Hub] } },
});

const INCIDENT_EDGES = 150_000;

describe("node bulkHardDelete of a high-degree node", () => {
  it(
    `removes and reports ${INCIDENT_EDGES} tombstoned incident edges`,
    { timeout: 60_000 },
    async () => {
      const { backend, db } = createLocalSqliteBackend();
      try {
        const [store] = await createStoreWithSchema(graph, backend);
        await store.nodes.HdHub.create({}, { id: "hub" });
        db.run(sql`
          WITH RECURSIVE n(i) AS (
            SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${INCIDENT_EDGES}
          )
          INSERT INTO typegraph_edges
            (graph_id, id, kind, from_kind, from_id, to_kind, to_id, props,
             created_at, updated_at, deleted_at)
          SELECT ${graph.id}, 'e-' || i, 'hdLinks', 'HdHub', 'hub', 'HdHub',
            'hub', '{}', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
          FROM n
        `);
        const removed = await backend.transaction((tx) =>
          requireDefined(tx.hardDeleteNodesBatch)({
            graphId: graph.id,
            kind: "HdHub",
            ids: ["hub"],
            releaseEdgeClaims: true,
          }),
        );
        expect(removed.removedNodeIds).toEqual(["hub"]);
        expect(removed.removedEdgeIds).toHaveLength(INCIDENT_EDGES);
        const remaining = db.get<{ count: number }>(
          sql`SELECT count(*) AS count FROM typegraph_edges`,
        );
        expect(remaining.count).toBe(0);
      } finally {
        await backend.close();
      }
    },
  );
  // MUTATION CHECK: collect the chunk's ids with
  // `removedEdgeIds.push(...chunkEdgeIds)` in `hardDeleteNodesBatch` — the
  // call throws RangeError after the DELETEs ran.
});
