/**
 * Refusal precedence for a single-edge create, with what survives, on every
 * backend.
 *
 * Eight refusal causes a create can meet: a dead endpoint, a taken source
 * axis, a taken target axis, a duplicate id, invalid props, a cycle in an
 * acyclic relation, a composition window conflict, and a durable identity
 * conflict. For each cause alone and each pair that one create can meet at
 * once, a case pins which error the Store raises — a cardinality refusal
 * with its direction and the incumbent it names — and the complete edge and
 * claim state afterwards, read from outside through the lane's own backend
 * and compared with the state before plus exactly the rows the create should
 * add. Every case runs at the root and inside `store.transaction()` with the
 * error caught and the transaction left to commit.
 *
 * A refused create should leave no row behind and remove none. Where a lane
 * does not — or where lanes, or paths on one lane, disagree on the winning
 * error — the case states the correct outcome and, per known defect, the
 * lanes it affects and the exact outcome main produces there today
 * (`tests/helpers/known-defect.ts`), labelled with the issue (#946) or the
 * design note's divergence (`D1`, `D2`, and `D7`, which the note does not
 * list). A fix that closes one fails the case with "defect fixed, flip this
 * marker" until the marker is removed.
 *
 * Pairs no single create can meet are listed with the reason in
 * {@link UNCONSTRUCTIBLE_PAIRS}, so the matrix stays total.
 */
import { describe, expect, it } from "vitest";

import { asNodeId } from "../../../src";
import { FORMAT_VERSION, importGraph } from "../../../src/interchange";
import {
  buildEdgeCreatePathGraph,
  CASE_RECEIVERS,
  caseLane,
  type CreateDefect,
  type EdgeCreatePathStore,
  type EdgeCreatePathSurface,
  expectCreateOutcome,
  ITEM,
  nextEdgeCreatePathGraphId,
  observeCreate,
  PART,
  seedEdgeCreatePathGraph,
  WHOLE,
} from "./edge-create-path-fixture";
import { type IntegrationTestContext } from "./test-context";

type RefusalCause =
  | "dead"
  | "source"
  | "target"
  | "dupId"
  | "props"
  | "cycle"
  | "composition"
  | "identity";

const INVALID = { label: "x", weight: "heavy" as unknown as number } as const;

// The refusals, as `settle` renders them.
const ENDPOINT = "EndpointNotFoundError[ENDPOINT_NOT_FOUND]";
const DUPLICATE_ID = "ValidationError[VALIDATION_ERROR] at id";
const INVALID_PROPS = "ValidationError[VALIDATION_ERROR] at weight";
const CYCLE = "EdgeAcyclicityError[EDGE_ACYCLICITY_ERROR]";
const WINDOW_OVERLAP = "CompositionError[COMPOSITION_WINDOW_OVERLAP]";
const WHOLE_OCCUPIED = "CompositionError[COMPOSITION_WHOLE_OCCUPIED]";
const IDENTITY = "EdgeMatchIdentityConflictError[EDGE_MATCH_IDENTITY_CONFLICT]";

/** A cardinality refusal on `direction`, naming `incumbent` as the holder. */
function cardinality(
  direction: "source" | "target",
  incumbent: string,
): string {
  return `CardinalityError[CARDINALITY_ERROR] ${direction} incumbent=${incumbent}`;
}

/**
 * #946: on a port without the fused claim insert (both SQLite drivers), the
 * session claims before the endpoint-predicated retry, so a taken axis
 * refuses before the dead endpoint is seen.
 */
function issue946(today: string): CreateDefect {
  return {
    label: "#946",
    on: { dialect: ["sqlite"] },
    today: { error: today },
  };
}

/**
 * D1: a durable-identity kind with a cardinality probes the axis before
 * any endpoint read (`probesCardinalityBeforeWrite`), on every lane; every
 * other create path reports the dead endpoint.
 */
