/**
 * Example 24: Bulk Writes — Recurring Catalog Sync
 *
 * Node and edge collections expose four bulk write operations, each a single
 * transactional call instead of N round-trips:
 *
 * - `bulkCreate(items)` — multi-row INSERT, returns the created nodes/edges
 *   in input order. Every item is Zod-validated up front.
 * - `bulkInsert(items)` — the dedicated fast path: same validated multi-row
 *   INSERT but returns nothing (no RETURNING clause, no result allocation).
 *   Prefer it for maximum-throughput ingestion when you don't need results.
 * - `bulkUpsertById(items)` — batched create-or-update keyed by ID. Existence
 *   is checked with one batched read; missing IDs are created (version 1),
 *   existing IDs are updated (version bumps). Returns results in input order.
 * - `bulkDelete(ids)` — batched soft delete. IDs that don't exist (or are
 *   already deleted) are silently ignored, so it is safe to re-run.
 *
 * Shared semantics worth knowing:
 * - Each call is all-or-nothing: bad items (schema violations, ID conflicts)
 *   fail the whole call and nothing is written, demonstrated in Part 5.
 * - Per-item operation hooks are intentionally skipped for throughput.
 * - PostgreSQL's 65,535 bind-parameter limit is handled internally — pass
 *   arrays of any size and TypeGraph chunks the INSERTs for you.
 *
 * The scenario is a recurring product-feed sync: an initial bulk load, a
 * nightly wave of changed rows, then pruning products that left the feed.
 * Example 17 (`bulkFindByIndex`) is the read-side companion: batched
 * candidate lookup for reconciling incoming rows that lack stable IDs.
 *
 * Run with:
 *   npx tsx examples/24-bulk-writes.ts
 */
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "@nicia-ai/typegraph";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Schema Definition
// ============================================================

const Product = defineNode("Product", {
  schema: z.object({
    sku: z.string(),
    name: z.string(),
    price: z.number().positive(),
  }),
});

const Category = defineNode("Category", {
  schema: z.object({ name: z.string() }),
});

const inCategory = defineEdge("inCategory", {
  schema: z.object({}),
});

const graph = defineGraph({
  id: "catalog_sync",
  nodes: {
    // cascade: pruning a product soft-deletes its inCategory edges too.
    Product: { type: Product, onDelete: "cascade" },
    Category: { type: Category },
  },
  edges: {
    inCategory: { type: inCategory, from: [Product], to: [Category] },
  },
});

// ============================================================
// Feed Data
// ============================================================

// The vendor feed keys rows by SKU. Deriving the node ID from the SKU is
// what makes bulkUpsertById an idempotent sync primitive: re-processing a
// feed row always lands on the same node.
function productIdForSku(sku: string): string {
  return `product:${sku}`;
}

function categoryIdForSlug(slug: string): string {
  return `category:${slug}`;
}

type FeedRow = Readonly<{ sku: string; name: string; price: number; category: string }>;

const INITIAL_FEED: readonly FeedRow[] = [
  { sku: "CLM-001", name: "Crash Pad", price: 189, category: "climbing" },
  { sku: "CLM-002", name: "Chalk Bag", price: 19, category: "climbing" },
  { sku: "CLM-003", name: "Quickdraw Set", price: 120, category: "climbing" },
  { sku: "FTW-101", name: "Approach Shoe", price: 139, category: "footwear" },
  { sku: "FTW-102", name: "Trail Sandal", price: 75, category: "footwear" },
  { sku: "FTW-103", name: "Winter Boot", price: 210, category: "footwear" },
];

// The nightly delta: two price changes and two brand-new products.
const CHANGED_ROWS_FEED: readonly FeedRow[] = [
  { sku: "CLM-001", name: "Crash Pad", price: 179, category: "climbing" },
  { sku: "FTW-101", name: "Approach Shoe", price: 149, category: "footwear" },
  { sku: "CLM-004", name: "Belay Device", price: 34, category: "climbing" },
  { sku: "FTW-104", name: "Trail Runner", price: 129, category: "footwear" },
];

// The feed's full manifest of currently-sold SKUs. FTW-102 and FTW-103
// are gone, so the prune step must remove them.
const CURRENT_SKU_MANIFEST: ReadonlySet<string> = new Set([
  "CLM-001",
  "CLM-002",
  "CLM-003",
  "CLM-004",
  "FTW-101",
  "FTW-104",
]);

