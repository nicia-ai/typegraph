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
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
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

type Population = "oneActive" | "one";
type Existence = "optional" | "required";
const ORDERS = ["endFirst", "attachFirst"] as const;
type Order = (typeof ORDERS)[number];
const BATCH_SIZES = [1, 1000] as const;

const ATTACHED_AT = "2020-01-01T00:00:00.000Z";
const MOVED_AT = "2021-01-01T00:00:00.000Z";

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

function errorCode(message: string): string {
  return /^[A-Z][A-Z_]+(?=:)/u.exec(message)?.[0] ?? message;
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

export function registerImportCompositionMoveIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("import: a composition move re-imported with onConflict update", () => {
    describe.each(ORDERS)("oneActive optional, %s", (order) => {
      it("ends the old attachment and opens the new one at every batch size", async () => {
        const outcome = await importAtEveryBatchSize(
          context,
          "oneActive",
          "optional",
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
    });
  });
}