function d1DurableProbeFirst(today: string): CreateDefect {
  return { label: "D1", on: {}, today: { error: today } };
}

/**
 * D2: on the SQLite drivers a refused one-axis create leaves the claim it
 * issued before its row was refused; with the error caught inside
 * `store.transaction` that claim commits.
 */
function d2ClaimResidue(
  error: string,
  claims: readonly string[],
): CreateDefect {
  return {
    label: "D2",
    on: { dialect: ["sqlite"], receiver: ["transaction"] },
    today: { error, added: { edges: [], claims } },
  };
}

/**
 * D7 (not in the design note): on PostgreSQL a duplicate-id INSERT fails
 * inside the caller's transaction with no savepoint around it, so catching
 * the refusal cannot keep the transaction: the sentinel is lost. The
 * transaction reports it, rejecting with `TransactionRolledBackError` on
 * every driver.
 */
const D7_POISONED_TRANSACTION: readonly CreateDefect[] = [
  {
    label: "D7",
    on: {
      lane: ["PGlite", "PostgreSQL", "PostgreSQL (postgres-js)"],
      receiver: ["transaction"],
    },
    today: {
      error: DUPLICATE_ID,
      commit: "TransactionRolledBackError[TRANSACTION_ROLLED_BACK]",
      sentinel: "lost",
    },
  },
];

/** Born ended: a window that closed before any case runs. */
const ENDED = {
  validFrom: "2019-01-01T00:00:00.000Z",
  validTo: "2019-06-01T00:00:00.000Z",
} as const;

const SECTION = {
  a: { kind: "MxSection", id: "s-a" },
  b: { kind: "MxSection", id: "s-b" },
  c: { kind: "MxSection", id: "s-c" },
} as const;

const CHAPTER = {
  a: { kind: "MxChapter", id: "k-a" },
  b: { kind: "MxChapter", id: "k-b" },
} as const;

const HOLDER = {
  h1: { kind: "MxHolder", id: "h1" },
  h2: { kind: "MxHolder", id: "h2" },
} as const;

const HELD = {
  x1: { kind: "MxHeld", id: "x1" },
  x2: { kind: "MxHeld", id: "x2" },
} as const;

/**
 * Reflexive composition: `n-ab` attaches s-a to s-b and `n-ca` s-c to s-a,
 * so s-a→s-c both overlaps s-a's open attachment and closes s-a→s-c→s-a.
 */
async function seedNestedSections(store: EdgeCreatePathStore): Promise<void> {
  await store.transaction(async (tx) => {
    for (const section of Object.values(SECTION)) {
      await tx.nodes.MxSection.create({}, { id: section.id });
    }
    await tx.edges.mxNest.create(
      SECTION.a,
      SECTION.b,
      { label: "ab" },
      { id: "n-ab" },
    );
    await tx.edges.mxNest.create(
      SECTION.c,
      SECTION.a,
      { label: "ca" },
      { id: "n-ca" },
    );
  });
}

/**
 * Reflexive composition with a durable identity: `c-ab` k-a→k-b labelled
 * `ab` is born ended, so it holds its identity but neither k-a's
 * attachment nor a place in the composition relation's open population;
 * `c-ba` k-b→k-a is open. A k-a→k-b `ab` create then repeats `c-ab`'s
 * identity and closes k-a→k-b→k-a, on a free attachment.
 */
async function seedEndedChapterIdentity(
  store: EdgeCreatePathStore,
): Promise<void> {
  await store.transaction(async (tx) => {
    for (const chapter of Object.values(CHAPTER)) {
      await tx.nodes.MxChapter.create({}, { id: chapter.id });
    }
    await tx.edges.mxChapterNest.create(
      CHAPTER.a,
      CHAPTER.b,
      { label: "ab" },
      { id: "c-ab", ...ENDED },
    );
    await tx.edges.mxChapterNest.create(
      CHAPTER.b,
      CHAPTER.a,
      { label: "ba" },
      { id: "c-ba" },
    );
  });
}

