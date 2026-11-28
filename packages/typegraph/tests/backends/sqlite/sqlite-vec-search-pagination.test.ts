/**
 * Cursor pagination over sqlite-vec's vec0 KNN, the engine-side top-k cut no
 * lane of the shared integration suite loads: with a vec0 table, both an
 * exact and an approximate `.similarTo()` are served by `MATCH … k = ?`, a
 * cut the compiler's node-id tiebreak cannot reach.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  embedding,
} from "../../../src";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import { type GraphBackend } from "../../../src/backend/types";

const Document = defineNode("Doc", {
  schema: z.object({ embedding: embedding(4) }),
});
const graph = defineGraph({
  id: "vec0_paging",
  nodes: { Doc: { type: Document } },
  edges: {},
});

const backends: GraphBackend[] = [];
afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close();
});

async function openStore() {
  const { backend } = createLocalSqliteBackend();
  backends.push(backend);
  if (backend.capabilities.vector?.supported !== true)
    throw new Error("sqlite-vec did not load");
  const [store] = await createStoreWithSchema(graph, backend);
  return store;
}

type Store = Awaited<ReturnType<typeof openStore>>;

function search(store: Store, k: number, approximate: boolean) {
  return store
    .query()
    .from("Doc", "d")
    .whereNode("d", (d) =>
      d.embedding.similarTo([1, 0, 0, 0], k, { approximate }),
    )
    .select((row) => ({ id: row.d.id }));
}

async function walk(
  store: Store,
  k: number,
  approximate: boolean,
  direction: "forward" | "backward",
): Promise<readonly string[]> {
  const pages: (readonly string[])[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await search(store, k, approximate).paginate(
      direction === "forward" ?
        { first: 1, ...(cursor === undefined ? {} : { after: cursor }) }
      : { last: 1, ...(cursor === undefined ? {} : { before: cursor }) },
    );
    pages.push(page.data.map((row) => row.id));
    const more = direction === "forward" ? page.hasNextPage : page.hasPrevPage;
    cursor = direction === "forward" ? page.nextCursor : page.prevCursor;
    if (!more || cursor === undefined) break;
  }
  return direction === "forward" ? pages.flat() : pages.toReversed().flat();
}

describe("cursor pagination over sqlite-vec's KNN cut", () => {
  it("repeats a cut inside a tie on every execution, and pages read exactly it", async () => {
    const store = await openStore();
    expect(
      backends[0]?.capabilities.vector?.repeatableApproximateSearch,
    ).toEqual({ repeatable: true });
    for (const id of "abcdefghijklmnopqrstuvwxyz") {
      await store.nodes.Doc.create({ embedding: [0.6, 0.8, 0, 0] }, { id });
    }
    for (const approximate of [false, true]) {
      const executions = new Set<string>();
      for (let run = 0; run < 20; run += 1) {
        const rows = await search(store, 5, approximate).execute();
        executions.add(rows.map((row) => row.id).join(","));
      }
      expect(executions.size).toBe(1);
      const executed = [...executions][0]?.split(",") ?? [];
      expect(executed).toHaveLength(5);
      expect({
        forward: await walk(store, 5, approximate, "forward"),
        backward: await walk(store, 5, approximate, "backward"),
      }).toEqual({ forward: executed, backward: executed });
    }
  });

  it("never spends a top-k slot on a zero embedding, whose cosine distance is undefined", async () => {
    const store = await openStore();
    await store.nodes.Doc.create({ embedding: [0, 0, 0, 0] }, { id: "z1" });
    await store.nodes.Doc.create({ embedding: [1, 0, 0, 0] }, { id: "a" });
    await store.nodes.Doc.create({ embedding: [0, 0, 0, 0] }, { id: "z0" });
    await store.nodes.Doc.create({ embedding: [0.6, 0.8, 0, 0] }, { id: "b" });
    for (const approximate of [false, true]) {
      for (const k of [2, 10]) {
        const rows = await search(store, k, approximate).execute();
        expect({ approximate, k, ids: rows.map((row) => row.id) }).toEqual({
          approximate,
          k,
          ids: ["a", "b"],
        });
        expect(await walk(store, k, approximate, "forward")).toEqual([
          "a",
          "b",
        ]);
      }
    }
  });
});
