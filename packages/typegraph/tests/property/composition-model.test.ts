/**
 * Model-based composition property: random command sequences over a small
 * composition graph, each command judged against an independent ownership
 * model rather than by re-running the code under test.
 *
 * The graph covers every shape the write paths distinguish: a whole
 * (`CpWhole`); a required `oneActive` mid kind (`CpMid`) realized by BOTH a
 * part-side `partOf` edge and a whole-side `hasPart` edge, so one part's
 * attachment spans two edge kinds; a required `one` leaf (`CpLeaf`); an
 * optional `one` leaf (`CpTag`); and a reflexive optional folder
 * (`CpFolder`), the one kind a composition cycle can run through.
 *
 * After every command the oracle checks: the allow/refuse verdict and error
 * class the model predicts; that a refusal changed no node, edge or claim row;
 * that the stored rows equal the model's; that no part holds more than one
 * attaching edge and every live required part hangs from a live whole (read
 * from the rows, not the model); `verifyConstraintFences()`; and that
 * `parts()` / `wholes()` agree with the model. A node delete additionally
 * checks its `planDelete` preview and the `cascadedParts` it reports against
 * the model's closure, leaf-first and by kind, then id, within a level.
 *
 * The Date is faked and advanced per command, with an occasional step
 * backwards, so a move instant can fall before an incumbent's start and a
 * window end can fall before its edge's start.
 */
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type CompositionCascadedPart,
  CompositionError,
  CompositionExistenceError,
  ConfigurationError,
  defineEdge,
  defineGraph,
  defineNode,
  EdgeAcyclicityError,
  EndpointNotFoundError,
  type GraphBackend,
  hasPart,
  type NodeDeletePlan,
  NodeDeletePlanMismatchError,
  NodeNotFoundError,
  type OperationHookContext,
  partOf,
  ValidationError,
} from "../../src";
import { createPostgresBackend } from "../../src/backend/drizzle/postgres";
import { createLocalPgliteBackend } from "../../src/backend/postgres/pglite";
import { sql } from "../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../src/query/sql-intent";
import { createStoreWithSchema } from "../../src/store";
import { requireDefined } from "../../src/utils/presence";
import { createTestBackend } from "../test-utils";
import { propertyRuns } from "./run-budget";

// ============================================================
// Graph
// ============================================================

const CpWhole = defineNode("CpWhole", { schema: z.object({}) });
const CpMid = defineNode("CpMid", { schema: z.object({}) });
const CpLeaf = defineNode("CpLeaf", { schema: z.object({}) });
const CpTag = defineNode("CpTag", { schema: z.object({}) });
const CpFolder = defineNode("CpFolder", { schema: z.object({}) });
const cpMidOf = defineEdge("cpMidOf", { schema: z.object({}) });
const cpWholeHasMid = defineEdge("cpWholeHasMid", { schema: z.object({}) });
const cpLeafOf = defineEdge("cpLeafOf", { schema: z.object({}) });
const cpTagOf = defineEdge("cpTagOf", { schema: z.object({}) });
const cpFolderOf = defineEdge("cpFolderOf", { schema: z.object({}) });

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      CpWhole: { type: CpWhole },
      CpMid: { type: CpMid },
      CpLeaf: { type: CpLeaf },
      CpTag: { type: CpTag },
      CpFolder: { type: CpFolder },
    },
    edges: {
      cpMidOf: {
        type: cpMidOf,
        from: [CpMid],
        to: [CpWhole],
        cardinality: "oneActive",
      },
      cpWholeHasMid: {
        type: cpWholeHasMid,
        from: [CpWhole],
        to: [CpMid],
        targetCardinality: "oneActive",
      },
      cpLeafOf: {
        type: cpLeafOf,
        from: [CpLeaf],
        to: [CpMid],
        cardinality: "one",
      },
      cpTagOf: {
        type: cpTagOf,
        from: [CpTag],
        to: [CpMid],
        cardinality: "one",
      },
      cpFolderOf: {
        type: cpFolderOf,
        from: [CpFolder],
        to: [CpFolder],
        cardinality: "one",
      },
    },
    ontology: [
      partOf(CpMid, CpWhole, { via: cpMidOf, existence: "required" }),
      hasPart(CpWhole, CpMid, { via: cpWholeHasMid, existence: "required" }),
      partOf(CpLeaf, CpMid, { via: cpLeafOf, existence: "required" }),
      partOf(CpTag, CpMid, { via: cpTagOf }),
      partOf(CpFolder, CpFolder, { via: cpFolderOf, partSide: "from" }),
    ],
  });
}

type CompositionGraph = ReturnType<typeof buildGraph>;
type CompositionStore = Awaited<
  ReturnType<typeof createStoreWithSchema<CompositionGraph>>
>[0];

const NODE_KINDS = ["CpWhole", "CpMid", "CpLeaf", "CpTag", "CpFolder"] as const;
type NodeKind = (typeof NODE_KINDS)[number];
type PartKind = Exclude<NodeKind, "CpWhole">;
const PART_KINDS: readonly PartKind[] = [
  "CpMid",
  "CpLeaf",
  "CpTag",
  "CpFolder",
];

const EDGE_KINDS = [
  "cpMidOf",
  "cpWholeHasMid",
  "cpLeafOf",
  "cpTagOf",
  "cpFolderOf",
] as const;
type EdgeKind = (typeof EDGE_KINDS)[number];

/** The reference model's copy of the ontology above, written out by hand. */
type ModelPair = Readonly<{
  partKind: PartKind;
  wholeKind: NodeKind;
  partSide: "from" | "to";
  population: "one" | "oneActive";
}>;
const PAIRS: Readonly<Record<EdgeKind, ModelPair>> = {
  cpMidOf: {
    partKind: "CpMid",
    wholeKind: "CpWhole",
    partSide: "from",
    population: "oneActive",
  },
  cpWholeHasMid: {
    partKind: "CpMid",
    wholeKind: "CpWhole",
    partSide: "to",
    population: "oneActive",
  },
  cpLeafOf: {
    partKind: "CpLeaf",
    wholeKind: "CpMid",
    partSide: "from",
    population: "one",
  },
  cpTagOf: {
    partKind: "CpTag",
    wholeKind: "CpMid",
    partSide: "from",
    population: "one",
  },
  cpFolderOf: {
    partKind: "CpFolder",
    wholeKind: "CpFolder",
    partSide: "from",
    population: "one",
  },
};
const REQUIRED_PART_KINDS: ReadonlySet<NodeKind> = new Set(["CpMid", "CpLeaf"]);
/** Leaf kinds the raw backend may retire without orphaning anything below them. */
const RAW_RETIRABLE_KINDS = ["CpLeaf", "CpTag"] as const;

function edgeKindsOfPart(kind: PartKind): readonly EdgeKind[] {
  return EDGE_KINDS.filter((edgeKind) => PAIRS[edgeKind].partKind === kind);
}

// ============================================================
// Reference model
// ============================================================

interface ModelNode {
  kind: NodeKind;
  live: boolean;
}
interface ModelEdge {
  kind: EdgeKind;
  partId: string;
  wholeId: string;
  validFrom: number;
  validTo: number | undefined;
  deleted: boolean;
}
interface Model {
  clock: number;
  /** Every node row that exists, live or tombstoned; a purged row is absent. */
  nodes: Map<string, ModelNode>;
  /** Every edge row that exists; ids under `PENDING_PREFIX` await their stored id. */
  edges: Map<string, ModelEdge>;
  /** Every node id ever issued, by kind, so a purged id can be named again. */
  issuedIds: Map<NodeKind, string[]>;
  nextSerial: number;
}

const PENDING_PREFIX = "pending:";
const START_INSTANT = Date.parse("2099-01-01T00:00:00.000Z");

function initialModel(): Model {
  return {
    clock: START_INSTANT,
    nodes: new Map(),
    edges: new Map(),
    issuedIds: new Map(NODE_KINDS.map((kind) => [kind, []])),
    nextSerial: 0,
  };
}

