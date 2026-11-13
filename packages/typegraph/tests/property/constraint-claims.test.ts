/**
 * The claim relations accept exactly the writes the declared constraints
 * admit, and hold exactly the claims the live data owes — over random write
 * sequences.
 *
 * A pure reference model of the graph (nodes, edges, their windows and
 * tombstones) predicts every step's verdict BEFORE the store runs it: accepted,
 * or refused with one of the typed errors the violated constraint owes. The
 * store must match both ways — a valid write the store refuses is as much a
 * failure as a violating write it accepts — so a claim that is never released
 * (a node delete that keeps its unique key, a stale edge claim that can never
 * be taken over) fails the run the first time a later valid write reuses the
 * axis, rather than hiding behind an "expected refusal" that swallows it.
 *
 * The model's liveness rules are written out here, not read from the claim
 * vocabulary: a `cardinality: "one"` axis counts every non-deleted edge, a
 * `oneActive` axis only edges with no `validTo`, the composition axis every
 * non-deleted edge of either realizing kind in either orientation. Only the
 * NAMES of claim rows (axis strings and encoded keys) come from the source,
 * because those are an encoding, not a decision.
 *
 * After every step three things must agree with the model: the live data the
 * store reads back, the claim rows (a released claim is gone or tombstoned; an
 * edge claim with no live holder may linger, since the edge fence has no
 * release path, but every axis the model says is held names its holder), and
 * `verifyConstraintFences()`, which must report nothing on data the fences
 * kept clean.
 *
 * A second property plants violating rows behind the store's back — the
 * pre-upgrade shapes the audit exists to find — and asserts the audit reports
 * exactly the violations the model derives from those rows.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  CardinalityError,
  CompositionError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  DisjointError,
  disjointWith,
  hasPart,
  partOf,
  type Store,
  subClassOf,
  type TransactionContext,
  UniquenessError,
} from "../../src";
import {
  type ClaimEdgeCardinalityParams,
  type GraphBackend,
} from "../../src/backend/types";
import { computeUniqueKey } from "../../src/constraints";
import { createSqlSchema } from "../../src/query/compiler/schema";
import { sql } from "../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../src/query/sql-intent";
import { buildKindRegistry } from "../../src/registry";
import {
  COMPOSITION_RELATION_NAME,
  DISJOINT_CONSTRAINT_NAME,
  disjointnessClaimAxis,
  uniquenessClaimAxis,
  uniquenessProbeKinds,
} from "../../src/store/claims/axis";
import { edgeInsertClaims } from "../../src/store/claims/composition-claims";
import {
  edgeCardinalityAxisReferences,
  edgeCardinalityClaimTarget,
} from "../../src/store/claims/edge-claims";
import { compareStrings } from "../../src/utils/compare";
import { requireDefined } from "../../src/utils/presence";
import { encodeTupleKey } from "../../src/utils/tuple-key";
import { readEdgeClaimRows } from "../edge-claim-rows";
import { createTestBackend } from "../test-utils";
import { propertyRuns } from "./run-budget";

// ============================================================
// Graph
// ============================================================

const emailSchema = z.object({ email: z.string() });
const FencedWorker = defineNode("FencedWorker", { schema: emailSchema });
const FencedEmployee = defineNode("FencedEmployee", { schema: emailSchema });
const FencedContractor = defineNode("FencedContractor", {
  schema: emailSchema,
});
const FencedCompany = defineNode("FencedCompany", {
  schema: z.object({ name: z.string() }),
});
const FencedVendor = defineNode("FencedVendor", {
  schema: z.object({ code: z.string() }),
});
const FencedPart = defineNode("FencedPart", { schema: z.object({}) });
const FencedBook = defineNode("FencedBook", { schema: z.object({}) });
const FencedAnthology = defineNode("FencedAnthology", {
  schema: z.object({}),
});

const fencedManages = defineEdge("fencedManages", { schema: z.object({}) });
const fencedAudits = defineEdge("fencedAudits", { schema: z.object({}) });
const fencedAssigned = defineEdge("fencedAssigned", { schema: z.object({}) });
const fencedPartInBook = defineEdge("fencedPartInBook", {
  schema: z.object({}),
});
const fencedAnthologyHasPart = defineEdge("fencedAnthologyHasPart", {
  schema: z.object({}),
});

const STAFF_EMAIL_CONSTRAINT = "fenced_staff_email";
const VENDOR_CODE_CONSTRAINT = "fenced_vendor_code";

const STAFF_EMAIL_UNIQUE = {
  name: STAFF_EMAIL_CONSTRAINT,
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const VENDOR_CODE_UNIQUE = {
  name: VENDOR_CODE_CONSTRAINT,
  fields: ["code"],
  scope: "kind",
  collation: "binary",
} as const;

const EDGE_DECLARATIONS = {
  fencedManages: { cardinality: "one" },
  fencedAudits: { targetCardinality: "one" },
  fencedAssigned: { cardinality: "oneActive" },
  fencedPartInBook: { cardinality: "one" },
  fencedAnthologyHasPart: { targetCardinality: "one" },
} as const;

/**
 * Every claim family: a uniqueness scope spanning a hierarchy, a `kind`-scoped
 * unique, a disjoint pair, a source `one`, a target `one`, a `oneActive`, and a
 * composition realized by two edge kinds in opposite orientations.
 */
const claimGraph = defineGraph({
  id: "fenced_constraint_claims",
  nodes: {
    FencedWorker: { type: FencedWorker, unique: [STAFF_EMAIL_UNIQUE] },
    FencedEmployee: { type: FencedEmployee, unique: [STAFF_EMAIL_UNIQUE] },
    FencedContractor: { type: FencedContractor, unique: [STAFF_EMAIL_UNIQUE] },
    FencedCompany: { type: FencedCompany },
    FencedVendor: { type: FencedVendor, unique: [VENDOR_CODE_UNIQUE] },
    FencedPart: { type: FencedPart },
    FencedBook: { type: FencedBook },
    FencedAnthology: { type: FencedAnthology },
  },
  edges: {
    fencedManages: {
      type: fencedManages,
      from: [FencedEmployee],
      to: [FencedVendor],
      ...EDGE_DECLARATIONS.fencedManages,
    },
    fencedAudits: {
      type: fencedAudits,
      from: [FencedContractor],
      to: [FencedVendor],
      ...EDGE_DECLARATIONS.fencedAudits,
    },
    fencedAssigned: {
      type: fencedAssigned,
      from: [FencedContractor],
      to: [FencedCompany],
      ...EDGE_DECLARATIONS.fencedAssigned,
    },
    fencedPartInBook: {
      type: fencedPartInBook,
      from: [FencedPart],
      to: [FencedBook],
      ...EDGE_DECLARATIONS.fencedPartInBook,
    },
    fencedAnthologyHasPart: {
      type: fencedAnthologyHasPart,
      from: [FencedAnthology],
      to: [FencedPart],
      ...EDGE_DECLARATIONS.fencedAnthologyHasPart,
    },
  },
  ontology: [
    subClassOf(FencedEmployee, FencedWorker),
    subClassOf(FencedContractor, FencedWorker),
    disjointWith(FencedEmployee, FencedCompany),
    partOf(FencedPart, FencedBook, { via: fencedPartInBook }),
    hasPart(FencedAnthology, FencedPart, { via: fencedAnthologyHasPart }),
  ],
});

