/**
 * Refusal precedence for a single-edge create, with what survives, on every
 * backend.
 *
 * Eight refusal causes a create can meet: a dead endpoint, a taken source
 * axis, a taken target axis, a duplicate id, invalid props, a cycle in an
 * acyclic kind, a composition window conflict, and a durable identity
 * conflict. For each cause alone and each pair that one create can meet at
 * once, a case pins which error the Store raises and which edge and claim
 * rows exist afterwards, read from outside through the lane's own backend.
 * Every case runs at the root and inside `store.transaction()` with the
 * error caught and the transaction left to commit.
 *
 * A refused create should leave no row behind. Where a lane does not — or
 * where lanes, or paths on one lane, disagree on the winning error — the case
 * is a known failure: it asserts the correct outcome under `it.fails`, labelled
 * with the issue (#946) or the design note's divergence (`D1`, `D2`, and
 * `D7`, which the note does not list), so the fix that closes it turns the
 * case red until the label is removed.
 *
 * Pairs no single create can meet are listed with the reason in
 * {@link UNCONSTRUCTIBLE_PAIRS}, so the matrix stays total.
 */
import { describe, expect, it } from "vitest";

import {
  buildEdgeCreatePathGraph,
  CASE_RECEIVERS,
  type EdgeCreatePathSurface,
  expectedOutcome,
  ITEM,
  type KnownFailure,
  nextEdgeCreatePathGraphId,
  observeCreate,
  PART,
  registerOutcomeCase,
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
const CARDINALITY = "CardinalityError[CARDINALITY_ERROR]";
const DUPLICATE_ID = "ValidationError[VALIDATION_ERROR] at id";
const INVALID_PROPS = "ValidationError[VALIDATION_ERROR] at weight";
const CYCLE = "EdgeAcyclicityError[EDGE_ACYCLICITY_ERROR]";
const WINDOW_OVERLAP = "CompositionError[COMPOSITION_WINDOW_OVERLAP]";
const WHOLE_OCCUPIED = "CompositionError[COMPOSITION_WHOLE_OCCUPIED]";
const IDENTITY = "EdgeMatchIdentityConflictError[EDGE_MATCH_IDENTITY_CONFLICT]";

/**
 * #946: on a port without the fused claim insert (both SQLite drivers), the
 * session claims before the endpoint-predicated retry, so a taken axis
 * refuses before the dead endpoint is seen.
 */
const ISSUE_946: KnownFailure = { label: "#946", dialects: ["sqlite"] };

/**
 * D1: a durable-identity kind with a cardinality probes the axis before
 * any endpoint read (`probesCardinalityBeforeWrite`), on every lane; every
 * other create path reports the dead endpoint.
 */
const D1_DURABLE_PROBE_FIRST: KnownFailure = { label: "D1" };

/**
 * D2: on the SQLite drivers a refused one-axis create leaves the claim it
 * issued before its row was refused; with the error caught inside
 * `store.transaction` that claim commits.
 */
const D2_CLAIM_RESIDUE: KnownFailure = {
  label: "D2",
  dialects: ["sqlite"],
  receivers: ["transaction"],
};

/**
 * D7 (not in the design note): on PostgreSQL a duplicate-id INSERT fails
 * inside the caller's transaction with no savepoint around it, so catching
 * the refusal cannot keep the transaction: COMMIT rolls everything back —
 * silently on node-postgres and PGlite, as a raised 23505 on postgres-js.
 */
const D7_POISONED_TRANSACTION: KnownFailure = {
  label: "D7",
  dialects: ["postgres"],
  receivers: ["transaction"],
};

type MatrixCase = Readonly<{
  causes: readonly [RefusalCause, ...RefusalCause[]];
  /** The kind and endpoints, as the report table names them. */
  carrier: string;
  /** The refusal the Store should raise. */
  wins: string;
  /** Lanes and receivers where today's Store does not. */
  knownFailures?: readonly KnownFailure[];
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
    wins: CARDINALITY,
    run: (s) => s.edges.mxAxes.create(ITEM.a, ITEM.c, { label: "x" }),
  },
  {
    causes: ["target"],
    carrier: "mxAxes c->b",
    wins: CARDINALITY,
    run: (s) => s.edges.mxAxes.create(ITEM.c, ITEM.b, { label: "x" }),
  },
  {
    causes: ["dupId"],
    carrier: "mxAxes c->d id e-ab",
    wins: DUPLICATE_ID,
    knownFailures: [D2_CLAIM_RESIDUE, D7_POISONED_TRANSACTION],
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
    knownFailures: [D2_CLAIM_RESIDUE],
    run: (s) => s.edges.mxSource.create(ITEM.c, ITEM.dead, { label: "x" }),
  },
  {
    causes: ["source"],
    carrier: "mxSource a->c",
    wins: CARDINALITY,
    run: (s) => s.edges.mxSource.create(ITEM.a, ITEM.c, { label: "x" }),
  },
  {
    causes: ["dupId"],
    carrier: "mxSource c->d id e-ab",
    wins: DUPLICATE_ID,
    knownFailures: [D2_CLAIM_RESIDUE, D7_POISONED_TRANSACTION],
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
    knownFailures: [D7_POISONED_TRANSACTION],
    run: (s) =>
      s.edges.mxPlain.create(ITEM.c, ITEM.d, { label: "x" }, { id: "e-ab" }),
  },
  {
    causes: ["dupId"],
    carrier: "mxIdentitySource c->d id e-ab",
    wins: DUPLICATE_ID,
    knownFailures: [D7_POISONED_TRANSACTION],
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
    knownFailures: [D2_CLAIM_RESIDUE],
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
    knownFailures: [ISSUE_946],
    run: (s) => s.edges.mxSource.create(ITEM.a, ITEM.dead, { label: "x" }),
  },
  {
    causes: ["dead", "source"],
    carrier: "mxIdentitySource a->dead",
    wins: ENDPOINT,
    knownFailures: [D1_DURABLE_PROBE_FIRST],
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
    knownFailures: [D1_DURABLE_PROBE_FIRST],
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
    causes: ["dead", "composition"],
    carrier: "mxMember p1->wdead",
    wins: WINDOW_OVERLAP,
    run: (s) => s.edges.mxMember.create(PART.p1, WHOLE.dead, { label: "x" }),
  },
  {
    causes: ["source", "target"],
    carrier: "mxAxes d->b",
    wins: CARDINALITY,
    run: (s) => s.edges.mxAxes.create(ITEM.d, ITEM.b, { label: "x" }),
  },
  {
    causes: ["dead", "dupId"],
    carrier: "mxSource c->dead id e-ab",
    wins: ENDPOINT,
    knownFailures: [D2_CLAIM_RESIDUE],
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
    wins: CARDINALITY,
    run: (s) =>
      s.edges.mxSource.create(ITEM.a, ITEM.c, { label: "x" }, { id: "e-ab" }),
  },
  {
    causes: ["source", "dupId"],
    carrier: "mxAxes a->c id e-da",
    wins: CARDINALITY,
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
    wins: CARDINALITY,
    run: (s) => s.edges.mxAxes.create(ITEM.a, ITEM.d, { label: "x" }),
  },
  {
    causes: ["source", "identity"],
    carrier: "mxIdentitySource a->b label ab",
    wins: CARDINALITY,
    run: (s) =>
      s.edges.mxIdentitySource.create(ITEM.a, ITEM.b, { label: "ab" }),
  },
  {
    causes: ["target", "dupId"],
    carrier: "mxAxes c->b id e-da",
    wins: CARDINALITY,
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
    wins: CARDINALITY,
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
    wins: CARDINALITY,
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
    causes: ["composition", "identity"],
    carrier: "mxIdentityMember ip1->w1 label m",
    wins: WHOLE_OCCUPIED,
    run: (s) =>
      s.edges.mxIdentityMember.create(PART.ip1, WHOLE.w1, { label: "m" }),
  },
];