function issueId(model: Model, kind: NodeKind, salt: string): string {
  model.nextSerial += 1;
  const id = `${salt}${model.nextSerial}`;
  requireDefined(model.issuedIds.get(kind)).push(id);
  return id;
}

function isLive(model: Model, id: string): boolean {
  return model.nodes.get(id)?.live === true;
}

function edgeCounts(edge: ModelEdge): boolean {
  if (edge.deleted) return false;
  return PAIRS[edge.kind].population === "one" || edge.validTo === undefined;
}

function attachmentOf(
  model: Model,
  partId: string,
): Readonly<{ id: string; edge: ModelEdge }> | undefined {
  for (const [id, edge] of model.edges) {
    if (edge.partId === partId && edgeCounts(edge)) return { id, edge };
  }
  return undefined;
}

function countingPartEdges(
  model: Model,
  wholeId: string,
): readonly Readonly<{ id: string; edge: ModelEdge }>[] {
  return [...model.edges]
    .filter(([, edge]) => edge.wholeId === wholeId && edgeCounts(edge))
    .map(([id, edge]) => ({ id, edge }));
}

/** Whether `ancestorId` is `nodeId` or one of the wholes above it. */
function isSelfOrAncestor(
  model: Model,
  ancestorId: string,
  nodeId: string,
): boolean {
  const seen = new Set<string>();
  let current: string | undefined = nodeId;
  while (current !== undefined && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = attachmentOf(model, current)?.edge.wholeId;
  }
  return false;
}

function compareTuples(
  left: readonly string[],
  right: readonly string[],
): number {
  for (const [index, value] of left.entries()) {
    const other = requireDefined(right[index]);
    if (value < other) return -1;
    if (value > other) return 1;
  }
  return 0;
}

/**
 * The cascade closure of one whole: breadth-first through every counting
 * composition edge (walking THROUGH a dead member), deepest level first, each
 * level by kind then id, dead members dropped last.
 */
function cascadeClosure(
  model: Model,
  rootId: string,
): readonly CompositionCascadedPart[] {
  const rounds: CompositionCascadedPart[][] = [];
  let frontier = [rootId];
  while (frontier.length > 0) {
    const round: CompositionCascadedPart[] = [];
    for (const wholeId of frontier) {
      const whole = requireDefined(model.nodes.get(wholeId));
      for (const { edge } of countingPartEdges(model, wholeId)) {
        round.push({
          kind: requireDefined(model.nodes.get(edge.partId)).kind,
          id: edge.partId,
          whole: { kind: whole.kind, id: wholeId },
          viaEdgeKind: edge.kind,
        });
      }
    }
    if (round.length > 0) rounds.push(round);
    frontier = round.map((member) => member.id);
  }
  return rounds
    .toReversed()
    .flatMap((round) =>
      round.toSorted((left, right) =>
        compareTuples([left.kind, left.id], [right.kind, right.id]),
      ),
    )
    .filter((member) => isLive(model, member.id));
}

function incidentEdgeIds(
  model: Model,
  nodeIds: ReadonlySet<string>,
  includeDeleted: boolean,
): readonly string[] {
  return [...model.edges]
    .filter(
      ([, edge]) =>
        (includeDeleted || !edge.deleted) &&
        (nodeIds.has(edge.partId) || nodeIds.has(edge.wholeId)),
    )
    .map(([id]) => id)
    .toSorted();
}

type ModelPlan = Readonly<{
  cascadedParts: readonly CompositionCascadedPart[];
  removedEdgeIds: readonly string[];
}>;

function deletePlan(model: Model, id: string): ModelPlan | undefined {
  if (!isLive(model, id)) return undefined;
  const cascadedParts = cascadeClosure(model, id);
  const deleted = new Set([id, ...cascadedParts.map((part) => part.id)]);
  return {
    cascadedParts,
    removedEdgeIds: incidentEdgeIds(model, deleted, false),
  };
}

function cascadedPartKey(part: CompositionCascadedPart): string {
  return `${part.kind}/${part.id}<${part.whole.kind}/${part.whole.id}:${part.viaEdgeKind}`;
}

function plansMatch(left: ModelPlan, right: ModelPlan): boolean {
  const sortedParts = (plan: ModelPlan) =>
    plan.cascadedParts.map((part) => cascadedPartKey(part)).toSorted();
  return (
    JSON.stringify(sortedParts(left)) === JSON.stringify(sortedParts(right)) &&
    JSON.stringify(left.removedEdgeIds) === JSON.stringify(right.removedEdgeIds)
  );
}

function applySoftDelete(model: Model, id: string): void {
  const plan = deletePlan(model, id);
  if (plan === undefined) return;
  for (const edgeId of plan.removedEdgeIds) {
    requireDefined(model.edges.get(edgeId)).deleted = true;
  }
  for (const nodeId of [id, ...plan.cascadedParts.map((part) => part.id)]) {
    requireDefined(model.nodes.get(nodeId)).live = false;
  }
}

function applyHardDelete(model: Model, id: string): void {
  if (!model.nodes.has(id)) return;
  const members = cascadeClosure(model, id).map((part) => part.id);
  const purged = new Set([id, ...members]);
  for (const edgeId of incidentEdgeIds(model, purged, true)) {
    model.edges.delete(edgeId);
  }
  for (const nodeId of purged) model.nodes.delete(nodeId);
}

let pendingSerial = 0;
function addEdge(model: Model, edge: Omit<ModelEdge, "deleted">): void {
  pendingSerial += 1;
  model.edges.set(`${PENDING_PREFIX}${pendingSerial}`, {
    ...edge,
    deleted: false,
  });
}

function storedEdgeIds(model: Model, kind: EdgeKind): readonly string[] {
  return [...model.edges]
    .filter(
      ([id, edge]) =>
        edge.kind === kind && !edge.deleted && !id.startsWith(PENDING_PREFIX),
    )
    .map(([id]) => id);
}

function pick<T>(items: readonly T[], index: number): T | undefined {
  return items.length === 0 ? undefined : items[index % items.length];
}

/** Issued ids of a kind, plus one that was never issued. */
function candidateIds(model: Model, kind: NodeKind): readonly string[] {
  return [...requireDefined(model.issuedIds.get(kind)), `${kind}-ghost`];
}

/**
 * Four picks in five name a live node of the kind (when there is one); the
 * fifth names any issued id or the never-issued one, so refusals over dead
 * and missing nodes stay in the mix without starving the graph of structure.
 */
function pickNodeId(
  model: Model,
  kind: NodeKind,
  value: number,
): string | undefined {
  const live = requireDefined(model.issuedIds.get(kind)).filter((id) =>
    isLive(model, id),
  );
  const index = Math.floor(value / 5);
  return value % 5 !== 0 && live.length > 0 ?
      pick(live, index)
    : pick(candidateIds(model, kind), index);
}

function iso(instant: number): string {
  return new Date(instant).toISOString();
}

// ============================================================
// Steps: one write, its predicted verdict, and its effect on the model
// ============================================================

type ErrorClass = abstract new (...args: never[]) => Error;