const registry = buildKindRegistry(claimGraph);

type ClaimStore = Store<typeof claimGraph>;
type WriteSurface = Pick<
  TransactionContext<typeof claimGraph>,
  "edges" | "nodes"
>;

const STAFF_KINDS = ["FencedEmployee", "FencedContractor"] as const;
type StaffKind = (typeof STAFF_KINDS)[number];

const DISJOINT_PAIR = ["FencedEmployee", "FencedCompany"] as const;

type NodeKind =
  | StaffKind
  | "FencedCompany"
  | "FencedVendor"
  | "FencedPart"
  | "FencedBook"
  | "FencedAnthology";

type EdgeKind = keyof typeof EDGE_DECLARATIONS;

/** Each edge kind's one declared endpoint pair. */
const EDGE_ENDPOINTS: Readonly<
  Record<EdgeKind, Readonly<{ fromKind: NodeKind; toKind: NodeKind }>>
> = {
  fencedManages: { fromKind: "FencedEmployee", toKind: "FencedVendor" },
  fencedAudits: { fromKind: "FencedContractor", toKind: "FencedVendor" },
  fencedAssigned: { fromKind: "FencedContractor", toKind: "FencedCompany" },
  fencedPartInBook: { fromKind: "FencedPart", toKind: "FencedBook" },
  fencedAnthologyHasPart: {
    fromKind: "FencedAnthology",
    toKind: "FencedPart",
  },
};

/** Which endpoint is the part, for the two composition-realizing kinds. */
const COMPOSITION_PART_SIDE: Readonly<
  Partial<Record<EdgeKind, "from" | "to">>
> = { fencedPartInBook: "from", fencedAnthologyHasPart: "to" };

// Short pools, so collisions are the common case rather than the rare one.
const ID_POOL = ["i1", "i2", "i3"] as const;
const EMAIL_POOL = ["a@x", "b@x", "c@x"] as const;
const CODE_POOL = ["c1", "c2"] as const;
const PART_POOL = ["p1", "p2"] as const;
const BOOK_POOL = ["b1", "b2"] as const;
const ANTHOLOGY_POOL = ["a1", "a2"] as const;

/** A window end that is set (so `oneActive` stops counting the edge) yet never reached. */
const ENDED_VALID_TO = "2999-01-01T00:00:00.000Z";

const STAFF_AXIS = uniquenessClaimAxis(
  "FencedEmployee",
  "kindWithSubClasses",
  registry,
);
const DISJOINT_AXIS = disjointnessClaimAxis(...DISJOINT_PAIR, registry);

function staffKey(email: string): string {
  return computeUniqueKey({ email }, ["email"], "binary");
}

function vendorKey(code: string): string {
  return computeUniqueKey({ code }, ["code"], "binary");
}

// ============================================================
// Steps
// ============================================================

type PutStep =
  | Readonly<{ type: "putStaff"; kind: StaffKind; id: string; email: string }>
  | Readonly<{ type: "putCompany"; id: string }>
  | Readonly<{ type: "putVendor"; id: string; code: string }>;

type Endpoints = Readonly<{ fromId: string; toId: string }>;

/**
 * Endpoints as indexes into the LIVE nodes of each declared endpoint kind,
 * resolved when the step runs: drawing ids from a pool instead would name a
 * dead endpoint most of the time and spend the run on skipped steps.
 */
type EndpointPicks = Readonly<{ fromPick: number; toPick: number }>;

type EdgeTargetType =
  "deleteEdge" | "hardDeleteEdge" | "endWindow" | "reopenWindow";

/**
 * One step, generic over how it names endpoints and edges: as generated
 * (`EndpointPicks`, an edge pick) or as resolved against the model (ids).
 */
type StepOf<TEndpoints, TEdge> =
  | PutStep
  | Readonly<{ type: "link"; edgeKind: EdgeKind } & TEndpoints>
  | Readonly<{
      type: "bulkStaff";
      kind: StaffKind;
      items: readonly Readonly<{ id: string; email: string }>[];
    }>
  | Readonly<{
      type: "bulkLink";
      edgeKind: EdgeKind;
      pairs: readonly TEndpoints[];
    }>
  | Readonly<{
      type: "deleteNode" | "hardDeleteNode";
      kind: StaffKind | "FencedCompany" | "FencedVendor";
      id: string;
    }>
  | Readonly<{ type: EdgeTargetType } & TEdge>;

/** A step a transaction may carry: a node write or a single edge create. */
type SimpleStep = Extract<
  StepOf<EndpointPicks, Readonly<{ pick: number }>>,
  Readonly<{ type: "putStaff" | "putCompany" | "putVendor" | "link" }>
>;

type Step =
  | StepOf<EndpointPicks, Readonly<{ pick: number }>>
  | Readonly<{ type: "transaction"; steps: readonly SimpleStep[] }>;

type GeneratedStep = Exclude<Step, Readonly<{ type: "transaction" }>>;
type ResolvedStep = StepOf<Endpoints, Readonly<{ edgeId: string }>>;

const endpointPicksArb: fc.Arbitrary<EndpointPicks> = fc.record({
  fromPick: fc.nat({ max: 5 }),
  toPick: fc.nat({ max: 5 }),
});

const edgeKindArb = fc.constantFrom(
  ...(Object.keys(EDGE_DECLARATIONS) as EdgeKind[]),
);

const putStepArb: fc.Arbitrary<PutStep> = fc.oneof(
  fc.record({
    type: fc.constant("putStaff" as const),
    kind: fc.constantFrom(...STAFF_KINDS),
    id: fc.constantFrom(...ID_POOL),
    email: fc.constantFrom(...EMAIL_POOL),
  }),
  fc.record({
    type: fc.constant("putCompany" as const),
    id: fc.constantFrom(...ID_POOL),
  }),
  fc.record({
    type: fc.constant("putVendor" as const),
    id: fc.constantFrom(...ID_POOL),
    code: fc.constantFrom(...CODE_POOL),
  }),
);

const linkStepArb = fc.record({
  type: fc.constant("link" as const),
  edgeKind: edgeKindArb,
  fromPick: fc.nat({ max: 5 }),
  toPick: fc.nat({ max: 5 }),
});

