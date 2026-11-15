/**
 * The store's acyclicity verdicts must equal an in-memory DFS oracle.
 *
 * The first property probes one candidate edge against a random DAG — the
 * case that catches an off-by-one in the reflexive seed or a wrong join
 * direction.
 *
 * The second runs random write sequences — single creates, batches (whose
 * rows may close a cycle only through each other), transactions of creates
 * across edge kinds, soft deletes, window ends and reopens — over two acyclic
 * relations sharing one node set:
 *
 * - the composition relation, the union of three realizing edge kinds walked
 *   part -> whole: `fcFolderOf` and `fcFiledIn` (part `from`) and
 *   `fcContains` (part `to`, the reversed member). Its `oneActive` rows count
 *   only while open, except `fcFiledIn`'s, which is also declared
 *   `acyclic: true` and so counts every non-deleted row;
 * - the standalone `fcLinksTo` relation, which counts every non-deleted row
 *   and never combines with the composition relation.
 *
 * The oracle rebuilds both relations from a plain model of the rows and asks
 * whether the write's resulting state has a cycle: the store must refuse
 * exactly those writes with `EdgeAcyclicityError`, and a refused write must
 * leave every row as it was.
 *
 * Every composition kind here is `oneActive`, so one part's composition rows
 * may never share a valid-time instant either. Rows carry real windows — a
 * history row in one of a few consecutive past years, an open row from a
 * later year — so a part can hold history beside its current row (the shape
 * that keeps a former descendant movable under it), and a write that would
 * overlap two of a part's windows is generated too. The oracle predicts that
 * refusal (`COMPOSITION_WINDOW_OVERLAP`) separately from the cycle verdict, in
 * the order the store decides them: a write's cycle first, then its windows.
 * Writes that would be refused for a part's current whole (the one-open-row
 * claim) are not generated, so cycle and window verdicts are the ones under
 * test.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  hasPart,
  partOf,
} from "../../src";
import { createLocalPgliteBackend } from "../../src/backend/postgres/pglite";
import { type GraphBackend } from "../../src/backend/types";
import { CompositionError, EdgeAcyclicityError } from "../../src/errors";
import { type ValidityEndMutation } from "../../src/store/types";
import { compareStrings } from "../../src/utils/compare";
import { requireDefined } from "../../src/utils/presence";
import { createTestBackend } from "../test-utils";
import { propertyRuns } from "./run-budget";

const Node = defineNode("Node", { schema: z.object({}) });
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });

const graph = defineGraph({
  id: "property_edge_acyclicity",
  nodes: { Node: { type: Node } },
  edges: {
    dependsOn: {
      type: dependsOn,
      from: [Node],
      to: [Node],
      acyclic: true,
    },
  },
});

/** A random DAG over node indices 0..nodeCount-1: every edge goes low -> high, so it is acyclic by construction. */
const dagArbitrary = fc.integer({ min: 2, max: 12 }).chain((nodeCount) =>
  fc.record({
    nodeCount: fc.constant(nodeCount),
    edges: fc.uniqueArray(
      fc
        .tuple(
          fc.integer({ min: 0, max: nodeCount - 1 }),
          fc.integer({ min: 0, max: nodeCount - 1 }),
        )
        .filter(([from, to]) => from < to)
        .map(([from, to]) => ({ from, to })),
      { selector: (edge) => `${edge.from}\0${edge.to}` },
    ),
    candidate: fc.tuple(
      fc.integer({ min: 0, max: nodeCount - 1 }),
      fc.integer({ min: 0, max: nodeCount - 1 }),
    ),
  }),
);

type Arc = Readonly<{ from: number; to: number }>;

/** DFS reachability oracle: does `to` reach `from` over `arcs`? */
function reachesOracle(
  arcs: readonly Arc[],
  from: number,
  to: number,
): boolean {
  if (from === to) return true;
  const adjacency = new Map<number, number[]>();
  for (const arc of arcs) {
    const targets = adjacency.get(arc.from) ?? [];
    targets.push(arc.to);
    adjacency.set(arc.from, targets);
  }
  const stack = [to];
  const seen = new Set<number>([to]);
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current === from) return true;
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return false;
}

/** Whether `arcs` contain a directed cycle (a self-loop included). */
function hasCycleOracle(arcs: readonly Arc[]): boolean {
  return arcs.some((arc, index) =>
    reachesOracle(
      arcs.filter((_, other) => other !== index),
      arc.from,
      arc.to,
    ),
  );
}