type DynamicNodeCollection = Readonly<{
  create: (
    props: object,
    options?: Readonly<{ id?: string; partOf?: object }>,
  ) => Promise<unknown>;
  delete: (
    id: string,
    options?: Readonly<{ expect: NodeDeletePlan }>,
  ) => Promise<void>;
  hardDelete: (id: string) => Promise<void>;
  bulkDelete: (ids: readonly string[]) => Promise<void>;
  upsertById: (id: string, props: object) => Promise<unknown>;
  reparent: (id: string, options: object) => Promise<unknown>;
  bulkReparent: (
    items: readonly Readonly<{ id: string; options: object }>[],
  ) => Promise<unknown>;
  planDelete: (id: string) => Promise<NodeDeletePlan | undefined>;
}>;
type NodeRefInput = Readonly<{ kind: string; id: string }>;
type DynamicEdgeCollection = Readonly<{
  create: (
    from: NodeRefInput,
    to: NodeRefInput,
    props: object,
  ) => Promise<unknown>;
  update: (
    id: string,
    props: object,
    options: Readonly<{ validTo: string }>,
  ) => Promise<unknown>;
  delete: (id: string) => Promise<void>;
  hardDelete: (id: string) => Promise<void>;
  bulkDelete: (ids: readonly string[]) => Promise<void>;
}>;
type Surface = Readonly<{
  nodes: Readonly<Record<NodeKind, DynamicNodeCollection>>;
  edges: Readonly<Record<EdgeKind, DynamicEdgeCollection>>;
}>;

type Real = Readonly<{
  store: CompositionStore;
  backend: GraphBackend;
  graphId: string;
  /** `cascadedParts` of every node delete's `onOperationEnd`, by node id. */
  cascades: Map<string, readonly CompositionCascadedPart[] | undefined>;
}>;

type Step = Readonly<{
  label: string;
  /** Empty: the write must succeed. Otherwise any of these classes is accepted. */
  refusals: readonly ErrorClass[];
  perform: (surface: Surface, real: Real) => Promise<void>;
  apply?: (model: Model) => void;
  /** Further checks after a successful top-level step, against the updated model. */
  verify?: (real: Real, model: Model) => Promise<void>;
}>;

/** Builds the next step from the model as it stands, or `undefined` when nothing applies. */
type StepFactory = (model: Model) => Step | undefined;

function surfaceOf(target: object): Surface {
  return target as unknown as Surface;
}

function partOfOption(
  model: Model,
  wholeId: string,
  wholeKind: NodeKind,
  via: EdgeKind | undefined,
): object {
  return {
    whole: { kind: wholeKind, id: wholeId },
    ...(via === undefined ? {} : { via }),
  };
}

function createNodeStep(
  kind: NodeKind,
  salt: string,
  attachment:
    | Readonly<{
        wholePick: number;
        via: EdgeKind | "omit";
        /** A stated whole, or the most recently issued id of the whole kind. */
        whole?: Readonly<{ id: string }> | "latest";
      }>
    | undefined,
): StepFactory {
  return (model) => {
    const id = issueId(model, kind, salt);
    const node = (surface: Surface) => surface.nodes[kind];
    if (attachment === undefined || kind === "CpWhole") {
      return {
        label: `create ${kind}/${id} bare`,
        refusals:
          REQUIRED_PART_KINDS.has(kind) ? [CompositionExistenceError] : [],
        perform: async (surface) => {
          await node(surface).create({}, { id });
        },
        apply: (next) => {
          next.nodes.set(id, { kind, live: true });
        },
      };
    }
    const partKind = kind;
    const viaKind =
      attachment.via === "omit" ?
        requireDefined(edgeKindsOfPart(partKind)[0])
      : attachment.via;
    const pair = PAIRS[viaKind];
    const wholeId =
      attachment.whole === "latest" ?
        (requireDefined(model.issuedIds.get(pair.wholeKind)).at(
          pair.wholeKind === kind ? -2 : -1,
        ) ?? `${pair.wholeKind}-ghost`)
      : (attachment.whole?.id ??
        requireDefined(
          pickNodeId(model, pair.wholeKind, attachment.wholePick),
        ));
    const stateVia = attachment.via === "omit" ? undefined : attachment.via;
    const refusals: ErrorClass[] = [];
    if (stateVia === undefined && edgeKindsOfPart(partKind).length > 1) {
      refusals.push(ConfigurationError);
    }
    if (wholeId === id) refusals.push(EdgeAcyclicityError);
    else if (!isLive(model, wholeId)) refusals.push(EndpointNotFoundError);
    return {
      label: `create ${kind}/${id} partOf ${wholeId} via ${attachment.via}`,
      refusals,
      perform: async (surface) => {
        await node(surface).create(
          {},
          {
            id,
            partOf: partOfOption(model, wholeId, pair.wholeKind, stateVia),
          },
        );
      },
      apply: (next) => {
        next.nodes.set(id, { kind, live: true });
        addEdge(next, {
          kind: viaKind,
          partId: id,
          wholeId,
          validFrom: next.clock,
          validTo: undefined,
        });
      },
    };
  };
}

function createEdgeStep(
  edgeKind: EdgeKind,
  partPick: number,
  wholePick: number,
): StepFactory {
  return (model) => {
    const pair = PAIRS[edgeKind];
    const partId = requireDefined(pickNodeId(model, pair.partKind, partPick));
    const wholeId = requireDefined(
      pickNodeId(model, pair.wholeKind, wholePick),
    );
    const refusals: ErrorClass[] = [];
    if (!isLive(model, partId) || !isLive(model, wholeId)) {
      refusals.push(EndpointNotFoundError);
    }
    if (attachmentOf(model, partId) !== undefined) {
      refusals.push(CompositionError);
    }
    if (isSelfOrAncestor(model, partId, wholeId)) {
      refusals.push(EdgeAcyclicityError);
    }
    const part = { kind: pair.partKind, id: partId };
    const whole = { kind: pair.wholeKind, id: wholeId };
    return {
      label: `edge ${edgeKind} create ${partId} -> ${wholeId}`,
      refusals,
      perform: async (surface) => {
        const [from, to] =
          pair.partSide === "from" ? [part, whole] : [whole, part];
        await surface.edges[edgeKind].create(from, to, {});
      },
      apply: (next) => {
        addEdge(next, {
          kind: edgeKind,
          partId,
          wholeId,
          validFrom: next.clock,
          validTo: undefined,
        });
      },
    };
  };
}

type AtMode = "omit" | "now" | "past" | "beforeIncumbent" | "future";
type MoveSpec = Readonly<{
  partPick: number;
  wholePick: number;
  via: EdgeKind | "omit";
  at: AtMode;
}>;
type ResolvedMove = Readonly<{
  partId: string;
  via: EdgeKind;
  statedVia: EdgeKind | undefined;
  wholeId: string;
  at: number | undefined;
  noop: boolean;
  /** The refusals this item earns on its own, before the batch's cycle check. */
  refusals: readonly ErrorClass[];
  options: object;
}>;

function resolveMove(
  model: Model,
  kind: PartKind,
  spec: MoveSpec,
): ResolvedMove {
  const kinds = edgeKindsOfPart(kind);
  const statedVia = spec.via === "omit" ? undefined : spec.via;
  const via = statedVia ?? requireDefined(kinds[0]);
  const pair = PAIRS[via];
  const partId = requireDefined(pickNodeId(model, kind, spec.partPick));
  const wholeId = requireDefined(
    pickNodeId(model, pair.wholeKind, spec.wholePick),
  );
  const incumbent = attachmentOf(model, partId);
  const at = ((): number | undefined => {
    switch (spec.at) {
      case "omit": {
        return undefined;
      }
      case "now": {
        return model.clock;
      }
      case "past": {
        return model.clock - 20_000;
      }
      case "future": {
        return model.clock + 20_000;
      }
      case "beforeIncumbent": {
        return (incumbent?.edge.validFrom ?? model.clock) - 10_000;
      }
    }
  })();
  const noop =
    incumbent?.edge.wholeId === wholeId && incumbent.edge.kind === via;
  const refusals: ErrorClass[] = [];
  if (statedVia === undefined && kinds.length > 1) {
    refusals.push(ConfigurationError);
  }
  if (!isLive(model, partId)) refusals.push(NodeNotFoundError);
  if (!isLive(model, wholeId)) refusals.push(EndpointNotFoundError);
  if (at !== undefined && at > model.clock) refusals.push(CompositionError);
  // A no-op move cannot honor a stated instant other than the held edge's
  // own start, so it refuses it rather than dropping it.
  if (noop && at !== undefined && at !== incumbent.edge.validFrom) {
    refusals.push(ValidationError);
  }
  if (
    !noop &&
    at !== undefined &&
    incumbent !== undefined &&
    PAIRS[incumbent.edge.kind].population === "oneActive" &&
    at < incumbent.edge.validFrom
  ) {
    refusals.push(CompositionError);
  }
  return {
    partId,
    via,
    statedVia,
    wholeId,
    at,
    noop,
    refusals,
    options: {
      ...partOfOption(model, wholeId, pair.wholeKind, statedVia),
      ...(at === undefined ? {} : { at: iso(at) }),
    },
  };
}