const simpleStepArb: fc.Arbitrary<SimpleStep> = fc.oneof(
  putStepArb,
  linkStepArb,
);

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { arbitrary: putStepArb, weight: 3 },
  { arbitrary: linkStepArb, weight: 6 },
  {
    arbitrary: fc.record({
      type: fc.constant("bulkStaff" as const),
      kind: fc.constantFrom(...STAFF_KINDS),
      items: fc.uniqueArray(
        fc.record({
          id: fc.constantFrom(...ID_POOL),
          email: fc.constantFrom(...EMAIL_POOL),
        }),
        { minLength: 1, maxLength: 2, selector: (item) => item.id },
      ),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      type: fc.constant("bulkLink" as const),
      edgeKind: edgeKindArb,
      pairs: fc.array(endpointPicksArb, { minLength: 1, maxLength: 2 }),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      type: fc.constantFrom("deleteNode" as const, "hardDeleteNode" as const),
      kind: fc.constantFrom(
        ...STAFF_KINDS,
        "FencedCompany" as const,
        "FencedVendor" as const,
      ),
      id: fc.constantFrom(...ID_POOL),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      type: fc.constantFrom(
        "deleteEdge" as const,
        "hardDeleteEdge" as const,
        "endWindow" as const,
        "reopenWindow" as const,
      ),
      pick: fc.nat({ max: 7 }),
    }),
    weight: 5,
  },
  {
    arbitrary: fc.record({
      type: fc.constant("transaction" as const),
      steps: fc.array(simpleStepArb, { minLength: 2, maxLength: 3 }),
    }),
    weight: 1,
  },
);

// ============================================================
// Reference model
// ============================================================

type ModelNode = Readonly<{
  kind: NodeKind;
  id: string;
  /** The email or vendor code, for the kinds that declare a unique. */
  uniqueValue?: string;
  deleted: boolean;
  /** False for a row planted past the store: it holds no claim rows. */
  claimed: boolean;
}>;

type ModelEdge = Readonly<{
  id: string;
  kind: EdgeKind;
  fromKind: NodeKind;
  fromId: string;
  toKind: NodeKind;
  toId: string;
  ended: boolean;
  deleted: boolean;
}>;

/** A `uniques` row written past the store, at a legacy (non-axis) node kind. */
type PlantedUnique = Readonly<{
  nodeKind: string;
  key: string;
  concreteKind: StaffKind;
  nodeId: string;
}>;

type ErrorClass = abstract new (...args: never[]) => Error;

type Verdict =
  | Readonly<{ accepted: true }>
  | Readonly<{
      accepted: false;
      refusals: readonly ErrorClass[];
      reason: string;
    }>;

const ACCEPT: Verdict = { accepted: true };

function refuse(refusals: readonly ErrorClass[], reason: string): Verdict {
  return { accepted: false, refusals, reason };
}

/**
 * A write that violates several constraints may be refused by whichever the
 * store checks first, so the combined verdict admits any of their errors.
 */
function combineVerdicts(verdicts: readonly Verdict[]): Verdict {
  const refusals = verdicts.filter(
    (verdict): verdict is Extract<Verdict, { accepted: false }> =>
      !verdict.accepted,
  );
  if (refusals.length === 0) return ACCEPT;
  return refuse(
    refusals.flatMap((verdict) => verdict.refusals),
    refusals.map((verdict) => verdict.reason).join("; "),
  );
}

function nodeKey(kind: string, id: string): string {
  return `${kind}/${id}`;
}

/**
 * The graph as the declared constraints see it, plus a verdict for every step.
 * Mutated only through {@link ClaimModel.apply} after the store accepted the
 * same step, so a prediction is always made against the state the store had.
 */
class ClaimModel {
  readonly nodes = new Map<string, ModelNode>();
  readonly edges = new Map<string, ModelEdge>();
  readonly plantedUniques: PlantedUnique[] = [];
  private edgeSequence = 0;

  clone(): ClaimModel {
    const copy = new ClaimModel();
    for (const [key, node] of this.nodes) copy.nodes.set(key, node);
    for (const [key, edge] of this.edges) copy.edges.set(key, edge);
    copy.plantedUniques.push(...this.plantedUniques);
    copy.edgeSequence = this.edgeSequence;
    return copy;
  }

  nextEdgeId(): string {
    this.edgeSequence += 1;
    return `e${String(this.edgeSequence)}`;
  }

  node(kind: string, id: string): ModelNode | undefined {
    return this.nodes.get(nodeKey(kind, id));
  }

  liveNode(kind: string, id: string): ModelNode | undefined {
    const node = this.node(kind, id);
    return node?.deleted === false ? node : undefined;
  }

  liveNodes(): readonly ModelNode[] {
    return [...this.nodes.values()].filter((node) => !node.deleted);
  }

  /** Non-deleted edges, ordered by id so a `pick` resolves deterministically. */
  liveEdges(): readonly ModelEdge[] {
    return [...this.edges.values()]
      .filter((edge) => !edge.deleted)
      .toSorted((left, right) => compareStrings(left.id, right.id));
  }

  edgeRows(): readonly ModelEdge[] {
    return [...this.edges.values()].toSorted((left, right) =>
      compareStrings(left.id, right.id),
    );
  }

  /** Whether any non-deleted edge (current, ended or otherwise) touches the node. */
  hasLiveIncidentEdge(kind: string, id: string): boolean {
    return this.liveEdges().some(
      (edge) =>
        (edge.fromKind === kind && edge.fromId === id) ||
        (edge.toKind === kind && edge.toId === id),
    );
  }

  /** The edges a step of `type` can name, ordered by id. */
  private edgesFor(type: EdgeTargetType): readonly ModelEdge[] {
    switch (type) {
      case "deleteEdge": {
        return this.liveEdges();
      }
      case "hardDeleteEdge": {
        return this.edgeRows();
      }
      case "endWindow": {
        return this.liveEdges().filter(
          (edge) => edge.kind === "fencedAssigned" && !edge.ended,
        );
      }
      case "reopenWindow": {
        return this.liveEdges().filter(
          (edge) => edge.kind === "fencedAssigned" && edge.ended,
        );
      }
    }
  }

  private static nth<T>(values: readonly T[], pick: number): T | undefined {
    return values[pick % Math.max(1, values.length)];
  }

  /** The live node of `kind` a pick names, ordered by id. */
  private pickLiveNode(kind: NodeKind, pick: number): string | undefined {
    const ids = this.liveNodes()
      .filter((node) => node.kind === kind)
      .map((node) => node.id)
      .toSorted((left, right) => compareStrings(left, right));
    return ClaimModel.nth(ids, pick);
  }

  private resolveEndpoints(
    edgeKind: EdgeKind,
    picks: EndpointPicks,
  ): Endpoints | undefined {
    const { fromKind, toKind } = EDGE_ENDPOINTS[edgeKind];
    const fromId = this.pickLiveNode(fromKind, picks.fromPick);
    const toId = this.pickLiveNode(toKind, picks.toPick);
    return fromId === undefined || toId === undefined ?
        undefined
      : { fromId, toId };
  }

  edge(id: string): ModelEdge {
    return requireDefined(this.edges.get(id), `model edge ${id}`);
  }

  // --- the constraint predicates, from the live rows ---

  /** Another live claimed staff node (a different owner) holding `email`. */
  staffEmailHolder(
    email: string,
    owner: Readonly<{ kind: NodeKind; id: string }>,
  ): ModelNode | undefined {
    return this.liveNodes().find(
      (node) =>
        node.claimed &&
        (node.kind === "FencedEmployee" || node.kind === "FencedContractor") &&
        node.uniqueValue === email &&
        nodeKey(node.kind, node.id) !== nodeKey(owner.kind, owner.id),
    );
  }