/**
 * `hasPart` with the part on the target side: `h-1` h1→x1 and `h-2` h2→x2.
 * h1→x2 then meets h1's taken source axis (`one`) and x2's open attachment.
 */
async function seedHolders(store: EdgeCreatePathStore): Promise<void> {
  await store.transaction(async (tx) => {
    for (const holder of Object.values(HOLDER)) {
      await tx.nodes.MxHolder.create({}, { id: holder.id });
    }
    for (const held of Object.values(HELD)) {
      await tx.nodes.MxHeld.create({}, { id: held.id });
    }
    await tx.edges.mxHolds.create(
      HOLDER.h1,
      HELD.x1,
      { label: "h1" },
      { id: "h-1" },
    );
    await tx.edges.mxHolds.create(
      HOLDER.h2,
      HELD.x2,
      { label: "h2" },
      { id: "h-2" },
    );
  });
}

/**
 * A live `mxIdentity` edge `i-cdead` c→dead labelled `cdead`. No Store write
 * links to a tombstoned node, and a node delete removes or refuses its live
 * edges; an import with `validateReferences: false` writes the row without
 * reading its endpoints, so the state is reachable through the public API.
 */
async function seedIdentityEdgeOntoDeadNode(
  store: EdgeCreatePathStore,
): Promise<void> {
  const result = await importGraph(
    store,
    {
      formatVersion: FORMAT_VERSION,
      exportedAt: "2026-01-01T00:00:00.000Z",
      source: { type: "external", description: "edge onto a dead node" },
      nodes: [],
      edges: [
        {
          kind: "mxIdentity",
          id: "i-cdead",
          from: ITEM.c,
          to: ITEM.dead,
          properties: { label: "cdead" },
        },
      ],
    },
    {
      onConflict: "error",
      onUnknownProperty: "error",
      validateReferences: false,
      batchSize: 100,
      refreshStatistics: false,
    },
  );
  expect(result.errors).toEqual([]);
  expect(result.edges.created).toBe(1);
  expect(
    await store.nodes.MxItem.getById(asNodeId(ITEM.dead.id)),
  ).toBeUndefined();
}

type MatrixCase = Readonly<{
  causes: readonly [RefusalCause, ...RefusalCause[]];
  /** The kind and endpoints, as the report table names them. */
  carrier: string;
  /** The refusal the Store should raise. */
  wins: string;
  /** Lanes and receivers where today's Store does something else. */
  defects?: readonly CreateDefect[];
  /** Rows this case needs beyond the shared seed, written before it runs. */
  prepare?: (store: EdgeCreatePathStore) => Promise<void>;
  run: (surface: EdgeCreatePathSurface) => Promise<unknown>;
}>;