describe("edge acyclicity: property", () => {
  it("agrees with a DFS reachability oracle over random DAGs and candidate edges", async () => {
    await fc.assert(
      fc.asyncProperty(
        dagArbitrary,
        async ({ nodeCount, edges, candidate }) => {
          const backend = createTestBackend();
          const store = createStore(graph, backend);
          const nodes = await store.nodes.Node.bulkCreate(
            Array.from({ length: nodeCount }, () => ({ props: {} })),
          );
          await store.edges.dependsOn.bulkCreate(
            edges.map((edge) => ({
              from: requireDefined(nodes[edge.from]),
              to: requireDefined(nodes[edge.to]),
            })),
          );

          const [candidateFrom, candidateTo] = candidate;
          const expectRefusal = reachesOracle(
            edges,
            candidateFrom,
            candidateTo,
          );

          let refused = false;
          try {
            await store.edges.dependsOn.create(
              requireDefined(nodes[candidateFrom]),
              requireDefined(nodes[candidateTo]),
            );
          } catch (error) {
            if (!(error instanceof EdgeAcyclicityError)) throw error;
            refused = true;
          }

          expect(refused).toBe(expectRefusal);
        },
      ),
      { numRuns: propertyRuns({ ci: 60, local: 200 }) },
    );
  }, 60_000);
});

// ============================================================
// Write sequences over a composition relation and a standalone relation
// ============================================================

const Folder = defineNode("Folder", { schema: z.object({}) });
const fcFolderOf = defineEdge("fcFolderOf", { schema: z.object({}) });
const fcFiledIn = defineEdge("fcFiledIn", { schema: z.object({}) });
const fcContains = defineEdge("fcContains", { schema: z.object({}) });
const fcLinksTo = defineEdge("fcLinksTo", { schema: z.object({}) });

function buildSequenceGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Folder: { type: Folder } },
    edges: {
      fcFolderOf: {
        type: fcFolderOf,
        from: [Folder],
        to: [Folder],
        cardinality: "oneActive",
      },
      fcFiledIn: {
        type: fcFiledIn,
        from: [Folder],
        to: [Folder],
        cardinality: "oneActive",
        acyclic: true,
      },
      fcContains: {
        type: fcContains,
        from: [Folder],
        to: [Folder],
        targetCardinality: "oneActive",
      },
      fcLinksTo: {
        type: fcLinksTo,
        from: [Folder],
        to: [Folder],
        acyclic: true,
      },
    },
    ontology: [
      partOf(Folder, Folder, { via: fcFolderOf, partSide: "from" }),
      partOf(Folder, Folder, { via: fcFiledIn, partSide: "from" }),
      hasPart(Folder, Folder, { via: fcContains, partSide: "to" }),
    ],
  });
}

type SequenceGraph = ReturnType<typeof buildSequenceGraph>;

const EDGE_KINDS = [
  "fcFolderOf",
  "fcFiledIn",
  "fcContains",
  "fcLinksTo",
] as const;
type SequenceEdgeKind = (typeof EDGE_KINDS)[number];

const COMPOSITION_KINDS: ReadonlySet<SequenceEdgeKind> = new Set([
  "fcFolderOf",
  "fcFiledIn",
  "fcContains",
]);
/** Composition kinds whose ended rows still count: also declared `acyclic: true`. */
const ALL_ROWS_COMPOSITION_KINDS: ReadonlySet<SequenceEdgeKind> = new Set([
  "fcFiledIn",
]);

const FOLDER_COUNT = 5;
/**
 * The windows rows are written with. A history row takes one past year,
 * `[HISTORY_YEARS[slot], HISTORY_YEARS[slot + 1])`, so two history rows of a
 * part overlap exactly when they share a slot, and consecutive slots abut. An
 * open row starts at {@link OPEN_FROM}, after every history year; ending it
 * sets {@link ENDED_AT}.
 */
const HISTORY_YEARS = [
  "1990-01-01T00:00:00.000Z",
  "1991-01-01T00:00:00.000Z",
  "1992-01-01T00:00:00.000Z",
  "1993-01-01T00:00:00.000Z",
] as const;
const HISTORY_SLOTS = HISTORY_YEARS.length - 1;
const OPEN_FROM = "2000-01-01T00:00:00.000Z";
const ENDED_AT = "2010-01-01T00:00:00.000Z";

interface ModelEdge {
  readonly id: string;
  readonly kind: SequenceEdgeKind;
  readonly from: number;
  readonly to: number;
  readonly validFrom: string;
  validTo: string | undefined;
  ended: boolean;
  deleted: boolean;
}

