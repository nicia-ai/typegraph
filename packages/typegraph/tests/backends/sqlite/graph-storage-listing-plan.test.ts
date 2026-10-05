/**
 * `listGraphIds` walks graph ids by index seek instead of reading every row of
 * the anchor relations. A walk whose step cannot use an index is worse than
 * the scan it replaced, and no result-level test notices that, so this holds
 * the plan: every anchor relation is only ever searched through an index on
 * `graph_id`, never scanned. SQLite keeps those indexes in byte order, so the
 * walk also starts at the cursor or prefix and stops after the page: a page
 * visits about `limit` graph ids however many graphs the database holds.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineNode,
  listGraphIds,
} from "../../../src";
import {
  GRAPH_PRESENCE_ANCHOR_KEYS,
  resolveGraphRelationNames,
} from "../../../src/backend/graph-relations";
import { requireDefined } from "../../../src/utils/presence";
import {
  createPlanCaptureBackend,
  explainQueryPlan,
  graphIdWalkVisitCount,
} from "../../test-utils";

const Note = defineNode("Note", { schema: z.object({ body: z.string() }) });

describe("listGraphIds SQLite query plan", () => {
  it("searches every anchor relation by a graph_id index and never scans one", async () => {
    const { backend, captured, client } = createPlanCaptureBackend();
    for (const id of ["plan_a", "plan_b", "plan_c"]) {
      const store = createStore(
        defineGraph({ id, nodes: { Note: { type: Note } }, edges: {} }),
        backend,
      );
      await store.nodes.Note.create({ body: id });
    }

    captured.length = 0;
    expect(await listGraphIds(backend, { after: "plan_a", limit: 1 })).toEqual([
      "plan_b",
    ]);
    const statement = requireDefined(
      captured.find((candidate) => candidate.sql.includes("RECURSIVE")),
    );
    const plan = explainQueryPlan(client, statement);

    const names = resolveGraphRelationNames(backend.tableNames);
    for (const key of GRAPH_PRESENCE_ANCHOR_KEYS) {
      const table = names[key];
      expect(plan, `relation ${key}`).not.toContain(`SCAN ${table}`);
      const searches = plan
        .split("\n")
        .filter((line) => line.includes(`SEARCH ${table} USING`));
      // Once to seed the walk, once per step of it.
      expect(searches.length, `relation ${key}`).toBeGreaterThanOrEqual(2);
      expect(
        searches.some((line) => line.endsWith("(graph_id>?)")),
        `relation ${key} steps by graph_id > previous`,
      ).toBe(true);
    }
  });

  it("visits only the graph ids a page needs, wherever the page sits", async () => {
    const { backend, captured, client } = createPlanCaptureBackend();
    const TOTAL_GRAPHS = 40;
    const ids = Array.from(
      { length: TOTAL_GRAPHS },
      (_, index) => `walk_${String(index).padStart(2, "0")}`,
    );
    for (const id of ids) {
      const store = createStore(
        defineGraph({ id, nodes: { Note: { type: Note } }, edges: {} }),
        backend,
      );
      await store.nodes.Note.create({ body: id });
    }

    async function visited(
      options: Parameters<typeof listGraphIds>[1],
    ): Promise<number> {
      captured.length = 0;
      await listGraphIds(backend, options);
      const statement = requireDefined(
        captured.find((candidate) => candidate.sql.includes("RECURSIVE")),
      );
      const counted = graphIdWalkVisitCount(statement);
      const row = client.prepare(counted.sql).get(...counted.params) as {
        visited: number;
      };
      return row.visited;
    }

    // The first page, a page in the middle, and a page past a prefix's start.
    expect(await visited({ limit: 3 })).toBeLessThanOrEqual(3);
    // One extra visit is the cursor itself, which the page then drops.
    expect(await visited({ after: "walk_20", limit: 3 })).toBeLessThanOrEqual(
      4,
    );
    expect(
      await visited({ prefix: "walk_3", after: "walk_35", limit: 2 }),
    ).toBeLessThanOrEqual(3);
    // A prefix ends the walk one id past its last match.
    expect(await visited({ prefix: "walk_1", limit: 100 })).toBeLessThanOrEqual(
      11,
    );
    expect(await visited({ prefix: "absent", limit: 100 })).toBeLessThanOrEqual(
      1,
    );
    // Unbounded, the same walk covers every graph; that is what the bounds save.
    expect(await visited({ limit: 1000 })).toBe(TOTAL_GRAPHS);
  });
});