  vendorCodeHolder(code: string, id: string): ModelNode | undefined {
    return this.liveNodes().find(
      (node) =>
        node.claimed &&
        node.kind === "FencedVendor" &&
        node.uniqueValue === code &&
        node.id !== id,
    );
  }

  /** The other kind of the disjoint pair, when `kind` is in it. */
  static disjointPartner(kind: NodeKind): NodeKind | undefined {
    if (kind === DISJOINT_PAIR[0]) return DISJOINT_PAIR[1];
    if (kind === DISJOINT_PAIR[1]) return DISJOINT_PAIR[0];
    return undefined;
  }

  /**
   * The non-deleted edges a new edge would share an axis with, per axis it
   * declares: a source `one` counts every edge from the source, a target
   * `one` every edge into the target, a `oneActive` only the unended ones,
   * and the composition axis every edge of EITHER realizing kind naming the
   * same part, whichever side it sits on.
   */
  axisContenders(candidate: ModelEdge): readonly string[] {
    const reasons: string[] = [];
    const peers = this.liveEdges().filter((edge) => edge.id !== candidate.id);
    const sameKind = peers.filter((edge) => edge.kind === candidate.kind);
    const declaration = EDGE_DECLARATIONS[candidate.kind];
    if ("cardinality" in declaration) {
      const activeOnly = declaration.cardinality === "oneActive";
      const holder = sameKind.find(
        (edge) =>
          edge.fromId === candidate.fromId && (!activeOnly || !edge.ended),
      );
      if (holder !== undefined && (!activeOnly || !candidate.ended))
        reasons.push(`source ${declaration.cardinality} held by ${holder.id}`);
    }
    if ("targetCardinality" in declaration) {
      const holder = sameKind.find((edge) => edge.toId === candidate.toId);
      if (holder !== undefined) reasons.push(`target one held by ${holder.id}`);
    }
    const part = compositionPart(candidate);
    if (part !== undefined) {
      const holder = peers.find((edge) => compositionPart(edge) === part);
      if (holder !== undefined)
        reasons.push(`composition part ${part} held by ${holder.id}`);
    }
    return reasons;
  }

  // --- verdicts ---

  /**
   * The step with its picks resolved against the current state, or
   * `undefined` when it names state this model does not decide (no live
   * endpoint to pick, a node with live edges to delete) and is skipped.
   */
  resolve(step: GeneratedStep): ResolvedStep | undefined {
    switch (step.type) {
      case "putStaff":
      case "putCompany":
      case "putVendor": {
        return step;
      }
      case "link": {
        const endpoints = this.resolveEndpoints(step.edgeKind, step);
        return endpoints === undefined ? undefined : (
            { type: "link", edgeKind: step.edgeKind, ...endpoints }
          );
      }
      case "bulkLink": {
        const pairs = step.pairs.map((pair) =>
          this.resolveEndpoints(step.edgeKind, pair),
        );
        return pairs.includes(undefined) ? undefined : (
            {
              type: "bulkLink",
              edgeKind: step.edgeKind,
              pairs: pairs.map((pair) => requireDefined(pair)),
            }
          );
      }
      case "bulkStaff": {
        // A create-only batch over ids with no row at all: what a create does
        // to a tombstoned id is the upsert's business, not this one's.
        return (
            step.items.every(
              (item) => this.node(step.kind, item.id) === undefined,
            )
          ) ?
            step
          : undefined;
      }
      case "deleteNode":
      case "hardDeleteNode": {
        const node =
          step.type === "deleteNode" ?
            this.liveNode(step.kind, step.id)
          : this.node(step.kind, step.id);
        return (
            node === undefined || this.hasLiveIncidentEdge(step.kind, step.id)
          ) ?
            undefined
          : step;
      }
      case "deleteEdge":
      case "hardDeleteEdge":
      case "endWindow":
      case "reopenWindow": {
        const edge = ClaimModel.nth(this.edgesFor(step.type), step.pick);
        return edge === undefined ? undefined : (
            { type: step.type, edgeId: edge.id }
          );
      }
    }
  }

  /** The verdict for one non-composite step; `edgeId` names a created edge. */
  verdict(step: ResolvedStep, edgeIds: readonly string[]): Verdict {
    switch (step.type) {
      case "putStaff": {
        const holder = this.staffEmailHolder(step.email, step);
        return combineVerdicts([
          holder === undefined ? ACCEPT : (
            refuse(
              [UniquenessError],
              `${step.email} held by ${nodeKey(holder.kind, holder.id)}`,
            )
          ),
          this.disjointVerdict(step.kind, step.id),
        ]);
      }
      case "putCompany": {
        return this.disjointVerdict("FencedCompany", step.id);
      }
      case "putVendor": {
        const holder = this.vendorCodeHolder(step.code, step.id);
        return holder === undefined ? ACCEPT : (
            refuse([UniquenessError], `${step.code} held by ${holder.id}`)
          );
      }
      case "link": {
        return this.linkVerdict(
          this.proposedEdge(step.edgeKind, step, requireDefined(edgeIds[0])),
        );
      }
      case "bulkStaff": {
        return this.batchVerdict(
          step.items.map((item): ResolvedStep => ({
            type: "putStaff",
            kind: step.kind,
            ...item,
          })),
          step.items.map(() => ""),
        );
      }
      case "bulkLink": {
        return this.batchVerdict(
          step.pairs.map((pair): ResolvedStep => ({
            type: "link",
            edgeKind: step.edgeKind,
            ...pair,
          })),
          edgeIds,
        );
      }
      case "reopenWindow": {
        return this.linkVerdict({ ...this.edge(step.edgeId), ended: false });
      }
      case "deleteNode":
      case "hardDeleteNode":
      case "deleteEdge":
      case "hardDeleteEdge":
      case "endWindow": {
        return ACCEPT;
      }
    }
  }

  /**
   * A node write is refused when the id is live under the OTHER kind of a
   * declared disjoint pair — unless the node itself is already live, whose
   * update claims nothing new.
   */
  private disjointVerdict(kind: NodeKind, id: string): Verdict {
    const partner = ClaimModel.disjointPartner(kind);
    if (partner === undefined) return ACCEPT;
    if (this.liveNode(kind, id) !== undefined) return ACCEPT;
    const other = this.liveNode(partner, id);
    return other?.claimed === true ?
        refuse([DisjointError], `${id} is live as ${partner}`)
      : ACCEPT;
  }

  private linkVerdict(candidate: ModelEdge): Verdict {
    const reasons = this.axisContenders(candidate);
    if (reasons.length === 0) return ACCEPT;
    return refuse(
      COMPOSITION_PART_SIDE[candidate.kind] === undefined ?
        [CardinalityError]
      : [CardinalityError, CompositionError],
      reasons.join("; "),
    );
  }