type Model = Readonly<{ edges: ModelEdge[] }>;

type ProposedEdge = Readonly<{
  kind: SequenceEdgeKind;
  from: number;
  to: number;
  ended: boolean;
  /** Which history year an ended row takes; ignored for an open row. */
  slot: number;
}>;

/** The part of a composition row: `from` for a part-`from` kind, `to` for the reversed `fcContains`. */
function partIndex(
  edge: Readonly<{ kind: SequenceEdgeKind; from: number; to: number }>,
): number {
  return edge.kind === "fcContains" ? edge.to : edge.from;
}

function wholeOf(
  edge: Readonly<{ kind: SequenceEdgeKind; from: number; to: number }>,
): number {
  return edge.kind === "fcContains" ? edge.from : edge.to;
}

function compositionCounts(edge: ModelEdge): boolean {
  return (
    COMPOSITION_KINDS.has(edge.kind) &&
    !edge.deleted &&
    (!edge.ended || ALL_ROWS_COMPOSITION_KINDS.has(edge.kind))
  );
}

/** Whether either relation, rebuilt from the model's rows, has a cycle. */
function modelHasCycle(edges: readonly ModelEdge[]): boolean {
  const composition = edges
    .filter((edge) => compositionCounts(edge))
    .map((edge) => ({ from: partIndex(edge), to: wholeOf(edge) }));
  const linksTo = edges
    .filter((edge) => edge.kind === "fcLinksTo" && !edge.deleted)
    .map((edge) => ({ from: edge.from, to: edge.to }));
  return hasCycleOracle(composition) || hasCycleOracle(linksTo);
}

/**
 * The window rule: one part's non-deleted composition rows never share a
 * valid-time instant. Windows are half-open `[validFrom, validTo)`; the
 * canonical ISO strings compare chronologically.
 */
function modelHasWindowOverlap(edges: readonly ModelEdge[]): boolean {
  const rows = edges.filter(
    (edge) => COMPOSITION_KINDS.has(edge.kind) && !edge.deleted,
  );
  return rows.some((row, index) =>
    rows
      .slice(index + 1)
      .some(
        (other) =>
          partIndex(other) === partIndex(row) &&
          row.validFrom < (other.validTo ?? "~") &&
          other.validFrom < (row.validTo ?? "~"),
      ),
  );
}

/** What the store must answer a write that leaves `edges`: its cycle first, then its windows. */
type Verdict = "accepted" | "cycle" | "windowOverlap";

function expectedVerdict(edges: readonly ModelEdge[]): Verdict {
  if (modelHasCycle(edges)) return "cycle";
  if (modelHasWindowOverlap(edges)) return "windowOverlap";
  return "accepted";
}

/** The parts that hold a whole through an open composition row (the composition claim). */
function heldParts(edges: readonly ModelEdge[]): Set<number> {
  return new Set(
    edges
      .filter(
        (edge) =>
          COMPOSITION_KINDS.has(edge.kind) && !edge.deleted && !edge.ended,
      )
      .map((edge) => partIndex(edge)),
  );
}

/**
 * Whether `proposed` claims no part twice and no part that already has a
 * whole: the only shape in which the composition claim cannot refuse first.
 */
function claimsAreFree(
  model: Model,
  proposed: readonly ProposedEdge[],
): boolean {
  const held = heldParts(model.edges);
  for (const edge of proposed) {
    if (!COMPOSITION_KINDS.has(edge.kind) || edge.ended) continue;
    const part = partIndex(edge);
    if (held.has(part)) return false;
    held.add(part);
  }
  return true;
}

const folderIndex = fc.integer({ min: 0, max: FOLDER_COUNT - 1 });
const proposedEdgeArbitrary = (kind: fc.Arbitrary<SequenceEdgeKind>) =>
  fc.record({
    kind,
    from: folderIndex,
    to: folderIndex,
    ended: fc.boolean(),
    slot: fc.integer({ min: 0, max: HISTORY_SLOTS - 1 }),
  });

const anyKind = fc.constantFrom(...EDGE_KINDS);

type Operation =
  | Readonly<{ op: "create"; edge: ProposedEdge }>
  | Readonly<{
      op: "bulkCreate";
      kind: SequenceEdgeKind;
      edges: readonly ProposedEdge[];
    }>
  | Readonly<{ op: "transaction"; edges: readonly ProposedEdge[] }>
  | Readonly<{ op: "delete"; pick: number }>
  | Readonly<{ op: "end"; pick: number }>
  | Readonly<{ op: "reopen"; pick: number }>;

