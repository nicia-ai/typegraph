/**
 * Re-importing a source in which a composition part MOVED to another whole.
 *
 * A `oneActive` move exports as two rows — the old attachment ended and a new
 * attachment opened at the same instant — while a `one` move deletes the old
 * row, so its export carries the new attachment alone. An `onConflict:
 * "update"` import of either must commit the same state whatever `batchSize`
 * it runs at and whatever order the document lists the rows in: the rows
 * depend on each other, so a split decided by slice boundaries is a defect.
 *
 * Every case compares the committed composition rows of a `batchSize: 1` run
 * against a `batchSize: 1000` run, then pins the expected state, and checks
 * that `verifyConstraintFences()` reports nothing.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, partOf } from "../../../src";
import { rowPropsToObject } from "../../../src/backend/types";
import {
  FORMAT_VERSION,
  type GraphData,
  type GraphInterchangeChunk,
  importGraph,
  importGraphStream,
  type ImportOptions,
  type ImportResult,
} from "../../../src/interchange";
import { requireDefined } from "../../../src/utils/presence";
import {
  type InspectableStore,
  type IntegrationTestContext,
} from "./test-context";

const Part = defineNode("IcmPart", { schema: z.object({}) });
const Whole = defineNode("IcmWhole", { schema: z.object({}) });
const partOfWhole = defineEdge("icmPartOf", {
  schema: z.object({ note: z.string().optional() }),
});

const POPULATIONS = ["oneActive", "one"] as const;
type Population = (typeof POPULATIONS)[number];
const EXISTENCES = ["optional", "required"] as const;
type Existence = (typeof EXISTENCES)[number];
const ORDERS = ["endFirst", "attachFirst"] as const;
type Order = (typeof ORDERS)[number];
const BATCH_SIZES = [1, 1000] as const;

const ATTACHED_AT = "2020-01-01T00:00:00.000Z";
const MOVED_AT = "2021-01-01T00:00:00.000Z";
/** Before the incumbent opened, so a move at this instant would invert it. */
const BEFORE_INCUMBENT = "2019-01-01T00:00:00.000Z";
/** Inside the incumbent's window, so an attachment opening here overlaps it. */
const INSIDE_INCUMBENT = "2020-06-01T00:00:00.000Z";

/** The label every committed state names the target's original edge by. */
const INCUMBENT = "incumbent";
const MOVED_EDGE_ID = "icm-moved";

function moveGraph(population: Population, existence: Existence, run: string) {
  return defineGraph({
    id: `import_composition_moves_${population}_${existence}_${run}`,
    nodes: { IcmPart: { type: Part }, IcmWhole: { type: Whole } },
    edges: {
      icmPartOf: {
        type: partOfWhole,
        from: [Part],
        to: [Whole],
        cardinality: population,
      },
    },
    ontology: [partOf(Part, Whole, { via: partOfWhole, existence })],
  });
}

type MoveStore = InspectableStore<ReturnType<typeof moveGraph>>;

/** A realizing edge whose schema transforms its value: parsing it twice shows. */
const taggedPartOf = defineEdge("icmTaggedPartOf", {
  schema: z.object({
    note: z
      .string()
      .transform((note) => `${note}!`)
      .optional(),
  }),
});

function taggedGraph(run: string) {
  return defineGraph({
    id: `import_composition_moves_props_${run}`,
    nodes: { IcmPart: { type: Part }, IcmWhole: { type: Whole } },
    edges: {
      icmTaggedPartOf: {
        type: taggedPartOf,
        from: [Part],
        to: [Whole],
        cardinality: "one",
      },
    },
    ontology: [partOf(Part, Whole, { via: taggedPartOf })],
  });
}

/**
 * Imports one document holding two rows with the same `properties`: one that
 * MOVES a part under `onCompositionIncumbent: "replace"`, and one that
 * attaches a part holding no whole — an ordinary create. Returns the stored
 * properties of each, so a test can hold the move to the ordinary create.
 */
async function importMoveBesideCreate(
  context: IntegrationTestContext,
  run: string,
  properties: Record<string, unknown>,
  overrides: Partial<ImportOptions>,
): Promise<
  Readonly<{
    errors: readonly string[];
    moved: Record<string, unknown> | undefined;
    created: Record<string, unknown> | undefined;
  }>
