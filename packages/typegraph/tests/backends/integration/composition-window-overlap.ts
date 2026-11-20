/**
 * One whole per part at EVERY valid-time coordinate: on a
 * `population: "oneActive"` pair, the windows of one part's composition edges
 * never overlap, so no `store.asOf(t)` read shows the part with two wholes.
 *
 * Fixture:
 *
 *   CwFigure --(cwFigureIn,      oneActive)--> CwSection | CwDocument
 *   CwFigure --(cwFigureInsetOf, oneActive)--> CwDocument   (a second realizing kind)
 *   CwPara   --(cwParaOf,        oneActive, REQUIRED)--> CwSection
 *   CwSection --(cwSectionOf,    one)--> CwDocument
 *
 * Every node is valid from 2018, so the node filter never hides a part or a
 * whole from the valid-time reads below; only the edges' windows decide.
 *
 * MUTATION CHECK (every refusal below): make `assertCompositionWindowsDisjoint`
 * (src/store/claims/composition-windows.ts) return before its plan — each
 * refused write then lands, and the asOf read it guards shows two wholes.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  CompositionError,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  partOf,
} from "../../../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../../../src/backend/derive-backend";
import { type IntegrationTestContext } from "./test-context";

const CwDocument = defineNode("CwDocument", { schema: z.object({}) });
const CwSection = defineNode("CwSection", { schema: z.object({}) });
const CwFigure = defineNode("CwFigure", {
  schema: z.object({ caption: z.string() }),
});
const CwPara = defineNode("CwPara", { schema: z.object({}) });
const CwNote = defineNode("CwNote", { schema: z.object({}) });

const cwFigureIn = defineEdge("cwFigureIn", { schema: z.object({}) });
const cwFigureInsetOf = defineEdge("cwFigureInsetOf", { schema: z.object({}) });
const cwParaOf = defineEdge("cwParaOf", { schema: z.object({}) });
const cwSectionOf = defineEdge("cwSectionOf", { schema: z.object({}) });
const cwNoteOf = defineEdge("cwNoteOf", {
  schema: z.object({ tag: z.string() }),
});

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      CwDocument: { type: CwDocument },
      CwSection: { type: CwSection },
      CwFigure: {
        type: CwFigure,
        unique: [
          {
            name: "cw_figure_caption",
            fields: ["caption"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      CwPara: { type: CwPara },
      CwNote: { type: CwNote },
    },
    edges: {
      cwFigureIn: {
        type: cwFigureIn,
        from: [CwFigure],
        to: [CwSection, CwDocument],
        cardinality: "oneActive",
      },
      cwFigureInsetOf: {
        type: cwFigureInsetOf,
        from: [CwFigure],
        to: [CwDocument],
        cardinality: "oneActive",
      },
      cwParaOf: {
        type: cwParaOf,
        from: [CwPara],
        to: [CwSection],
        cardinality: "oneActive",
      },
      cwSectionOf: {
        type: cwSectionOf,
        from: [CwSection],
        to: [CwDocument],
        cardinality: "one",
      },
      // A durable match identity: every batch create of this kind runs the
      // row-by-row durable fallback.
      cwNoteOf: {
        type: cwNoteOf,
        from: [CwNote],
        to: [CwDocument],
        cardinality: "oneActive",
        matchIdentity: { name: "cw-note-tag", fields: ["tag"] },
      },
    },
    ontology: [
      partOf(CwFigure, CwSection, { via: cwFigureIn }),
      partOf(CwFigure, CwDocument, { via: cwFigureIn }),
      partOf(CwFigure, CwDocument, { via: cwFigureInsetOf }),
      partOf(CwPara, CwSection, { via: cwParaOf, existence: "required" }),
      partOf(CwSection, CwDocument, { via: cwSectionOf }),
      partOf(CwNote, CwDocument, { via: cwNoteOf }),
    ],
  });
}

const NODE_SINCE = "2018-01-01T00:00:00.000Z";
const Y2019 = "2019-01-01T00:00:00.000Z";
const Y2020 = "2020-01-01T00:00:00.000Z";
const Y2021 = "2021-01-01T00:00:00.000Z";
const Y2022 = "2022-01-01T00:00:00.000Z";
const Y2023 = "2023-01-01T00:00:00.000Z";

function midYear(year: number): string {
  return `${String(year)}-07-01T00:00:00.000Z`;
}

const OVERLAP_CODE = "COMPOSITION_WINDOW_OVERLAP";

async function refusal(write: Promise<unknown>): Promise<CompositionError> {
  const error = await write.then(
    () => {
      throw new Error("expected the write to be refused");
    },
    (error_: unknown) => error_,
  );
  expect(error).toBeInstanceOf(CompositionError);
  const composition = error as CompositionError;
  expect(composition.code).toBe(OVERLAP_CODE);
  return composition;
}

/**
 * `backend` with `insertEdgesDurableBatchReturning` withheld, on the backend
 * and on every transaction it opens — a custom port that declares durable
 * edge match identity but implements only the single-row command.
 */