const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
  {
    weight: 4,
    arbitrary: proposedEdgeArbitrary(anyKind).map(
      (edge) => ({ op: "create", edge }) as const,
    ),
  },
  {
    weight: 2,
    arbitrary: anyKind.chain((kind) =>
      fc
        .array(proposedEdgeArbitrary(fc.constant(kind)), {
          minLength: 2,
          maxLength: 4,
        })
        .map((edges) => ({ op: "bulkCreate", kind, edges }) as const),
    ),
  },
  {
    weight: 1,
    arbitrary: fc
      .array(
        proposedEdgeArbitrary(anyKind).map((edge) => ({
          ...edge,
          ended: false,
        })),
        { minLength: 2, maxLength: 3 },
      )
      .map((edges) => ({ op: "transaction", edges }) as const),
  },
  {
    weight: 1,
    arbitrary: fc.nat().map((pick) => ({ op: "delete", pick }) as const),
  },
  {
    weight: 1,
    arbitrary: fc.nat().map((pick) => ({ op: "end", pick }) as const),
  },
  {
    weight: 2,
    arbitrary: fc.nat().map((pick) => ({ op: "reopen", pick }) as const),
  },
);

type SequenceStore = Awaited<
  ReturnType<typeof createStoreWithSchema<SequenceGraph>>
>[0];

type FolderRef = Readonly<{ kind: "Folder"; id: string }>;

function folderRef(index: number): FolderRef {
  return { kind: "Folder", id: `folder-${index}` };
}

function edgeWindow(
  edge: ProposedEdge,
): Readonly<{ validFrom: string; validTo?: string }> {
  return edge.ended ?
      {
        validFrom: requireDefined(HISTORY_YEARS[edge.slot]),
        validTo: requireDefined(HISTORY_YEARS[edge.slot + 1]),
      }
    : { validFrom: OPEN_FROM };
}

function createOne(
  store:
    SequenceStore | Parameters<Parameters<SequenceStore["transaction"]>[0]>[0],
  edge: ProposedEdge,
): Promise<Readonly<{ id: string }>> {
  return store.edges[edge.kind].create(
    folderRef(edge.from),
    folderRef(edge.to),
    {},
    edgeWindow(edge),
  );
}

/**
 * The id-taking writes for a row the model names by kind. Stored ids are
 * branded per edge kind, so each kind's collection is reached by name.
 */
function edgeWrites(
  store: SequenceStore,
  kind: SequenceEdgeKind,
): Readonly<{
  delete: (id: string) => Promise<void>;
  update: (id: string, options: ValidityEndMutation) => Promise<unknown>;
}> {
  switch (kind) {
    case "fcFolderOf": {
      const edges = store.edges.fcFolderOf;
      return {
        delete: (id) => edges.delete(asEdgeId<typeof fcFolderOf>(id)),
        update: (id, options) =>
          edges.update(asEdgeId<typeof fcFolderOf>(id), {}, options),
      };
    }
    case "fcFiledIn": {
      const edges = store.edges.fcFiledIn;
      return {
        delete: (id) => edges.delete(asEdgeId<typeof fcFiledIn>(id)),
        update: (id, options) =>
          edges.update(asEdgeId<typeof fcFiledIn>(id), {}, options),
      };
    }
    case "fcContains": {
      const edges = store.edges.fcContains;
      return {
        delete: (id) => edges.delete(asEdgeId<typeof fcContains>(id)),
        update: (id, options) =>
          edges.update(asEdgeId<typeof fcContains>(id), {}, options),
      };
    }
    case "fcLinksTo": {
      const edges = store.edges.fcLinksTo;
      return {
        delete: (id) => edges.delete(asEdgeId<typeof fcLinksTo>(id)),
        update: (id, options) =>
          edges.update(asEdgeId<typeof fcLinksTo>(id), {}, options),
      };
    }
  }
}

/** Runs `write`, answering how the store judged it. Any other error fails the property. */
async function verdictOf(write: () => Promise<unknown>): Promise<Verdict> {
  try {
    await write();
    return "accepted";
  } catch (error) {
    if (error instanceof EdgeAcyclicityError) return "cycle";
    if (
      error instanceof CompositionError &&
      error.code === "COMPOSITION_WINDOW_OVERLAP"
    ) {
      return "windowOverlap";
    }
    throw error;
  }
}

