/**
 * The read-free half of the composition window decision
 * (`planCompositionWindowDecision`, src/store/claims/composition-windows.ts):
 * which frames it settles without reading a stored row, and which it must
 * read for. A `reparent` that splits its incumbent's window brings the part no
 * instant it did not already hold, so it costs no read; every attach, history
 * row, widened window and resurrection does. The verdicts the reads lead to
 * are covered on every backend by
 * `tests/backends/integration/composition-window-overlap.ts`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../src";
import { type InsertEdgeParams } from "../src/backend/types";
import { buildKindRegistry } from "../src/registry";
import {
  assertCompositionWindowsDisjoint,
  type CompositionWindowEdge,
  planCompositionWindowDecision,
  readCompositionWindowConflict,
} from "../src/store/claims/composition-windows";
import { uncapturedGraphWriteLock } from "../src/store/recorded-capture/clock";
import { createTestBackend } from "./test-utils";

const Reel = defineNode("Reel", { schema: z.object({}) });
const Cut = defineNode("Cut", { schema: z.object({}) });
const Slot = defineNode("Slot", { schema: z.object({}) });
const cutOf = defineEdge("cutOf", { schema: z.object({}) });
const slotOf = defineEdge("slotOf", { schema: z.object({}) });

const graph = defineGraph({
  id: "composition_window_decision",
  nodes: { Reel: { type: Reel }, Cut: { type: Cut }, Slot: { type: Slot } },
  edges: {
    cutOf: { type: cutOf, from: [Cut], to: [Reel], cardinality: "oneActive" },
    slotOf: { type: slotOf, from: [Slot], to: [Reel], cardinality: "one" },
  },
  ontology: [
    partOf(Cut, Reel, { via: cutOf }),
    partOf(Slot, Reel, { via: slotOf }),
  ],
});
const registry = buildKindRegistry(graph);

const NOW = "2024-06-01T00:00:00.000Z";
const Y2020 = "2020-01-01T00:00:00.000Z";
const Y2021 = "2021-01-01T00:00:00.000Z";
const Y2022 = "2022-01-01T00:00:00.000Z";

function insert(
  id: string,
  window: Pick<InsertEdgeParams, "validFrom" | "validTo">,
  kind: "cutOf" | "slotOf" = "cutOf",
): InsertEdgeParams {
  return {
    graphId: "g",
    id,
    kind,
    fromKind: kind === "cutOf" ? "Cut" : "Slot",
    fromId: "part",
    toKind: "Reel",
    toId: `reel-${id}`,
    props: {},
    ...window,
  };
}

function storedRow(
  id: string,
  window: Readonly<{ validFrom?: string; validTo?: string }>,
): CompositionWindowEdge {
  return {
    id,
    kind: "cutOf",
    from_kind: "Cut",
    from_id: "part",
    to_kind: "Reel",
    to_id: `reel-${id}`,
    valid_from: window.validFrom,
    valid_to: window.validTo,
    deleted_at: undefined,
  };
}

function partsToRead(
  plan: ReturnType<typeof planCompositionWindowDecision>,
): readonly string[] {
  return plan.partsToRead.map((part) => `${part.kind}:${part.id}`);
}

describe("composition window decision: what it settles without a read", () => {
  it("reads for an ordinary attach, whose stamped start may fall inside a stored row written on a later clock, and not for a zero-width row", () => {
    // The stamped attach's read is load-bearing: see the integration case
    // "refuses an ordinary attach stamped at a clock behind a history row's
    // end" (tests/backends/integration/composition-window-overlap.ts).
    const plan = planCompositionWindowDecision(
      registry,
      { inserts: [insert("attach", {})] },
      NOW,
    );
    expect(plan.inFrameConflict).toBeUndefined();
    expect(partsToRead(plan)).toEqual(["Cut:part"]);
    expect(
      partsToRead(
        planCompositionWindowDecision(
          registry,
          { inserts: [insert("empty", { validFrom: Y2021, validTo: Y2021 })] },
          NOW,
        ),
      ),
    ).toEqual([]);
  });

  it("reads nothing for a reparent that ends its incumbent where the new attachment starts", () => {
    // MUTATION CHECK: ignore `heldWindows` in `planCompositionWindowDecision`
    // — a backdated reparent with an incumbent then reads.
    const incumbent = storedRow("incumbent", { validFrom: Y2020 });
    const plan = planCompositionWindowDecision(
      registry,
      {
        revisions: [
          { before: incumbent, after: { ...incumbent, valid_to: Y2021 } },
        ],
        inserts: [insert("moved", { validFrom: Y2021 })],
      },
      NOW,
    );
    expect(plan.inFrameConflict).toBeUndefined();
    expect(partsToRead(plan)).toEqual([]);
  });

  it("reads nothing for a write that shrinks a window, and for population `one`", () => {
    const row = storedRow("ended", { validFrom: Y2020, validTo: Y2022 });
    expect(
      partsToRead(
        planCompositionWindowDecision(
          registry,
          { revisions: [{ before: row, after: { ...row, valid_to: Y2021 } }] },
          NOW,
        ),
      ),
    ).toEqual([]);
    expect(
      partsToRead(
        planCompositionWindowDecision(
          registry,
          { inserts: [insert("slot", { validFrom: Y2020 }, "slotOf")] },
          NOW,
        ),
      ),
    ).toEqual([]);
  });

  it("reads the part for a backdated attach, a history row, a widened window and a resurrection", () => {
    const ended = storedRow("ended", { validFrom: Y2020, validTo: Y2021 });
    const frames = [
      { inserts: [insert("backdated", { validFrom: Y2020 })] },
      { inserts: [insert("history", { validFrom: Y2020, validTo: Y2021 })] },
      { inserts: [insert("born-ended", { validTo: Y2021 })] },
      {
        revisions: [{ before: ended, after: { ...ended, valid_to: Y2022 } }],
      },
      {
        revisions: [
          {
            before: { ...ended, deleted_at: Y2022 },
            after: ended,
          },
        ],
      },
    ];
    for (const frame of frames) {
      expect(
        partsToRead(planCompositionWindowDecision(registry, frame, NOW)),
      ).toEqual(["Cut:part"]);
    }
  });

  it("refuses two of the frame's own rows that overlap before any read, and folds a row's writes into its last state", () => {
    const overlapping = planCompositionWindowDecision(
      registry,
      {
        inserts: [
          insert("first", { validFrom: Y2020, validTo: Y2022 }),
          insert("second", { validFrom: Y2021, validTo: Y2022 }),
        ],
      },
      NOW,
    );
    expect(overlapping.inFrameConflict).toMatchObject({
      proposed: { id: "second" },
      incumbent: { id: "first" },
    });

    // An insert the same frame then ends is one row, judged once.
    const inserted = insert("inserted", { validFrom: Y2020, validTo: Y2022 });
    const folded = planCompositionWindowDecision(
      registry,
      {
        inserts: [inserted],
        revisions: [
          {
            before: storedRow("inserted", {
              validFrom: Y2020,
              validTo: Y2022,
            }),
            after: storedRow("inserted", { validFrom: Y2020, validTo: Y2021 }),
          },
        ],
      },
      NOW,
    );
    expect(folded.inFrameConflict).toBeUndefined();
    expect(partsToRead(folded)).toEqual(["Cut:part"]);
  });
});

describe("composition window decision: the unfenced preview", () => {
  it("names the stored edge a planned write would overlap, and writes nothing", async () => {
    // MUTATION CHECK: drop the stored-row loop from
    // `findCompositionWindowConflict` — the preview then answers `undefined`
    // for a planned row the write path would refuse.
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);
    const since = { validFrom: "2018-01-01T00:00:00.000Z" };
    const reel = await store.nodes.Reel.create({}, since);
    const otherReel = await store.nodes.Reel.create({}, since);
    const cut = await store.nodes.Cut.create({}, since);
    const history = await store.edges.cutOf.create(
      cut,
      reel,
      {},
      {
        validFrom: Y2020,
        validTo: Y2022,
      },
    );
    const planned = (validFrom: string): InsertEdgeParams => ({
      graphId: store.graphId,
      id: "planned",
      kind: "cutOf",
      fromKind: "Cut",
      fromId: cut.id,
      toKind: "Reel",
      toId: otherReel.id,
      props: {},
      validFrom,
    });

    const conflict = await readCompositionWindowConflict(
      registry,
      backend,
      store.graphId,
      { inserts: [planned(Y2021)] },
    );
    expect(conflict).toMatchObject({
      part: { kind: "Cut", id: cut.id },
      proposed: { id: "planned", valid_from: Y2021 },
      incumbent: { id: history.id, valid_from: Y2020, valid_to: Y2022 },
    });
    expect(
      await readCompositionWindowConflict(registry, backend, store.graphId, {
        inserts: [planned(Y2022)],
      }),
    ).toBeUndefined();
    expect(
      await store.edges.cutOf.find({}, { temporalMode: "includeEnded" }),
    ).toHaveLength(1);
  });
});

describe("composition window decision: a verdict is consumed only for the writes it decided", () => {
  // MUTATION CHECK: make `verdictCoversWrites` answer `true` whenever a
  // verdict is passed — the different and re-windowed writes below are then
  // admitted with no decision at all, overlap included.
  it("returns the verdict for exactly its own writes and decides every other write itself", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);
    const since = { validFrom: "2018-01-01T00:00:00.000Z" };
    const reel = await store.nodes.Reel.create({}, since);
    const otherReel = await store.nodes.Reel.create({}, since);
    const cut = await store.nodes.Cut.create({}, since);
    await store.edges.cutOf.create(
      cut,
      reel,
      {},
      {
        validFrom: Y2020,
        validTo: Y2022,
      },
    );
    const ctx = {
      graphId: store.graphId,
      registry,
      lock: uncapturedGraphWriteLock(),
    };
    const planned = (
      validFrom: string,
      validTo: string,
      id = "planned",
    ): InsertEdgeParams => ({
      graphId: store.graphId,
      id,
      kind: "cutOf",
      fromKind: "Cut",
      fromId: cut.id,
      toKind: "Reel",
      toId: otherReel.id,
      props: {},
      validFrom,
      validTo,
    });
    const legal = { inserts: [planned(Y2022, "2023-01-01T00:00:00.000Z")] };

    const verdict = await assertCompositionWindowsDisjoint(ctx, backend, legal);
    // The same writes on the same graph and transaction: the decision stands.
    await expect(
      assertCompositionWindowsDisjoint(ctx, backend, legal, verdict),
    ).resolves.toBe(verdict);

    // The same row stating another window, and another row: each decided
    // anew, and refused for the overlap the verdict never judged.
    for (const write of [
      planned(Y2021, "2023-01-01T00:00:00.000Z"),
      planned(Y2021, "2023-01-01T00:00:00.000Z", "another"),
    ]) {
      await expect(
        assertCompositionWindowsDisjoint(
          ctx,
          backend,
          { inserts: [write] },
          verdict,
        ),
      ).rejects.toMatchObject({ code: "COMPOSITION_WINDOW_OVERLAP" });
    }

    // Another graph: decided again there, under its own verdict.
    await expect(
      assertCompositionWindowsDisjoint(
        { ...ctx, graphId: "another_graph" },
        backend,
        legal,
        verdict,
      ),
    ).resolves.not.toBe(verdict);
  });
});
