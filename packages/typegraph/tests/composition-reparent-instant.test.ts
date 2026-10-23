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
  CompositionError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
  ValidationError,
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
/** A `population: "one"` part: its incumbent is deleted on a move, not ended. */
const Still = defineNode("RiStill", { schema: z.object({}) });
const stillOf = defineEdge("riStillOf", { schema: z.object({}) });

const CLOCK_START = "2026-03-01T00:00:00.000Z";
/** Far larger than any plausible same-millisecond collision. */
const ADVANCE_MS = 60_000;

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      RiShow: { type: Show },
      RiClip: { type: Clip },
      RiStill: { type: Still },
    },
    edges: {
      riClipOf: {
        type: clipOf,
        from: [Clip],
        to: [Show],
        cardinality: "oneActive",
      },
      riStillOf: {
        type: stillOf,
        from: [Still],
        to: [Show],
        cardinality: "one",
      },
    },
    ontology: [
      partOf(Clip, Show, { via: clipOf, existence: "required" }),
      partOf(Still, Show, { via: stillOf }),
    ],
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
        { partOf: { whole: { kind: "RiShow", id: showA.id } } },
      );

      // MUTATION: give the two halves of the move their own clock reads —
      // in `prepareCompositionAttachmentMoves`
      // (src/store/operations/node-operations.ts), record `nowIso()` as the
      // retire's `moveInstant` instead of the instant the replacement was
      // prepared with. The two rows then carry instants a clock advance
      // apart, and both assertions below fail.
      await store.nodes.RiClip.reparent(clip.id, {
        whole: { kind: "RiShow", id: showB.id },
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

  it("takes at as its only move instant and refuses a stated validFrom", async () => {
    const [store] = await createStoreWithSchema(
      buildGraph("reparent_stated_at"),
      createTestBackend(),
    );
    const showA = await store.nodes.RiShow.create({});
    const showB = await store.nodes.RiShow.create({});
    const clip = await store.nodes.RiClip.create(
      {},
      {
        partOf: {
          whole: { kind: "RiShow", id: showA.id },
          validFrom: "2024-01-01T00:00:00.000Z",
        },
      },
    );
    const at = "2024-06-01T00:00:00.000Z";

    // MUTATION: add "validFrom" to `REPARENT_OPTION_KEYS`
    // (src/store/operations/composition-create.ts). The option is then
    // accepted and dropped, the move goes through, and this rejects nothing.
    const refusal = await store.nodes.RiClip.reparent(clip.id, {
      whole: { kind: "RiShow", id: showB.id },
      // @ts-expect-error reparent has one instant, `at`; it takes no validFrom
      validFrom: at,
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ValidationError);
    expect((refusal as ValidationError).details.issues).toEqual([
      expect.objectContaining({ path: "options.validFrom" }),
    ]);
    const untouched = await store.edges.riClipOf.find({});
    expect(untouched.map((edge) => edge.toId)).toEqual([showA.id]);

    const moved = await store.nodes.RiClip.reparent(clip.id, {
      whole: { kind: "RiShow", id: showB.id },
      at,
    });
    expect(moved.moved).toBe(true);
    expect(moved.edge.meta.validFrom).toBe(at);
    expect(moved.edge.kind).toBe("riClipOf");

    const history = await store.edges.riClipOf.find(
      {},
      { temporalMode: "includeEnded" },
    );
    const retired = requireDefined(
      history.find((edge) => edge.toId === showA.id),
      "the retired attachment",
    );
    expect(retired.meta.validTo).toBe(at);
  });

  it("refuses a stated validTo or a malformed at, each under its own option name", async () => {
    const [store] = await createStoreWithSchema(
      buildGraph("reparent_refused_options"),
      createTestBackend(),
    );
    const showA = await store.nodes.RiShow.create({});
    const showB = await store.nodes.RiShow.create({});
    const clip = await store.nodes.RiClip.create(
      {},
      { partOf: { whole: { kind: "RiShow", id: showA.id } } },
    );
    const whole = { kind: "RiShow", id: showB.id } as const;

    const issuePaths = async (
      attempt: Promise<unknown>,
    ): Promise<readonly string[]> => {
      const refusal = await attempt.catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ValidationError);
      return (refusal as ValidationError).details.issues.map(
        (issue) => issue.path,
      );
    };

    // MUTATION: add "validTo" to `REPARENT_OPTION_KEYS`
    // (src/store/operations/composition-create.ts). The bound is then
    // accepted and applied, so the move goes through and nothing is refused.
    expect(
      await issuePaths(
        store.nodes.RiClip.reparent(clip.id, {
          whole,
          // @ts-expect-error a move states no window; `at` is its only instant
          validTo: "2999-01-01T00:00:00.000Z",
        }),
      ),
    ).toEqual(["options.validTo"]);

    // MUTATION: return `at` unchecked from `readMoveInstant`. The malformed
    // value then reaches the edge insert and is refused under "validFrom".
    expect(
      await issuePaths(
        // @ts-expect-error `at` is a string
        store.nodes.RiClip.reparent(clip.id, { whole, at: 5 }),
      ),
    ).toEqual(["options.at"]);

    const untouched = await store.edges.riClipOf.find({});
    expect(untouched.map((edge) => edge.toId)).toEqual([showA.id]);
  });

  it("does not copy the part node's validity window onto the realizing edge", async () => {
    const [store] = await createStoreWithSchema(
      buildGraph("composition_edge_window"),
      createTestBackend(),
    );
    const show = await store.nodes.RiShow.create({});
    const nodeFrom = "2020-01-01T00:00:00.000Z";
    const edgeFrom = "2021-01-01T00:00:00.000Z";
    await store.nodes.RiClip.create(
      {},
      {
        validFrom: nodeFrom,
        partOf: { whole: { kind: "RiShow", id: show.id }, validFrom: edgeFrom },
      },
    );
    const edges = await store.edges.riClipOf.find({});
    expect(edges).toHaveLength(1);
    expect(requireDefined(edges[0]).meta.validFrom).toBe(edgeFrom);
    const clips = await store.nodes.RiClip.find({});
    const clip = requireDefined(clips[0]);
    expect(clip.meta.validFrom).toBe(nodeFrom);
  });
});