/** Every stored row of every kind, as the model spells it. */
async function storedRows(store: SequenceStore): Promise<readonly string[]> {
  const rows: string[] = [];
  for (const kind of EDGE_KINDS) {
    const edges = await store.edges[kind].find(
      {},
      { temporalMode: "includeTombstones" },
    );
    for (const edge of edges) {
      rows.push(
        describeRow({
          id: edge.id,
          kind,
          from: Number(edge.fromId.slice("folder-".length)),
          to: Number(edge.toId.slice("folder-".length)),
          validFrom: edge.meta.validFrom ?? "unbounded",
          validTo: edge.meta.validTo,
          ended: edge.meta.validTo !== undefined,
          deleted: edge.meta.deletedAt !== undefined,
        }),
      );
    }
  }
  return rows.toSorted(compareStrings);
}

function describeRow(edge: ModelEdge): string {
  const state =
    edge.deleted ? "deleted"
    : edge.ended ? "ended"
    : "open";
  return `${edge.kind}:${edge.id} ${edge.from}->${edge.to} [${edge.validFrom}, ${edge.validTo ?? "open"}) ${state}`;
}

function modelRows(model: Model): readonly string[] {
  return model.edges.map((edge) => describeRow(edge)).toSorted(compareStrings);
}

function newModelEdge(id: string, edge: ProposedEdge): ModelEdge {
  const window = edgeWindow(edge);
  return {
    id,
    kind: edge.kind,
    from: edge.from,
    to: edge.to,
    validFrom: window.validFrom,
    validTo: window.validTo,
    ended: edge.ended,
    deleted: false,
  };
}

/**
 * Applies `operation` to the store and the model. Returns a description of
 * the step for a failure message, or `undefined` when the operation does not
 * apply to the current state (and was skipped).
 */
async function applyOperation(
  store: SequenceStore,
  model: Model,
  operation: Operation,
): Promise<string | undefined> {
  switch (operation.op) {
    case "create": {
      if (!claimsAreFree(model, [operation.edge])) return undefined;
      const expected = expectedVerdict([
        ...model.edges,
        newModelEdge("proposed", operation.edge),
      ]);
      let created: Readonly<{ id: string }> | undefined;
      const verdict = await verdictOf(async () => {
        created = await createOne(store, operation.edge);
      });
      expect({
        step: `create ${JSON.stringify(operation.edge)}`,
        verdict,
      }).toEqual({
        step: `create ${JSON.stringify(operation.edge)}`,
        verdict: expected,
      });
      if (created !== undefined) {
        model.edges.push(newModelEdge(created.id, operation.edge));
      }
      return `create ${JSON.stringify(operation.edge)}`;
    }
    case "bulkCreate": {
      if (!claimsAreFree(model, operation.edges)) return undefined;
      const expected = expectedVerdict([
        ...model.edges,
        ...operation.edges.map((edge, index) =>
          newModelEdge(`proposed-${index}`, edge),
        ),
      ]);
      let created: readonly Readonly<{ id: string }>[] = [];
      const verdict = await verdictOf(async () => {
        created = await store.edges[operation.kind].bulkCreate(
          operation.edges.map((edge) => ({
            from: folderRef(edge.from),
            to: folderRef(edge.to),
            ...edgeWindow(edge),
          })),
        );
      });
      expect({
        step: `bulkCreate ${JSON.stringify(operation.edges)}`,
        verdict,
      }).toEqual({
        step: `bulkCreate ${JSON.stringify(operation.edges)}`,
        verdict: expected,
      });
      for (const [index, edge] of created.entries()) {
        model.edges.push(
          newModelEdge(edge.id, requireDefined(operation.edges[index])),
        );
      }
      return `bulkCreate ${JSON.stringify(operation.edges)}`;
    }
    case "transaction": {
      if (!claimsAreFree(model, operation.edges)) return undefined;
      // The creates run one after another, so the first one refused decides
      // the transaction's verdict, judged on the rows written before it.
      const expected =
        operation.edges
          .map((_, index) =>
            expectedVerdict([
              ...model.edges,
              ...operation.edges
                .slice(0, index + 1)
                .map((edge, position) =>
                  newModelEdge(`proposed-${position}`, edge),
                ),
            ]),
          )
          .find((stepVerdict) => stepVerdict !== "accepted") ?? "accepted";
      const created: Readonly<{ id: string }>[] = [];
      const verdict = await verdictOf(() =>
        store.transaction(async (tx) => {
          for (const edge of operation.edges) {
            created.push(await createOne(tx, edge));
          }
        }),
      );
      expect({
        step: `transaction ${JSON.stringify(operation.edges)}`,
        verdict,
      }).toEqual({
        step: `transaction ${JSON.stringify(operation.edges)}`,
        verdict: expected,
      });
      if (verdict === "accepted") {
        for (const [index, edge] of created.entries()) {
          model.edges.push(
            newModelEdge(edge.id, requireDefined(operation.edges[index])),
          );
        }
      }
      return `transaction ${JSON.stringify(operation.edges)}`;
    }
    case "delete": {
      const live = model.edges.filter((edge) => !edge.deleted);
      const target = live[operation.pick % Math.max(live.length, 1)];
      if (target === undefined) return undefined;
      await edgeWrites(store, target.kind).delete(target.id);
      target.deleted = true;
      return `delete ${describeRow(target)}`;
    }
    case "end": {
      const open = model.edges.filter(
        (edge) =>
          !edge.deleted && !edge.ended && COMPOSITION_KINDS.has(edge.kind),
      );
      const target = open[operation.pick % Math.max(open.length, 1)];
      if (target === undefined) return undefined;
      await edgeWrites(store, target.kind).update(target.id, {
        validTo: ENDED_AT,
      });
      target.ended = true;
      target.validTo = ENDED_AT;
      return `end ${describeRow(target)}`;
    }
    case "reopen": {
      const ended = model.edges.filter(
        (edge) =>
          !edge.deleted && edge.ended && COMPOSITION_KINDS.has(edge.kind),
      );
      const target = ended[operation.pick % Math.max(ended.length, 1)];
      if (target === undefined) return undefined;
      const reopened = { ...target, ended: false, validTo: undefined };
      if (!claimsAreFree(model, [{ ...reopened, slot: 0 }])) return undefined;
      const expected = expectedVerdict(
        model.edges.map((edge) => (edge === target ? reopened : edge)),
      );
      const verdict = await verdictOf(() =>
        edgeWrites(store, target.kind).update(target.id, {
          clearValidTo: true,
        }),
      );
      expect({ step: `reopen ${describeRow(target)}`, verdict }).toEqual({
        step: `reopen ${describeRow(target)}`,
        verdict: expected,
      });
      if (verdict === "accepted") {
        target.ended = false;
        target.validTo = undefined;
      }
      return `reopen ${describeRow(target)}`;
    }
  }
}