function applyMove(model: Model, move: ResolvedMove): void {
  if (move.noop) return;
  const incumbent = attachmentOf(model, move.partId);
  const oneActiveIncumbent =
    incumbent !== undefined &&
    PAIRS[incumbent.edge.kind].population === "oneActive";
  const instant =
    move.at ??
    (oneActiveIncumbent ?
      Math.max(model.clock, requireDefined(incumbent).edge.validFrom)
    : model.clock);
  if (incumbent !== undefined) {
    if (oneActiveIncumbent) incumbent.edge.validTo = instant;
    else incumbent.edge.deleted = true;
  }
  addEdge(model, {
    kind: move.via,
    partId: move.partId,
    wholeId: move.wholeId,
    validFrom: instant,
    validTo: undefined,
  });
}

function hasCycleAbove(model: Model, partId: string): boolean {
  const seen = new Set<string>();
  let current: string | undefined = partId;
  while (current !== undefined) {
    if (seen.has(current)) return true;
    seen.add(current);
    current = attachmentOf(model, current)?.edge.wholeId;
  }
  return false;
}

function reparentStep(kind: PartKind, spec: MoveSpec): StepFactory {
  return (model) => {
    const move = resolveMove(model, kind, spec);
    const refusals = [...move.refusals];
    if (
      !move.noop &&
      (move.partId === move.wholeId ||
        isSelfOrAncestor(model, move.partId, move.wholeId))
    ) {
      refusals.push(EdgeAcyclicityError);
    }
    return {
      label: `reparent ${kind}/${move.partId} -> ${move.wholeId} via ${spec.via} at ${spec.at}`,
      refusals,
      perform: async (surface) => {
        await surface.nodes[kind].reparent(move.partId, move.options);
      },
      apply: (next) => {
        applyMove(next, move);
      },
    };
  };
}

function bulkReparentStep(
  kind: PartKind,
  specs: readonly MoveSpec[],
): StepFactory {
  return (model) => {
    const moves = specs.map((spec) => resolveMove(model, kind, spec));
    const refusals = moves.flatMap((move) => move.refusals);
    const partIds = moves.map((move) => move.partId);
    if (new Set(partIds).size < partIds.length) refusals.push(ValidationError);
    if (refusals.length === 0) {
      const projected = structuredClone(model);
      for (const move of moves) applyMove(projected, move);
      if (moves.some((move) => hasCycleAbove(projected, move.partId))) {
        refusals.push(EdgeAcyclicityError);
      }
    }
    return {
      label: `bulkReparent ${kind} [${moves.map((move) => `${move.partId}->${move.wholeId}`).join(", ")}]`,
      refusals,
      perform: async (surface) => {
        await surface.nodes[kind].bulkReparent(
          moves.map((move) => ({ id: move.partId, options: move.options })),
        );
      },
      apply: (next) => {
        for (const move of moves) applyMove(next, move);
      },
    };
  };
}

type NodeDeleteForm = "delete" | "hardDelete";

function nodeDeleteStep(
  kind: NodeKind,
  idPick: number,
  form: NodeDeleteForm,
): StepFactory {
  return (model) => {
    const id = requireDefined(pickNodeId(model, kind, idPick));
    const expectedPlan = deletePlan(model, id);
    let preview: NodeDeletePlan | undefined;
    return {
      label: `${form} ${kind}/${id}`,
      refusals: [],
      perform: async (surface, real) => {
        const collection = surface.nodes[kind];
        preview = await collection.planDelete(id);
        real.cascades.delete(id);
        await (form === "delete" ?
          collection.delete(id)
        : collection.hardDelete(id));
      },
      apply: (next) => {
        if (form === "delete") applySoftDelete(next, id);
        else applyHardDelete(next, id);
      },
      // `planDelete` previews the soft delete; a hard delete cascades
      // through the same closure.
      verify: async (real) => {
        expect({ id, preview: previewOf(preview) }).toEqual({
          id,
          preview: expectedPlan,
        });
        if (expectedPlan === undefined) return;
        expect({ id, cascadedParts: real.cascades.get(id) }).toEqual({
          id,
          cascadedParts: expectedPlan.cascadedParts,
        });
        await Promise.resolve();
      },
    };
  };
}

function previewOf(plan: NodeDeletePlan | undefined): ModelPlan | undefined {
  if (plan === undefined) return undefined;
  return {
    cascadedParts: plan.cascadedParts.map((part) => ({
      kind: part.kind,
      id: part.id,
      whole: { kind: part.whole.kind, id: part.whole.id },
      viaEdgeKind: part.viaEdgeKind,
    })),
    removedEdgeIds: [...plan.removedEdgeIds],
  };
}

function nodeBulkDeleteStep(
  kind: NodeKind,
  picks: readonly number[],
): StepFactory {
  return (model) => {
    const ids = [
      ...new Set(
        picks.map((index) => requireDefined(pickNodeId(model, kind, index))),
      ),
    ];
    return {
      label: `bulkDelete ${kind} [${ids.join(", ")}]`,
      refusals: [],
      perform: async (surface) => {
        await surface.nodes[kind].bulkDelete(ids);
      },
      apply: (next) => {
        for (const id of ids) applySoftDelete(next, id);
      },
    };
  };
}

function detachRefusal(model: Model, edge: ModelEdge): readonly ErrorClass[] {
  const pair = PAIRS[edge.kind];
  return (
      edgeCounts(edge) &&
        REQUIRED_PART_KINDS.has(pair.partKind) &&
        isLive(model, edge.partId)
    ) ?
      [CompositionExistenceError]
    : [];
}

type EdgeWriteForm = "delete" | "hardDelete";

function edgeDeleteStep(
  edgeKind: EdgeKind,
  edgePick: number,
  form: EdgeWriteForm,
): StepFactory {
  return (model) => {
    const id = pick(storedEdgeIds(model, edgeKind), edgePick);
    if (id === undefined) return;
    const edge = requireDefined(model.edges.get(id));
    return {
      label: `edge ${edgeKind} ${form} ${id} (${edge.partId} -> ${edge.wholeId})`,
      refusals: detachRefusal(model, edge),
      perform: async (surface) => {
        await (form === "delete" ?
          surface.edges[edgeKind].delete(id)
        : surface.edges[edgeKind].hardDelete(id));
      },
      apply: (next) => {
        if (form === "delete")
          requireDefined(next.edges.get(id)).deleted = true;
        else next.edges.delete(id);
      },
    };
  };
}

function edgeBulkDeleteStep(
  edgeKind: EdgeKind,
  picks: readonly number[],
): StepFactory {
  return (model) => {
    const candidates = storedEdgeIds(model, edgeKind);
    if (candidates.length === 0) return;
    const ids = [
      ...new Set(picks.map((index) => requireDefined(pick(candidates, index)))),
    ];
    const refusals = ids.flatMap((id) =>
      detachRefusal(model, requireDefined(model.edges.get(id))),
    );
    return {
      label: `edge ${edgeKind} bulkDelete [${ids.join(", ")}]`,
      refusals,
      perform: async (surface) => {
        await surface.edges[edgeKind].bulkDelete(ids);
      },
      apply: (next) => {
        for (const id of ids) requireDefined(next.edges.get(id)).deleted = true;
      },
    };
  };
}

