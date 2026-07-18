/**
 * Example 25: Transactions — Atomic Multi-Write Operations
 *
 * `store.transaction(async (tx) => { ... })` runs a callback in which every
 * write either commits together or rolls back together. The callback receives
 * a transaction context with the same collection API as the store —
 * `tx.nodes.<Kind>` and `tx.edges.<name>` — plus `tx.sql`, the raw Drizzle
 * handle bound to the same transaction for the caller's own relational
 * tables. The callback's return value becomes the return value of
 * `store.transaction()`.
 *
 * The motivating scenario: placing an order must write an Order node,
 * decrement the inventory it draws from, AND link the two with a `fulfills`
 * edge. Any one of those without the others corrupts the books — atomicity
 * is the point, not a nicety.
 *
 * This example demonstrates:
 * - a successful transaction and its returned value
 * - full rollback when the callback throws mid-way
 * - the partial state the same failure leaves behind WITHOUT a transaction
 * - the fail-loud guard against using the root `store` inside the callback
 * - `store.withTransaction(externalTx)` for joining a caller-owned transaction
 *
 * Run with:
 *   npx tsx examples/25-transactions.ts
 */
import {
  createAdapterStore,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { createExampleBackend } from "./_helpers";

// ============================================================
// Schema Definition
// ============================================================

const InventoryItem = defineNode("InventoryItem", {
  schema: z.object({
    sku: z.string(),
    onHand: z.number().int(),
  }),
});

const Order = defineNode("Order", {
  schema: z.object({
    sku: z.string(),
    quantity: z.number().int(),
  }),
});

// The invariant: every committed Order is fulfilled from inventory.
const fulfills = defineEdge("fulfills", {
  schema: z.object({ quantity: z.number().int() }),
});

const graph = defineGraph({
  id: "order_fulfillment",
  nodes: {
    InventoryItem: { type: InventoryItem },
    Order: { type: Order },
  },
  edges: {
    fulfills: { type: fulfills, from: [InventoryItem], to: [Order] },
  },
});

// ============================================================
// Demonstrate Transactions
// ============================================================

export async function main() {
  const backend = createExampleBackend();
  const store = createAdapterStore(graph, backend);

  try {
    console.log("=== Transactions (store.transaction) ===\n");

    const widget = await store.nodes.InventoryItem.create({
      sku: "WIDGET",
      onHand: 10,
    });
    console.log(`Seeded inventory: ${widget.sku} onHand=${widget.onHand}\n`);

    // ============================================================
    // 1. A successful transaction — three writes, one commit
    // ============================================================

    console.log("=== 1. Successful transaction ===\n");

    // The callback's return value propagates out of store.transaction().
    const order = await store.transaction(async (tx) => {
      const created = await tx.nodes.Order.create({
        sku: "WIDGET",
        quantity: 3,
      });
      await tx.nodes.InventoryItem.update(widget.id, {
        sku: "WIDGET",
        onHand: 10 - 3,
      });
      await tx.edges.fulfills.create(widget, created, { quantity: 3 });

      // Reads through `tx` observe the still-uncommitted writes.
      const uncommitted = await tx.nodes.Order.find();
      console.log(
        `  inside tx: order visible to tx reads (count=${uncommitted.length})`,
      );
      return created;
    });

    const widgetAfterCommit = await store.nodes.InventoryItem.getById(
      widget.id,
    );
    const onHandAfterCommit = widgetAfterCommit?.onHand;
    const edgesAfterCommit = await store.edges.fulfills.findFrom(widget);
    console.log(`  committed: order ${order.id} (quantity=${order.quantity})`);
    console.log(
      `  committed: onHand=${onHandAfterCommit}, fulfills edges=${edgesAfterCommit.length}\n`,
    );

    // ============================================================
    // 2. A failing transaction — thrown error rolls EVERYTHING back
    // ============================================================

    console.log("=== 2. Failing transaction rolls back completely ===\n");

    // Write the order AND the inventory decrement first, then discover the
    // stock went negative — exactly the mid-flight failure that would
    // otherwise strand partial writes.
    try {
      await store.transaction(async (tx) => {
        const doomed = await tx.nodes.Order.create({
          sku: "WIDGET",
          quantity: 50,
        });
        const remaining = 7 - 50;
        await tx.nodes.InventoryItem.update(widget.id, {
          sku: "WIDGET",
          onHand: remaining,
        });
        await tx.edges.fulfills.create(widget, doomed, { quantity: 50 });
        console.log(
          "  inside tx: 3 writes applied, about to fail the stock check...",
        );
        if (remaining < 0)
          throw new Error(`insufficient stock: onHand would be ${remaining}`);
      });
    } catch (error) {
      console.log(`  caught: ${(error as Error).message}`);
    }

    const orders = await store.nodes.Order.find();
    const widgetAfterRollback = await store.nodes.InventoryItem.getById(
      widget.id,
    );
    const onHandAfterRollback = widgetAfterRollback?.onHand;
    const edgesAfterRollback = await store.edges.fulfills.findFrom(widget);
    console.log(
      `  rolled back: order count still ${orders.length} (the doomed order is gone)`,
    );
    console.log(
      `  rolled back: onHand still ${onHandAfterRollback} (decrement undone)`,
    );
    console.log(
      `  rolled back: fulfills edges still ${edgesAfterRollback.length}\n`,
    );

    // ============================================================
    // 3. The same failure WITHOUT a transaction strands partial state
    // ============================================================

    console.log("=== 3. Without a transaction: partial writes survive ===\n");

    try {
      const orphan = await store.nodes.Order.create({
        sku: "WIDGET",
        quantity: 50,
      });
      const remaining = 7 - 50;
      if (remaining < 0)
        throw new Error(
          `insufficient stock for order ${orphan.id}: onHand would be ${remaining}`,
        );
      await store.nodes.InventoryItem.update(widget.id, {
        sku: "WIDGET",
        onHand: remaining,
      });
    } catch (error) {
      console.log(`  caught: ${(error as Error).message}`);
    }

    const strandedOrders = await store.nodes.Order.find();
    const fulfilledEdges = await store.edges.fulfills.findFrom(widget);
    const unfulfilled = strandedOrders.length - fulfilledEdges.length;
    console.log(
      `  stranded: order count is now ${strandedOrders.length} — ${unfulfilled} order has NO fulfills edge`,
    );
    console.log(
      "  the invariant is broken; cleanup is now the caller's problem.",
    );

    // Repair the books before moving on.
    const orphaned = strandedOrders.filter(
      (candidate) => candidate.quantity === 50,
    );
    for (const stranded of orphaned) {
      await store.nodes.Order.delete(stranded.id);
    }
    console.log(`  cleaned up ${orphaned.length} orphaned order manually\n`);

    // ============================================================
    // 4. Inside the callback, use `tx` — never the root `store`
    // ============================================================

    console.log("=== 4. The root store is guarded inside a transaction ===\n");

    // The transaction holds the SQLite backend's serialized execution slot,
    // so awaiting a root-store operation (including a nested
    // store.transaction()) inside the callback would deadlock. TypeGraph
    // detects this and fails loudly instead of hanging.
    try {
      await store.transaction(async () => {
        await store.nodes.Order.find(); // WRONG: root store, not tx.nodes
      });
    } catch (error) {
      console.log(`  guarded: ${(error as Error).message.split(":")[0]}\n`);
    }

    // ============================================================
    // 5. Adopting a caller-owned transaction (store.withTransaction)
    // ============================================================

    console.log(
      "=== 5. Joining an external transaction (withTransaction) ===\n",
    );

    // When the relational layer owns the transaction, `store.withTransaction`
    // enlists graph writes on the caller's connection instead of opening its
    // own. The synchronous better-sqlite3 driver cannot run an async Drizzle
    // transaction callback, so the caller drives BEGIN/COMMIT/ROLLBACK
    // explicitly. (History-enabled stores use `store.withRecordedTransaction`.)
    const { backend: externalBackend, db } = createLocalSqliteBackend();
    try {
      const externalStore = createAdapterStore(graph, externalBackend);

      db.run(sql`BEGIN`);
      const txStore = externalStore.withTransaction(db);
      const adopted = await txStore.nodes.Order.create({
        sku: "WIDGET",
        quantity: 1,
      });
      db.run(sql`ROLLBACK`); // the CALLER decides — and rolls back

      const visible = await externalStore.nodes.Order.getById(adopted.id);
      console.log(
        `  caller rolled back: adopted graph write persisted? ${visible !== undefined}`,
      );
      console.log(
        "  the caller's COMMIT/ROLLBACK is the single boundary for both layers.\n",
      );
    } finally {
      await externalBackend.close();
    }

    console.log("=== Transactions example complete ===");
  } finally {
    await backend.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