function withoutDurableEdgeBatch(backend: GraphBackend): GraphBackend {
  const withheld = ["insertEdgesDurableBatchReturning"] as const;
  return deriveBackend(projectBackendWithout(backend, withheld), {
    transaction: (fn, options) =>
      backend.transaction(
        (tx) => fn(projectBackendWithout(tx, withheld)),
        options,
      ),
  });
}

export function registerCompositionWindowOverlapIntegrationTests(
  context: IntegrationTestContext,
): void {
  let graphCounter = 0;
  const nextGraphId = (): string => {
    graphCounter += 1;
    return `composition_window_overlap_${String(graphCounter)}`;
  };

  async function setup() {
    const store = await context.createStore(buildGraph(nextGraphId()));
    const since = { validFrom: NODE_SINCE };
    const paper = await store.nodes.CwDocument.create({}, since);
    const sec = await store.nodes.CwSection.create({}, since);
    const sec2 = await store.nodes.CwSection.create({}, since);
    const fig = await store.nodes.CwFigure.create({ caption: "f" }, since);
    return { store, paper, sec, sec2, fig };
  }

  type Setup = Awaited<ReturnType<typeof setup>>;

  /** The wholes a valid-time read shows the part with, as `kind:id`. */
  async function wholesAt(
    store: Setup["store"],
    partKind: "CwFigure" | "CwPara",
    partId: string,
    at: string,
  ): Promise<readonly string[]> {
    const rows = await store
      .asOf(at)
      .query()
      .from(partKind, "part")
      .whereNode("part", (node) => node.id.eq(partId))
      .wholes("whole", { maxHops: 1 })
      .select((ctx) => `${ctx.whole.kind}:${ctx.whole.id}`)
      .execute();
    return rows.toSorted();
  }

  async function figureRows(store: Setup["store"]) {
    const rows = [
      ...(await store.edges.cwFigureIn.find(
        {},
        { temporalMode: "includeEnded" },
      )),
      ...(await store.edges.cwFigureInsetOf.find(
        {},
        { temporalMode: "includeEnded" },
      )),
    ];
    return rows
      .map(
        (edge) =>
          `${edge.kind}:${edge.toId} [${edge.meta.validFrom ?? "-"},${edge.meta.validTo ?? "-"})`,
      )
      .toSorted();
  }

  describe("Composition valid-time windows (one whole per part at every instant)", () => {
    it("refuses a history row overlapping the part's open membership, naming the incumbent", async () => {
      const { store, paper, sec, fig } = await setup();
      const open = await store.edges.cwFigureIn.create(
        fig,
        sec,
        {},
        {
          validFrom: Y2020,
        },
      );

      const error = await refusal(
        store.edges.cwFigureIn.create(
          fig,
          paper,
          {},
          {
            validFrom: Y2019,
            validTo: Y2021,
          },
        ),
      );
      expect(error.details).toMatchObject({
        situation: "windowOverlap",
        partKind: "CwFigure",
        partId: fig.id,
        wholeKind: "CwDocument",
        wholeId: paper.id,
        edgeKind: "cwFigureIn",
        validFrom: Y2019,
        validTo: Y2021,
        incumbentEdgeKind: "cwFigureIn",
        incumbentEdgeId: open.id,
        incumbentWholeKind: "CwSection",
        incumbentWholeId: sec.id,
        incumbentValidFrom: Y2020,
      });
      expect(error.details).not.toHaveProperty("incumbentValidTo");
      expect(await wholesAt(store, "CwFigure", fig.id, midYear(2020))).toEqual([
        `CwSection:${sec.id}`,
      ]);

      // A history row that ENDS where the membership begins shares no
      // instant with it: windows are half-open.
      await store.edges.cwFigureIn.create(
        fig,
        paper,
        {},
        {
          validFrom: Y2019,
          validTo: Y2020,
        },
      );
      expect(await wholesAt(store, "CwFigure", fig.id, midYear(2019))).toEqual([
        `CwDocument:${paper.id}`,
      ]);
      expect(await wholesAt(store, "CwFigure", fig.id, Y2020)).toEqual([
        `CwSection:${sec.id}`,
      ]);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("refuses a row born ended with no lower bound, which reads at every instant before its end", async () => {
      const { store, paper, sec, fig } = await setup();
      await store.edges.cwFigureIn.create(fig, sec, {}, { validFrom: Y2020 });

      await refusal(
        store.edges.cwFigureIn.create(fig, paper, {}, { validTo: Y2021 }),
      );
      expect(await figureRows(store)).toEqual(
        [`cwFigureIn:${sec.id} [${Y2020},-)`].toSorted(),
      );
    });

    it("judges every realizing edge kind that holds the part, not one edge kind", async () => {
      const { store, paper, sec, fig } = await setup();
      await store.edges.cwFigureIn.create(fig, sec, {}, { validFrom: Y2020 });

      const error = await refusal(
        store.edges.cwFigureInsetOf.create(
          fig,
          paper,
          {},
          {
            validFrom: Y2019,
            validTo: Y2021,
          },
        ),
      );
      expect(error.details).toMatchObject({
        edgeKind: "cwFigureInsetOf",
        incumbentEdgeKind: "cwFigureIn",
      });
    });

    it("refuses overlapping history of a required part", async () => {
      const { store, sec, sec2 } = await setup();
      const para = await store.nodes.CwPara.create(
        {},
        { validFrom: NODE_SINCE, partOf: { whole: sec, validFrom: Y2020 } },
      );

      await refusal(
        store.edges.cwParaOf.create(
          para,
          sec2,
          {},
          {
            validFrom: Y2019,
            validTo: Y2023,
          },
        ),
      );
      expect(await wholesAt(store, "CwPara", para.id, midYear(2021))).toEqual([
        `CwSection:${sec.id}`,
      ]);
    });

    it("refuses two overlapping rows of one batch before either is written, on every batch surface", async () => {
      const { store, paper, sec, fig } = await setup();
      const items = [
        { from: fig, to: paper, props: {}, validFrom: Y2020, validTo: Y2022 },
        { from: fig, to: sec, props: {}, validFrom: Y2021, validTo: Y2023 },
      ] as const;

      await refusal(store.edges.cwFigureIn.bulkInsert(items));
      await refusal(store.edges.cwFigureIn.bulkCreate(items));
      await refusal(
        store.edges.cwFigureIn.bulkUpsertById(
          items.map((item, index) => ({
            ...item,
            id: asEdgeId<typeof cwFigureIn>(`cw-batch-${index}`),
          })),
        ),
      );
      expect(await figureRows(store)).toEqual([]);

      // The same two rows made to abut are one whole per instant.
      await store.edges.cwFigureIn.bulkInsert([
        { from: fig, to: paper, props: {}, validFrom: Y2020, validTo: Y2021 },
        { from: fig, to: sec, props: {}, validFrom: Y2021, validTo: Y2023 },
      ]);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("refuses a backdated reparent onto a part's history when it holds no current whole", async () => {
      const { store, paper, sec, fig } = await setup();
      await store.edges.cwFigureIn.create(
        fig,
        paper,
        {},
        {
          validFrom: Y2020,
          validTo: Y2022,
        },
      );

      await refusal(
        store.nodes.CwFigure.reparent(fig.id, { whole: sec, at: Y2021 }),
      );
      await refusal(
        store.nodes.CwFigure.bulkReparent([
          { id: fig.id, options: { whole: sec, at: Y2021 } },
        ]),
      );
      await refusal(
        store.edges.cwFigureIn.create(fig, sec, {}, { validFrom: Y2021 }),
      );
      expect(await wholesAt(store, "CwFigure", fig.id, midYear(2021))).toEqual([
        `CwDocument:${paper.id}`,
      ]);

      // Moving in where the history ends leaves one whole at every instant.
      await store.nodes.CwFigure.reparent(fig.id, { whole: sec, at: Y2022 });
      expect(await wholesAt(store, "CwFigure", fig.id, midYear(2021))).toEqual([
        `CwDocument:${paper.id}`,
      ]);
      expect(await wholesAt(store, "CwFigure", fig.id, midYear(2022))).toEqual([
        `CwSection:${sec.id}`,
      ]);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("accepts a backdated reparent that splits the incumbent's window, and an ordinary attach and move", async () => {
      const { store, paper, sec, sec2, fig } = await setup();
      await store.edges.cwFigureIn.create(
        fig,
        paper,
        {},
        {
          validFrom: Y2019,
          validTo: Y2020,
        },
      );
      await store.edges.cwFigureIn.create(fig, sec, {}, { validFrom: Y2020 });

      await store.nodes.CwFigure.reparent(fig.id, { whole: sec2, at: Y2021 });
      await store.nodes.CwFigure.reparent(fig.id, {
        whole: paper,
        via: cwFigureIn,
      });
      expect(await wholesAt(store, "CwFigure", fig.id, midYear(2019))).toEqual([
        `CwDocument:${paper.id}`,
      ]);
      expect(await wholesAt(store, "CwFigure", fig.id, midYear(2020))).toEqual([
        `CwSection:${sec.id}`,
      ]);
      expect(await wholesAt(store, "CwFigure", fig.id, midYear(2021))).toEqual([
        `CwSection:${sec2.id}`,
      ]);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("refuses a getOrCreateByConstraint attachment backdated over the part's history", async () => {
      const { store, paper, sec, fig } = await setup();
      await store.edges.cwFigureIn.create(
        fig,
        paper,
        {},
        {
          validFrom: Y2020,
          validTo: Y2022,
        },
      );

      await refusal(
        store.nodes.CwFigure.getOrCreateByConstraint(
          "cw_figure_caption",
          { caption: "f" },
          { partOf: { whole: sec, validFrom: Y2021 } },
        ),
      );
      const attached = await store.nodes.CwFigure.getOrCreateByConstraint(
        "cw_figure_caption",
        { caption: "f" },
        { partOf: { whole: sec, validFrom: Y2022 } },
      );
      expect(attached.node.id).toBe(fig.id);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("refuses an edge update that widens an ended window over another, on every update surface", async () => {
      const { store, paper, sec, fig } = await setup();
      const early = await store.edges.cwFigureIn.create(
        fig,
        paper,
        {},
        {
          validFrom: Y2019,
          validTo: Y2020,
        },
      );
      await store.edges.cwFigureIn.create(
        fig,
        sec,
        {},
        {
          validFrom: Y2021,
          validTo: Y2022,
        },
      );

      await refusal(
        store.edges.cwFigureIn.update(
          early.id,
          {},
          {
            validTo: midYear(2021),
          },
        ),
      );
      await refusal(
        store.edges.cwFigureIn.update(early.id, {}, { clearValidTo: true }),
      );
      await refusal(
        store.edges.cwFigureIn.bulkUpsertById([
          {
            id: early.id,
            from: fig,
            to: paper,
            props: {},
            validTo: midYear(2021),
          },
        ]),
      );
      await refusal(
        store.edges.cwFigureIn.getOrCreateByEndpoints(
          fig,
          paper,
          {},
          {
            ifExists: "update",
            validTo: midYear(2021),
          },
        ),
      );
      expect(await figureRows(store)).toEqual(
        [
          `cwFigureIn:${paper.id} [${Y2019},${Y2020})`,
          `cwFigureIn:${sec.id} [${Y2021},${Y2022})`,
        ].toSorted(),
      );

      // Widening up to the next window's start is still one whole per instant.
      await store.edges.cwFigureIn.update(early.id, {}, { validTo: Y2021 });
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("judges an update set as the state it leaves: shrink one row and add the next in one batch", async () => {
      const { store, paper, sec, fig } = await setup();
      const long = await store.edges.cwFigureIn.create(
        fig,
        paper,
        {},
        {
          validFrom: Y2019,
          validTo: Y2023,
        },
      );

      await refusal(
        store.edges.cwFigureIn.bulkUpsertById([
          {
            id: asEdgeId<typeof cwFigureIn>("cw-next"),
            from: fig,
            to: sec,
            props: {},
            validFrom: Y2021,
            validTo: Y2022,
          },
        ]),
      );
      await store.edges.cwFigureIn.bulkUpsertById([
        { id: long.id, from: fig, to: paper, props: {}, validTo: Y2020 },
        {
          id: asEdgeId<typeof cwFigureIn>("cw-next"),
          from: fig,
          to: sec,
          props: {},
          validFrom: Y2021,
          validTo: Y2022,
        },
      ]);
      expect(await figureRows(store)).toEqual(
        [
          `cwFigureIn:${paper.id} [${Y2019},${Y2020})`,
          `cwFigureIn:${sec.id} [${Y2021},${Y2022})`,
        ].toSorted(),
      );
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("refuses resurrecting a deleted row whose window another row now holds", async () => {
      const { store, paper, sec, fig } = await setup();
      const former = await store.edges.cwFigureIn.create(
        fig,
        paper,
        {},
        {
          validFrom: Y2020,
          validTo: Y2022,
        },
      );
      await store.edges.cwFigureIn.delete(former.id);
      // A deleted row reads at no coordinate, so its window is free.
      await store.edges.cwFigureIn.create(
        fig,
        sec,
        {},
        {
          validFrom: Y2021,
          validTo: Y2023,
        },
      );

      await refusal(
        store.edges.cwFigureIn.bulkUpsertById([
          { id: former.id, from: fig, to: paper, props: {} },
        ]),
      );
      await refusal(
        store.edges.cwFigureIn.getOrCreateByEndpoints(fig, paper, {}),
      );
      expect(await wholesAt(store, "CwFigure", fig.id, midYear(2021))).toEqual([
        `CwSection:${sec.id}`,
      ]);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    // MUTATION CHECK: restore the stamped-attach fast path in
    // `planCompositionWindowDecision` (skip the read when every uncovered
    // write opens at or after the operation instant) — the attach below,
    // stamped at a clock that stepped back behind the history row's end, is
    // then admitted and the part reads under two wholes in the gap.
    it("refuses an ordinary attach stamped at a clock behind a history row's end", async () => {
      const { store, paper, sec, fig } = await setup();
      const historyEnd = new Date(Date.now() - 1000).toISOString();
      await store.edges.cwFigureIn.create(
        fig,
        paper,
        {},
        {
          validFrom: Y2019,
          validTo: historyEnd,
        },
      );
      // Another writer's clock, or this one after a step back, runs behind
      // the end that row was written with.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.parse(historyEnd) - 60_000);
        await refusal(store.edges.cwFigureIn.create(fig, sec, {}));
        await refusal(store.nodes.CwFigure.reparent(fig.id, { whole: sec }));
      } finally {
        vi.useRealTimers();
      }
      expect(await figureRows(store)).toEqual([
        `cwFigureIn:${paper.id} [${Y2019},${historyEnd})`,
      ]);

      // On a clock at or past that end the same attach is one whole per
      // instant.
      await store.edges.cwFigureIn.create(fig, sec, {});
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("lets a zero-width window through: it occupies no instant", async () => {
      const { store, paper, sec, fig } = await setup();
      await store.edges.cwFigureIn.create(fig, sec, {}, { validFrom: Y2020 });
      await store.edges.cwFigureIn.create(
        fig,
        paper,
        {},
        {
          validFrom: Y2021,
          validTo: Y2021,
        },
      );
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("leaves population `one` to its claim: a second row is refused as a second whole", async () => {
      const { store, paper, sec } = await setup();
      const otherPaper = await store.nodes.CwDocument.create(
        {},
        { validFrom: NODE_SINCE },
      );
      await store.edges.cwSectionOf.create(
        sec,
        paper,
        {},
        {
          validFrom: Y2019,
          validTo: Y2020,
        },
      );

      await expect(
        store.edges.cwSectionOf.create(
          sec,
          otherPaper,
          {},
          {
            validFrom: Y2021,
            validTo: Y2022,
          },
        ),
      ).rejects.toMatchObject({ code: "COMPOSITION_WHOLE_OCCUPIED" });
    });

    // MUTATION CHECK (both bulkGetOrCreateByEndpoints cases): have each
    // update leg decide its window again instead of consuming the batch's
    // `CompositionWindowVerdict` (drop `decidedCompositionWindows` from the leg
    // options in `executeEdgeBulkGetOrCreateByEndpoints`,
    // src/store/operations/edge-operations.ts) — the resurrection, written
    // first, is then judged against the row the later leg shrinks, and the
    // legal batch is refused.
    for (const creates of [false, true]) {
      it(`bulkGetOrCreateByEndpoints on a coalescing store judges its update legs as the state the batch leaves${creates ? " (with a create)" : ""}`, async () => {
        const store = await context.createStore(buildGraph(nextGraphId()), {
          coalesceUnchangedUpserts: true,
        });
        const since = { validFrom: NODE_SINCE };
        const paper = await store.nodes.CwDocument.create({}, since);
        const laterPaper = await store.nodes.CwDocument.create({}, since);
        const sec = await store.nodes.CwSection.create({}, since);
        const fig = await store.nodes.CwFigure.create({ caption: "f" }, since);
        await store.edges.cwFigureIn.create(
          fig,
          paper,
          {},
          {
            validFrom: Y2019,
            validTo: Y2023,
          },
        );
        const retired = await store.edges.cwFigureIn.create(
          fig,
          sec,
          {},
          {
            validFrom: NODE_SINCE,
            validTo: Y2019,
          },
        );
        await store.edges.cwFigureIn.delete(retired.id);
        const created =
          creates ?
            [
              {
                from: fig,
                to: laterPaper,
                props: {},
                validFrom: Y2023,
                validTo: "2024-01-01T00:00:00.000Z",
              },
            ]
          : [];
        // The section row comes back with a window the paper row covers as
        // stored, but not as the batch's later item leaves it.
        const batch = (paperEnd: string) =>
          store.edges.cwFigureIn.bulkGetOrCreateByEndpoints(
            [
              {
                from: fig,
                to: sec,
                props: {},
                validFrom: Y2021,
                validTo: Y2022,
              },
              { from: fig, to: paper, props: {}, validTo: paperEnd },
              ...created,
            ],
            { ifExists: "update" },
          );
        const before = [`cwFigureIn:${paper.id} [${Y2019},${Y2023})`];

        // Genuinely overlapping: the paper row still reaches into the
        // section row's window. Refused, and nothing is written.
        const overlapping = await refusal(batch(midYear(2021)));
        expect(overlapping.details).toMatchObject({
          situation: "windowOverlap",
        });
        expect(await figureRows(store)).toEqual(before);

        const results = await batch(Y2020);
        expect(results.map((result) => result.action)).toEqual([
          "resurrected",
          "updated",
          ...(creates ? ["created"] : []),
        ]);
        expect(await figureRows(store)).toEqual(
          [
            `cwFigureIn:${paper.id} [${Y2019},${Y2020})`,
            `cwFigureIn:${sec.id} [${Y2021},${Y2022})`,
            ...(creates ?
              [
                `cwFigureIn:${laterPaper.id} [${Y2023},2024-01-01T00:00:00.000Z)`,
              ]
            : []),
          ].toSorted(),
        );
        expect(await store.verifyConstraintFences()).toEqual([]);
      });
    }

    // MUTATION CHECK: have the durable fallback's row-by-row creates decide
    // their windows again instead of consuming the batch's verdict (drop
    // `decidedCompositionWindows` from the `executeEdgeCreateInternal` options
    // in `executeEdgeCreateBatch`, src/store/operations/edge-operations.ts) —
    // the new row is then judged against the stored row the paired update has
    // not shrunk yet, and the legal batch is refused.
    it("bulkUpsertById through the row-by-row durable fallback judges its creates as the state the batch leaves", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const since = { validFrom: NODE_SINCE };
      const paper = await store.nodes.CwDocument.create({}, since);
      const laterPaper = await store.nodes.CwDocument.create({}, since);
      const note = await store.nodes.CwNote.create({}, since);
      const long = await store.edges.cwNoteOf.create(
        note,
        paper,
        { tag: "first" },
        { validFrom: Y2019, validTo: Y2023 },
      );
      // A backend that declares durable match identity but has no batch
      // member for it, so every durable batch create runs the row-by-row
      // fallback — in a transaction too.
      const fallbackStore = createStore(
        store.graph,
        withoutDurableEdgeBatch(context.getBackend()),
      );
      const noteRows = async () => {
        const edges = await store.edges.cwNoteOf.find(
          {},
          { temporalMode: "includeEnded" },
        );
        return edges
          .map(
            (edge) =>
              `${edge.toId} [${edge.meta.validFrom ?? "-"},${edge.meta.validTo ?? "-"})`,
          )
          .toSorted();
      };
      const batch = (longEnd: string) =>
        fallbackStore.edges.cwNoteOf.bulkUpsertById([
          {
            id: long.id,
            from: note,
            to: paper,
            props: { tag: "first" },
            validTo: longEnd,
          },
          {
            id: asEdgeId<typeof cwNoteOf>("cw-note-next"),
            from: note,
            to: laterPaper,
            props: { tag: "second" },
            validFrom: Y2021,
            validTo: Y2022,
          },
        ]);

      // Genuinely overlapping: refused, and neither write lands.
      await refusal(batch(midYear(2021)));
      expect(await noteRows()).toEqual([`${paper.id} [${Y2019},${Y2023})`]);

      await batch(Y2020);
      expect(await noteRows()).toEqual(
        [
          `${paper.id} [${Y2019},${Y2020})`,
          `${laterPaper.id} [${Y2021},${Y2022})`,
        ].toSorted(),
      );
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("verifyConstraintFences reports a part whose stored windows overlap", async () => {
      const { store, paper, sec, fig } = await setup();
      const kept = await store.edges.cwFigureIn.create(
        fig,
        sec,
        {},
        {
          validFrom: Y2020,
          validTo: Y2022,
        },
      );
      // Beneath the store: no write path would accept this row.
      await store.backend.insertEdge({
        graphId: store.graphId,
        id: "cw-planted-overlap",
        kind: "cwFigureInsetOf",
        fromKind: "CwFigure",
        fromId: fig.id,
        toKind: "CwDocument",
        toId: paper.id,
        props: {},
        validFrom: Y2021,
        validTo: Y2023,
      });

      expect(await store.verifyConstraintFences()).toEqual([
        {
          family: "compositionWindowOverlap",
          partKind: "CwFigure",
          partId: fig.id,
          edgeIds: [kept.id, "cw-planted-overlap"].toSorted(),
        },
      ]);
      expect(
        await wholesAt(store, "CwFigure", fig.id, midYear(2021)),
      ).toHaveLength(2);
    });
    // MUTATION CHECK: drop the `compositionWindowOverlap` read from
    // `verifyConstraintFences` (src/store/claims/verify.ts) — the audit then
    // reports a clean graph while the asOf read shows two wholes.
  });
}