const REFUSAL_CASES: readonly MatrixCase[] = [
  // ---- single causes ----
  {
    causes: ["dead"],
    carrier: "mxAxes c->dead",
    wins: ENDPOINT,
    run: (s) => s.edges.mxAxes.create(ITEM.c, ITEM.dead, { label: "x" }),
  },
  {
    causes: ["source"],
    carrier: "mxAxes a->c",
    wins: cardinality("source", "e-ab"),
    run: (s) => s.edges.mxAxes.create(ITEM.a, ITEM.c, { label: "x" }),
  },
  {
    causes: ["target"],
    carrier: "mxAxes c->b",
    wins: cardinality("target", "e-ab"),
    run: (s) => s.edges.mxAxes.create(ITEM.c, ITEM.b, { label: "x" }),
  },
  {
    causes: ["dupId"],
    carrier: "mxAxes c->d id e-ab",
    wins: DUPLICATE_ID,
    defects: [
      d2ClaimResidue(DUPLICATE_ID, [
        'one:mxAxes ["MxItem","c"] -> e-ab',
        'to:one:mxAxes ["MxItem","d"] -> e-ab',
      ]),
      ...D7_POISONED_TRANSACTION,
    ],
    run: (s) =>
      s.edges.mxAxes.create(ITEM.c, ITEM.d, { label: "x" }, { id: "e-ab" }),
  },
  {
    causes: ["props"],
    carrier: "mxAxes c->d",
    wins: INVALID_PROPS,
    run: (s) => s.edges.mxAxes.create(ITEM.c, ITEM.d, INVALID),
  },
  {
    causes: ["cycle"],
    carrier: "mxAxes b->d",
    wins: CYCLE,
    run: (s) => s.edges.mxAxes.create(ITEM.b, ITEM.d, { label: "x" }),
  },
  {
    causes: ["composition"],
    carrier: "mxMember p1->w2",
    wins: WINDOW_OVERLAP,
    run: (s) => s.edges.mxMember.create(PART.p1, WHOLE.w2, { label: "x" }),
  },
  {
    causes: ["identity"],
    carrier: "mxIdentity a->b label ab",
    wins: IDENTITY,
    run: (s) => s.edges.mxIdentity.create(ITEM.a, ITEM.b, { label: "ab" }),
  },
  // ---- single causes on a one-axis kind (the fused one-claim path) ----
  {
    causes: ["dead"],
    carrier: "mxSource c->dead",
    wins: ENDPOINT,
    defects: [
      d2ClaimResidue(ENDPOINT, ['one:mxSource ["MxItem","c"] -> <generated>']),
    ],
    run: (s) => s.edges.mxSource.create(ITEM.c, ITEM.dead, { label: "x" }),
  },
  {
    causes: ["source"],
    carrier: "mxSource a->c",
    wins: cardinality("source", "s-ab"),
    run: (s) => s.edges.mxSource.create(ITEM.a, ITEM.c, { label: "x" }),
  },
  {
    causes: ["dupId"],
    carrier: "mxSource c->d id e-ab",
    wins: DUPLICATE_ID,
    defects: [
      d2ClaimResidue(DUPLICATE_ID, ['one:mxSource ["MxItem","c"] -> e-ab']),
      ...D7_POISONED_TRANSACTION,
    ],
    run: (s) =>
      s.edges.mxSource.create(ITEM.c, ITEM.d, { label: "x" }, { id: "e-ab" }),
  },
  {
    causes: ["props"],
    carrier: "mxSource c->d",
    wins: INVALID_PROPS,
    run: (s) => s.edges.mxSource.create(ITEM.c, ITEM.d, INVALID),
  },
  {
    causes: ["dupId"],
    carrier: "mxPlain c->d id e-ab",
    wins: DUPLICATE_ID,
    defects: D7_POISONED_TRANSACTION,
    run: (s) =>
      s.edges.mxPlain.create(ITEM.c, ITEM.d, { label: "x" }, { id: "e-ab" }),
  },
  {
    causes: ["dupId"],
    carrier: "mxIdentitySource c->d id e-ab",
    wins: DUPLICATE_ID,
    defects: D7_POISONED_TRANSACTION,
    run: (s) =>
      s.edges.mxIdentitySource.create(
        ITEM.c,
        ITEM.d,
        { label: "x" },
        { id: "e-ab" },
      ),
  },
  {
    causes: ["dead"],
    carrier: "mxIdentitySource c->dead",
    wins: ENDPOINT,
    defects: [
      d2ClaimResidue(ENDPOINT, [
        'one:mxIdentitySource ["MxItem","c"] -> <generated>',
      ]),
    ],
    run: (s) =>
      s.edges.mxIdentitySource.create(ITEM.c, ITEM.dead, { label: "x" }),
  },
  // ---- pairs ----
  {
    causes: ["dead", "source"],
    carrier: "mxAxes a->dead",
    wins: ENDPOINT,
    run: (s) => s.edges.mxAxes.create(ITEM.a, ITEM.dead, { label: "x" }),
  },
  {
    causes: ["dead", "source"],
    carrier: "mxSource a->dead",
    wins: ENDPOINT,
    defects: [issue946(cardinality("source", "s-ab"))],
    run: (s) => s.edges.mxSource.create(ITEM.a, ITEM.dead, { label: "x" }),
  },
  {
    causes: ["dead", "source"],
    carrier: "mxIdentitySource a->dead",
    wins: ENDPOINT,
    defects: [d1DurableProbeFirst(cardinality("source", "is-ab"))],
    run: (s) =>
      s.edges.mxIdentitySource.create(ITEM.a, ITEM.dead, { label: "x" }),
  },
  {
    causes: ["dead", "target"],
    carrier: "mxAxes dead->b",
    wins: ENDPOINT,
    run: (s) => s.edges.mxAxes.create(ITEM.dead, ITEM.b, { label: "x" }),
  },
  {
    causes: ["dead", "target"],
    carrier: "mxIdentityTarget dead->b",
    wins: ENDPOINT,
    defects: [d1DurableProbeFirst(cardinality("target", "it-ab"))],
    run: (s) =>
      s.edges.mxIdentityTarget.create(ITEM.dead, ITEM.b, { label: "x" }),
  },
  {
    causes: ["dead", "dupId"],
    carrier: "mxAxes c->dead id e-ab",
    wins: ENDPOINT,
    run: (s) =>
      s.edges.mxAxes.create(ITEM.c, ITEM.dead, { label: "x" }, { id: "e-ab" }),
  },
  {
    causes: ["dead", "props"],
    carrier: "mxAxes c->dead",
    wins: ENDPOINT,
    run: (s) => s.edges.mxAxes.create(ITEM.c, ITEM.dead, INVALID),
  },
  {
    causes: ["dead", "cycle"],
    carrier: "mxAxes dead->dead",
    wins: ENDPOINT,
    run: (s) => s.edges.mxAxes.create(ITEM.dead, ITEM.dead, { label: "x" }),
  },
  {
    causes: ["dead", "composition"],
    carrier: "mxMember p1->wdead",
    wins: WINDOW_OVERLAP,
    run: (s) => s.edges.mxMember.create(PART.p1, WHOLE.dead, { label: "x" }),
  },
  {
    causes: ["dead", "identity"],
    carrier: "mxIdentity c->dead label cdead",
    wins: IDENTITY,
    prepare: seedIdentityEdgeOntoDeadNode,
    run: (s) =>
      s.edges.mxIdentity.create(ITEM.c, ITEM.dead, { label: "cdead" }),
  },
  {
    causes: ["source", "target"],
    carrier: "mxAxes d->b",
    wins: cardinality("source", "e-da"),
    run: (s) => s.edges.mxAxes.create(ITEM.d, ITEM.b, { label: "x" }),
  },
  {
    causes: ["dead", "dupId"],
    carrier: "mxSource c->dead id e-ab",
    wins: ENDPOINT,
    defects: [
      d2ClaimResidue(ENDPOINT, ['one:mxSource ["MxItem","c"] -> e-ab']),
    ],
    run: (s) =>
      s.edges.mxSource.create(
        ITEM.c,
        ITEM.dead,
        { label: "x" },
        { id: "e-ab" },
      ),
  },
  {
    causes: ["source", "dupId"],
    carrier: "mxSource a->c id e-ab",
    wins: cardinality("source", "s-ab"),
    run: (s) =>
      s.edges.mxSource.create(ITEM.a, ITEM.c, { label: "x" }, { id: "e-ab" }),
  },
  {
    causes: ["source", "dupId"],
    carrier: "mxAxes a->c id e-da",
    wins: cardinality("source", "e-ab"),
    run: (s) =>
      s.edges.mxAxes.create(ITEM.a, ITEM.c, { label: "x" }, { id: "e-da" }),
  },
  {
    causes: ["source", "props"],
    carrier: "mxAxes a->c",
    wins: INVALID_PROPS,
    run: (s) => s.edges.mxAxes.create(ITEM.a, ITEM.c, INVALID),
  },
  {
    causes: ["source", "cycle"],
    carrier: "mxAxes a->d",
    wins: cardinality("source", "e-ab"),
    run: (s) => s.edges.mxAxes.create(ITEM.a, ITEM.d, { label: "x" }),
  },
  {
    causes: ["source", "composition"],
    carrier: "mxHolds h1->x2",
    wins: WHOLE_OCCUPIED,
    prepare: seedHolders,
    run: (s) => s.edges.mxHolds.create(HOLDER.h1, HELD.x2, { label: "x" }),
  },
  {
    causes: ["source", "identity"],
    carrier: "mxIdentitySource a->b label ab",
    wins: cardinality("source", "is-ab"),
    run: (s) =>
      s.edges.mxIdentitySource.create(ITEM.a, ITEM.b, { label: "ab" }),
  },
  {
    causes: ["target", "dupId"],
    carrier: "mxAxes c->b id e-da",
    wins: cardinality("target", "e-ab"),
    run: (s) =>
      s.edges.mxAxes.create(ITEM.c, ITEM.b, { label: "x" }, { id: "e-da" }),
  },
  {
    causes: ["target", "props"],
    carrier: "mxAxes c->b",
    wins: INVALID_PROPS,
    run: (s) => s.edges.mxAxes.create(ITEM.c, ITEM.b, INVALID),
  },
  {
    causes: ["target", "cycle"],
    carrier: "mxAxes b->a",
    wins: cardinality("target", "e-da"),
    run: (s) => s.edges.mxAxes.create(ITEM.b, ITEM.a, { label: "x" }),
  },
  {
    causes: ["target", "composition"],
    carrier: "mxCappedMember cp2->w3",
    wins: WHOLE_OCCUPIED,
    run: (s) =>
      s.edges.mxCappedMember.create(PART.cp2, WHOLE.w3, { label: "x" }),
  },
  {
    causes: ["target", "identity"],
    carrier: "mxIdentityTarget a->b label ab",
    wins: cardinality("target", "it-ab"),
    run: (s) =>
      s.edges.mxIdentityTarget.create(ITEM.a, ITEM.b, { label: "ab" }),
  },
  {
    causes: ["dupId", "props"],
    carrier: "mxAxes c->d id e-ab",
    wins: INVALID_PROPS,
    run: (s) => s.edges.mxAxes.create(ITEM.c, ITEM.d, INVALID, { id: "e-ab" }),
  },
  {
    causes: ["dupId", "cycle"],
    carrier: "mxAxes b->d id e-ab",
    wins: CYCLE,
    run: (s) =>
      s.edges.mxAxes.create(ITEM.b, ITEM.d, { label: "x" }, { id: "e-ab" }),
  },
  {
    causes: ["dupId", "composition"],
    carrier: "mxMember p1->w2 id e-ab",
    wins: WINDOW_OVERLAP,
    run: (s) =>
      s.edges.mxMember.create(
        PART.p1,
        WHOLE.w2,
        { label: "x" },
        { id: "e-ab" },
      ),
  },
  {
    causes: ["dupId", "identity"],
    carrier: "mxIdentity a->b label ab id i-cd",
    wins: IDENTITY,
    run: (s) =>
      s.edges.mxIdentity.create(
        ITEM.a,
        ITEM.b,
        { label: "ab" },
        { id: "i-cd" },
      ),
  },
  {
    causes: ["props", "cycle"],
    carrier: "mxAxes b->d",
    wins: INVALID_PROPS,
    run: (s) => s.edges.mxAxes.create(ITEM.b, ITEM.d, INVALID),
  },
  {
    causes: ["props", "composition"],
    carrier: "mxMember p1->w2",
    wins: INVALID_PROPS,
    run: (s) => s.edges.mxMember.create(PART.p1, WHOLE.w2, INVALID),
  },
  {
    causes: ["props", "identity"],
    carrier: "mxIdentity a->b label ab",
    wins: INVALID_PROPS,
    run: (s) =>
      s.edges.mxIdentity.create(ITEM.a, ITEM.b, {
        label: "ab",
        weight: INVALID.weight,
      }),
  },
  {
    causes: ["cycle", "composition"],
    carrier: "mxNest s-a->s-c",
    wins: CYCLE,
    prepare: seedNestedSections,
    run: (s) => s.edges.mxNest.create(SECTION.a, SECTION.c, { label: "x" }),
  },
  {
    causes: ["cycle", "identity"],
    carrier: "mxChapterNest k-a->k-b label ab",
    wins: CYCLE,
    prepare: seedEndedChapterIdentity,
    run: (s) =>
      s.edges.mxChapterNest.create(CHAPTER.a, CHAPTER.b, { label: "ab" }),
  },
  {
    causes: ["composition", "identity"],
    carrier: "mxIdentityMember ip1->w1 label m",
    wins: WHOLE_OCCUPIED,
    run: (s) =>
      s.edges.mxIdentityMember.create(PART.ip1, WHOLE.w1, { label: "m" }),
  },
];