type EndMode = "now" | "past" | "beforeStart" | "future";

function edgeEndStep(
  edgeKind: EdgeKind,
  edgePick: number,
  mode: EndMode,
  partId?: () => string | undefined,
): StepFactory {
  return (model) => {
    const candidates = storedEdgeIds(model, edgeKind).filter(
      (id) =>
        partId === undefined ||
        requireDefined(model.edges.get(id)).partId === partId(),
    );
    const id = pick(candidates, edgePick);
    if (id === undefined) return;
    const edge = requireDefined(model.edges.get(id));
    const validTo = ((): number => {
      switch (mode) {
        case "now": {
          return model.clock;
        }
        case "past": {
          return model.clock - 10_000;
        }
        case "beforeStart": {
          return edge.validFrom - 10_000;
        }
        case "future": {
          return model.clock + 10_000;
        }
      }
    })();
    const refusals: ErrorClass[] = [];
    if (validTo > model.clock) refusals.push(CompositionError);
    if (validTo < edge.validFrom) refusals.push(ValidationError);
    if (edge.validTo === undefined)
      refusals.push(...detachRefusal(model, edge));
    return {
      label: `edge ${edgeKind} end ${id} at ${mode} (${edge.partId} -> ${edge.wholeId}, open=${edge.validTo === undefined})`,
      refusals,
      perform: async (surface) => {
        await surface.edges[edgeKind].update(id, {}, { validTo: iso(validTo) });
      },
      apply: (next) => {
        requireDefined(next.edges.get(id)).validTo = validTo;
      },
    };
  };
}

function restoreStep(
  kind: NodeKind,
  idPick: number,
  stated?: () => string | undefined,
): StepFactory {
  return (model) => {
    const id =
      stated === undefined ?
        requireDefined(pickNodeId(model, kind, idPick))
      : stated();
    if (id === undefined) return;
    const node = model.nodes.get(id);
    const attachment = attachmentOf(model, id);
    const holdsLiveWhole =
      node !== undefined &&
      attachment !== undefined &&
      isLive(model, attachment.edge.wholeId);
    const refusals =
      node?.live !== true && REQUIRED_PART_KINDS.has(kind) && !holdsLiveWhole ?
        [CompositionExistenceError]
      : [];
    return {
      label: `upsertById ${kind}/${id} (${
        node === undefined ? "absent"
        : node.live ? "live"
        : "tombstoned"
      })`,
      refusals,
      perform: async (surface) => {
        await surface.nodes[kind].upsertById(id, {});
      },
      apply: (next) => {
        next.nodes.set(id, { kind, live: true });
        if (!requireDefined(next.issuedIds.get(kind)).includes(id)) {
          requireDefined(next.issuedIds.get(kind)).push(id);
        }
      },
    };
  };
}

/**
 * Retires a leaf through the RAW backend member, which leaves its composition
 * edge live: the dirty shape a cascade must walk through without reporting
 * the dead part, and the one route to an ended `one` window on a part that is
 * live again later.
 */
function rawRetireStep(
  kind: (typeof RAW_RETIRABLE_KINDS)[number],
  idPick: number,
  retired?: (id: string | undefined) => void,
): StepFactory {
  return (model) => {
    const id = pick(
      requireDefined(model.issuedIds.get(kind)).filter((candidate) =>
        isLive(model, candidate),
      ),
      idPick,
    );
    retired?.(id);
    if (id === undefined) return;
    return {
      label: `raw retire ${kind}/${id}`,
      refusals: [],
      perform: async (_surface, real) => {
        await real.backend.deleteNode({ graphId: real.graphId, kind, id });
      },
      apply: (next) => {
        requireDefined(next.nodes.get(id)).live = false;
      },
    };
  };
}

type Interleave = "none" | "attach" | "unrelated";

/** `planDelete`, then a write that may change the plan, then `delete({ expect })`. */
function guardedDeleteSteps(
  kind: NodeKind,
  idPick: number,
  interleave: Interleave,
  salt: string,
): readonly StepFactory[] {
  let preview: NodeDeletePlan | undefined;
  let planned: ModelPlan | undefined;
  let id = `${kind}-ghost`;
  const interleaved: StepFactory = (model) => {
    id = requireDefined(pickNodeId(model, kind, idPick));
    planned = deletePlan(model, id);
    if (interleave === "none" || planned === undefined) {
      return {
        label: `planDelete ${kind}/${id}`,
        refusals: [],
        perform: async (surface) => {
          preview = await surface.nodes[kind].planDelete(id);
        },
        verify: async () => {
          expect({ id, preview: previewOf(preview) }).toEqual({
            id,
            preview: planned,
          });
          await Promise.resolve();
        },
      };
    }
    const attachUnder: Readonly<
      Record<NodeKind, [NodeKind, EdgeKind] | undefined>
    > = {
      CpWhole: ["CpMid", "cpMidOf"],
      CpMid: ["CpTag", "cpTagOf"],
      CpFolder: ["CpFolder", "cpFolderOf"],
      CpLeaf: undefined,
      CpTag: undefined,
    };
    const target = interleave === "attach" ? attachUnder[kind] : undefined;
    const create =
      target === undefined ?
        createNodeStep("CpWhole", salt, undefined)(model)
      : createNodeStep(target[0], salt, {
          wholePick: 0,
          via: target[1],
          whole: { id },
        })(model);
    const write = requireDefined(create);
    return {
      label: `planDelete ${kind}/${id}, then ${write.label}`,
      refusals: [],
      perform: async (surface, real) => {
        preview = await surface.nodes[kind].planDelete(id);
        await write.perform(surface, real);
      },
      apply: (next) => {
        write.apply?.(next);
      },
      verify: async () => {
        expect({ id, preview: previewOf(preview) }).toEqual({
          id,
          preview: planned,
        });
        await Promise.resolve();
      },
    };
  };
  const guarded: StepFactory = (model) => {
    if (planned === undefined) return;
    const before = planned;
    const now = requireDefined(deletePlan(model, id));
    return {
      label: `delete ${kind}/${id} expecting the earlier plan`,
      refusals: plansMatch(before, now) ? [] : [NodeDeletePlanMismatchError],
      perform: async (surface) => {
        await surface.nodes[kind].delete(id, {
          expect: requireDefined(preview),
        });
      },
      apply: (next) => {
        applySoftDelete(next, id);
      },
    };
  };
  return [interleaved, guarded];
}

// ============================================================
// Observing the store
// ============================================================

type RowState = Readonly<{
  nodes: readonly string[];
  edges: readonly string[];
}>;

function instantOf(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Date.parse(value);
}

async function readRows(real: Real): Promise<
  Readonly<{
    nodes: readonly Readonly<{ id: string; kind: string; live: boolean }>[];
    edges: readonly Readonly<{
      id: string;
      kind: EdgeKind;
      fromId: string;
      toId: string;
      validFrom: number | undefined;
      validTo: number | undefined;
      deleted: boolean;
    }>[];
    raw: unknown;
  }>
> {
  const nodeRows = await Promise.all(
    NODE_KINDS.map((kind) =>
      real.backend.findNodesByKind({
        graphId: real.graphId,
        kind,
        excludeDeleted: false,
        temporalMode: "includeTombstones",
      }),
    ),
  );
  const edgeRows = await Promise.all(
    EDGE_KINDS.map((kind) =>
      real.backend.findEdgesByKind({
        graphId: real.graphId,
        kind,
        excludeDeleted: false,
        temporalMode: "includeTombstones",
      }),
    ),
  );
  const claims = await real.backend.execute(
    asCompiledRowsSql(sql`
      SELECT axis, key, edge_id, updated_at
      FROM typegraph_edge_claims
      WHERE graph_id = ${real.graphId}
      ORDER BY axis, key
    `),
  );
  const nodes = nodeRows
    .flat()
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      live: row.deleted_at === undefined,
    }))
    .toSorted((left, right) => compareTuples([left.id], [right.id]));
  const edges = edgeRows
    .flat()
    .map((row) => ({
      id: row.id,
      kind: row.kind as EdgeKind,
      fromId: row.from_id,
      toId: row.to_id,
      validFrom: instantOf(row.valid_from),
      validTo: instantOf(row.valid_to),
      deleted: row.deleted_at !== undefined,
    }))
    .toSorted((left, right) => compareTuples([left.id], [right.id]));
  return {
    nodes,
    edges,
    raw: {
      nodes: nodeRows
        .flat()
        .toSorted((left, right) => compareTuples([left.id], [right.id])),
      edges: edgeRows
        .flat()
        .toSorted((left, right) => compareTuples([left.id], [right.id])),
      claims,
    },
  };
}