  /** A batch is all-or-nothing: the first refused item refuses it whole. */
  private batchVerdict(
    items: readonly ResolvedStep[],
    edgeIds: readonly string[],
  ): Verdict {
    const scratch = this.clone();
    for (const [index, item] of items.entries()) {
      const itemEdgeIds = item.type === "link" ? [edgeIds[index] ?? ""] : [];
      const verdict = scratch.verdict(item, itemEdgeIds);
      if (!verdict.accepted)
        return refuse(
          verdict.refusals,
          `item ${String(index)}: ${verdict.reason}`,
        );
      scratch.apply(item, itemEdgeIds);
    }
    return ACCEPT;
  }

  proposedEdge(
    edgeKind: EdgeKind,
    endpoints: Readonly<{ fromId: string; toId: string }>,
    id: string,
  ): ModelEdge {
    return {
      id,
      kind: edgeKind,
      ...EDGE_ENDPOINTS[edgeKind],
      fromId: endpoints.fromId,
      toId: endpoints.toId,
      ended: false,
      deleted: false,
    };
  }

  /** Applies an accepted step. */
  apply(step: ResolvedStep, edgeIds: readonly string[]): void {
    switch (step.type) {
      case "putStaff": {
        this.putNode(step.kind, step.id, step.email);
        return;
      }
      case "putCompany": {
        this.putNode("FencedCompany", step.id, undefined);
        return;
      }
      case "putVendor": {
        this.putNode("FencedVendor", step.id, step.code);
        return;
      }
      case "link": {
        const edge = this.proposedEdge(
          step.edgeKind,
          step,
          requireDefined(edgeIds[0]),
        );
        this.edges.set(edge.id, edge);
        return;
      }
      case "bulkStaff": {
        for (const item of step.items)
          this.putNode(step.kind, item.id, item.email);
        return;
      }
      case "bulkLink": {
        for (const [index, pair] of step.pairs.entries()) {
          const edge = this.proposedEdge(
            step.edgeKind,
            pair,
            requireDefined(edgeIds[index]),
          );
          this.edges.set(edge.id, edge);
        }
        return;
      }
      case "deleteNode": {
        const node = requireDefined(this.node(step.kind, step.id));
        this.nodes.set(nodeKey(step.kind, step.id), { ...node, deleted: true });
        return;
      }
      case "hardDeleteNode": {
        this.nodes.delete(nodeKey(step.kind, step.id));
        // A hard delete also purges the tombstoned edges at the node.
        for (const edge of this.edgeRows()) {
          const touches =
            (edge.fromKind === step.kind && edge.fromId === step.id) ||
            (edge.toKind === step.kind && edge.toId === step.id);
          if (touches) this.edges.delete(edge.id);
        }
        return;
      }
      case "deleteEdge": {
        this.edges.set(step.edgeId, {
          ...this.edge(step.edgeId),
          deleted: true,
        });
        return;
      }
      case "hardDeleteEdge": {
        this.edges.delete(step.edgeId);
        return;
      }
      case "endWindow":
      case "reopenWindow": {
        this.edges.set(step.edgeId, {
          ...this.edge(step.edgeId),
          ended: step.type === "endWindow",
        });
        return;
      }
    }
  }

  putNode(kind: NodeKind, id: string, uniqueValue: string | undefined): void {
    this.nodes.set(nodeKey(kind, id), {
      kind,
      id,
      ...(uniqueValue === undefined ? {} : { uniqueValue }),
      deleted: false,
      claimed: true,
    });
  }

  // --- what the claim relations must hold ---

  /** Every live `uniques` row the store owes: uniqueness and disjointness claims. */
  expectedUniqueRows(): readonly UniqueRow[] {
    const rows: UniqueRow[] = [];
    for (const node of this.liveNodes()) {
      if (!node.claimed) continue;
      const owner = { node_id: node.id, concrete_kind: node.kind };
      if (node.kind === "FencedEmployee" || node.kind === "FencedContractor") {
        rows.push({
          node_kind: STAFF_AXIS,
          constraint_name: STAFF_EMAIL_CONSTRAINT,
          key: staffKey(requireDefined(node.uniqueValue)),
          ...owner,
        });
      }
      if (node.kind === "FencedVendor") {
        rows.push({
          node_kind: "FencedVendor",
          constraint_name: VENDOR_CODE_CONSTRAINT,
          key: vendorKey(requireDefined(node.uniqueValue)),
          ...owner,
        });
      }
      if (ClaimModel.disjointPartner(node.kind) !== undefined) {
        rows.push({
          node_kind: DISJOINT_AXIS,
          constraint_name: DISJOINT_CONSTRAINT_NAME,
          key: node.id,
          ...owner,
        });
      }
    }
    return rows;
  }

  /**
   * `(axis, key) -> holder edge id` for every axis a live edge holds, by the
   * model's own membership rule (an ended edge leaves its `oneActive` axis).
   * The axis and key strings are the claim owner's encoding.
   */
  expectedEdgeClaims(): ReadonlyMap<string, string> {
    const held = new Map<string, string>();
    for (const edge of this.liveEdges()) {
      const claims = edgeInsertClaims(registry, EDGE_DECLARATIONS[edge.kind], {
        graphId: claimGraph.id,
        ...edge,
      });
      for (const claim of claims) {
        if (claim.cardinality === "oneActive" && edge.ended) continue;
        const target = edgeClaimTargetKey(claim);
        held.set(target, edge.id);
      }
    }
    return held;
  }
}

function compositionPart(edge: ModelEdge): string | undefined {
  const side = COMPOSITION_PART_SIDE[edge.kind];
  if (side === undefined) return undefined;
  return side === "from" ?
      nodeKey(edge.fromKind, edge.fromId)
    : nodeKey(edge.toKind, edge.toId);
}

// ============================================================
// Store side
// ============================================================

type UniqueRow = Readonly<{
  node_kind: string;
  constraint_name: string;
  key: string;
  node_id: string;
  concrete_kind: string;
}>;

async function readLiveUniqueRows(
  backend: GraphBackend,
): Promise<readonly UniqueRow[]> {
  const schema = createSqlSchema(backend.tableNames);
  return backend.execute<UniqueRow>(
    asCompiledRowsSql(sql`
      SELECT node_kind, constraint_name, key, node_id, concrete_kind
      FROM ${sql.identifier(schema.tables.uniques)}
      WHERE graph_id = ${claimGraph.id} AND deleted_at IS NULL
    `),
  );
}

function edgeClaimTargetKey(claim: ClaimEdgeCardinalityParams): string {
  const target = edgeCardinalityClaimTarget(claim);
  return `${target.axis}\u0000${target.key}`;
}

function sortedJson(values: readonly unknown[]): readonly string[] {
  return values
    .map((value) => JSON.stringify(value))
    .toSorted((left, right) => compareStrings(left, right));
}

function nodeRef(kind: NodeKind, id: string) {
  return { kind, id: asNodeId(id) };
}