/** Where the attachments are written, before the clock steps back to {@link STEPPED_BACK}. */
const ATTACHED_AT = "2026-03-01T00:00:10.000Z";
const STEPPED_BACK = "2026-03-01T00:00:05.000Z";

/**
 * A store with two shows and `clipCount` clips attached to the first, written
 * at {@link ATTACHED_AT}, with the fake clock then stepped back to
 * {@link STEPPED_BACK}: every incumbent attachment now starts later than the
 * clock reads. The caller restores real timers.
 */
async function storeAfterBackwardStep(graphId: string, clipCount: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(ATTACHED_AT));
  const [store] = await createStoreWithSchema(
    buildGraph(graphId),
    createTestBackend(),
  );
  const showA = await store.nodes.RiShow.create({});
  const showB = await store.nodes.RiShow.create({});
  const clips = [];
  for (let index = 0; index < clipCount; index += 1) {
    clips.push(
      await store.nodes.RiClip.create(
        {},
        { partOf: { whole: { kind: "RiShow", id: showA.id } } },
      ),
    );
  }
  vi.setSystemTime(new Date(STEPPED_BACK));
  return { store, showA, showB, clips };
}

describe("reparent across a backward clock step", () => {
  it("moves a oneActive part with no `at` at the incumbent's start, leaving a zero-width retired window", async () => {
    try {
      const { store, showA, showB, clips } = await storeAfterBackwardStep(
        "reparent_backward_step",
        1,
      );
      const clip = requireDefined(clips[0]);

      // MUTATION: make `resolveCompositionMoveInstant`
      // (src/store/operations/composition-create.ts) return the clock read for
      // a defaulted instant. The incumbent's window then ends before it
      // starts, and the move is refused with an inverted-window
      // ValidationError naming an edge the caller never mentioned.
      const moved = await store.nodes.RiClip.reparent(clip.id, {
        whole: { kind: "RiShow", id: showB.id },
      });
      expect(moved.moved).toBe(true);
      expect(moved.edge.meta.validFrom).toBe(ATTACHED_AT);

      const rows = await store.edges.riClipOf.find(
        {},
        { temporalMode: "includeEnded" },
      );
      const retired = requireDefined(
        rows.find((edge) => edge.toId === showA.id),
        "the retired attachment",
      );
      expect(retired.meta.validFrom).toBe(ATTACHED_AT);
      expect(retired.meta.validTo).toBe(ATTACHED_AT);

      // Once wall time reaches the move, the part holds exactly the new whole.
      vi.setSystemTime(new Date(ATTACHED_AT));
      const current = await store.edges.riClipOf.find({});
      expect(current.map((edge) => edge.toId)).toEqual([showB.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves every part of a bulkReparent with no `at` at its own incumbent's start", async () => {
    try {
      const { store, showA, showB, clips } = await storeAfterBackwardStep(
        "bulk_reparent_backward_step",
        2,
      );

      // MUTATION: as above — a clock-read move instant refuses the batch.
      const moved = await store.nodes.RiClip.bulkReparent(
        clips.map((clip) => ({
          id: clip.id,
          options: { whole: { kind: "RiShow", id: showB.id } },
        })),
      );
      expect(moved.map((result) => result.moved)).toEqual([true, true]);
      expect(moved.map((result) => result.edge.meta.validFrom)).toEqual([
        ATTACHED_AT,
        ATTACHED_AT,
      ]);

      const history = await store.edges.riClipOf.find(
        {},
        { temporalMode: "includeEnded" },
      );
      const retired = history.filter((edge) => edge.toId === showA.id);
      expect(retired.map((edge) => edge.meta.validTo)).toEqual([
        ATTACHED_AT,
        ATTACHED_AT,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a stated `at` earlier than the incumbent's start with COMPOSITION_MOVE_BEFORE_INCUMBENT, writing nothing", async () => {
    try {
      const { store, showA, showB, clips } = await storeAfterBackwardStep(
        "reparent_before_incumbent",
        2,
      );
      const [first, second] = clips.map((clip) => requireDefined(clip));
      const attachments = await store.edges.riClipOf.find(
        {},
        { temporalMode: "includeEnded" },
      );
      const incumbent = requireDefined(
        attachments.find((edge) => edge.fromId === requireDefined(first).id),
        "the first clip's attachment",
      );
      const whole = { kind: "RiShow", id: showB.id } as const;

      // MUTATION: make `resolveCompositionMoveInstant` return a stated `at`
      // unjudged. The window end then reaches the edge update, which refuses
      // it with an inverted-window ValidationError instead.
      const refusal = await store.nodes.RiClip.reparent(
        requireDefined(first).id,
        { whole, at: STEPPED_BACK },
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(CompositionError);
      expect(refusal).toMatchObject({
        code: "COMPOSITION_MOVE_BEFORE_INCUMBENT",
        details: {
          situation: "moveBeforeIncumbent",
          partKind: "RiClip",
          partId: requireDefined(first).id,
          wholeKind: "RiShow",
          wholeId: showB.id,
          incumbentEdgeKind: "riClipOf",
          incumbentEdgeId: incumbent.id,
          incumbentValidFrom: ATTACHED_AT,
          at: STEPPED_BACK,
        },
      });

      // A batch whose LAST item refuses moves none of them — not even the
      // first, a legal defaulted move — also when the refusal is caught
      // inside the caller's transaction and it commits.
      await store.transaction(async (tx) => {
        await expect(
          tx.nodes.RiClip.bulkReparent([
            { id: requireDefined(second).id, options: { whole } },
            {
              id: requireDefined(first).id,
              options: { whole, at: STEPPED_BACK },
            },
          ]),
        ).rejects.toMatchObject({ code: "COMPOSITION_MOVE_BEFORE_INCUMBENT" });
      });

      const rows = await store.edges.riClipOf.find(
        {},
        { temporalMode: "includeEnded" },
      );
      expect(rows).toHaveLength(2);
      expect(rows.map((edge) => edge.toId)).toEqual([showA.id, showA.id]);
      expect(rows.map((edge) => edge.meta.validTo)).toEqual([
        undefined,
        undefined,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves at a stated `at` equal to the incumbent's start, retiring a zero-width window", async () => {
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(ATTACHED_AT));
      const [store] = await createStoreWithSchema(
        buildGraph("reparent_at_incumbent_start"),
        createTestBackend(),
      );
      const showA = await store.nodes.RiShow.create({});
      const showB = await store.nodes.RiShow.create({});
      const clip = await store.nodes.RiClip.create(
        {},
        { partOf: { whole: { kind: "RiShow", id: showA.id } } },
      );

      // MUTATION: refuse when the stated `at` is NOT LATER than the
      // incumbent's start (`<=` instead of `<`) — this zero-width retire is
      // then refused.
      const moved = await store.nodes.RiClip.reparent(clip.id, {
        whole: { kind: "RiShow", id: showB.id },
        at: ATTACHED_AT,
      });
      expect(moved.edge.meta.validFrom).toBe(ATTACHED_AT);
      const history = await store.edges.riClipOf.find(
        {},
        { temporalMode: "includeEnded" },
      );
      const retired = requireDefined(
        history.find((edge) => edge.toId === showA.id),
        "the retired attachment",
      );
      expect(retired.meta.validTo).toBe(ATTACHED_AT);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a population-one move at its own instant: the deleted incumbent has no window to end", async () => {
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(ATTACHED_AT));
      const [store] = await createStoreWithSchema(
        buildGraph("reparent_one_backward_step"),
        createTestBackend(),
      );
      const showA = await store.nodes.RiShow.create({});
      const showB = await store.nodes.RiShow.create({});
      const showC = await store.nodes.RiShow.create({});
      const still = await store.nodes.RiStill.create(
        {},
        { partOf: { whole: { kind: "RiShow", id: showA.id } } },
      );
      vi.setSystemTime(new Date(STEPPED_BACK));

      // MUTATION: judge every incumbent, not only one whose window the move
      // ends — the defaulted move then starts at the deleted incumbent's
      // start, and the stated earlier `at` is refused.
      const defaulted = await store.nodes.RiStill.reparent(still.id, {
        whole: { kind: "RiShow", id: showB.id },
      });
      expect(defaulted.edge.meta.validFrom).toBe(STEPPED_BACK);

      const stated = "2026-03-01T00:00:01.000Z";
      const restated = await store.nodes.RiStill.reparent(still.id, {
        whole: { kind: "RiShow", id: showC.id },
        at: stated,
      });
      expect(restated.edge.meta.validFrom).toBe(stated);
      const rows = await store.edges.riStillOf.find(
        {},
        { temporalMode: "includeEnded" },
      );
      expect(rows.map((edge) => edge.toId)).toEqual([showC.id]);
    } finally {
      vi.useRealTimers();
    }
  });
});