function describeModel(model: Model): RowState {
  return {
    nodes: [...model.nodes]
      .map(([id, node]) => `${id}:${node.kind}:${node.live ? "live" : "dead"}`)
      .toSorted(),
    edges: [...model.edges]
      .map(([id, edge]) => describeEdge(id, edge))
      .toSorted(),
  };
}

function describeEdge(
  id: string,
  edge: Readonly<{
    kind: EdgeKind;
    partId: string;
    wholeId: string;
    validFrom: number | undefined;
    validTo: number | undefined;
    deleted: boolean;
  }>,
): string {
  return `${id}:${edge.kind}:${edge.partId}<${edge.wholeId}:from=${edge.validFrom}:to=${edge.validTo ?? "open"}:${edge.deleted ? "deleted" : "live"}`;
}

/** Gives every pending model edge the id the store assigned the row it wrote. */
function reconcileEdgeIds(
  model: Model,
  rows: Awaited<ReturnType<typeof readRows>>,
): void {
  const unclaimed = rows.edges.filter((row) => !model.edges.has(row.id));
  for (const [pendingId, edge] of model.edges) {
    if (!pendingId.startsWith(PENDING_PREFIX)) continue;
    const pair = PAIRS[edge.kind];
    const index = unclaimed.findIndex((row) => {
      const partId = pair.partSide === "from" ? row.fromId : row.toId;
      const wholeId = pair.partSide === "from" ? row.toId : row.fromId;
      return (
        row.kind === edge.kind &&
        partId === edge.partId &&
        wholeId === edge.wholeId &&
        row.deleted === edge.deleted &&
        row.validTo === edge.validTo
      );
    });
    if (index === -1) continue;
    const [row] = unclaimed.splice(index, 1);
    model.edges.delete(pendingId);
    model.edges.set(requireDefined(row).id, edge);
  }
}

function describeRows(rows: Awaited<ReturnType<typeof readRows>>): RowState {
  return {
    nodes: rows.nodes
      .map((node) => `${node.id}:${node.kind}:${node.live ? "live" : "dead"}`)
      .toSorted(),
    edges: rows.edges
      .map((row) => {
        const pair = PAIRS[row.kind];
        return describeEdge(row.id, {
          kind: row.kind,
          partId: pair.partSide === "from" ? row.fromId : row.toId,
          wholeId: pair.partSide === "from" ? row.toId : row.fromId,
          validFrom: row.validFrom,
          validTo: row.validTo,
          deleted: row.deleted,
        });
      })
      .toSorted(),
  };
}

/** Invariants read from the stored rows alone, never from the model. */
function assertRowInvariants(rows: Awaited<ReturnType<typeof readRows>>): void {
  const liveNodes = new Set(
    rows.nodes.filter((node) => node.live).map((node) => node.id),
  );
  const attachments = new Map<string, string[]>();
  for (const row of rows.edges) {
    const pair = PAIRS[row.kind];
    if (row.deleted) continue;
    if (pair.population === "oneActive" && row.validTo !== undefined) continue;
    const partId = pair.partSide === "from" ? row.fromId : row.toId;
    const wholeId = pair.partSide === "from" ? row.toId : row.fromId;
    attachments.set(partId, [...(attachments.get(partId) ?? []), wholeId]);
  }
  const shared = [...attachments].filter(([, wholes]) => wholes.length > 1);
  expect({ partsWithSeveralAttachingEdges: shared }).toEqual({
    partsWithSeveralAttachingEdges: [],
  });
  const orphans = rows.nodes
    .filter(
      (node) => node.live && REQUIRED_PART_KINDS.has(node.kind as NodeKind),
    )
    .filter((node) => {
      const [wholeId] = attachments.get(node.id) ?? [];
      return wholeId === undefined || !liveNodes.has(wholeId);
    })
    .map((node) => node.id);
  expect({ liveRequiredPartsWithoutLiveWhole: orphans }).toEqual({
    liveRequiredPartsWithoutLiveWhole: [],
  });
}

function expectedParts(model: Model, rootId: string): readonly string[] {
  const found: string[] = [];
  let frontier = [rootId];
  while (frontier.length > 0) {
    frontier = frontier.flatMap((wholeId) =>
      countingPartEdges(model, wholeId)
        .map(({ edge }) => edge.partId)
        .filter((partId) => isLive(model, partId)),
    );
    found.push(...frontier);
  }
  return found;
}

function expectedWholes(model: Model, rootId: string): readonly string[] {
  const found: string[] = [];
  let current = attachmentOf(model, rootId)?.edge.wholeId;
  while (current !== undefined && isLive(model, current)) {
    found.push(current);
    current = attachmentOf(model, current)?.edge.wholeId;
  }
  return found;
}

function navigationPairs(
  rows: readonly Readonly<{ root: string; node: string }>[],
): readonly string[] {
  return rows.map((row) => `${row.root}>${row.node}`).toSorted();
}

async function assertNavigationMatches(
  real: Real,
  model: Model,
): Promise<void> {
  const liveOf = (kinds: readonly NodeKind[]) =>
    [...model.nodes]
      .filter(([, node]) => node.live && kinds.includes(node.kind))
      .map(([id]) => id);
  const query = () => real.store.query().temporal("includeEnded");
  const actualParts = [
    ...(await query()
      .from("CpWhole", "root")
      .parts("node")
      .select((ctx) => ({ root: ctx.root.id, node: ctx.node.id }))
      .execute()),
    ...(await query()
      .from("CpMid", "root")
      .parts("node")
      .select((ctx) => ({ root: ctx.root.id, node: ctx.node.id }))
      .execute()),
    ...(await query()
      .from("CpFolder", "root")
      .parts("node")
      .select((ctx) => ({ root: ctx.root.id, node: ctx.node.id }))
      .execute()),
  ];
  const actualWholes = [
    ...(await query()
      .from("CpMid", "root")
      .wholes("node")
      .select((ctx) => ({ root: ctx.root.id, node: ctx.node.id }))
      .execute()),
    ...(await query()
      .from("CpLeaf", "root")
      .wholes("node")
      .select((ctx) => ({ root: ctx.root.id, node: ctx.node.id }))
      .execute()),
    ...(await query()
      .from("CpTag", "root")
      .wholes("node")
      .select((ctx) => ({ root: ctx.root.id, node: ctx.node.id }))
      .execute()),
    ...(await query()
      .from("CpFolder", "root")
      .wholes("node")
      .select((ctx) => ({ root: ctx.root.id, node: ctx.node.id }))
      .execute()),
  ];
  const expectedPartRows = liveOf(["CpWhole", "CpMid", "CpFolder"]).flatMap(
    (root) => expectedParts(model, root).map((node) => ({ root, node })),
  );
  const expectedWholeRows = liveOf([
    "CpMid",
    "CpLeaf",
    "CpTag",
    "CpFolder",
  ]).flatMap((root) =>
    expectedWholes(model, root).map((node) => ({ root, node })),
  );
  expect({
    parts: navigationPairs(actualParts),
    wholes: navigationPairs(actualWholes),
  }).toEqual({
    parts: navigationPairs(expectedPartRows),
    wholes: navigationPairs(expectedWholeRows),
  });
}

