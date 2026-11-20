/**
 * `bulkFindFrom` / `bulkFindTo` degrade gracefully on backends without SQL
 * window functions: `limitPerInput` is capped in JS instead of via the
 * statement's `ROW_NUMBER()`.
 *
 * This is backend-specific wiring (it simulates an engine capability gap via
 * the `windowFunctions: false` override), so it lives here rather than in the
 * shared cross-backend suite, whose real backends all support window
 * functions. Both paths are pinned to the same reference — the leading edges
 * `findFrom` returns on that same store — so a window partition ordered
 * differently from the singleton read cannot pass.
 */
import { describe, expect, it } from "vitest";

import { createStoreWithSchema } from "../../../src";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import { integrationTestGraph } from "../integration/fixtures";

const EDGE_COUNT = 4;
const LIMIT_PER_INPUT = 3;

async function seededStore(windowFunctions: boolean) {
  const { backend } = createLocalSqliteBackend({
    capabilities: { windowFunctions },
  });
  const [store] = await createStoreWithSchema(integrationTestGraph, backend);
  const hub = await store.nodes.Person.create({ name: "hub" }, { id: "hub" });
  for (let index = 0; index < EDGE_COUNT; index += 1) {
    const target = await store.nodes.Person.create(
      { name: `target-${index}` },
      { id: `target-${index}` },
    );
    await store.edges.knows.create(hub, target, { since: `since-${index}` });
  }
  return { store, hub };
}

describe("bulk endpoint read window-function fallback", () => {
  for (const windowFunctions of [true, false]) {
    it(`caps limitPerInput to findFrom's leading edges (windowFunctions: ${windowFunctions})`, async () => {
      const { store, hub } = await seededStore(windowFunctions);
      const singleton = await store.edges.knows.findFrom(hub);

      const [bucket] = await store.edges.knows.bulkFindFrom([hub], {
        limitPerInput: LIMIT_PER_INPUT,
      });

      expect((bucket ?? []).map((edge) => edge.id)).toEqual(
        singleton.slice(0, LIMIT_PER_INPUT).map((edge) => edge.id),
      );
    });
  }

  it("still returns the full edge set when limitPerInput is omitted", async () => {
    const { store, hub } = await seededStore(false);

    const [bucket] = await store.edges.knows.bulkFindFrom([hub]);

    expect(bucket).toHaveLength(EDGE_COUNT);
  });
});
