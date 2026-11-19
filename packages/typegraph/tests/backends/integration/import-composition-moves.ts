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

import {
  asEdgeId,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../../../src";
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

const ENDED: readonly CommittedEdge[] = [
  { id: INCUMBENT, whole: "old", validFrom: ATTACHED_AT, validTo: MOVED_AT },
];

// ---------------------------------------------------------------------------
// An end whose re-attaching row is not applied
// ---------------------------------------------------------------------------

/** Before the incumbent opened: the part's earlier history on the second whole. */
const EARLIER = "2019-01-01T00:00:00.000Z";
const EARLIER_EDGE_ID = "icm-earlier";
const OTHER_PART_ID = "icm-other-part";
const OTHER_PART_EDGE_ID = "icm-other-part-edge";
const MOVE_INCOMPLETE = "INTERCHANGE_COMPOSITION_MOVE_INCOMPLETE";
/** After {@link MOVED_AT}: the end a later row gives an attachment. */
const LATER = "2022-01-01T00:00:00.000Z";
const REPLACEMENT_ID = "icm-replacement";

/** The error of a row attaching the part to a whole that does not exist. */
function missing(id: string): Readonly<{ id: string; code: string }> {
  return { id, code: "To node not found: IcmWhole:no-such-whole" };
}

/**
 * The ways one document reaches the target: `importGraph` at each batch size
 * and, where the graph allows a streamed import, `importGraphStream` with the
 * document as one chunk. Each must commit the same rows.
 */
const IMPORT_ROUTES = [
  { name: "importGraph batchSize 1", batchSize: 1, stream: false },
  { name: "importGraph batchSize 1000", batchSize: 1000, stream: false },
  { name: "importGraphStream", batchSize: 1000, stream: true },
] as const;

/** A part not attached to anything, which an import can attach. */
async function createUnattachedPart(seeded: Seeded): Promise<string> {
  const part = await seeded.store.nodes.IcmPart.create({});
  return part.id;
}

/**
 * The part's ended attachment to the second whole, before it moved to the
 * first: the row a caller-assigned id names when the part moves back.
 */
async function seedEarlierAttachment(seeded: Seeded): Promise<void> {
  const result = await importGraph(
    seeded.store,
    document([
      {
        kind: "icmPartOf",
        id: EARLIER_EDGE_ID,
        from: { kind: "IcmPart", id: seeded.partId },
        to: { kind: "IcmWhole", id: seeded.newWholeId },
        properties: {},
        validFrom: EARLIER,
        validTo: ATTACHED_AT,
      },
    ]),
    options(1000),
  );
  expect(result.errors).toEqual([]);
}

/** Another part attached to the second whole under {@link OTHER_PART_EDGE_ID}. */
async function seedOtherPart(seeded: Seeded): Promise<void> {
  const result = await importGraph(
    seeded.store,
    {
      ...document([
        {
          kind: "icmPartOf",
          id: OTHER_PART_EDGE_ID,
          from: { kind: "IcmPart", id: OTHER_PART_ID },
          to: { kind: "IcmWhole", id: seeded.newWholeId },
          properties: {},
          validFrom: ATTACHED_AT,
        },
      ]),
      nodes: [{ kind: "IcmPart", id: OTHER_PART_ID, properties: {} }],
    },
    options(1000),
  );
  expect(result.errors).toEqual([]);
}

/** A row attaching the part to the second whole again, under `id`. */
function reattachUnder(seeded: Seeded, id: string): EdgeRows[number] {
  return { ...attachElsewhere(seeded, MOVED_AT), id };
}

/** A row attaching the part to a whole that does not exist. */
function attachToMissingWhole(
  seeded: Seeded,
  id: string,
  wholeId: string,
): EdgeRows[number] {
  return {
    ...attachElsewhere(seeded, MOVED_AT),
    id,
    to: { kind: "IcmWhole", id: wholeId },
  };
}

/**
 * Runs `rows` against a freshly seeded `oneActive` graph, after `arrange`, by
 * every import route the existence allows, asserts every route committed the
 * same thing, and returns that outcome.
 */
async function importByEveryRoute<Arranged>(
  context: IntegrationTestContext,
  existence: Existence,
  arrange: (seeded: Seeded) => Promise<Arranged>,
  rows: (seeded: Seeded, arranged: Arranged) => EdgeRows,
): Promise<Outcome> {
  // A streamed import refuses a graph declaring a required part up front.
  const routes = IMPORT_ROUTES.filter(
    (route) => !route.stream || existence === "optional",
  );
  const outcomes = new Map<string, Outcome>();
  for (const [index, route] of routes.entries()) {
    const seeded = await seed(context, "oneActive", existence, `route${index}`);
    const arranged = await arrange(seeded);
    const edges = rows(seeded, arranged);
    const result =
      route.stream ?
        await importGraphStream(
          seeded.store,
          chunks(edges),
          // Reported per row, as `importGraph` reports them.
          options(route.batchSize, { onStreamChunkError: "continue" }),
        )
      : await importGraph(
          seeded.store,
          document(edges),
          options(route.batchSize),
        );
    outcomes.set(route.name, await outcomeOf(seeded, result));
  }
  const first = requireDefined(outcomes.values().next().value);
  // Compared as a whole, so a mismatch prints every route's outcome.
  expect(Object.fromEntries(outcomes)).toEqual(
    Object.fromEntries([...outcomes.keys()].map((name) => [name, first])),
  );
  return first;
}

async function nothingToArrange(): Promise<void> {
  await Promise.resolve();
}

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
            counts: { created: 1, updated: 1, skipped: 0 },
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
            counts: { created: 0, updated: 0, skipped: 0 },
            errors:
              order === "endFirst" ?
                [endError, attachError]
              : [attachError, endError],
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
        // batch size and in either order.
        describe.each(ORDERS)("%s", (order) => {
          it("refuses the second attachment", async () => {
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
              },
              errors: [
                ...(ended ?
                  []
                : [{ id: INCUMBENT, code: "COMPOSITION_DETACH_REFUSED" }]),
                { id: MOVED_EDGE_ID, code: "COMPOSITION_WHOLE_OCCUPIED" },
              ],
              fenceViolations: 0,
            });
          });
        });
      },
    );

    describe.each(POPULATIONS)("%s, the new attachment alone", (population) => {
      // A `one` move deletes the old row, so its export carries the new
      // attachment alone; the target still holds the old one, which the
      // document does not end, so the new row would give the part a second
      // whole and is refused like any other.
      describe.each(EXISTENCES)("%s", (existence) => {
        it("refuses the new attachment while the part holds its old one", async () => {
          const outcome = await importAtEveryBatchSize(
            context,
            population,
            existence,
            (seeded) => [attachElsewhere(seeded, MOVED_AT)],
          );
          expect(outcome).toEqual({
            edges: UNMOVED,
            counts: { created: 0, updated: 0, skipped: 0 },
            errors: [{ id: MOVED_EDGE_ID, code: "COMPOSITION_WHOLE_OCCUPIED" }],
            fenceViolations: 0,
          });
        });
      });
    });

    it("applies an end whose id the document repeats as its own row, not as half of a move", async () => {
      // The repeat tightens the end the first row states. Repeats of an
      // existing id are applied with the existing rows, before any move, so a
      // first row taken as half of a move would then be written after its own
      // repeat — widening the end the repeat set — and be refused.
      const outcome = await importAtEveryBatchSize(
        context,
        "oneActive",
        "optional",
        (seeded) => [
          endIncumbent(seeded, MOVED_AT),
          attachElsewhere(seeded, MOVED_AT),
          endIncumbent(seeded, INSIDE_INCUMBENT),
        ],
      );
      expect(outcome).toEqual({
        edges: [
          {
            id: MOVED_EDGE_ID,
            whole: "new",
            validFrom: MOVED_AT,
            validTo: undefined,
          },
          {
            id: INCUMBENT,
            whole: "old",
            validFrom: ATTACHED_AT,
            validTo: INSIDE_INCUMBENT,
          },
        ],
        counts: { created: 1, updated: 2, skipped: 0 },
        errors: [],
        fenceViolations: 0,
      });
    });

    describe.each(EXISTENCES)(
      "oneActive %s, the attach refused before anything is written",
      (existence) => {
        // The attach is refused while the document is classified, so no
        // create ever runs; the end must still not be written alone.
        const cases = [
          {
            name: "an attach to a whole that does not exist",
            nodes: [],
            attachError: "To node not found: IcmWhole:no-such-whole",
            attach: (seeded: Seeded): EdgeRows[number] => ({
              ...attachElsewhere(seeded, MOVED_AT),
              to: { kind: "IcmWhole", id: "no-such-whole" },
            }),
          },
          {
            name: "an attach whose property is invalid",
            nodes: [],
            attachError:
              "note: Invalid input: expected string, received number",
            attach: (seeded: Seeded): EdgeRows[number] => ({
              ...attachElsewhere(seeded, MOVED_AT),
              properties: { note: 5 },
            }),
          },
          {
            name: "an attach to a whole whose own row the import refuses",
            nodes: [
              {
                kind: "IcmWhole",
                id: "refused-whole",
                properties: { bogus: 1 },
              },
            ],
            attachError: "To node not found: IcmWhole:refused-whole",
            attach: (seeded: Seeded): EdgeRows[number] => ({
              ...attachElsewhere(seeded, MOVED_AT),
              to: { kind: "IcmWhole", id: "refused-whole" },
            }),
          },
        ] as const;
        describe.each(ORDERS)("%s", (order) => {
          it.each(cases)(
            "keeps the old attachment: $name",
            async (testCase) => {
              const outcome = await sameAtEveryBatchSize(async (batchSize) => {
                const seeded = await seed(
                  context,
                  "oneActive",
                  existence,
                  `refused_attach_b${batchSize}`,
                );
                const result = await importGraph(
                  seeded.store,
                  {
                    ...document(
                      ordered(
                        order,
                        endIncumbent(seeded, MOVED_AT),
                        testCase.attach(seeded),
                      ),
                    ),
                    nodes: [...testCase.nodes],
                  },
                  options(batchSize),
                );
                return outcomeOf(seeded, result);
              });
              expect(outcome).toEqual({
                edges: UNMOVED,
                counts: { created: 0, updated: 0, skipped: 0 },
                errors: [
                  ...(testCase.nodes.length > 0 ?
                    [{ id: "refused-whole", code: "Unknown properties: bogus" }]
                  : []),
                  { id: MOVED_EDGE_ID, code: testCase.attachError },
                  {
                    id: INCUMBENT,
                    code: "INTERCHANGE_COMPOSITION_MOVE_INCOMPLETE",
                  },
                ],
                fenceViolations: 0,
              });
            },
          );
        });
      },
    );

    it("keeps both items when one half of a slot swap is refused before anything is written", async () => {
      const report = await sameAtEveryBatchSize(async (batchSize) => {
        const store = await context.createStore(
          slotGraph(`refused_swap_b${batchSize}`),
        );
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
              { validFrom: ATTACHED_AT, validTo: MOVED_AT },
            ),
            compositionRow(
              "icmInSlot",
              "i1-s2",
              itemRef(firstItem.id),
              slotRef(s2.id),
              { validFrom: MOVED_AT },
            ),
            compositionRow(
              "icmInSlot",
              edgeOf(secondItem.id),
              itemRef(secondItem.id),
              slotRef(s2.id),
              { validFrom: ATTACHED_AT, validTo: MOVED_AT },
            ),
            // The second item's new slot does not exist, so its end must not
            // free s2 for the first item.
            compositionRow(
              "icmInSlot",
              "i2-missing",
              itemRef(secondItem.id),
              slotRef("no-such-slot"),
              { validFrom: MOVED_AT },
            ),
          ]),
          options(batchSize),
        );
        const open = await store.edges.icmInSlot.find({});
        const label = (id: string): string =>
          id === edgeOf(firstItem.id) ? "i1-incumbent"
          : id === edgeOf(secondItem.id) ? "i2-incumbent"
          : id;
        return {
          // The refusal's leading clause: an occupied slot names a generated id.
          errors: result.errors.map((entry) => ({
            id: label(entry.id),
            code: errorCode(entry.error).split(":")[0],
          })),
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
        // Classification, then the stranded end, then the first item's move,
        // whose attach finds s2 still held.
        errors: [
          { id: "i2-missing", code: "To node not found" },
          {
            id: "i2-incumbent",
            code: "INTERCHANGE_COMPOSITION_MOVE_INCOMPLETE",
          },
          {
            id: "i1-incumbent",
            code: "INTERCHANGE_COMPOSITION_MOVE_INCOMPLETE",
          },
          { id: "i1-s2", code: "Cardinality violation" },
        ],
        edges: { created: 0, updated: 0, skipped: 0 },
        open: ["i1→s1", "i2→s2"],
        fenceViolations: [],
      });
    });

    describe.each(EXISTENCES)(
      "a move onto a whole this import creates and then removes, %s leaf",
      (leafExistence) => {
        // mid2 is a required part whose own attachment names a root that
        // does not exist, so the import removes it once its edges are in —
        // after the leaf's move to it was written.
        it("keeps the leaf on its old whole", async () => {
          const report = await sameAtEveryBatchSize(async (batchSize) => {
            const store = await context.createStore(
              nestedGraph("oneActive", leafExistence, `b${batchSize}`),
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
              compositionRow(
                "icmLeafOf",
                requireDefined(incumbent).id,
                leafRef,
                { kind: "IcmMid", id: mid1.id },
                { validFrom: ATTACHED_AT, validTo: MOVED_AT },
              ),
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
              options(batchSize),
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
              // mid2 was created, then removed with the purge: once per
              // round, so a round that rolls back must take its count back.
              nodes: result.nodes,
              edges: result.edges,
              fenceViolations,
            };
          });
          expect(report).toEqual({
            leafEdges: [{ id: INCUMBENT, whole: "mid1", validTo: undefined }],
            mid2: undefined,
            leafRowErrors: [
              {
                id: INCUMBENT,
                code: "INTERCHANGE_COMPOSITION_MOVE_INCOMPLETE",
              },
              {
                id: "leaf-moved",
                code: "INTERCHANGE_COMPOSITION_MOVE_INCOMPLETE",
              },
            ],
            nodes: { created: 0, updated: 0, skipped: 0 },
            edges: { created: 0, updated: 0, skipped: 0 },
            fenceViolations: [],
          });
        });
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
        edges: { created: 2, updated: 2, skipped: 0 },
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
          edges: { created: 2, updated: 2, skipped: 0 },
          open: ["a⊂b", "b⊂root"],
          fenceViolations: [],
        });
      },
    );

    describe("an end whose re-attaching row is not applied", () => {
      // Each document ends the part's attachment and states a row attaching
      // it again that is not applied, outside the one shape that pairs as a
      // move. Writing the end alone would leave an optional part with no
      // whole; a required part's lone end is refused as a detach.
      describe.each(EXISTENCES)("oneActive %s", (existence) => {
        describe.each(ORDERS)("%s", (order) => {
          // A caller-assigned id that names a stored row is disposed of with
          // the rows naming existing edges, and import never reopens an ended
          // row, restores a deleted one or takes over another edge's id.
          const storedIdCases = [
            {
              name: "the part's own ended row, restated from a later validFrom",
              arrange: seedEarlierAttachment,
              attachId: EARLIER_EDGE_ID,
              attachError: "IMMUTABLE_VALIDITY_LOWER_BOUND",
              committed: [
                {
                  id: EARLIER_EDGE_ID,
                  whole: "new",
                  validFrom: EARLIER,
                  validTo: ATTACHED_AT,
                },
              ],
              skipped: 0,
            },
            {
              name: "a deleted row, which import skips without an error",
              arrange: async (seeded: Seeded): Promise<void> => {
                await seedEarlierAttachment(seeded);
                await seeded.store.edges.icmPartOf.delete(
                  asEdgeId<typeof partOfWhole>(EARLIER_EDGE_ID),
                );
              },
              attachId: EARLIER_EDGE_ID,
              attachError: undefined,
              committed: [],
              skipped: 1,
            },
            {
              name: "another part's edge",
              arrange: seedOtherPart,
              attachId: OTHER_PART_EDGE_ID,
              attachError: "INTERCHANGE_EDGE_KIND_CONFLICT",
              committed: [
                {
                  id: OTHER_PART_EDGE_ID,
                  whole: "new",
                  validFrom: ATTACHED_AT,
                  validTo: undefined,
                },
              ],
              skipped: 0,
            },
          ] as const;

          it.each(storedIdCases)(
            "keeps the old attachment when the attach row's id names $name",
            async (testCase) => {
              const outcome = await importByEveryRoute(
                context,
                existence,
                testCase.arrange,
                (seeded) =>
                  ordered(
                    order,
                    endIncumbent(seeded, MOVED_AT),
                    reattachUnder(seeded, testCase.attachId),
                  ),
              );
              const endError = { id: INCUMBENT, code: MOVE_INCOMPLETE };
              const attachErrors =
                testCase.attachError === undefined ?
                  []
                : [{ id: testCase.attachId, code: testCase.attachError }];
              expect(outcome).toEqual({
                edges: [...testCase.committed, ...UNMOVED].toSorted(
                  (left, right) => left.id.localeCompare(right.id),
                ),
                counts: { created: 0, updated: 0, skipped: testCase.skipped },
                errors:
                  order === "endFirst" ?
                    [endError, ...attachErrors]
                  : [...attachErrors, endError],
                fenceViolations: 0,
              });
            },
          );
        });

        it("keeps the old attachment when two attach rows are refused", async () => {
          const outcome = await importByEveryRoute(
            context,
            existence,
            nothingToArrange,
            (seeded) => [
              endIncumbent(seeded, MOVED_AT),
              attachToMissingWhole(seeded, "icm-first", "no-such-whole"),
              attachToMissingWhole(seeded, "icm-second", "no-such-whole"),
            ],
          );
          expect(outcome).toEqual({
            edges: UNMOVED,
            counts: { created: 0, updated: 0, skipped: 0 },
            errors: [
              {
                id: "icm-first",
                code: "To node not found: IcmWhole:no-such-whole",
              },
              {
                id: "icm-second",
                code: "To node not found: IcmWhole:no-such-whole",
              },
              { id: INCUMBENT, code: MOVE_INCOMPLETE },
            ],
            fenceViolations: 0,
          });
        });

        it("keeps the old attachment when a refused attach row's id is repeated", async () => {
          // The repeat is applied after every create, so only once the end is
          // already written is it known to be refused too.
          const outcome = await importByEveryRoute(
            context,
            existence,
            nothingToArrange,
            (seeded) => [
              endIncumbent(seeded, MOVED_AT),
              attachToMissingWhole(seeded, MOVED_EDGE_ID, "no-such-whole"),
              attachToMissingWhole(seeded, MOVED_EDGE_ID, "no-such-whole"),
            ],
          );
          const missing = {
            id: MOVED_EDGE_ID,
            code: "To node not found: IcmWhole:no-such-whole",
          };
          expect(outcome).toEqual({
            edges: UNMOVED,
            counts: { created: 0, updated: 0, skipped: 0 },
            errors: [
              missing,
              {
                id: INCUMBENT,
                code:
                  existence === "optional" ? MOVE_INCOMPLETE : (
                    "COMPOSITION_DETACH_REFUSED"
                  ),
              },
              missing,
            ],
            fenceViolations: 0,
          });
        });

        it("keeps the old attachment when the end is repeated", async () => {
          const outcome = await importByEveryRoute(
            context,
            existence,
            nothingToArrange,
            (seeded) => [
              endIncumbent(seeded, MOVED_AT),
              endIncumbent(seeded, MOVED_AT),
              attachToMissingWhole(seeded, MOVED_EDGE_ID, "no-such-whole"),
            ],
          );
          expect(outcome).toEqual({
            edges: UNMOVED,
            counts: { created: 0, updated: 0, skipped: 0 },
            errors: [
              {
                id: MOVED_EDGE_ID,
                code: "To node not found: IcmWhole:no-such-whole",
              },
              { id: INCUMBENT, code: MOVE_INCOMPLETE },
              { id: INCUMBENT, code: MOVE_INCOMPLETE },
            ],
            fenceViolations: 0,
          });
        });
      });

      it("keeps an attachment the document creates when the row moving it on is refused", async () => {
        // The repeat that ends the created row is applied after every create,
        // so the move's attach is refused against the still-open row first.
        const outcome = await importByEveryRoute(
          context,
          "optional",
          createUnattachedPart,
          (seeded, partId) => {
            const part = { kind: "IcmPart", id: partId };
            const attached = compositionRow(
              "icmPartOf",
              "icm-first",
              part,
              { kind: "IcmWhole", id: seeded.oldWholeId },
              { validFrom: ATTACHED_AT },
            );
            return [
              attached,
              { ...attached, validTo: MOVED_AT },
              compositionRow(
                "icmPartOf",
                "icm-second",
                part,
                { kind: "IcmWhole", id: seeded.newWholeId },
                { validFrom: MOVED_AT },
              ),
            ];
          },
        );
        expect(outcome).toEqual({
          edges: [
            {
              id: "icm-first",
              whole: "old",
              validFrom: ATTACHED_AT,
              validTo: undefined,
            },
            ...UNMOVED,
          ],
          counts: { created: 1, updated: 0, skipped: 0 },
          errors: [
            { id: "icm-second", code: "COMPOSITION_WHOLE_OCCUPIED" },
            { id: "icm-first", code: MOVE_INCOMPLETE },
          ],
          fenceViolations: 0,
        });
      });

      describe("judged from the writes each row applied", () => {
        it("keeps an attachment a repeat creates when a later repeat ends it and the next attach is refused", async () => {
          // The first row for the id is refused, so the repeat creating the
          // attachment and the repeat ending it are the only rows writing it.
          const outcome = await importByEveryRoute(
            context,
            "optional",
            createUnattachedPart,
            (seeded, partId) => {
              const part = { kind: "IcmPart", id: partId };
              const attached = compositionRow(
                "icmPartOf",
                REPLACEMENT_ID,
                part,
                { kind: "IcmWhole", id: seeded.newWholeId },
                { validFrom: MOVED_AT },
              );
              return [
                { ...attached, to: { kind: "IcmWhole", id: "no-such-whole" } },
                attached,
                { ...attached, validTo: LATER },
                {
                  ...attached,
                  id: "icm-next",
                  to: { kind: "IcmWhole", id: "no-such-whole" },
                },
              ];
            },
          );
          expect(outcome).toEqual({
            edges: [
              {
                id: REPLACEMENT_ID,
                whole: "new",
                validFrom: MOVED_AT,
                validTo: undefined,
              },
              ...UNMOVED,
            ],
            counts: { created: 1, updated: 0, skipped: 0 },
            errors: [
              missing(REPLACEMENT_ID),
              missing("icm-next"),
              { id: REPLACEMENT_ID, code: MOVE_INCOMPLETE },
            ],
            fenceViolations: 0,
          });
        });

        it("moves the part and refuses only the end that left it with no whole", async () => {
          const outcome = await importByEveryRoute(
            context,
            "optional",
            nothingToArrange,
            (seeded) => [
              endIncumbent(seeded, MOVED_AT),
              attachToMissingWhole(seeded, REPLACEMENT_ID, "no-such-whole"),
              reattachUnder(seeded, REPLACEMENT_ID),
              { ...reattachUnder(seeded, REPLACEMENT_ID), validTo: LATER },
              attachToMissingWhole(seeded, "icm-next", "no-such-whole"),
            ],
          );
          expect(outcome).toEqual({
            edges: [
              {
                id: REPLACEMENT_ID,
                whole: "new",
                validFrom: MOVED_AT,
                validTo: undefined,
              },
              ...ENDED,
            ],
            counts: { created: 1, updated: 1, skipped: 0 },
            errors: [
              missing(REPLACEMENT_ID),
              missing("icm-next"),
              { id: REPLACEMENT_ID, code: MOVE_INCOMPLETE },
            ],
            fenceViolations: 0,
          });
        });

        it("keeps the history a repeat creates under the id of a refused attachment", async () => {
          // The open attachment is refused because the part holds its
          // incumbent; the repeat then creates ended history before it, which
          // ends nothing.
          const outcome = await importByEveryRoute(
            context,
            "optional",
            nothingToArrange,
            (seeded) => [
              reattachUnder(seeded, REPLACEMENT_ID),
              {
                ...reattachUnder(seeded, REPLACEMENT_ID),
                validFrom: EARLIER,
                validTo: ATTACHED_AT,
              },
              attachToMissingWhole(seeded, "icm-next", "no-such-whole"),
            ],
          );
          expect(outcome).toEqual({
            edges: [
              {
                id: REPLACEMENT_ID,
                whole: "new",
                validFrom: EARLIER,
                validTo: ATTACHED_AT,
              },
              ...UNMOVED,
            ],
            counts: { created: 1, updated: 0, skipped: 0 },
            errors: [
              missing("icm-next"),
              { id: REPLACEMENT_ID, code: "COMPOSITION_WHOLE_OCCUPIED" },
            ],
            fenceViolations: 0,
          });
        });

        it("moves the part to a replacement whose refused repeat would have ended it", async () => {
          // The repeat would end the replacement before it opened, so it is
          // refused, and the replacement still attaches the part.
          const outcome = await importByEveryRoute(
            context,
            "optional",
            nothingToArrange,
            (seeded) => [
              endIncumbent(seeded, MOVED_AT),
              reattachUnder(seeded, REPLACEMENT_ID),
              {
                ...reattachUnder(seeded, REPLACEMENT_ID),
                validFrom: undefined,
                validTo: EARLIER,
              },
              attachToMissingWhole(seeded, "icm-next", "no-such-whole"),
              attachToMissingWhole(seeded, "icm-other", "no-such-whole"),
            ],
          );
          expect(outcome).toEqual({
            edges: [
              {
                id: REPLACEMENT_ID,
                whole: "new",
                validFrom: MOVED_AT,
                validTo: undefined,
              },
              ...ENDED,
            ],
            counts: { created: 1, updated: 1, skipped: 0 },
            errors: [
              missing("icm-next"),
              missing("icm-other"),
              { id: REPLACEMENT_ID, code: "INVERTED_VALIDITY_WINDOW" },
            ],
            fenceViolations: 0,
          });
        });
      });

      describe("a lone end the document states on purpose is written", () => {
        it("when a refused row names the ended edge itself", async () => {
          // The refused row restates the incumbent open; it is the edge being
          // ended, not a row attaching the part anywhere else.
          const outcome = await importByEveryRoute(
            context,
            "optional",
            nothingToArrange,
            (seeded) => [
              {
                ...endIncumbent(seeded, MOVED_AT),
                validTo: undefined,
                properties: { note: 5 },
              },
              endIncumbent(seeded, MOVED_AT),
            ],
          );
          expect(outcome).toEqual({
            edges: ENDED,
            counts: { created: 0, updated: 1, skipped: 0 },
            errors: [
              {
                id: INCUMBENT,
                code: "note: Invalid input: expected string, received number",
              },
            ],
            fenceViolations: 0,
          });
        });

        it("when the refused row is ended history, not an attachment", async () => {
          const outcome = await importByEveryRoute(
            context,
            "optional",
            nothingToArrange,
            (seeded) => [
              endIncumbent(seeded, MOVED_AT),
              {
                ...attachToMissingWhole(seeded, "icm-history", "no-such-whole"),
                validFrom: EARLIER,
                validTo: ATTACHED_AT,
              },
            ],
          );
          expect(outcome).toEqual({
            edges: ENDED,
            counts: { created: 0, updated: 1, skipped: 0 },
            errors: [
              {
                id: "icm-history",
                code: "To node not found: IcmWhole:no-such-whole",
              },
            ],
            fenceViolations: 0,
          });
        });
      });
    });

    describe("importGraphStream", () => {
      it("refuses the first half of a move split across chunks", async () => {
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
        ).rejects.toThrow(/already has a whole/u);
        const committed = await seeded.store.edges.icmPartOf.find({});
        expect(committed.map((edge) => edge.toId)).toEqual([seeded.oldWholeId]);
      });
    });
  });
}
