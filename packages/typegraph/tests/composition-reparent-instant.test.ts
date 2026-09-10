/**
 * `reparent` moves a part with ONE clock read, and the two halves of the move
 * abut in valid time.
 *
 * The cross-backend suite (`tests/backends/integration/composition-attachment.ts`)
 * asserts the abutment on a real engine, but it cannot PROVE the single read:
 * two `nowIso()` calls a few statements apart usually land in the same
 * millisecond, so a two-read implementation passes it by luck. This file
 * removes the luck — the fake clock advances between the retire and the attach
 * (a wrapper on the transaction target's edge insert), so a second read is
 * guaranteed to sample a later instant and the hole becomes observable.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import {
  type GraphBackend,
  type InsertEdgeParams,
  type TransactionBackend,
} from "../src/backend/types";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const Show = defineNode("RiShow", { schema: z.object({}) });
const Clip = defineNode("RiClip", { schema: z.object({}) });
const clipOf = defineEdge("riClipOf", { schema: z.object({}) });

const CLOCK_START = "2026-03-01T00:00:00.000Z";
/** Far larger than any plausible same-millisecond collision. */
const ADVANCE_MS = 60_000;

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: { RiShow: { type: Show }, RiClip: { type: Clip } },
    edges: {
      riClipOf: {
        type: clipOf,
        from: [Clip],
        to: [Show],
        cardinality: "oneActive",
      },
    },
    ontology: [partOf(Clip, Show, { via: clipOf, existence: "required" })],
  });
}

function advanceClock(): void {
  vi.setSystemTime(new Date(Date.now() + ADVANCE_MS));
}

/**
 * Advances the fake clock immediately BEFORE every edge insert the write
 * transaction issues. A reparent that samples its own instant for the attach
 * therefore stamps a `valid_from` strictly later than the `valid_to` it just
 * wrote on the incumbent; one that carries the move instant through cannot.
 *
 * The wrapper decorates the TRANSACTION TARGET (through `deriveBackend`, never
 * a spread copy), because that is the object the attach's insert reaches.
 */
function clockAdvancingBackend(base: GraphBackend): GraphBackend {
  function advancing(target: TransactionBackend): TransactionBackend {
    return deriveBackend(target, {
      insertEdge: async (params: InsertEdgeParams) => {
        advanceClock();
        return target.insertEdge(params);
      },
      ...(target.insertEdgeNoReturn === undefined ?
        {}
      : {
          insertEdgeNoReturn: async (params: InsertEdgeParams) => {
            advanceClock();
            await requireDefined(target.insertEdgeNoReturn)(params);
          },
        }),
    });
  }
  return deriveBackend(base, {
    transaction: (run, options) =>
      base.transaction((target) => run(advancing(target)), options),
  });
}

describe("reparent's move instant", () => {
  it("ends the incumbent window at the SAME instant the new window opens, with the clock advancing in between", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(CLOCK_START));
      const backend = clockAdvancingBackend(createTestBackend());
      const [store] = await createStoreWithSchema(
        buildGraph("reparent_move_instant"),
        backend,
      );

      const showA = await store.nodes.RiShow.create({});
      const showB = await store.nodes.RiShow.create({});
      const clip = await store.nodes.RiClip.create(
        {},
        { partOf: { kind: "RiShow", id: showA.id } },
      );

      // MUTATION: give the two halves of the move their own clock reads —
      // in `applyCompositionAttachmentUnderFence`
      // (src/store/operations/node-operations.ts), pass `nowIso()` inline to
      // `endCompositionEdgeWindow` and drop the `{ validFrom: moveInstant }`
      // argument to `attachCompositionCreateEdge`. The attach then stamps
      // `CLOCK_START + n * ADVANCE_MS`, a full minute after the window it
      // replaced ended, and both assertions below fail.
      await store.nodes.RiClip.reparent(clip.id, {
        kind: "RiShow",
        id: showB.id,
      });

      const rows = await store.edges.riClipOf.find(
        {},
        { temporalMode: "includeEnded" },
      );
      expect(rows).toHaveLength(2);
      const ended = requireDefined(
        rows.find((edge) => edge.toId === showA.id),
        "the retired attachment",
      );
      const open = requireDefined(
        rows.find((edge) => edge.toId === showB.id),
        "the new attachment",
      );
      const moveInstant = requireDefined(
        ended.meta.validTo,
        "the retired window's validTo",
      );
      expect(open.meta.validFrom).toBe(moveInstant);

      // The windows are half-open `[from, to)`, so the move instant belongs to
      // exactly one of them: this `existence: "required"` part holds one whole
      // at every valid-time coordinate, never zero and never two.
      const atMove = await store.asOf(moveInstant).edges.riClipOf.find({});
      expect(atMove).toHaveLength(1);
      expect(
        requireDefined(atMove[0], "the attachment at the move instant").toId,
      ).toBe(showB.id);
    } finally {
      vi.useRealTimers();
    }
  });
});