/** Runs one step against the store (or a transaction's write surface). */
async function execute(
  surface: WriteSurface,
  model: ClaimModel,
  step: ResolvedStep,
  edgeIds: readonly string[],
): Promise<void> {
  switch (step.type) {
    case "putStaff": {
      await surface.nodes[step.kind].upsertById(step.id, { email: step.email });
      return;
    }
    case "putCompany": {
      await surface.nodes.FencedCompany.upsertById(step.id, { name: step.id });
      return;
    }
    case "putVendor": {
      await surface.nodes.FencedVendor.upsertById(step.id, { code: step.code });
      return;
    }
    case "bulkStaff": {
      await surface.nodes[step.kind].bulkCreate(
        step.items.map((item) => ({
          props: { email: item.email },
          id: item.id,
        })),
      );
      return;
    }
    case "link": {
      await createEdge(
        surface,
        step.edgeKind,
        step,
        requireDefined(edgeIds[0]),
      );
      return;
    }
    case "bulkLink": {
      await bulkCreateEdges(surface, step.edgeKind, step.pairs, edgeIds);
      return;
    }
    case "deleteNode": {
      await surface.nodes[step.kind].delete(asNodeId(step.id));
      return;
    }
    case "hardDeleteNode": {
      await surface.nodes[step.kind].hardDelete(asNodeId(step.id));
      return;
    }
    case "deleteEdge": {
      const edge = model.edge(step.edgeId);
      await surface.edges[edge.kind].delete(asEdgeId(edge.id));
      return;
    }
    case "hardDeleteEdge": {
      const edge = model.edge(step.edgeId);
      await surface.edges[edge.kind].hardDelete(asEdgeId(edge.id));
      return;
    }
    case "endWindow": {
      const edge = model.edge(step.edgeId);
      await surface.edges.fencedAssigned.update(
        asEdgeId(edge.id),
        {},
        { validTo: ENDED_VALID_TO },
      );
      return;
    }
    case "reopenWindow": {
      const edge = model.edge(step.edgeId);
      await surface.edges.fencedAssigned.update(
        asEdgeId(edge.id),
        {},
        { clearValidTo: true },
      );
      return;
    }
  }
}

async function createEdge(
  surface: WriteSurface,
  edgeKind: EdgeKind,
  endpoints: Readonly<{ fromId: string; toId: string }>,
  id: string,
): Promise<void> {
  const { fromKind, toKind } = EDGE_ENDPOINTS[edgeKind];
  const from = nodeRef(fromKind, endpoints.fromId);
  const to = nodeRef(toKind, endpoints.toId);
  // The collections are typed per kind; the endpoint kinds above are the one
  // pair each kind declares, which the store re-validates regardless.
  const collection = surface.edges[edgeKind] as unknown as Readonly<{
    create: (
      from: unknown,
      to: unknown,
      props: object,
      options: Readonly<{ id: string }>,
    ) => Promise<unknown>;
  }>;
  await collection.create(from, to, {}, { id });
}

async function bulkCreateEdges(
  surface: WriteSurface,
  edgeKind: EdgeKind,
  pairs: readonly Readonly<{ fromId: string; toId: string }>[],
  ids: readonly string[],
): Promise<void> {
  const { fromKind, toKind } = EDGE_ENDPOINTS[edgeKind];
  const collection = surface.edges[edgeKind] as unknown as Readonly<{
    bulkCreate: (items: readonly unknown[]) => Promise<unknown>;
  }>;
  await collection.bulkCreate(
    pairs.map((pair, index) => ({
      from: nodeRef(fromKind, pair.fromId),
      to: nodeRef(toKind, pair.toId),
      props: {},
      id: requireDefined(ids[index]),
    })),
  );
}

/**
 * Runs `run` and holds its outcome to `verdict` in BOTH directions, with
 * enough of the step and the model's reasoning in the message to debug from.
 */
async function expectVerdict(
  verdict: Verdict,
  label: string,
  run: () => Promise<void>,
): Promise<boolean> {
  try {
    await run();
  } catch (error) {
    if (verdict.accepted) {
      throw new Error(`${label}: the model accepts it, but the store refused`, {
        cause: error,
      });
    }
    if (!verdict.refusals.some((refusal) => error instanceof refusal)) {
      throw new Error(
        `${label}: the model expected ${verdict.refusals.map((refusal) => refusal.name).join(" | ")} (${verdict.reason}), but the store threw something else`,
        { cause: error },
      );
    }
    return false;
  }
  if (!verdict.accepted) {
    throw new Error(
      `${label}: the model refuses it (${verdict.reason}), but the store accepted`,
    );
  }
  return true;
}

function edgeIdsFor(model: ClaimModel, step: ResolvedStep): readonly string[] {
  if (step.type === "link") return [model.nextEdgeId()];
  if (step.type === "bulkLink") return step.pairs.map(() => model.nextEdgeId());
  return [];
}

/** Predicts, runs and (when accepted) applies one non-transaction step. */
async function runStep(
  surface: WriteSurface,
  model: ClaimModel,
  generated: GeneratedStep,
): Promise<void> {
  const step = model.resolve(generated);
  if (step === undefined) return;
  const edgeIds = edgeIdsFor(model, step);
  const verdict = model.verdict(step, edgeIds);
  const accepted = await expectVerdict(
    verdict,
    `${JSON.stringify(step)} as ${edgeIds.join(",") || "-"}`,
    () => execute(surface, model, step, edgeIds),
  );
  if (accepted) model.apply(step, edgeIds);
}

/** Everything the store holds must agree with the model. */
async function assertAgreesWithModel(
  store: ClaimStore,
  backend: GraphBackend,
  model: ClaimModel,
): Promise<void> {
  // 1. The live data itself.
  const storeNodes: string[] = [];
  for (const node of await store.nodes.FencedEmployee.find())
    storeNodes.push(`FencedEmployee/${node.id}=${node.email}`);
  for (const node of await store.nodes.FencedContractor.find())
    storeNodes.push(`FencedContractor/${node.id}=${node.email}`);
  for (const node of await store.nodes.FencedVendor.find())
    storeNodes.push(`FencedVendor/${node.id}=${node.code}`);
  for (const node of await store.nodes.FencedCompany.find())
    storeNodes.push(`FencedCompany/${node.id}=`);
  const modelNodes = model
    .liveNodes()
    .filter((node) =>
      [
        "FencedEmployee",
        "FencedContractor",
        "FencedVendor",
        "FencedCompany",
      ].includes(node.kind),
    )
    .map((node) => `${nodeKey(node.kind, node.id)}=${node.uniqueValue ?? ""}`);
  expect(storeNodes.toSorted(), "live nodes").toEqual(modelNodes.toSorted());

  const storeEdges: string[] = [];
  for (const edgeKind of Object.keys(EDGE_DECLARATIONS) as EdgeKind[]) {
    for (const edge of await store.edges[edgeKind].find())
      storeEdges.push(`${edgeKind}/${edge.id}`);
  }
  expect(storeEdges.toSorted(), "live edges").toEqual(
    model
      .liveEdges()
      .map((edge) => `${edge.kind}/${edge.id}`)
      .toSorted(),
  );

  // 2. Released node claims are gone; owed ones are present, nothing else.
  expect(
    sortedJson(await readLiveUniqueRows(backend)),
    "live uniques rows (uniqueness + disjointness claims)",
  ).toEqual(sortedJson(model.expectedUniqueRows()));

  // 3. Every held edge axis names its holder. A row on an axis no live edge
  // holds is a stale claim the next writer takes over, so it may linger.
  const claimRows = await readEdgeClaimRows(backend, claimGraph.id);
  const rowsByTarget = new Map(
    claimRows.map((row) => [`${row.axis}\u0000${row.key}`, row.edge_id]),
  );
  for (const [target, holder] of model.expectedEdgeClaims()) {
    expect(
      rowsByTarget.get(target),
      `edge claim ${JSON.stringify(target)}`,
    ).toBe(holder);
  }

  // 4. On data the fences kept clean, the audit reports nothing.
  expect(await store.verifyConstraintFences()).toEqual([]);
}