> {
  const store = await context.createStore(taggedGraph(run));
  const oldWhole = await store.nodes.IcmWhole.create({});
  const newWhole = await store.nodes.IcmWhole.create({});
  const moving = await store.nodes.IcmPart.create(
    {},
    { partOf: { whole: oldWhole, validFrom: ATTACHED_AT } },
  );
  const unattached = await store.nodes.IcmPart.create({});
  const attachRow = (id: string, partId: string): EdgeRows[number] => ({
    kind: "icmTaggedPartOf",
    id,
    from: { kind: "IcmPart", id: partId },
    to: { kind: "IcmWhole", id: newWhole.id },
    properties,
    validFrom: MOVED_AT,
  });
  const result = await importGraph(
    store,
    document([
      attachRow("icm-moved", moving.id),
      attachRow("icm-created", unattached.id),
    ]),
    {
      ...options(1000),
      onCompositionIncumbent: "replace",
      ...overrides,
    },
  );
  const storedProps = async (
    id: string,
  ): Promise<Record<string, unknown> | undefined> => {
    const row = await store.backend.getEdge(store.graphId, id);
    return row === undefined ? undefined : rowPropsToObject(row.props);
  };
  return {
    errors: result.errors.map((entry) => `${entry.id}: ${entry.error}`),
    moved: await storedProps("icm-moved"),
    created: await storedProps("icm-created"),
  };
}

type Seeded = Readonly<{
  store: MoveStore;
  partId: string;
  oldWholeId: string;
  newWholeId: string;
  incumbentId: string;
}>;

/** A part attached to one whole since {@link ATTACHED_AT}, and a second whole. */
async function seed(
  context: IntegrationTestContext,
  population: Population,
  existence: Existence,
  run: string,
): Promise<Seeded> {
  const store = await context.createStore(
    moveGraph(population, existence, run),
  );
  const oldWhole = await store.nodes.IcmWhole.create({});
  const newWhole = await store.nodes.IcmWhole.create({});
  const part = await store.nodes.IcmPart.create(
    {},
    { partOf: { whole: oldWhole, validFrom: ATTACHED_AT } },
  );
  const [incumbent] = await store.edges.icmPartOf.find({});
  return {
    store,
    partId: part.id,
    oldWholeId: oldWhole.id,
    newWholeId: newWhole.id,
    incumbentId: requireDefined(incumbent).id,
  };
}

type EdgeRows = GraphData["edges"];

/** The target's incumbent row, restated with `validTo` ending it. */
function endIncumbent(seeded: Seeded, validTo: string): EdgeRows[number] {
  return {
    kind: "icmPartOf",
    id: seeded.incumbentId,
    from: { kind: "IcmPart", id: seeded.partId },
    to: { kind: "IcmWhole", id: seeded.oldWholeId },
    properties: {},
    validFrom: ATTACHED_AT,
    validTo,
  };
}

/** A new attachment of the part to the second whole, opening at `validFrom`. */
function attachElsewhere(seeded: Seeded, validFrom: string): EdgeRows[number] {
  return {
    kind: "icmPartOf",
    id: MOVED_EDGE_ID,
    from: { kind: "IcmPart", id: seeded.partId },
    to: { kind: "IcmWhole", id: seeded.newWholeId },
    properties: {},
    validFrom,
  };
}

function document(edges: EdgeRows): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "external", description: "composition move re-import" },
    nodes: [],
    edges,
  };
}

/** A header, then one edge chunk per argument: each chunk commits on its own. */
async function* chunks(
  ...edgeChunks: readonly EdgeRows[]
): AsyncIterable<GraphInterchangeChunk> {
  const { formatVersion, exportedAt, source } = document([]);
  await Promise.resolve();
  yield { type: "header", header: { formatVersion, exportedAt, source } };
  for (const edges of edgeChunks) yield { type: "edges", edges };
}

function options(
  batchSize: number,
  overrides: Partial<ImportOptions> = {},
): ImportOptions {
  return {
    onConflict: "update",
    onUnknownProperty: "error",
    validateReferences: true,
    batchSize,
    refreshStatistics: false,
    ...overrides,
  };
}

type CommittedEdge = Readonly<{
  id: string;
  whole: "old" | "new";
  validFrom: string | undefined;
  validTo: string | undefined;
}>;

/**
 * What one run committed, in terms independent of its generated ids, so runs
 * on separate graphs compare equal exactly when they committed the same thing.
 */
type Outcome = Readonly<{
  edges: readonly CommittedEdge[];
  counts: ImportResult["edges"];
  errors: readonly Readonly<{ id: string; code: string }>[];
  fenceViolations: number;
}>;

/**
 * The branchable code a per-row error leads with; the occupied-slot refusal
 * an edge create's own claim probe reports carries none, so it is named here.
 */
function errorCode(message: string): string {
  const prefixed = /^[A-Z][A-Z_]+(?=:)/u.exec(message)?.[0];
  if (prefixed !== undefined) return prefixed;
  return message.includes("already has a whole") ?
      "COMPOSITION_WHOLE_OCCUPIED"
    : message;
}

