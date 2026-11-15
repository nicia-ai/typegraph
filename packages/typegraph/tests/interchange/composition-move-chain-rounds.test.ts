/**
 * A chain of composition moves whose first link is refused: item i moves from
 * slot i into slot i-1, which only the move before it frees, and slot 0 is
 * held by an item that does not move. Every move fails, discovered one link
 * per pass over the moves. Those passes must stay passes over the MOVES: the
 * creates, repeats and required-part purge written after the moves run once,
 * so a refused chain never multiplies the rest of the import.
 *
 * Counted, not timed: a plain edge in the same document is the sentinel, and
 * each time it is inserted is one run of everything after the moves.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, partOf } from "../../src";
import {
  deriveBackend,
  projectGraphBackend,
} from "../../src/backend/derive-backend";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import type { InsertEdgeParams } from "../../src/backend/types";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
} from "../../src/interchange";
import { createStore, createStoreWithSchema } from "../../src/store";
import { requireDefined } from "../../src/utils/presence";

const Item = defineNode("CmcItem", { schema: z.object({}) });
const Slot = defineNode("CmcSlot", { schema: z.object({}) });
const inSlot = defineEdge("cmcInSlot", { schema: z.object({}) });
const nextTo = defineEdge("cmcNextTo", { schema: z.object({}) });

const graph = defineGraph({
  id: "composition_move_chain_rounds",
  nodes: { CmcItem: { type: Item }, CmcSlot: { type: Slot } },
  edges: {
    cmcInSlot: {
      type: inSlot,
      from: [Item],
      to: [Slot],
      cardinality: "oneActive",
      targetCardinality: "oneActive",
    },
    cmcNextTo: { type: nextTo, from: [Slot], to: [Slot] },
  },
  ontology: [partOf(Item, Slot, { via: inSlot })],
});

const ATTACHED_AT = "2020-01-01T00:00:00.000Z";
const MOVED_AT = "2021-01-01T00:00:00.000Z";
const CHAIN_LENGTH = 12;
const SENTINEL_EDGE_ID = "cmc-sentinel";

describe("a refused chain of composition moves", () => {
  it("writes everything after the moves once, however long the chain", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [setup] = await createStoreWithSchema(graph, backend);
      const slots: Awaited<ReturnType<typeof setup.nodes.CmcSlot.create>>[] =
        [];
      for (let index = 0; index <= CHAIN_LENGTH; index++) {
        slots.push(await setup.nodes.CmcSlot.create({}));
      }
      const slotAt = (index: number) => requireDefined(slots[index]);
      await setup.nodes.CmcItem.create(
        {},
        { partOf: { whole: slotAt(0), validFrom: ATTACHED_AT } },
      );
      const items: Awaited<ReturnType<typeof setup.nodes.CmcItem.create>>[] =
        [];
      for (let index = 1; index <= CHAIN_LENGTH; index++) {
        items.push(
          await setup.nodes.CmcItem.create(
            {},
            { partOf: { whole: slotAt(index), validFrom: ATTACHED_AT } },
          ),
        );
      }
      const held = await setup.edges.cmcInSlot.find({});
      const edges: GraphData["edges"] = items.flatMap((item, offset) => {
        const index = offset + 1;
        const incumbent = requireDefined(
          held.find((edge) => edge.fromId === item.id),
        );
        return [
          {
            kind: "cmcInSlot",
            id: incumbent.id,
            from: { kind: "CmcItem", id: item.id },
            to: { kind: "CmcSlot", id: slotAt(index).id },
            properties: {},
            validFrom: ATTACHED_AT,
            validTo: MOVED_AT,
          },
          {
            kind: "cmcInSlot",
            id: `cmc-move-${index}`,
            from: { kind: "CmcItem", id: item.id },
            to: { kind: "CmcSlot", id: slotAt(index - 1).id },
            properties: {},
            validFrom: MOVED_AT,
          },
        ];
      });
      edges.push({
        kind: "cmcNextTo",
        id: SENTINEL_EDGE_ID,
        from: { kind: "CmcSlot", id: slotAt(0).id },
        to: { kind: "CmcSlot", id: slotAt(1).id },
        properties: {},
      });

      let sentinelInserts = 0;
      const countSentinel = (
        params: InsertEdgeParams | readonly InsertEdgeParams[],
      ): void => {
        const rows = Array.isArray(params) ? params : [params];
        sentinelInserts += rows.filter(
          (row: InsertEdgeParams) => row.id === SENTINEL_EDGE_ID,
        ).length;
      };
      const counting = deriveBackend(projectGraphBackend(backend), {
        transaction: (run, options) =>
          backend.transaction(
            (target) =>
              run(
                deriveBackend(target, {
                  insertEdge: (params) => {
                    countSentinel(params);
                    return target.insertEdge(params);
                  },
                  ...(target.insertEdgeNoReturn === undefined ?
                    {}
                  : {
                      insertEdgeNoReturn: (params: InsertEdgeParams) => {
                        countSentinel(params);
                        return requireDefined(target.insertEdgeNoReturn)(
                          params,
                        );
                      },
                    }),
                  ...(target.insertEdgesBatch === undefined ?
                    {}
                  : {
                      insertEdgesBatch: (
                        params: readonly InsertEdgeParams[],
                      ) => {
                        countSentinel(params);
                        return requireDefined(target.insertEdgesBatch)(params);
                      },
                    }),
                }),
              ),
            options,
          ),
      });

      const result = await importGraph(
        createStore(graph, counting),
        {
          formatVersion: FORMAT_VERSION,
          exportedAt: "2026-01-01T00:00:00.000Z",
          source: { type: "external", description: "refused move chain" },
          nodes: [],
          edges,
        },
        { onConflict: "update", refreshStatistics: false },
      );

      expect({
        refusedRows: result.errors.length,
        created: result.edges.created,
        updated: result.edges.updated,
        sentinelInserts,
      }).toEqual({
        refusedRows: 2 * CHAIN_LENGTH,
        created: 1,
        updated: 0,
        sentinelInserts: 1,
      });
    } finally {
      await backend.close();
    }
  });
});