// ============================================================
// Commands and seed
// ============================================================

type ClaimSystem = Readonly<{ store: ClaimStore; backend: GraphBackend }>;

/** One step as a model-run command: skipped when the model cannot decide it. */
class StepCommand implements fc.AsyncCommand<ClaimModel, ClaimSystem> {
  constructor(readonly step: Step) {}

  check(model: Readonly<ClaimModel>): boolean {
    return (
      this.step.type === "transaction" || model.resolve(this.step) !== undefined
    );
  }

  async run(model: ClaimModel, system: ClaimSystem): Promise<void> {
    const { step } = this;
    if (step.type === "transaction") {
      // Each inner refusal is caught INSIDE the transaction, which must then
      // commit the inner writes the model accepted and nothing of the refused
      // ones.
      await system.store.transaction(async (tx) => {
        for (const inner of step.steps) await runStep(tx, model, inner);
      });
    } else {
      await runStep(system.store, model, step);
    }
    await assertAgreesWithModel(system.store, system.backend, model);
  }

  toString(): string {
    return JSON.stringify(this.step);
  }
}

const commandsArb = fc.commands(
  [stepArb.map((step) => new StepCommand(step))],
  { maxCommands: 24, size: "+1" },
);

/**
 * A populated, violation-free starting state. Without it the interesting
 * region — a second claimant on a held axis — needs live endpoints that a
 * short random sequence rarely builds first.
 */
const SEED_STEPS: readonly SimpleStep[] = [
  { type: "putStaff", kind: "FencedEmployee", id: "i1", email: "a@x" },
  { type: "putStaff", kind: "FencedContractor", id: "i2", email: "b@x" },
  { type: "putVendor", id: "i1", code: "c1" },
  { type: "putVendor", id: "i2", code: "c2" },
  { type: "putCompany", id: "i3" },
];

const STRUCTURAL_SEED: readonly Readonly<{
  kind: "FencedPart" | "FencedBook" | "FencedAnthology";
  ids: readonly string[];
}>[] = [
  { kind: "FencedPart", ids: PART_POOL },
  { kind: "FencedBook", ids: BOOK_POOL },
  { kind: "FencedAnthology", ids: ANTHOLOGY_POOL },
];

async function seed(store: ClaimStore, model: ClaimModel): Promise<void> {
  for (const step of SEED_STEPS) await runStep(store, model, step);
  for (const { kind, ids } of STRUCTURAL_SEED) {
    for (const id of ids) {
      await store.nodes[kind].create({}, { id });
      model.putNode(kind, id, undefined);
    }
  }
}

// ============================================================
// Dirty rows: what the audit must report
// ============================================================

const PLANTED_VALID_FROM = "2000-01-01T00:00:00.000Z";
const PLANTED_VALID_TO = "2001-01-01T00:00:00.000Z";

/** Kinds a staff claim folds onto STAFF_AXIS from, other than the axis itself. */
const LEGACY_STAFF_AXES = uniquenessProbeKinds(
  "FencedEmployee",
  "kindWithSubClasses",
  registry,
).slice(1);

type Plant =
  | Readonly<
      {
        type: "plantEdge";
        edgeKind: EdgeKind;
        ended: boolean;
      } & EndpointPicks
    >
  | Readonly<{
      type: "plantNode";
      kind: "FencedEmployee" | "FencedCompany";
      id: string;
    }>
  | Readonly<{
      type: "plantUnique";
      nodeKind: string;
      email: string;
      concreteKind: StaffKind;
      nodeId: string;
    }>;

const plantArb: fc.Arbitrary<Plant> = fc.oneof(
  fc.record({
    type: fc.constant("plantEdge" as const),
    edgeKind: edgeKindArb,
    fromPick: fc.nat({ max: 5 }),
    toPick: fc.nat({ max: 5 }),
    ended: fc.boolean(),
  }),
  fc.record({
    type: fc.constant("plantNode" as const),
    kind: fc.constantFrom("FencedEmployee" as const, "FencedCompany" as const),
    id: fc.constantFrom(...ID_POOL),
  }),
  fc.record({
    type: fc.constant("plantUnique" as const),
    nodeKind: fc.constantFrom(...LEGACY_STAFF_AXES),
    email: fc.constantFrom(...EMAIL_POOL),
    concreteKind: fc.constantFrom(...STAFF_KINDS),
    nodeId: fc.constantFrom(...ID_POOL, "ghost"),
  }),
);

/** Writes one dirty row past the store, skipping one that would collide with a key. */
async function plantRow(
  backend: GraphBackend,
  model: ClaimModel,
  plant: Plant,
): Promise<void> {
  switch (plant.type) {
    case "plantEdge": {
      const { fromKind, toKind } = EDGE_ENDPOINTS[plant.edgeKind];
      const link = model.resolve({ ...plant, type: "link" });
      if (link?.type !== "link") return;
      const id = `planted-${model.nextEdgeId()}`;
      await backend.insertEdge({
        graphId: claimGraph.id,
        id,
        kind: plant.edgeKind,
        fromKind,
        fromId: link.fromId,
        toKind,
        toId: link.toId,
        props: {},
        ...(plant.ended ?
          { validFrom: PLANTED_VALID_FROM, validTo: PLANTED_VALID_TO }
        : {}),
      });
      model.edges.set(id, {
        ...model.proposedEdge(plant.edgeKind, link, id),
        ended: plant.ended,
      });
      return;
    }
    case "plantNode": {
      if (model.node(plant.kind, plant.id) !== undefined) return;
      const uniqueValue =
        plant.kind === "FencedEmployee" ? `planted-${plant.id}@x` : undefined;
      await backend.insertNode({
        graphId: claimGraph.id,
        kind: plant.kind,
        id: plant.id,
        props:
          uniqueValue === undefined ?
            { name: plant.id }
          : { email: uniqueValue },
      });
      model.nodes.set(nodeKey(plant.kind, plant.id), {
        kind: plant.kind,
        id: plant.id,
        ...(uniqueValue === undefined ? {} : { uniqueValue }),
        deleted: false,
        claimed: false,
      });
      return;
    }
    case "plantUnique": {
      const key = staffKey(plant.email);
      const occupied = model.plantedUniques.some(
        (row) => row.nodeKind === plant.nodeKind && row.key === key,
      );
      if (occupied) return;
      await backend.insertUnique({
        graphId: claimGraph.id,
        nodeKind: plant.nodeKind,
        constraintName: STAFF_EMAIL_CONSTRAINT,
        key,
        nodeId: plant.nodeId,
        concreteKind: plant.concreteKind,
      });
      model.plantedUniques.push({
        nodeKind: plant.nodeKind,
        key,
        concreteKind: plant.concreteKind,
        nodeId: plant.nodeId,
      });
      return;
    }
  }
}