async function outcomeOf(
  seeded: Seeded,
  result: ImportResult,
): Promise<Outcome> {
  const rows = await seeded.store.edges.icmPartOf.find(
    {},
    { temporalMode: "includeEnded" },
  );
  const fenceViolations = await seeded.store.verifyConstraintFences();
  const label = (id: string): string =>
    id === seeded.incumbentId ? INCUMBENT : id;
  return {
    edges: rows
      .map((row): CommittedEdge => ({
        id: label(row.id),
        whole: row.toId === seeded.oldWholeId ? "old" : "new",
        validFrom: row.meta.validFrom,
        validTo: row.meta.validTo,
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
    counts: result.edges,
    errors: result.errors.map((entry) => ({
      id: label(entry.id),
      code: errorCode(entry.error),
    })),
    fenceViolations: fenceViolations.length,
  };
}

/**
 * Runs `rows` against a fresh seeded graph at every batch size, asserts the
 * committed outcomes are identical, and returns that one outcome.
 */
async function importAtEveryBatchSize(
  context: IntegrationTestContext,
  population: Population,
  existence: Existence,
  rows: (seeded: Seeded) => EdgeRows,
  overrides: Partial<ImportOptions> = {},
): Promise<Outcome> {
  const outcomes: Outcome[] = [];
  for (const batchSize of BATCH_SIZES) {
    const seeded = await seed(
      context,
      population,
      existence,
      `b${batchSize}_${outcomes.length}`,
    );
    const result = await importGraph(
      seeded.store,
      document(rows(seeded)),
      options(batchSize, overrides),
    );
    outcomes.push(await outcomeOf(seeded, result));
  }
  const first = requireDefined(outcomes[0]);
  // Compared as a whole, so a mismatch prints every batch size's outcome.
  expect(outcomes).toEqual(outcomes.map(() => first));
  return first;
}

function ordered(
  order: Order,
  end: EdgeRows[number],
  attach: EdgeRows[number],
): EdgeRows {
  return order === "endFirst" ? [end, attach] : [attach, end];
}

const MOVED: readonly CommittedEdge[] = [
  { id: MOVED_EDGE_ID, whole: "new", validFrom: MOVED_AT, validTo: undefined },
  { id: INCUMBENT, whole: "old", validFrom: ATTACHED_AT, validTo: MOVED_AT },
];

const UNMOVED: readonly CommittedEdge[] = [
  { id: INCUMBENT, whole: "old", validFrom: ATTACHED_AT, validTo: undefined },
];

// ---------------------------------------------------------------------------
// Moves that depend on the rest of the document
// ---------------------------------------------------------------------------

const Root = defineNode("IcmRoot", { schema: z.object({}) });
const Mid = defineNode("IcmMid", { schema: z.object({}) });
const Leaf = defineNode("IcmLeaf", { schema: z.object({}) });
const midOf = defineEdge("icmMidOf", { schema: z.object({}) });
const leafOf = defineEdge("icmLeafOf", { schema: z.object({}) });

/** Root ⊃ Mid (required) ⊃ Leaf: a leaf can move onto a mid the import creates. */
function nestedGraph(
  population: Population,
  leafExistence: Existence,
  run: string,
) {
  return defineGraph({
    id: `import_composition_moves_nested_${population}_${leafExistence}_${run}`,
    nodes: {
      IcmRoot: { type: Root },
      IcmMid: { type: Mid },
      IcmLeaf: { type: Leaf },
    },
    edges: {
      icmMidOf: {
        type: midOf,
        from: [Mid],
        to: [Root],
        cardinality: "oneActive",
      },
      icmLeafOf: {
        type: leafOf,
        from: [Leaf],
        to: [Mid],
        cardinality: population,
      },
    },
    ontology: [
      partOf(Mid, Root, { via: midOf, existence: "required" }),
      partOf(Leaf, Mid, { via: leafOf, existence: leafExistence }),
    ],
  });
}

const Slot = defineNode("IcmSlot", { schema: z.object({}) });
const Item = defineNode("IcmItem", { schema: z.object({}) });
const inSlot = defineEdge("icmInSlot", { schema: z.object({}) });

/** A slot holds one item at a time, so two items can only exchange slots together. */
function slotGraph(run: string) {
  return defineGraph({
    id: `import_composition_moves_slots_${run}`,
    nodes: { IcmSlot: { type: Slot }, IcmItem: { type: Item } },
    edges: {
      icmInSlot: {
        type: inSlot,
        from: [Item],
        to: [Slot],
        cardinality: "oneActive",
        targetCardinality: "oneActive",
      },
    },
    ontology: [partOf(Item, Slot, { via: inSlot })],
  });
}

const Folder = defineNode("IcmFolder", { schema: z.object({}) });
const inFolder = defineEdge("icmInFolder", { schema: z.object({}) });

/** Folders nest in folders, so a move can only invert a hierarchy acyclically together. */
function folderGraph(run: string) {
  return defineGraph({
    id: `import_composition_moves_folders_${run}`,
    nodes: { IcmFolder: { type: Folder } },
    edges: {
      icmInFolder: {
        type: inFolder,
        from: [Folder],
        to: [Folder],
        cardinality: "oneActive",
      },
    },
    ontology: [partOf(Folder, Folder, { via: inFolder, partSide: "from" })],
  });
}

function compositionRow(
  kind: string,
  id: string,
  from: Readonly<{ kind: string; id: string }>,
  to: Readonly<{ kind: string; id: string }>,
  window: Readonly<{ validFrom: string; validTo?: string }>,
): EdgeRows[number] {
  return { kind, id, from, to, properties: {}, ...window };
}

function partAttachRow(
  id: string,
  partId: string,
  wholeId: string,
): EdgeRows[number] {
  return compositionRow(
    "icmPartOf",
    id,
    { kind: "IcmPart", id: partId },
    { kind: "IcmWhole", id: wholeId },
    { validFrom: MOVED_AT },
  );
}

function itemRef(id: string): Readonly<{ kind: string; id: string }> {
  return { kind: "IcmItem", id };
}

function slotRef(id: string): Readonly<{ kind: string; id: string }> {
  return { kind: "IcmSlot", id };
}

function folderRef(id: string): Readonly<{ kind: string; id: string }> {
  return { kind: "IcmFolder", id };
}

/**
 * Runs `scenario` once per batch size, asserts every run reported the same
 * thing, and returns that report.
 */
async function sameAtEveryBatchSize<T>(
  scenario: (batchSize: number) => Promise<T>,
): Promise<T> {
  const reports: T[] = [];
  for (const batchSize of BATCH_SIZES) reports.push(await scenario(batchSize));
  const first = requireDefined(reports[0]);
  // Compared as a whole, so a mismatch prints every batch size's report.
  expect(reports).toEqual(reports.map(() => first));
  return first;
}

export function registerImportCompositionMoveIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("import: a composition move re-imported with onConflict update", () => {
    describe.each(EXISTENCES)("oneActive %s", (existence) => {
      describe.each(ORDERS)("%s", (order) => {
        it("ends the old attachment and opens the new one at every batch size", async () => {
          const outcome = await importAtEveryBatchSize(
            context,
            "oneActive",
            existence,
            (seeded) =>
              ordered(
                order,
                endIncumbent(seeded, MOVED_AT),
                attachElsewhere(seeded, MOVED_AT),
              ),
          );
          expect(outcome).toEqual({
            edges: MOVED,
            counts: { created: 1, updated: 1, skipped: 0, replaced: 0 },
            errors: [],
            fenceViolations: 0,
          });
        });

        it("keeps the old attachment when the new one is refused", async () => {
          const outcome = await importAtEveryBatchSize(
            context,
            "oneActive",
            existence,
            (seeded) =>
              ordered(
                order,
                endIncumbent(seeded, MOVED_AT),
                attachElsewhere(seeded, INSIDE_INCUMBENT),
              ),
          );
          const endError = {
            id: INCUMBENT,
            code: "INTERCHANGE_COMPOSITION_MOVE_INCOMPLETE",
          };
          const attachError = {
            id: MOVED_EDGE_ID,
            code: "COMPOSITION_WINDOW_OVERLAP",
          };
          expect(outcome).toEqual({
            edges: UNMOVED,
            counts: { created: 0, updated: 0, skipped: 0, replaced: 0 },
            errors:
              order === "endFirst" ?
                [endError, attachError]
              : [attachError, endError],
            fenceViolations: 0,
          });
        });

        it("applies the same move under onCompositionIncumbent replace", async () => {
          const outcome = await importAtEveryBatchSize(
            context,
            "oneActive",
            existence,
            (seeded) =>
              ordered(
                order,
                endIncumbent(seeded, MOVED_AT),
                attachElsewhere(seeded, MOVED_AT),
              ),
            { onCompositionIncumbent: "replace" },
          );
          expect(outcome).toEqual({
            edges: MOVED,
            counts: { created: 1, updated: 1, skipped: 0, replaced: 0 },
            errors: [],
            fenceViolations: 0,
          });
        });
      });
    });

    describe.each(EXISTENCES)(
      "one %s, both rows in the document",
      (existence) => {
        // An ended `one` row still holds its part, so ending it makes no room:
        // the document contradicts itself, and the outcome is the same at every
        // batch size, in either order, under either setting.
        describe.each(ORDERS)("%s", (order) => {
          it.each(["refuse", "replace"] as const)(
            "refuses the second attachment under %s",
            async (onCompositionIncumbent) => {
              const outcome = await importAtEveryBatchSize(
                context,
                "one",
                existence,
                (seeded) =>
                  ordered(
                    order,
                    endIncumbent(seeded, MOVED_AT),
                    attachElsewhere(seeded, MOVED_AT),
                  ),
                { onCompositionIncumbent },
              );
              const ended = existence === "optional";
              expect(outcome).toEqual({
                edges: [
                  {
                    id: INCUMBENT,
                    whole: "old",
                    validFrom: ATTACHED_AT,
                    validTo: ended ? MOVED_AT : undefined,
                  },
                ],
                counts: {
                  created: 0,
                  updated: ended ? 1 : 0,
                  skipped: 0,
                  replaced: 0,
                },
                errors: [
                  ...(ended ?
                    []
                  : [{ id: INCUMBENT, code: "COMPOSITION_DETACH_REFUSED" }]),
                  { id: MOVED_EDGE_ID, code: "COMPOSITION_WHOLE_OCCUPIED" },
                ],
                fenceViolations: 0,
              });
            },
          );
        });
      },
    );

    describe.each(POPULATIONS)("%s, the new attachment alone", (population) => {
      describe.each(EXISTENCES)("%s", (existence) => {
        it("refuses the move by default, naming the option", async () => {
          const outcome = await importAtEveryBatchSize(
            context,
            population,
            existence,
            (seeded) => [attachElsewhere(seeded, MOVED_AT)],
          );
          expect(outcome).toEqual({
            edges: UNMOVED,
            counts: { created: 0, updated: 0, skipped: 0, replaced: 0 },
            errors: [
              { id: MOVED_EDGE_ID, code: "COMPOSITION_IMPORT_MOVE_REFUSED" },
            ],
            fenceViolations: 0,
          });
        });

        it("moves the part under onCompositionIncumbent replace", async () => {
          const outcome = await importAtEveryBatchSize(
            context,
            population,
            existence,
            (seeded) => [attachElsewhere(seeded, MOVED_AT)],
            { onCompositionIncumbent: "replace" },
          );
          expect(outcome).toEqual({
            // A `one` incumbent is deleted; a `oneActive` one ends at the new
            // edge's validFrom, so the two windows abut.
            edges:
              population === "one" ?
                [
                  {
                    id: MOVED_EDGE_ID,
                    whole: "new",
                    validFrom: MOVED_AT,
                    validTo: undefined,
                  },
                ]
              : MOVED,
            counts: { created: 1, updated: 0, skipped: 0, replaced: 1 },
            errors: [],
            fenceViolations: 0,
          });
        });
      });
    });

    it("refuses a replace move whose row states an end", async () => {
      const outcome = await importAtEveryBatchSize(
        context,
        "one",
        "optional",
        (seeded) => [
          { ...attachElsewhere(seeded, MOVED_AT), validTo: MOVED_AT },
        ],
        { onCompositionIncumbent: "replace" },
      );
      expect(outcome).toEqual({
        edges: UNMOVED,
        counts: { created: 0, updated: 0, skipped: 0, replaced: 0 },
        errors: [
          {
            id: MOVED_EDGE_ID,
            code: "COMPOSITION_IMPORT_MOVE_WINDOW_UNSUPPORTED",
          },
        ],
        fenceViolations: 0,
      });
    });

    it("refuses a replace move that would end the incumbent before it opened", async () => {
      const outcome = await importAtEveryBatchSize(
        context,
        "oneActive",
        "required",
        (seeded) => [attachElsewhere(seeded, BEFORE_INCUMBENT)],
        { onCompositionIncumbent: "replace" },
      );
      expect(outcome).toEqual({
        edges: UNMOVED,
        counts: { created: 0, updated: 0, skipped: 0, replaced: 0 },
        errors: [
          { id: MOVED_EDGE_ID, code: "COMPOSITION_MOVE_BEFORE_INCUMBENT" },
        ],
        fenceViolations: 0,
      });
    });

    it("refuses an onCompositionIncumbent value it does not declare", async () => {
      const seeded = await seed(context, "one", "optional", "invalid_option");
      await expect(
        importGraph(seeded.store, document([]), {
          ...options(1000),
          onCompositionIncumbent: "move" as "replace",
        }),
      ).rejects.toThrow(/onCompositionIncumbent/u);
    });

    describe.each(POPULATIONS)(
      "%s, one part attached twice beside an unrelated move",
      (population) => {
        it("refuses both rows naming the part and applies the unrelated move", async () => {
          const report = await sameAtEveryBatchSize(async (batchSize) => {
            const store = await context.createStore(
              moveGraph(population, "optional", `contested_b${batchSize}`),
            );
            const w1 = await store.nodes.IcmWhole.create({});
            const w2 = await store.nodes.IcmWhole.create({});
            const w3 = await store.nodes.IcmWhole.create({});
            const w4 = await store.nodes.IcmWhole.create({});
            const p1 = await store.nodes.IcmPart.create(
              {},
              { partOf: { whole: w1, validFrom: ATTACHED_AT } },
            );
            const p2 = await store.nodes.IcmPart.create(
              {},
              { partOf: { whole: w1, validFrom: ATTACHED_AT } },
            );
            const result = await importGraph(
              store,
              document([
                partAttachRow("a", p1.id, w2.id),
                partAttachRow("b", p1.id, w3.id),
                partAttachRow("c", p2.id, w4.id),
              ]),
              options(batchSize, { onCompositionIncumbent: "replace" }),
            );
            const open = await store.edges.icmPartOf.find({});
            const name = (id: string): string =>
              id === w1.id ? "w1"
              : id === w4.id ? "w4"
              : id;
            return {
              errors: result.errors.map((entry) => ({
                id: entry.id,
                code: errorCode(entry.error),
                namesBothRows:
                  entry.error.includes('"a"') && entry.error.includes('"b"'),
              })),
              edges: result.edges,
              open: open
                .map(
                  (edge) =>
                    `${edge.fromId === p1.id ? "p1" : "p2"}→${name(edge.toId)}`,
                )
                .toSorted(),
              fenceViolations: await store.verifyConstraintFences(),
            };
          });
          expect(report).toEqual({
            errors: [
              {
                id: "a",
                code: "INTERCHANGE_COMPOSITION_MOVE_INCOMPLETE",
                namesBothRows: true,
              },
              {
                id: "b",
                code: "INTERCHANGE_COMPOSITION_MOVE_INCOMPLETE",
                namesBothRows: true,
              },
            ],
            edges: { created: 1, updated: 0, skipped: 0, replaced: 1 },
            open: ["p1→w1", "p2→w4"],
            fenceViolations: [],
          });
        });
      },
    );

    describe("the properties a replace move writes", () => {
      it("runs the realizing edge's schema transform once, as an ordinary create does", async () => {
        const stored = await importMoveBesideCreate(
          context,
          "transform",
          { note: "moved" },
          {},
        );
        expect(stored).toEqual({
          errors: [],
          moved: { note: "moved!" },
          created: { note: "moved!" },
        });
      });

      it('keeps a key onUnknownProperty "allow" admitted, as an ordinary create does', async () => {
        const stored = await importMoveBesideCreate(
          context,
          "allow",
          { note: "kept", extra: 1 },
          { onUnknownProperty: "allow" },
        );
        expect(stored).toEqual({
          errors: [],
          moved: { note: "kept", extra: 1 },
          created: { note: "kept", extra: 1 },
        });
      });
    });

    describe.each(EXISTENCES)(
      "a move onto a whole this import creates and then removes, %s leaf",
      (leafExistence) => {
        // mid2 is a required part whose own attachment names a root that
        // does not exist, so the import removes it once its edges are in —
        // after the leaf's move to it was written.
        it.each(["oneActive", "one"] as const)(
          // "oneActive": the move's two rows; "one": a replace move.
          "keeps the leaf on its old whole: %s",
          async (population) => {
            const report = await sameAtEveryBatchSize(async (batchSize) => {
              const store = await context.createStore(
                nestedGraph(population, leafExistence, `b${batchSize}`),
              );
              const root = await store.nodes.IcmRoot.create({});
              const mid1 = await store.nodes.IcmMid.create(
                {},
                { partOf: { whole: root, validFrom: ATTACHED_AT } },
              );
              const leaf = await store.nodes.IcmLeaf.create(
                {},
                { partOf: { whole: mid1, validFrom: ATTACHED_AT } },
              );
              const [incumbent] = await store.edges.icmLeafOf.find({});
              const leafRef = { kind: "IcmLeaf", id: leaf.id };
              const rows: EdgeRows = [
                compositionRow(
                  "icmMidOf",
                  "mid2-of",
                  { kind: "IcmMid", id: "mid2" },
                  { kind: "IcmRoot", id: "no-such-root" },
                  { validFrom: ATTACHED_AT },
                ),
                ...(population === "oneActive" ?
                  [
                    compositionRow(
                      "icmLeafOf",
                      requireDefined(incumbent).id,
                      leafRef,
                      { kind: "IcmMid", id: mid1.id },
                      { validFrom: ATTACHED_AT, validTo: MOVED_AT },
                    ),
                  ]
                : []),
                compositionRow(
                  "icmLeafOf",
                  "leaf-moved",
                  leafRef,
                  { kind: "IcmMid", id: "mid2" },
                  { validFrom: MOVED_AT },
                ),
              ];
              const result = await importGraph(
                store,
                {
                  ...document(rows),
                  nodes: [{ kind: "IcmMid", id: "mid2", properties: {} }],
                },
                options(batchSize, { onCompositionIncumbent: "replace" }),
              );
              const leafEdges = await store.edges.icmLeafOf.find(
                {},
                { temporalMode: "includeEnded" },
              );
              const fenceViolations = await store.verifyConstraintFences();
              const incumbentId = requireDefined(incumbent).id;
              return {
                leafEdges: leafEdges.map((edge) => ({
                  id: edge.id === incumbentId ? INCUMBENT : edge.id,
                  whole: edge.toId === mid1.id ? "mid1" : edge.toId,
                  validTo: edge.meta.validTo,
                })),
                mid2: await store.backend.getNode(
                  store.graphId,
                  "IcmMid",
                  "mid2",
                ),
                leafRowErrors: result.errors
                  .filter(
                    (entry) =>
                      entry.id === incumbentId || entry.id === "leaf-moved",
                  )
                  .map((entry) => ({
                    id: entry.id === incumbentId ? INCUMBENT : entry.id,
                    code: errorCode(entry.error),
                  })),
                edges: result.edges,
                fenceViolations,
              };
            });
            expect(report).toEqual({
              leafEdges: [{ id: INCUMBENT, whole: "mid1", validTo: undefined }],
              mid2: undefined,
              leafRowErrors: [
                ...(population === "oneActive" ?
                  [
                    {
                      id: INCUMBENT,
                      code: "INTERCHANGE_COMPOSITION_MOVE_INCOMPLETE",
                    },
                  ]
                : []),
                {
                  id: "leaf-moved",
                  code: "INTERCHANGE_COMPOSITION_MOVE_INCOMPLETE",
                },
              ],
              edges: { created: 0, updated: 0, skipped: 0, replaced: 0 },
              fenceViolations: [],
            });
          },
        );
      },
    );

    it("exchanges two items' slots, as bulkReparent does", async () => {
      const report = await sameAtEveryBatchSize(async (batchSize) => {
        const store = await context.createStore(slotGraph(`b${batchSize}`));
        const s1 = await store.nodes.IcmSlot.create({});
        const s2 = await store.nodes.IcmSlot.create({});
        const firstItem = await store.nodes.IcmItem.create(
          {},
          { partOf: { whole: s1, validFrom: ATTACHED_AT } },
        );
        const secondItem = await store.nodes.IcmItem.create(
          {},
          { partOf: { whole: s2, validFrom: ATTACHED_AT } },
        );
        const held = await store.edges.icmInSlot.find({});
        const edgeOf = (itemId: string): string =>
          requireDefined(held.find((edge) => edge.fromId === itemId)).id;
        const result = await importGraph(
          store,
          document([
            compositionRow(
              "icmInSlot",
              edgeOf(firstItem.id),
              itemRef(firstItem.id),
              slotRef(s1.id),
              {
                validFrom: ATTACHED_AT,
                validTo: MOVED_AT,
              },
            ),
            compositionRow(
              "icmInSlot",
              "i1-s2",
              itemRef(firstItem.id),
              slotRef(s2.id),
              {
                validFrom: MOVED_AT,
              },
            ),
            compositionRow(
              "icmInSlot",
              edgeOf(secondItem.id),
              itemRef(secondItem.id),
              slotRef(s2.id),
              {
                validFrom: ATTACHED_AT,
                validTo: MOVED_AT,
              },
            ),
            compositionRow(
              "icmInSlot",
              "i2-s1",
              itemRef(secondItem.id),
              slotRef(s1.id),
              {
                validFrom: MOVED_AT,
              },
            ),
          ]),
          options(batchSize),
        );
        const open = await store.edges.icmInSlot.find({});
        return {
          errors: result.errors,
          edges: result.edges,
          open: open
            .map(
              (edge) =>
                `${edge.fromId === firstItem.id ? "i1" : "i2"}→${edge.toId === s1.id ? "s1" : "s2"}`,
            )
            .toSorted(),
          fenceViolations: await store.verifyConstraintFences(),
        };
      });
      expect(report).toEqual({
        errors: [],
        edges: { created: 2, updated: 2, skipped: 0, replaced: 0 },
        open: ["i1→s2", "i2→s1"],
        fenceViolations: [],
      });
    });

    it.each(["parentMoveFirst", "childMoveFirst"] as const)(
      "inverts a hierarchy whatever order the moves are listed in: %s",
      async (order) => {
        const report = await sameAtEveryBatchSize(async (batchSize) => {
          const store = await context.createStore(
            folderGraph(`${order}_b${batchSize}`),
          );
          const root = await store.nodes.IcmFolder.create({});
          const a = await store.nodes.IcmFolder.create(
            {},
            { partOf: { whole: root, validFrom: ATTACHED_AT } },
          );
          const b = await store.nodes.IcmFolder.create(
            {},
            { partOf: { whole: a, validFrom: ATTACHED_AT } },
          );
          const held = await store.edges.icmInFolder.find({});
          const edgeOf = (folderId: string): string =>
            requireDefined(held.find((edge) => edge.fromId === folderId)).id;
          // The source moved b up to root, then a down under b.
          const aMove = [
            compositionRow(
              "icmInFolder",
              edgeOf(a.id),
              folderRef(a.id),
              folderRef(root.id),
              {
                validFrom: ATTACHED_AT,
                validTo: MOVED_AT,
              },
            ),
            compositionRow(
              "icmInFolder",
              "a-under-b",
              folderRef(a.id),
              folderRef(b.id),
              {
                validFrom: MOVED_AT,
              },
            ),
          ];
          const bMove = [
            compositionRow(
              "icmInFolder",
              edgeOf(b.id),
              folderRef(b.id),
              folderRef(a.id),
              {
                validFrom: ATTACHED_AT,
                validTo: MOVED_AT,
              },
            ),
            compositionRow(
              "icmInFolder",
              "b-under-root",
              folderRef(b.id),
              folderRef(root.id),
              {
                validFrom: MOVED_AT,
              },
            ),
          ];
          const result = await importGraph(
            store,
            document(
              order === "parentMoveFirst" ?
                [...aMove, ...bMove]
              : [...bMove, ...aMove],
            ),
            options(batchSize),
          );
          const open = await store.edges.icmInFolder.find({});
          const name = (id: string): string =>
            id === root.id ? "root"
            : id === a.id ? "a"
            : "b";
          return {
            errors: result.errors,
            edges: result.edges,
            open: open
              .map((edge) => `${name(edge.fromId)}⊂${name(edge.toId)}`)
              .toSorted(),
            fenceViolations: await store.verifyConstraintFences(),
          };
        });
        expect(report).toEqual({
          errors: [],
          edges: { created: 2, updated: 2, skipped: 0, replaced: 0 },
          open: ["a⊂b", "b⊂root"],
          fenceViolations: [],
        });
      },
    );

    describe("importGraphStream", () => {
      it("applies onCompositionIncumbent replace to each chunk", async () => {
        const seeded = await seed(context, "one", "optional", "stream_one");
        const result = await importGraphStream(
          seeded.store,
          chunks([attachElsewhere(seeded, MOVED_AT)]),
          { ...options(1000), onCompositionIncumbent: "replace" },
        );
        expect(await outcomeOf(seeded, result)).toEqual({
          edges: [
            {
              id: MOVED_EDGE_ID,
              whole: "new",
              validFrom: MOVED_AT,
              validTo: undefined,
            },
          ],
          counts: { created: 1, updated: 0, skipped: 0, replaced: 1 },
          errors: [],
          fenceViolations: 0,
        });
      });

      it("converges a move split across chunks under replace", async () => {
        const seeded = await seed(
          context,
          "oneActive",
          "optional",
          "stream_split",
        );
        const result = await importGraphStream(
          seeded.store,
          chunks(
            [attachElsewhere(seeded, MOVED_AT)],
            [endIncumbent(seeded, MOVED_AT)],
          ),
          { ...options(1000), onCompositionIncumbent: "replace" },
        );
        expect(await outcomeOf(seeded, result)).toEqual({
          edges: MOVED,
          counts: { created: 1, updated: 1, skipped: 0, replaced: 1 },
          errors: [],
          fenceViolations: 0,
        });
      });

      it("refuses the first half of a move split across chunks by default", async () => {
        const seeded = await seed(
          context,
          "oneActive",
          "optional",
          "stream_split_refused",
        );
        await expect(
          importGraphStream(
            seeded.store,
            chunks(
              [attachElsewhere(seeded, MOVED_AT)],
              [endIncumbent(seeded, MOVED_AT)],
            ),
            options(1000),
          ),
        ).rejects.toThrow(/COMPOSITION_IMPORT_MOVE_REFUSED/u);
        const committed = await seeded.store.edges.icmPartOf.find({});
        expect(committed.map((edge) => edge.toId)).toEqual([seeded.oldWholeId]);
      });
    });
  });
}
