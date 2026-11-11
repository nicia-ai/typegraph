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
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  CompositionError,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../../../src";
import { type IntegrationTestContext } from "./test-context";

const CwDocument = defineNode("CwDocument", { schema: z.object({}) });
const CwSection = defineNode("CwSection", { schema: z.object({}) });
const CwFigure = defineNode("CwFigure", {
  schema: z.object({ caption: z.string() }),
});
const CwPara = defineNode("CwPara", { schema: z.object({}) });

const cwFigureIn = defineEdge("cwFigureIn", { schema: z.object({}) });
const cwFigureInsetOf = defineEdge("cwFigureInsetOf", { schema: z.object({}) });
const cwParaOf = defineEdge("cwParaOf", { schema: z.object({}) });
const cwSectionOf = defineEdge("cwSectionOf", { schema: z.object({}) });

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
    },
    ontology: [
      partOf(CwFigure, CwSection, { via: cwFigureIn }),
      partOf(CwFigure, CwDocument, { via: cwFigureIn }),
      partOf(CwFigure, CwDocument, { via: cwFigureInsetOf }),
      partOf(CwPara, CwSection, { via: cwParaOf, existence: "required" }),
      partOf(CwSection, CwDocument, { via: cwSectionOf }),
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