let sequenceGraphCounter = 0;

async function runSequence(
  backend: GraphBackend,
  operations: readonly Operation[],
): Promise<void> {
  sequenceGraphCounter += 1;
  const [store] = await createStoreWithSchema(
    buildSequenceGraph(`property_acyclic_sequence_${sequenceGraphCounter}`),
    backend,
  );
  await store.nodes.Folder.bulkCreate(
    Array.from({ length: FOLDER_COUNT }, (_, index) => ({
      id: folderRef(index).id,
      props: {},
    })),
  );
  const model: Model = { edges: [] };
  const steps: string[] = [];
  for (const operation of operations) {
    const step = await applyOperation(store, model, operation);
    if (step === undefined) continue;
    steps.push(step);
    expect({ steps, rows: await storedRows(store) }).toEqual({
      steps,
      rows: modelRows(model),
    });
  }
  expect({ steps, violations: await store.verifyConstraintFences() }).toEqual({
    steps,
    violations: [],
  });
}

const sequenceArbitrary = fc.array(operationArbitrary, {
  minLength: 4,
  maxLength: 16,
});

describe("edge acyclicity: write sequences over a composition and a standalone relation", () => {
  it("refuses exactly the writes whose resulting state has a cycle (SQLite)", async () => {
    await fc.assert(
      fc.asyncProperty(sequenceArbitrary, async (operations) => {
        const backend = createTestBackend();
        try {
          await runSequence(backend, operations);
        } finally {
          await backend.close();
        }
      }),
      { numRuns: propertyRuns({ ci: 150, local: 300 }) },
    );
  }, 120_000);

  it("refuses exactly the writes whose resulting state has a cycle (PGlite)", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    try {
      await fc.assert(
        fc.asyncProperty(sequenceArbitrary, (operations) =>
          runSequence(backend, operations),
        ),
        { numRuns: propertyRuns({ ci: 25, local: 50 }) },
      );
    } finally {
      await backend.close();
    }
  }, 180_000);
});