type Owner = Readonly<{ concreteKind: string; nodeId: string }>;

function groupBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

/**
 * Every violation the audit must report, derived from the model's rows by the
 * DECLARED rules rather than from the claim rows: two owners of one key on a
 * uniqueness axis (store-written claims plus planted legacy-axis rows), one id
 * live under both kinds of the disjoint pair, two members of one cardinality
 * population, two wholes of one part.
 */
function expectedViolations(model: ClaimModel): readonly unknown[] {
  const violations: unknown[] = [];

  const uniqueRows = [
    ...model
      .expectedUniqueRows()
      .filter((row) => row.constraint_name !== DISJOINT_CONSTRAINT_NAME)
      .map((row) => ({
        axis: row.node_kind,
        constraintName: row.constraint_name,
        key: row.key,
        owner: { concreteKind: row.concrete_kind, nodeId: row.node_id },
      })),
    ...model.plantedUniques.map((row) => ({
      axis: STAFF_AXIS,
      constraintName: STAFF_EMAIL_CONSTRAINT,
      key: row.key,
      owner: { concreteKind: row.concreteKind, nodeId: row.nodeId },
    })),
  ];
  for (const rows of groupBy(
    uniqueRows,
    (row) => `${row.constraintName}\u0000${row.axis}\u0000${row.key}`,
  ).values()) {
    const owners = new Map<string, Owner>(
      rows.map((row) => [
        nodeKey(row.owner.concreteKind, row.owner.nodeId),
        row.owner,
      ]),
    );
    if (owners.size < 2) continue;
    const first = requireDefined(rows[0]);
    violations.push({
      family: "nodeUniqueness",
      target: {
        relation: "uniques",
        graphId: claimGraph.id,
        axis: first.axis,
        constraintName: first.constraintName,
        key: first.key,
      },
      owners: [...owners.values()],
    });
  }

  for (const id of ID_POOL) {
    if (
      model.liveNode(DISJOINT_PAIR[0], id) === undefined ||
      model.liveNode(DISJOINT_PAIR[1], id) === undefined
    )
      continue;
    violations.push({
      family: "nodeDisjointness",
      target: {
        relation: "uniques",
        graphId: claimGraph.id,
        axis: DISJOINT_AXIS,
        constraintName: DISJOINT_CONSTRAINT_NAME,
        key: id,
      },
      owners: DISJOINT_PAIR.map((kind) => ({ concreteKind: kind, nodeId: id })),
    });
  }

  const liveEdges = model.liveEdges();
  for (const edgeKind of Object.keys(EDGE_DECLARATIONS) as EdgeKind[]) {
    for (const ref of edgeCardinalityAxisReferences(
      EDGE_DECLARATIONS[edgeKind],
    )) {
      const members = liveEdges.filter(
        (edge) =>
          edge.kind === edgeKind &&
          (ref.cardinality !== "oneActive" || !edge.ended),
      );
      const keyed = groupBy(members, (edge) =>
        ref.direction === "source" ? edge.fromId : edge.toId,
      );
      for (const group of keyed.values()) {
        if (group.length < 2) continue;
        const sample = requireDefined(group[0]);
        violations.push({
          family: "edgeCardinality",
          target: edgeCardinalityClaimTarget({
            ...ref,
            graphId: claimGraph.id,
            edgeKind,
            edgeId: sample.id,
            fromKind: sample.fromKind,
            fromId: sample.fromId,
            toKind: sample.toKind,
            toId: sample.toId,
          }),
          edgeKind,
          direction: ref.direction,
          cardinality: ref.cardinality,
          keyedOn:
            ref.direction === "source" ?
              { from: { kind: sample.fromKind, id: sample.fromId } }
            : { to: { kind: sample.toKind, id: sample.toId } },
          edgeIds: group.map((edge) => edge.id),
        });
      }
    }
  }

  const compositionMembers = liveEdges.filter(
    (edge) => compositionPart(edge) !== undefined,
  );
  for (const [part, group] of groupBy(compositionMembers, (edge) =>
    requireDefined(compositionPart(edge)),
  )) {
    if (group.length < 2) continue;
    const [partKind, partId] = part.split("/");
    violations.push({
      family: "composition",
      target: {
        relation: "edgeClaims",
        graphId: claimGraph.id,
        axis: COMPOSITION_RELATION_NAME,
        key: encodeTupleKey([requireDefined(partKind), requireDefined(partId)]),
      },
      part: { kind: requireDefined(partKind), id: requireDefined(partId) },
      edgeIds: group.map((edge) => edge.id),
    });
  }
  return violations;
}

/** A violation with every list in a canonical order, for set comparison. */
function sortedIfList(list: unknown): unknown {
  return Array.isArray(list) ? sortedJson(list as readonly unknown[]) : list;
}

function canonicalViolation(violation: unknown): string {
  const record = violation as Readonly<Record<string, unknown>>;
  return JSON.stringify({
    ...record,
    ...("owners" in record ? { owners: sortedIfList(record["owners"]) } : {}),
    ...("edgeIds" in record ?
      { edgeIds: sortedIfList(record["edgeIds"]) }
    : {}),
  });
}

function canonicalViolations(
  violations: readonly unknown[],
): readonly string[] {
  return violations
    .map((violation) => canonicalViolation(violation))
    .toSorted((left, right) => compareStrings(left, right));
}

// ============================================================
// Properties
// ============================================================

describe("constraint claims over random write sequences", () => {
  it("accept exactly the writes the model admits and hold exactly the claims it owes", async () => {
    await fc.assert(
      fc.asyncProperty(commandsArb, async (commands) => {
        const backend = createTestBackend();
        const [store] = await createStoreWithSchema(claimGraph, backend);
        const model = new ClaimModel();
        await seed(store, model);
        await assertAgreesWithModel(store, backend, model);
        await fc.asyncModelRun(
          () => ({ model, real: { store, backend } }),
          commands,
        );
      }),
      { numRuns: propertyRuns({ ci: 60, local: 120 }) },
    );
  });

  it("report exactly the violations planted past the store", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArb, { maxLength: 8 }),
        fc.array(plantArb, { minLength: 1, maxLength: 4 }),
        async (steps, plants) => {
          const backend = createTestBackend();
          const [store] = await createStoreWithSchema(claimGraph, backend);
          const model = new ClaimModel();
          await seed(store, model);
          for (const step of steps) {
            if (step.type === "transaction") continue;
            await runStep(store, model, step);
          }
          for (const plant of plants) await plantRow(backend, model, plant);

          expect(
            canonicalViolations(await store.verifyConstraintFences()),
          ).toEqual(canonicalViolations(expectedViolations(model)));
        },
      ),
      { numRuns: propertyRuns({ ci: 60, local: 120 }) },
    );
  });
});