/**
 * Pairs no single create meets, and why. Listed so the matrix is total: a
 * test asserts every pair is either a case above or named here, and none is
 * both.
 */
const UNCONSTRUCTIBLE_PAIRS: Readonly<Record<string, string>> = {};

const CAUSES: readonly RefusalCause[] = [
  "dead",
  "source",
  "target",
  "dupId",
  "props",
  "cycle",
  "composition",
  "identity",
];

function caseKey(matrixCase: MatrixCase): string {
  return `${matrixCase.causes.join("+")} [${matrixCase.carrier}]`;
}

export function registerEdgeCreateRefusalMatrixIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("edge create refusal matrix", () => {
    it("covers every pair of refusal causes, or names why it cannot", () => {
      const covered = new Set(
        REFUSAL_CASES.filter(
          (matrixCase) => matrixCase.causes.length === 2,
        ).map((matrixCase) => matrixCase.causes.join("+")),
      );
      const pairs = CAUSES.flatMap((first, index) =>
        CAUSES.slice(index + 1).map((second) => `${first}+${second}`),
      );
      expect(
        pairs.filter(
          (pair) =>
            !covered.has(pair) && !Object.hasOwn(UNCONSTRUCTIBLE_PAIRS, pair),
        ),
      ).toEqual([]);
      expect(
        pairs.filter(
          (pair) =>
            covered.has(pair) && Object.hasOwn(UNCONSTRUCTIBLE_PAIRS, pair),
        ),
      ).toEqual([]);
      const singles = new Set(
        REFUSAL_CASES.filter(
          (matrixCase) => matrixCase.causes.length === 1,
        ).map((matrixCase) => matrixCase.causes[0]),
      );
      expect(CAUSES.filter((cause) => !singles.has(cause))).toEqual([]);
    });

    describe.each(CASE_RECEIVERS)("%s", (receiver) => {
      for (const matrixCase of REFUSAL_CASES) {
        it.for([caseKey(matrixCase)])("%s", async () => {
          const graphId = nextEdgeCreatePathGraphId("edge_refusal_matrix");
          const store = await context.createStore(
            buildEdgeCreatePathGraph(graphId),
          );
          await seedEdgeCreatePathGraph(store);
          await matrixCase.prepare?.(store);
          const observation = await observeCreate(
            context.getBackend(),
            graphId,
            store,
            receiver,
            matrixCase.run,
          );
          expectCreateOutcome({
            lane: caseLane(context, receiver),
            receiver,
            observation,
            correct: { error: matrixCase.wins },
            ...(matrixCase.defects === undefined ?
              {}
            : { defects: matrixCase.defects }),
          });
        });
      }
    });
  });
}