/**
 * Pairs no single create meets, and why. Listed so the matrix is total: a
 * test asserts every pair is either a case above or named here.
 */
const UNCONSTRUCTIBLE_PAIRS: Readonly<Record<string, string>> = {
  "dead+cycle":
    "a cycle needs a live path back to the source, and a dead node has no live edge",
  "dead+identity":
    "a durable identity conflict needs a live incumbent on the same endpoints",
  "source+composition":
    "a composition kind's attachment slot IS its source axis: the composition case is that pair",
  "cycle+composition":
    "a part and its whole are different kinds, so no composition edge closes a path",
  "cycle+identity":
    "an identity conflict repeats live endpoints u->v; a cycle needs v->u live, which the acyclic kind forbids",
};

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
      const missing = CAUSES.flatMap((first, index) =>
        CAUSES.slice(index + 1).map((second) => `${first}+${second}`),
      ).filter(
        (pair) =>
          !covered.has(pair) && !Object.hasOwn(UNCONSTRUCTIBLE_PAIRS, pair),
      );
      expect(missing).toEqual([]);
      const singles = new Set(
        REFUSAL_CASES.filter(
          (matrixCase) => matrixCase.causes.length === 1,
        ).map((matrixCase) => matrixCase.causes[0]),
      );
      expect(CAUSES.filter((cause) => !singles.has(cause))).toEqual([]);
    });

    describe.each(CASE_RECEIVERS)("%s", (receiver) => {
      for (const matrixCase of REFUSAL_CASES) {
        registerOutcomeCase(context, {
          title: caseKey(matrixCase),
          receiver,
          knownFailures: matrixCase.knownFailures ?? [],
          assertCorrect: async () => {
            const graphId = nextEdgeCreatePathGraphId("edge_refusal_matrix");
            const store = await context.createStore(
              buildEdgeCreatePathGraph(graphId),
            );
            await seedEdgeCreatePathGraph(store);
            const outcome = await observeCreate(
              context.getBackend(),
              graphId,
              store,
              receiver,
              matrixCase.run,
            );
            expect(outcome).toEqual(
              expectedOutcome(receiver, { error: matrixCase.wins }),
            );
          },
        });
      }
    });
  });
}
