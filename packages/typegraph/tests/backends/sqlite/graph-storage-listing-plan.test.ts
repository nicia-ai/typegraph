/**
 * `listGraphIds` walks graph ids by index seek instead of reading every row of
 * the anchor relations. A walk whose step cannot use an index is worse than
 * the scan it replaced, and no result-level test notices that, so this holds
 * the plan: every anchor relation is only ever searched through an index on
 * `graph_id`, never scanned.
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
import { createPlanCaptureBackend, explainQueryPlan } from "../../test-utils";

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
});