/**
 * The audit findings the model expects: none, except the composition rows
 * whose window starts or ends after the clock — rows written before the clock
 * stepped backwards, which the audit names however they were written.
 */
function expectedFenceViolations(model: Model): readonly unknown[] {
  return EDGE_KINDS.toSorted()
    .map((edgeKind) => ({
      family: "compositionFutureWindow",
      edgeKind,
      edgeIds: [...model.edges]
        .filter(
          ([, edge]) =>
            edge.kind === edgeKind &&
            !edge.deleted &&
            (edge.validFrom > model.clock ||
              (edge.validTo ?? model.clock) > model.clock),
        )
        .map(([id]) => id)
        .toSorted(),
    }))
    .filter((violation) => violation.edgeIds.length > 0);
}

function errorSummary(error: unknown): string {
  if (error === undefined) return "success";
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return `${error.name}${typeof code === "string" ? ` ${code}` : ""}: ${error.message}`;
  }
  return `non-Error rejection: ${typeof error}`;
}

/** The error `operation` rejects with, or `undefined` when it resolves. */
async function outcomeOf(operation: Promise<void>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return undefined;
}

function assertVerdict(step: Step, error: unknown): void {
  if (step.refusals.length === 0) {
    expect({ step: step.label, outcome: errorSummary(error) }).toEqual({
      step: step.label,
      outcome: "success",
    });
    return;
  }
  const accepted = step.refusals.map((refusal) => refusal.name);
  expect({
    step: step.label,
    accepted,
    refusedAsPredicted:
      error !== undefined &&
      step.refusals.some((refusal) => error instanceof refusal),
    outcome: errorSummary(error),
  }).toMatchObject({ step: step.label, accepted, refusedAsPredicted: true });
}

async function assertNothingWritten(
  real: Real,
  step: Step,
  before: Awaited<ReturnType<typeof readRows>>,
): Promise<void> {
  const after = await readRows(real);
  expect({ refused: step.label, rows: after.raw }).toEqual({
    refused: step.label,
    rows: before.raw,
  });
}

async function assertStoreMatchesModel(
  real: Real,
  model: Model,
): Promise<void> {
  const rows = await readRows(real);
  reconcileEdgeIds(model, rows);
  expect(describeRows(rows)).toEqual(describeModel(model));
  assertRowInvariants(rows);
  expect(await real.store.verifyConstraintFences()).toEqual(
    expectedFenceViolations(model),
  );
  await assertNavigationMatches(real, model);
}

// ============================================================
// Commands
// ============================================================

class StepsCommand implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly name: string,
    readonly tick: number,
    readonly factories: readonly StepFactory[],
  ) {}

  check(): boolean {
    return true;
  }

  async run(model: Model, real: Real): Promise<void> {
    advanceClock(model, this.tick);
    const surface = surfaceOf(real.store);
    for (const factory of this.factories) {
      const step = factory(model);
      if (step === undefined) continue;
      const before =
        step.refusals.length === 0 ? undefined : await readRows(real);
      const error = await outcomeOf(step.perform(surface, real));
      assertVerdict(step, error);
      if (error === undefined) {
        step.apply?.(model);
        await assertStoreMatchesModel(real, model);
        await step.verify?.(real, model);
      } else {
        await assertNothingWritten(real, step, requireDefined(before));
      }
    }
  }

  toString(): string {
    return `${this.name} [tick ${this.tick}]`;
  }
}

/** Several steps in one `store.transaction`, each refusal caught inside it. */
class TransactionCommand implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly name: string,
    readonly tick: number,
    readonly factories: readonly StepFactory[],
  ) {}

  check(): boolean {
    return true;
  }

  async run(model: Model, real: Real): Promise<void> {
    advanceClock(model, this.tick);
    await real.store.transaction(async (tx) => {
      const surface = surfaceOf(tx);
      for (const factory of this.factories) {
        const step = factory(model);
        if (step === undefined) continue;
        const error = await outcomeOf(step.perform(surface, real));
        assertVerdict(step, error);
        if (error === undefined) step.apply?.(model);
      }
    });
    await assertStoreMatchesModel(real, model);
  }

  toString(): string {
    return `${this.name} [tick ${this.tick}]`;
  }
}

function advanceClock(model: Model, tick: number): void {
  model.clock += tick;
  vi.setSystemTime(model.clock);
}

const tickArb = fc.oneof(
  { weight: 5, arbitrary: fc.constant(60_000) },
  { weight: 1, arbitrary: fc.constant(-30_000) },
);
const saltArb = fc.constantFrom("a", "q", "Z");
const pickArb = fc.nat({ max: 999 });
const viaOfMid = fc.constantFrom<EdgeKind | "omit">(
  "cpMidOf",
  "cpMidOf",
  "cpWholeHasMid",
  "cpWholeHasMid",
  "omit",
);

function viaArbOf(kind: PartKind): fc.Arbitrary<EdgeKind | "omit"> {
  return kind === "CpMid" ? viaOfMid : fc.constant("omit");
}

const partKindArb = fc.constantFrom(...PART_KINDS);
const nodeKindArb = fc.constantFrom(...NODE_KINDS);
const edgeKindArb = fc.constantFrom(...EDGE_KINDS);
const atArb = fc.constantFrom<AtMode>(
  "omit",
  "omit",
  "now",
  "past",
  "beforeIncumbent",
  "future",
);

const endModeArb = fc.constantFrom<EndMode>(
  "now",
  "past",
  "beforeStart",
  "future",
);

const createArb = fc
  .tuple(nodeKindArb, saltArb, fc.option(pickArb, { freq: 4 }))
  .chain(([kind, salt, wholePick]) =>
    (kind === "CpWhole" ? fc.constant("omit" as const) : viaArbOf(kind)).map(
      (via) => ({
        name: `create ${kind}`,
        factories: [
          createNodeStep(
            kind,
            salt,
            wholePick === null ? undefined : { wholePick, via },
          ),
        ],
      }),
    ),
  );

/**
 * A whole with a mid under it, a leaf and a tag under that mid, and a folder
 * inside a folder: depth the single creates rarely reach on their own.
 */
const growArb = fc
  .tuple(
    saltArb,
    viaOfMid.filter((via) => via !== "omit"),
  )
  .map(([salt, via]) => ({
    name: "grow",
    factories: [
      createNodeStep("CpWhole", salt, undefined),
      createNodeStep("CpMid", salt, { wholePick: 0, via, whole: "latest" }),
      createNodeStep("CpLeaf", salt, {
        wholePick: 0,
        via: "omit",
        whole: "latest",
      }),
      createNodeStep("CpTag", salt, {
        wholePick: 0,
        via: "omit",
        whole: "latest",
      }),
      createNodeStep("CpFolder", salt, undefined),
      createNodeStep("CpFolder", salt, {
        wholePick: 0,
        via: "omit",
        whole: "latest",
      }),
    ],
  }));

const createEdgeArb = fc
  .tuple(edgeKindArb, pickArb, pickArb)
  .map(([edgeKind, partPick, wholePick]) => ({
    name: `edge ${edgeKind} create`,
    factories: [createEdgeStep(edgeKind, partPick, wholePick)],
  }));

function moveSpecArb(kind: PartKind): fc.Arbitrary<MoveSpec> {
  return fc.record({
    partPick: pickArb,
    wholePick: pickArb,
    via: viaArbOf(kind),
    at: atArb,
  });
}

const reparentArb = partKindArb.chain((kind) =>
  fc.oneof(
    {
      weight: 3,
      arbitrary: moveSpecArb(kind).map((spec) => ({
        name: `reparent ${kind}`,
        factories: [reparentStep(kind, spec)],
      })),
    },
    {
      weight: 1,
      arbitrary: fc
        .array(moveSpecArb(kind), { minLength: 1, maxLength: 3 })
        .map((specs) => ({
          name: `bulkReparent ${kind}`,
          factories: [bulkReparentStep(kind, specs)],
        })),
    },
  ),
);

