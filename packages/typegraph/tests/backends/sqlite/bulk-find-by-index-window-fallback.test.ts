/**
 * bulkFindByIndex degrades gracefully on backends without SQL window
 * functions: limitPerInput is capped in JS instead of via `ROW_NUMBER()`.
 *
 * This is backend-specific wiring (it simulates an engine capability gap via
 * the `windowFunctions: false` override), so it lives here rather than in the
 * shared cross-backend suite, whose real backends all support window
 * functions.
 */
import { describe, expect, it } from "vitest";

import { createStoreWithSchema } from "../../../src";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import { integrationTestGraph } from "../integration/fixtures";

// Fixed ids so the window and JS-fallback paths cap the same deterministic
// set (both order by node id), and so the two stores are directly comparable.
const PRODUCT_IDS = ["p1", "p2", "p3", "p4", "p5"] as const;

async function seededStore(windowFunctions: boolean, category: string) {
  const { backend } = createLocalSqliteBackend({
    capabilities: { windowFunctions },
  });
  const [store] = await createStoreWithSchema(integrationTestGraph, backend);
  for (const id of PRODUCT_IDS) {
    await store.nodes.Product.create({ name: id, price: 1, category }, { id });
  }
  return store;
}

describe("bulkFindByIndex window-function fallback", () => {
  it("caps limitPerInput in JS when the backend lacks window functions", async () => {
    const store = await seededStore(false, "capped");

    const [bucket] = await store.nodes.Product.bulkFindByIndex(
      "product_category",
      [{ props: { category: "capped" } }],
      { limitPerInput: 2 },
    );

    expect(bucket).toHaveLength(2);
  });

  it("returns the same capped result with and without window functions", async () => {
    const withWindow = await seededStore(true, "x");
    const withoutWindow = await seededStore(false, "x");

    const cap = async (store: Awaited<ReturnType<typeof seededStore>>) => {
      const [bucket] = await store.nodes.Product.bulkFindByIndex(
        "product_category",
        [{ props: { category: "x" } }],
        { limitPerInput: 3 },
      );
      return (bucket ?? []).map((node) => node.id);
    };

    // Identical data + same per-id ordering → identical capped subset.
    const windowed = await cap(withWindow);
    expect(await cap(withoutWindow)).toEqual(windowed);
    expect(windowed).toEqual(["p1", "p2", "p3"]);
  });

  it("still returns the full set when limitPerInput is omitted", async () => {
    const store = await seededStore(false, "all");

    const [bucket] = await store.nodes.Product.bulkFindByIndex(
      "product_category",
      [{ props: { category: "all" } }],
    );

    expect(bucket).toHaveLength(5);
  });
});
