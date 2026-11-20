/**
 * Removing a kind and later re-adding it must not corrupt either incarnation.
 *
 * Two hazards, closed at different layers:
 *
 * 1. **Re-add while cleanup is pending is refused.** The old rows are still in
 *    the base relations and reads filter only by `(graph_id, kind)` — there is
 *    no schema-generation boundary — so re-adding would make the previous
 *    incarnation's rows visible alongside the new ones. `Store.evolve` refuses
 *    until `materializeRemovals()` has run.
 *
 * 2. **Cleanup never deletes the rows of a live kind.** `materializeRemovals`
 *    re-derives removals by walking schema history, comparing each consecutive
 *    pair of documents, so a removal at v3 is still discovered after v4 re-added
 *    the kind. Cleanup is an unconditional `DELETE ... WHERE kind = ?`, so
 *    acting on it would destroy the new incarnation's data. The decline is
 *    reported (`status: "skipped"`), not silent.
 *
 * The guard in (1) closes the common path. (2) still matters for a removal that
 * never queued a row — a commit that dropped an empty kind, or a `removeKinds`
 * that crashed before its queue write — where history reconciliation surfaces
 * the removal only after the kind is live again.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { GraphBackend } from "../src/backend/types";
import type { GraphDef } from "../src/core/define-graph";
import { defineGraph } from "../src/core/define-graph";
import { defineNode } from "../src/core/node";
import { ConfigurationError } from "../src/errors";
import { defineGraphExtension } from "../src/graph-extension";
import { computeSchemaHash, serializeSchema } from "../src/schema/serializer";
import { createStoreWithSchema } from "../src/store/store";
import { requireDefined } from "../src/utils/presence";
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

/**
 * Commit a schema version directly, bypassing the removal queue — the state a
 * `removeKinds()` crash leaves behind, and the one shape that can reach a live
 * kind carrying a history-derived removal.
 */
async function commitWithoutQueueing<G extends GraphDef>(
  backend: GraphBackend,
  graph: G,
  currentVersion: number,
): Promise<void> {
  const schema = serializeSchema(graph, currentVersion + 1);
  await backend.commitSchemaVersion({
    graphId: graph.id,
    expected: { kind: "active", version: currentVersion },
    version: currentVersion + 1,
    schemaHash: await computeSchemaHash(schema),
    schemaDoc: schema,
  });
}

describe("removed-then-re-added kinds", () => {
  it("refuses to re-add a kind whose cleanup is still pending", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(widgetExtension);
    await evolved.getNodeCollectionOrThrow("Widget").create({ label: "old" });

    const removed = await evolved.removeKinds(["Widget"]);

    const error = await removed
      .evolve(widgetExtension)
      .catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).message).toContain(
      "materializeRemovals",
    );
  });

  it("allows the re-add once cleanup has run, with no rows carried over", async () => {
    // The documented cycle: remove -> materializeRemovals -> re-add.
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(widgetExtension);
    await evolved.getNodeCollectionOrThrow("Widget").create({ label: "old" });

    const removed = await evolved.removeKinds(["Widget"]);
    await removed.materializeRemovals();

    const readded = await removed.evolve(widgetExtension);
    await readded.getNodeCollectionOrThrow("Widget").create({ label: "new" });

    const rows = await readded
      .getNodeCollectionOrThrow("Widget")
      .find({ limit: 50 });
    expect(rows.map((row) => row["label"])).toEqual(["new"]);
  });

  it("declines a history-derived removal for a kind that is live again", async () => {
    // Reaches the guard the only way still open: a removal committed without a
    // queue row, so nothing blocks the re-add and reconciliation surfaces the
    // removal afterwards.
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(widgetExtension);
    await evolved.getNodeCollectionOrThrow("Widget").create({ label: "old" });

    const activeVersion = requireDefined(
      await backend.getActiveSchema(baseGraph.id),
      "active schema",
    ).version;
    await commitWithoutQueueing(backend, baseGraph, activeVersion);

    const [reopened] = await createStoreWithSchema(baseGraph, backend);
    const readded = await reopened.evolve(widgetExtension);
    await readded
      .getNodeCollectionOrThrow("Widget")
      .create({ label: "written after re-add" });

    const result = await readded.materializeRemovals();

    const widgetEntry = result.results.find((entry) => entry.kind === "Widget");
    if (widgetEntry?.status !== "skipped") {
      throw new Error(`expected a skipped entry, got ${widgetEntry?.status}`);
    }
    expect(widgetEntry.reason).toBe("kind-is-live");

    // The live incarnation's row survives — that is the point of the decline.
    expect(
      await backend.countNodesByKind({ graphId: baseGraph.id, kind: "Widget" }),
    ).toBeGreaterThan(0);
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
