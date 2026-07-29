import { describe, expect, it } from "vitest";
import { z } from "zod";

import { MigrationError } from "../../../src";
import { defineGraph } from "../../../src/core/define-graph";
import { defineNode } from "../../../src/core/node";
import { defineGraphExtension } from "../../../src/graph-extension";
import { getActiveSchema, migrateSchema } from "../../../src/schema";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

async function activeVersion(
  context: IntegrationTestContext,
  id: string,
): Promise<number> {
  const active = await getActiveSchema(context.getBackend(), id);
  return requireDefined(active, "active schema").version;
}

/**
 * Cross-backend contract for `migrateSchema`'s kind handling.
 *
 * These are the guarantees that keep a schema commit from destroying data, and
 * they are enforced with SQL the two dialects do not share — row-count probes,
 * kind-wide deletes, and schema-history reconciliation. A SQLite-only test
 * would happily certify a divergence, so the contract lives here.
 */
export function registerMigrateSchemaKindIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("migrateSchema kind handling", () => {
    const Person = defineNode("Person", {
      schema: z.object({ name: z.string() }),
    });
    const Company = defineNode("Company", {
      schema: z.object({ name: z.string() }),
    });

    /** Distinct id per test so suites sharing one database cannot collide. */
    function graphFor(suffix: string) {
      return defineGraph({
        id: `migrate_kinds_${suffix}`,
        nodes: { Person: { type: Person }, Company: { type: Company } },
        edges: {},
      });
    }

    function withoutCompany(id: string) {
      return defineGraph({
        id,
        nodes: { Person: { type: Person } },
        edges: {},
      });
    }

    const widgetExtension = defineGraphExtension({
      nodes: { Widget: { properties: { label: { type: "string" } } } },
    });

    it("bootstraps the kind-removal queue before evolve preflight", async () => {
      const graph = graphFor("legacy_removal_queue");
      const store = await context.createStore(graph);
      const backend = context.getBackend();

      // A pre-0.44 database has all established schema tables but not the
      // newly-added removal queue. Evolve must initialize its own preflight
      // dependency rather than requiring an out-of-band backend bootstrap.
      await requireDefined(backend.executeDdl)(
        'DROP TABLE IF EXISTS "typegraph_kind_removals"',
      );

      const evolved = await store.evolve(widgetExtension);

      expect(evolved.introspect().kinds.map((kind) => kind.name)).toContain(
        "Widget",
      );
      expect(
        await requireDefined(backend.getPendingKindRemovals)(graph.id),
      ).toEqual([]);
    });

    it("folds the persisted extension, preserving runtime kinds and their rows", async () => {
      const graph = graphFor("fold");
      const store = await context.createStore(graph);
      const evolved = await store.evolve(widgetExtension);
      const widget = await evolved
        .getNodeCollectionOrThrow("Widget")
        .create({ label: "kept" });

      // The caller passes the compile-time graph; it does not know Widget exists.
      await migrateSchema(
        context.getBackend(),
        graph,
        await activeVersion(context, graph.id),
      );

      const active = requireDefined(
        await getActiveSchema(context.getBackend(), graph.id),
        "active schema",
      );
      expect(Object.keys(active.nodes)).toContain("Widget");

      const reopened = await context.createStore(graph);
      const found = await reopened
        .getNodeCollectionOrThrow("Widget")
        .getById(widget.id);
      expect(found?.["label"]).toBe("kept");
    });

    it("refuses to drop a kind that still holds rows", async () => {
      const graph = graphFor("refuse");
      const store = await context.createStore(graph);
      await store.nodes.Company.create({ name: "Initech" });

      const error = await migrateSchema(
        context.getBackend(),
        withoutCompany(graph.id),
        await activeVersion(context, graph.id),
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(MigrationError);
      const details = (error as MigrationError).details;
      if (details.reason !== "kind-removal") throw new Error("wrong reason");
      expect(details.droppedKinds.nodes).toEqual(["Company"]);

      // The refusal leaves the active version untouched.
      const active = requireDefined(
        await getActiveSchema(context.getBackend(), graph.id),
        "active schema",
      );
      expect(Object.keys(active.nodes)).toContain("Company");
    });

    it("allows dropping an empty kind — the documented three-deploy flow", async () => {
      const graph = graphFor("empty_drop");
      await context.createStore(graph);

      await migrateSchema(
        context.getBackend(),
        withoutCompany(graph.id),
        await activeVersion(context, graph.id),
      );

      const active = requireDefined(
        await getActiveSchema(context.getBackend(), graph.id),
        "active schema",
      );
      expect(Object.keys(active.nodes)).not.toContain("Company");
    });

    it("discardDroppedKindRows commits, and the reconciler deletes the rows", async () => {
      const graph = graphFor("discard");
      const store = await context.createStore(graph);
      await store.nodes.Company.create({ name: "Initech" });

      await migrateSchema(
        context.getBackend(),
        withoutCompany(graph.id),
        await activeVersion(context, graph.id),
        { discardDroppedKindRows: true },
      );

      const reopened = await context.createStore(withoutCompany(graph.id));
      await reopened.materializeRemovals();

      expect(
        await context.getBackend().countNodesByKind({
          graphId: graph.id,
          kind: "Company",
          excludeDeleted: false,
        }),
      ).toBe(0);
    });

    it("refuses to re-add a kind whose cleanup is still pending", async () => {
      // The old incarnation's rows are still in the base relations and reads
      // filter only by (graph_id, kind), so re-adding would surface them
      // alongside the new ones. Enforced identically on both dialects.
      const graph = graphFor("readd");
      const store = await context.createStore(graph);
      const evolved = await store.evolve(widgetExtension);
      await evolved.getNodeCollectionOrThrow("Widget").create({ label: "old" });

      const removed = await evolved.removeKinds(["Widget"]);
      const error = await removed
        .evolve(widgetExtension)
        .catch((error_: unknown) => error_);

      expect((error as Error).message).toContain("materializeRemovals");
    });

    it("carries no rows across a remove / cleanup / re-add cycle", async () => {
      const graph = graphFor("readd_clean");
      const store = await context.createStore(graph);
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
  });
}
