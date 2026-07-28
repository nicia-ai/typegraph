/**
 * A kind that is dropped and later re-added must not have its rows deleted by
 * a subsequent reconcile.
 *
 * `materializeRemovals` re-derives removals by walking schema-version history,
 * comparing each consecutive pair of documents. That comparison is local to the
 * transition, so a kind removed at v3 is still discovered as "removed at v3"
 * even when v4 re-added it and applications have written new rows since. The
 * cleanup it queues is an unconditional `DELETE ... WHERE kind = ?`, so without
 * a guard the reconcile destroys live data belonging to a kind the active
 * schema declares.
 *
 * The invariant: never delete rows of a kind the active schema still has.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph } from "../src/core/define-graph";
import { defineNode } from "../src/core/node";
import { defineGraphExtension } from "../src/graph-extension";
import { createStoreWithSchema } from "../src/store/store";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });

const baseGraph = defineGraph({
  id: "kind_readd_reconcile",
  nodes: { Person: { type: Person } },
  edges: {},
});

const widgetExtension = defineGraphExtension({
  nodes: { Widget: { properties: { label: { type: "string" } } } },
});

describe("removed-then-re-added kinds", () => {
  it("does not delete rows written after a kind is re-added", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    // Add the kind and write a row.
    const evolved = await store.evolve(widgetExtension);
    await evolved.getNodeCollectionOrThrow("Widget").create({ label: "old" });

    // Remove it through the sanctioned path, which queues cleanup.
    const removed = await evolved.removeKinds(["Widget"]);

    // Re-add it and write new data.
    const readded = await removed.evolve(widgetExtension);
    await readded
      .getNodeCollectionOrThrow("Widget")
      .create({ label: "written after re-add" });

    // A routine reconcile must not touch the live kind — and must SAY it
    // declined. A silent skip leaves the queue at a non-zero depth with
    // nothing in the output explaining why, which an operator cannot tell
    // apart from "nothing was pending".
    const result = await readded.materializeRemovals();
    const widgetEntry = result.results.find((entry) => entry.kind === "Widget");
    // Narrowing on `status` is what makes `reason` reachable — the entry type
    // is a union, so each outcome carries exactly its own payload.
    if (widgetEntry?.status !== "skipped") {
      throw new Error(`expected a skipped entry, got ${widgetEntry?.status}`);
    }
    expect(widgetEntry.reason).toBe("kind-is-live");

    expect(
      await backend.countNodesByKind({ graphId: baseGraph.id, kind: "Widget" }),
    ).toBeGreaterThan(0);
    const survivors = await readded
      .getNodeCollectionOrThrow("Widget")
      .find({ limit: 10 });
    expect(survivors.map((node) => node["label"])).toContain(
      "written after re-add",
    );
  });

  it("still cleans up a kind that stays removed", async () => {
    // The guard must not disable legitimate cleanup.
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(widgetExtension);
    await evolved.getNodeCollectionOrThrow("Widget").create({ label: "gone" });

    const removed = await evolved.removeKinds(["Widget"]);
    await removed.materializeRemovals();

    expect(
      await backend.countNodesByKind({
        graphId: baseGraph.id,
        kind: "Widget",
        excludeDeleted: false,
      }),
    ).toBe(0);
  });
});