const TIMING_ROW_COUNT = 500;

function divider(title: string): void {
  console.log(`\n=== ${title} ===\n`);
}

// ============================================================
// Main
// ============================================================

export async function main(): Promise<void> {
  console.log("=== Bulk Writes — Recurring Catalog Sync ===");

  const backend = createExampleBackend();
  const store = createStore(graph, backend);

  try {
    // ============================================================
    // Part 1: Initial load — bulkCreate for nodes and edges
    // ============================================================

    divider("Part 1: Initial load (bulkCreate)");

    const categorySlugs = [...new Set(INITIAL_FEED.map((row) => row.category))];
    const categories = await store.nodes.Category.bulkCreate(
      categorySlugs.map((slug) => ({ id: categoryIdForSlug(slug), props: { name: slug } })),
    );

    const initialProducts = await store.nodes.Product.bulkCreate(
      INITIAL_FEED.map((row) => ({
        id: productIdForSku(row.sku),
        props: { sku: row.sku, name: row.name, price: row.price },
      })),
    );

    const initialEdges = await store.edges.inCategory.bulkCreate(
      INITIAL_FEED.map((row) => ({
        from: { kind: "Product", id: productIdForSku(row.sku) },
        to: { kind: "Category", id: categoryIdForSlug(row.category) },
      })),
    );

    console.log(`Created ${categories.length} categories, ${initialProducts.length} products,`);
    console.log(`and ${initialEdges.length} inCategory edges — 3 bulk calls, not 14 row-by-row writes.`);
    console.log("Results come back in input order with all metadata populated:");
    for (const product of initialProducts.slice(0, 2)) {
      console.log(`  ${product.sku}  ${product.name.padEnd(14)} $${String(product.price).padEnd(4)} v${product.meta.version}`);
    }
    console.log("  ...");

    // ============================================================
    // Part 2: Nightly wave — bulkUpsertById (create-or-update by ID)
    // ============================================================

    divider("Part 2: Nightly changed-rows feed (bulkUpsertById)");

    console.log("Each row lands by ID: existing IDs are updated, new IDs are created.");
    console.log("`meta.version` makes the outcome observable — 1 = created, >1 = updated.\n");

    const upserted = await store.nodes.Product.bulkUpsertById(
      CHANGED_ROWS_FEED.map((row) => ({
        id: productIdForSku(row.sku),
        props: { sku: row.sku, name: row.name, price: row.price },
      })),
    );

    let createdCount = 0;
    let updatedCount = 0;
    for (const product of upserted) {
      const outcome = product.meta.version === 1 ? "CREATED" : `UPDATED (v${product.meta.version})`;
      if (product.meta.version === 1) createdCount += 1;
      else updatedCount += 1;
      console.log(`  ${product.sku}  ${product.name.padEnd(14)} $${String(product.price).padEnd(4)} → ${outcome}`);
    }
    console.log(`\nWave result: ${createdCount} created, ${updatedCount} updated.`);

    // New products still need their category edges.
    const newProducts = upserted.filter((product) => product.meta.version === 1);
    await store.edges.inCategory.bulkCreate(
      CHANGED_ROWS_FEED.filter((row) => newProducts.some((p) => p.sku === row.sku)).map((row) => ({
        from: { kind: "Product", id: productIdForSku(row.sku) },
        to: { kind: "Category", id: categoryIdForSlug(row.category) },
      })),
    );

    // ============================================================
    // Part 3: Prune — bulkDelete products that left the feed
    // ============================================================

    divider("Part 3: Prune departed SKUs (bulkDelete)");

    const allProducts = await store.nodes.Product.find();
    const staleIds = allProducts
      .filter((product) => !CURRENT_SKU_MANIFEST.has(product.sku))
      .map((product) => product.id);

    const productsBefore = await store.nodes.Product.count();
    const edgesBefore = await store.edges.inCategory.count();

    await store.nodes.Product.bulkDelete(staleIds);

    const productsAfter = await store.nodes.Product.count();
    const edgesAfter = await store.edges.inCategory.count();

    console.log(`Manifest diff found ${staleIds.length} stale products: ${staleIds.join(", ")}`);
    console.log(`Products: ${productsBefore} → ${productsAfter} (soft-deleted, recoverable via temporal reads)`);
    console.log(`Edges:    ${edgesBefore} → ${edgesAfter} (onDelete: "cascade" removed their inCategory edges)`);

    // bulkDelete silently ignores missing/already-deleted IDs, so re-running
    // the prune is a no-op — safe for at-least-once sync jobs.
    await store.nodes.Product.bulkDelete(staleIds);
    console.log(`Re-running the same prune: still ${await store.nodes.Product.count()} products (idempotent).`);

    // ============================================================
    // Part 4: Throughput — per-row loop vs bulkCreate vs bulkInsert
    // ============================================================

    divider(`Part 4: Throughput over ${TIMING_ROW_COUNT} rows`);

    console.log("Per-row create() pays per-item transaction and hook overhead. The bulk");
    console.log("APIs validate every item, then issue one multi-row INSERT per chunk.");
    console.log("Absolute times vary by machine — the ordering is the point.\n");

    function timingRows(prefix: string): { id: string; props: z.input<typeof Product.schema> }[] {
      return Array.from({ length: TIMING_ROW_COUNT }, (_, index) => ({
        id: productIdForSku(`${prefix}-${index}`),
        props: { sku: `${prefix}-${index}`, name: `Bulk Item ${index}`, price: 10 + index },
      }));
    }

    const loopStart = performance.now();
    for (const row of timingRows("LOOP")) {
      await store.nodes.Product.create(row.props, { id: row.id });
    }
    const loopMs = performance.now() - loopStart;

    const bulkCreateStart = performance.now();
    await store.nodes.Product.bulkCreate(timingRows("BULKC"));
    const bulkCreateMs = performance.now() - bulkCreateStart;

    const bulkInsertStart = performance.now();
    await store.nodes.Product.bulkInsert(timingRows("BULKI"));
    const bulkInsertMs = performance.now() - bulkInsertStart;

    console.log(`  per-row create() loop : ${loopMs.toFixed(1).padStart(7)} ms`);
    console.log(`  bulkCreate (returns)  : ${bulkCreateMs.toFixed(1).padStart(7)} ms  (${(loopMs / bulkCreateMs).toFixed(1)}x faster on this run)`);
    console.log(`  bulkInsert (void)     : ${bulkInsertMs.toFixed(1).padStart(7)} ms  (${(loopMs / bulkInsertMs).toFixed(1)}x faster on this run)`);

    // ============================================================
    // Part 5: Atomicity — one bad item aborts the whole batch
    // ============================================================

    divider("Part 5: Atomicity on failure");

    console.log("A bad item — here an ID collision with an existing product — fails the");
    console.log("whole call. Nothing is written, not even the valid rows before it.\n");

    const countBeforeFailure = await store.nodes.Product.count();
    try {
      await store.nodes.Product.bulkInsert([
        { id: productIdForSku("ATOMIC-1"), props: { sku: "ATOMIC-1", name: "Valid Row", price: 1 } },
        { id: productIdForSku("CLM-001"), props: { sku: "CLM-001", name: "Collision", price: 2 } },
      ]);
    } catch (error) {
      console.log(`  bulkInsert threw: ${error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)}`);
    }
    const countAfterFailure = await store.nodes.Product.count();
    const leakedRows = await store
      .query()
      .from("Product", "p")
      .whereNode("p", (p) => p.sku.eq("ATOMIC-1"))
      .select((ctx) => ({ id: ctx.p.id }))
      .execute();
    console.log(`  Product count unchanged: ${countBeforeFailure} → ${countAfterFailure}.`);
    console.log(`  The valid first row was not written either: ${leakedRows.length === 0 ? "correct" : "LEAKED"}.`);

    // ============================================================
    // Summary
    // ============================================================

    divider("Summary");

    console.log("  1. bulkCreate: validated multi-row INSERT, results in input order.");
    console.log("  2. bulkUpsertById: idempotent create-or-update keyed by stable IDs;");
    console.log("     meta.version distinguishes created (1) from updated (>1).");
    console.log("  3. bulkDelete: batched soft delete; missing IDs ignored, cascades");
    console.log("     per the node's onDelete behavior, safe to re-run.");
    console.log("  4. bulkInsert: the void-returning fast path for pure ingestion.");
    console.log("  5. Each call is all-or-nothing: a bad item means nothing is written.");
    console.log("\nFor feeds without stable IDs, reconcile first with bulkFindByIndex");
    console.log("(example 17), then route rows to bulkCreate or bulkUpsertById.");
  } finally {
    await backend.close();
  }

  console.log("\n=== Example Complete ===");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
