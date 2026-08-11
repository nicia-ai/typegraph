import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { GraphBackend, GraphDef } from "../../../src";
import {
  createStoreWithSchema,
  defineGraph,
  defineGraphExtension,
  defineNode,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { computeSchemaHash, serializeSchema } from "../../../src/schema";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

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

/** Cross-backend safety boundaries for destructive removal materialization. */
export function registerRemovalMaterializationIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("removal materialization", () => {
    const Person = defineNode("Person", {
      schema: z.object({ name: z.string() }),
    });
    const baseGraph = defineGraph({
      id: "removal_materialization_race",
      nodes: { Person: { type: Person } },
      edges: {},
    });
    const widgetExtension = defineGraphExtension({
      nodes: { Widget: { properties: { label: { type: "string" } } } },
    });

    it("rechecks kind liveness inside the schema transaction", async () => {
      const baseBackend = context.getBackend();
      const getPendingKindRemovals = requireDefined(
        baseBackend.getPendingKindRemovals,
      );
      const raceState: {
        readdBeforePendingRowsReturn: boolean;
        liveGraph?: GraphDef;
      } = { readdBeforePendingRowsReturn: false };
      const backend = deriveBackend(baseBackend, {
        async getPendingKindRemovals(graphId) {
          const pending = await getPendingKindRemovals(graphId);
          if (raceState.readdBeforePendingRowsReturn) {
            raceState.readdBeforePendingRowsReturn = false;
            const graph = requireDefined(raceState.liveGraph, "live graph");
            const activeVersion = requireDefined(
              await baseBackend.getActiveSchema(graphId),
              "active schema",
            ).version;
            await commitWithoutQueueing(baseBackend, graph, activeVersion);
          }
          return pending;
        },
      });
      const [store] = await createStoreWithSchema(baseGraph, backend);
      const evolved = await store.evolve(widgetExtension);
      await evolved
        .getNodeCollectionOrThrow("Widget")
        .create({ label: "preserve me" });
      const removed = await evolved.removeKinds(["Widget"]);

      // The initial active-schema scan has already observed the removal when
      // getPendingKindRemovals runs. Commit the re-add before the destructive
      // pass so only the transaction-bound recheck can preserve the live kind.
      raceState.liveGraph = evolved.graph;
      raceState.readdBeforePendingRowsReturn = true;
      const result = await removed.materializeRemovals();

      expect(result.results).toContainEqual({
        entity: "node",
        kind: "Widget",
        status: "skipped",
        reason: "kind-is-live",
      });
      await expect(
        baseBackend.countNodesByKind({
          graphId: baseGraph.id,
          kind: "Widget",
          excludeDeleted: false,
        }),
      ).resolves.toBe(1);
    });
  });
}