const nodeDeleteArb = fc.oneof(
  fc
    .tuple(
      nodeKindArb,
      pickArb,
      fc.constantFrom<NodeDeleteForm>("delete", "hardDelete"),
    )
    .map(([kind, idPick, form]) => ({
      name: `${form} ${kind}`,
      factories: [nodeDeleteStep(kind, idPick, form)],
    })),
  fc
    .tuple(nodeKindArb, fc.array(pickArb, { minLength: 1, maxLength: 3 }))
    .map(([kind, picks]) => ({
      name: `bulkDelete ${kind}`,
      factories: [nodeBulkDeleteStep(kind, picks)],
    })),
);

const edgeWriteArb = fc.oneof(
  {
    weight: 1,
    arbitrary: fc
      .tuple(
        edgeKindArb,
        pickArb,
        fc.constantFrom<EdgeWriteForm>("delete", "hardDelete"),
      )
      .map(([edgeKind, edgePick, form]) => ({
        name: `edge ${edgeKind} ${form}`,
        factories: [edgeDeleteStep(edgeKind, edgePick, form)],
      })),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(edgeKindArb, fc.array(pickArb, { minLength: 1, maxLength: 3 }))
      .map(([edgeKind, picks]) => ({
        name: `edge ${edgeKind} bulkDelete`,
        factories: [edgeBulkDeleteStep(edgeKind, picks)],
      })),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(edgeKindArb, pickArb, endModeArb)
      .map(([edgeKind, edgePick, mode]) => ({
        name: `edge ${edgeKind} end`,
        factories: [edgeEndStep(edgeKind, edgePick, mode)],
      })),
  },
);

const restoreArb = fc.tuple(nodeKindArb, pickArb).map(([kind, idPick]) => ({
  name: `upsertById ${kind}`,
  factories: [restoreStep(kind, idPick)],
}));

const rawRetireArb = fc
  .tuple(fc.constantFrom(...RAW_RETIRABLE_KINDS), pickArb)
  .map(([kind, idPick]) => ({
    name: `raw retire ${kind}`,
    factories: [rawRetireStep(kind, idPick)],
  }));

/**
 * Retire a leaf raw, end its window while it is dead, restore it, and end the
 * window again: the one route to a live part whose `one` window has already
 * ended, where re-ending it is no detachment.
 */
const endedWindowDetourArb = fc
  .tuple(fc.constantFrom(...RAW_RETIRABLE_KINDS), pickArb, endModeArb)
  .map(([kind, idPick, reEnd]) => {
    let retiredId: string | undefined;
    const edgeKind = kind === "CpLeaf" ? "cpLeafOf" : "cpTagOf";
    return {
      name: `ended-window detour ${kind}`,
      factories: [
        rawRetireStep(kind, idPick, (id) => {
          retiredId = id;
        }),
        edgeEndStep(edgeKind, 0, "now", () => retiredId),
        restoreStep(kind, 0, () => retiredId),
        edgeEndStep(edgeKind, 0, reEnd, () => retiredId),
      ],
    };
  });

const guardedDeleteArb = fc
  .tuple(
    nodeKindArb,
    pickArb,
    fc.constantFrom<Interleave>("none", "attach", "unrelated"),
    saltArb,
  )
  .map(([kind, idPick, interleave, salt]) => ({
    name: `guarded delete ${kind} (${interleave})`,
    factories: guardedDeleteSteps(kind, idPick, interleave, salt),
  }));

/** A write the model always refuses, so a batch is guaranteed one caught refusal. */
const refusalArb = fc.oneof(
  saltArb.map((salt) => createNodeStep("CpLeaf", salt, undefined)),
  fc.tuple(pickArb, pickArb).map(([partPick, wholePick]) =>
    reparentStep("CpLeaf", {
      partPick,
      wholePick,
      via: "omit",
      at: "future",
    }),
  ),
);

/** Writes a `store.transaction` callback may issue (the raw backend member is not one). */
const transactionalArb = fc.oneof(
  { weight: 4, arbitrary: createArb },
  { weight: 2, arbitrary: growArb },
  { weight: 1, arbitrary: createEdgeArb },
  { weight: 2, arbitrary: reparentArb },
  { weight: 3, arbitrary: nodeDeleteArb },
  { weight: 3, arbitrary: edgeWriteArb },
  { weight: 1, arbitrary: restoreArb },
);

const simpleArb = fc.oneof(
  { weight: 12, arbitrary: transactionalArb },
  { weight: 1, arbitrary: rawRetireArb },
  { weight: 1, arbitrary: endedWindowDetourArb },
);

const commandArbs = [
  ...Array.from({ length: 4 }, () =>
    fc
      .tuple(simpleArb, tickArb)
      .map(
        ([command, tick]) =>
          new StepsCommand(command.name, tick, command.factories),
      ),
  ),
  fc
    .tuple(guardedDeleteArb, tickArb)
    .map(
      ([command, tick]) =>
        new StepsCommand(command.name, tick, command.factories),
    ),
  fc
    .tuple(transactionalArb, refusalArb, transactionalArb, tickArb)
    .map(
      ([first, refusal, last, tick]) =>
        new TransactionCommand(
          `transaction [${first.name}, refused write, ${last.name}]`,
          tick,
          [...first.factories, refusal, ...last.factories],
        ),
    ),
];

const MAX_COMMANDS = 30;

// ============================================================
// Lanes
// ============================================================

type Lane = Readonly<{
  name: string;
  runs: number;
  open: () => Promise<
    Readonly<{ backend: GraphBackend; close: () => Promise<void> }>
  >;
}>;

const LANES: readonly Lane[] = [
  {
    name: "SQLite",
    runs: propertyRuns({ ci: 60, local: 200 }),
    open: () =>
      Promise.resolve({
        backend: createTestBackend(),
        close: () => Promise.resolve(),
      }),
  },
  {
    name: "PGlite",
    runs: propertyRuns({ ci: 20, local: 60 }),
    open: async () => {
      const local = await createLocalPgliteBackend({ vector: false });
      return { backend: local.backend, close: () => local.backend.close() };
    },
  },
  {
    name: "PGlite root (fused-capable)",
    runs: propertyRuns({ ci: 20, local: 60 }),
    open: async () => {
      const local = await createLocalPgliteBackend({ vector: false });
      return {
        backend: createPostgresBackend(local.db, { vector: false }),
        close: () => local.backend.close(),
      };
    },
  },
];

let graphSerial = 0;

describe.each(LANES)("composition model ($name)", (lane) => {
  let opened: Awaited<ReturnType<Lane["open"]>>;

  beforeAll(async () => {
    opened = await lane.open();
  });

  afterAll(async () => {
    await opened.close();
  });

  it("every command's verdict, rows, closure and navigation match the ownership model", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.commands(commandArbs, { maxCommands: MAX_COMMANDS, size: "max" }),
          async (commands) => {
            graphSerial += 1;
            vi.setSystemTime(START_INSTANT);
            const graph = buildGraph(`composition_model_${graphSerial}`);
            const cascades = new Map<
              string,
              readonly CompositionCascadedPart[] | undefined
            >();
            const [store] = await createStoreWithSchema(graph, opened.backend, {
              hooks: {
                onOperationEnd: (ctx: OperationHookContext) => {
                  if (ctx.entity === "node" && ctx.operation === "delete") {
                    cascades.set(ctx.id, ctx.cascadedParts);
                  }
                },
              },
            });
            const real: Real = {
              store,
              backend: opened.backend,
              graphId: graph.id,
              cascades,
            };
            await fc.asyncModelRun(
              () => ({ model: initialModel(), real }),
              commands,
            );
          },
        ),
        { numRuns: lane.runs },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 600_000);
});
