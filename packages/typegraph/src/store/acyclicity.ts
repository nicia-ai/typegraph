/**
 * Acyclicity of an edge relation: `acyclic: true` on an edge registration,
 * and the composition relation.
 *
 * THE acyclicity predicate: "does `from` lie in the reflexive-transitive
 * closure of `to`, over one acyclic relation's live edges". Every write path
 * that can put an edge into a declared-acyclic relation calls
 * {@link assertEdgeRelationsAcyclic} (rows already visible to the frame, or
 * one row) or {@link assertUnwrittenEdgeRelationsAcyclic} (a batch probed
 * before its insert) and no other function; the audit and the
 * schema-tightening preflight call {@link readEdgeAcyclicityViolations},
 * which shares the same SQL builder (`buildEdgeAcyclicityProbe`,
 * `src/store/recursive-cte.ts`) so a live-graph audit and a write-path probe
 * can never disagree about what counts as a cycle.
 *
 * The check is exhaustive: a set-semantics (`UNION`, never `UNION ALL`)
 * recursive reachability with no depth bound. `MAX_EXPLICIT_RECURSIVE_DEPTH`
 * does not apply here — see `buildEdgeAcyclicityProbe`'s docblock. An engine
 * that cuts the search short (statement timeout, resource exhaustion) is
 * reported as indeterminate, never as "no cycle".
 *
 * Population: every non-deleted edge of a standalone `acyclic: true`
 * relation counts, regardless of its validity window. A cycle is a property
 * of the edge relation, not of an instant, so honoring `validTo` would let a
 * future-dated edge close a cycle no write ever probed. The composition
 * relation takes its population from composition instead — see
 * {@link compositionAcyclicRelation}.
 */
import { resolveRecursiveTraversal } from "../backend/capabilities/recursive-traversal";
import { assertFencedSnapshotIsFresh } from "../backend/command-contract";
import { type GraphBackend } from "../backend/types";
import { type GraphDef } from "../core/define-graph";
import { ConfigurationError, EdgeAcyclicityError } from "../errors";
import { EdgeAcyclicityIndeterminateError } from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { type DialectAdapter } from "../query/dialect/types";
import { countSqlParameters, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { type KindRegistry } from "../registry/kind-registry";
import { chunk } from "../utils/array";
import { compareStrings } from "../utils/compare";
import { requireDefined } from "../utils/presence";
import { isStatementCutShortError } from "../utils/sql-errors";
import {
  COMPOSITION_RELATION_NAME,
  displayAcyclicRelationName,
} from "./claims/axis";
import { compositionCountsEndedRows } from "./claims/composition-claims";
import { type GraphWriteLock } from "./recorded-capture/clock";
import {
  ACYCLICITY_SEED_ROW_PARAM_COUNT,
  ACYCLICITY_TARGET_ROW_PARAM_COUNT,
  type AcyclicityProbeSeed,
  buildEdgeAcyclicityProbe,
} from "./recursive-cte";

/**
 * One member of an acyclic relation: an edge kind, and the orientation its
 * rows must be read in to walk the relation part->whole. A standalone
 * `acyclic: true` registration is always `reversed: false` — that relation IS
 * the edge kind, read in its stored direction. The composition relation mixes
 * `reversed: false` (part -> whole realizing edges) and `reversed: true`
 * (whole -> part realizing edges) and is checked as ONE directed relation; a
 * plain edge-kind list cannot express that.
 */
export type AcyclicRelationMember = Readonly<{
  edgeKind: string;
  reversed: boolean;
  /**
   * Set when only rows whose validity window is still open are in the
   * relation. Absent for every standalone `acyclic: true` kind, whose
   * non-deleted rows all count; set for a composition kind whose ended rows
   * are history rather than memberships.
   */
  openEndedOnly?: true;
}>;

/** One acyclic relation: a name, and the oriented edge kinds that form it. */
export type AcyclicEdgeRelation = Readonly<{
  /** The edge kind for a standalone relation; the composition relation's
   * reserved name for the composition union. */
  name: string;
  members: readonly AcyclicRelationMember[];
}>;

/**
 * A standalone `acyclic: true` registration's own relation: the edge
 * kind IS the relation, named after itself, with one `reversed: false`
 * member. The one constructor for this shape, so a caller that reasons over
 * a proposed edge kind rather than a runtime {@link GraphDef} — the
 * schema-tightening preflight, grouping a tightening's newly-declared edge
 * kinds — builds the identical shape {@link acyclicEdgeRelations} does,
 * rather than hand-spelling the member literal a second time.
 */
export function standaloneAcyclicRelation(
  edgeKind: string,
): AcyclicEdgeRelation {
  return { name: edgeKind, members: [{ edgeKind, reversed: false }] };
}

/**
 * The composition relation as ONE acyclic relation, oriented part -> whole. `undefined` when the graph declares no composition pair —
 * the caller drops it from the relation list rather than probing an empty
 * one.
 *
 * `reversed` is defined relative to this relation's canonical walk direction,
 * part -> whole: a `partSide: "to"` realizing edge (a `has_*`-shaped kind,
 * whole `from` / part `to`) is stored whole -> part, so it must be walked in
 * reverse to read part -> whole like every other member; a `partSide: "from"`
 * kind already IS part -> whole in its stored direction. This is what lets
 * `A partOf B via chapterOf` and `B partOf A via includedIn` — two edge
 * kinds, opposite orientations — form ONE directed relation the recursive
 * probe walks uniformly, so a cycle spanning both is caught even though
 * neither edge kind is acyclic alone.
 *
 * Membership follows the composition relation's own population rule
 * ({@link compositionCountsEndedRows}), not the standalone one: an ended row
 * of a `oneActive` realizing edge is the history a reparent leaves and is not
 * in the relation, exactly as the composition claim, the cascade's closure
 * and the attachment reader treat it. Counting it would make every move a
 * permanent ancestor edge, so a former ancestor could never be placed under a
 * former descendant.
 *
 * Named after {@link COMPOSITION_RELATION_NAME} (the same reserved axis the
 * composition CLAIM is written at, `src/store/claims/axis.ts`) — the
 * acyclicity relation and the claim relation are two independent invariants
 * that happen to share one reserved string because both are graph-wide, not
 * per-edge-kind. The reserved separator is what keeps this
 * name from ever colliding with a standalone `acyclic: true` relation (which
 * is named after its own edge kind, and no edge kind may spell the
 * separator — `assertClaimAxisSafe`); every place this name reaches a public
 * error or audit field reads it through {@link displayAcyclicRelationName}
 * first, so the separator itself is never something a caller sees.
 */
export function compositionAcyclicRelation(
  registry: KindRegistry,
): AcyclicEdgeRelation | undefined {
  const edgeKinds = registry.compositionEdgeKinds();
  if (edgeKinds.length === 0) return undefined;
  return {
    name: COMPOSITION_RELATION_NAME,
    members: edgeKinds.map((edgeKind) => {
      const partSide = requireDefined(registry.compositionPartSide(edgeKind));
      const population = requireDefined(
        registry.compositionEdgePopulation(edgeKind),
      );
      return {
        edgeKind,
        reversed: partSide === "to",
        ...(compositionCountsEndedRows(partSide, population) ?
          {}
        : { openEndedOnly: true as const }),
      };
    }),
  };
}

const acyclicEdgeRelationsCache = new WeakMap<
  GraphDef,
  WeakMap<KindRegistry, readonly AcyclicEdgeRelation[]>
>();

/**
 * Every acyclic relation this graph declares, in code-point order by name:
 * one standalone relation per `acyclic: true` edge kind, plus the
 * composition relation ({@link compositionAcyclicRelation}) when the
 * registry declares any `partOf`/`hasPart` pair.
 *
 * Memoized per `(GraphDef, KindRegistry)` object identity:
 * {@link assertEdgeRelationsAcyclic} calls {@link acyclicRelationForEdgeKind}
 * (which reads this) once per proposed edge, and neither a `GraphDef` nor a
 * built `KindRegistry` changes after construction, so rebuilding and
 * re-sorting this list per row of a large batch would be pure waste. Nested
 * rather than a single map keyed on a composite: the schema-tightening
 * preflight calls this with a PROPOSED registry built fresh per
 * probe, so caching must never let a stale registry's relation answer for a
 * different one built from the same `GraphDef`.
 */
export function acyclicEdgeRelations(
  graph: GraphDef,
  registry: KindRegistry,
): readonly AcyclicEdgeRelation[] {
  const byRegistry = acyclicEdgeRelationsCache.get(graph);
  const cached = byRegistry?.get(registry);
  if (cached !== undefined) return cached;
  const standalone = Object.entries(graph.edges)
    .filter(([, registration]) => registration.acyclic === true)
    .map(([edgeKind]) => standaloneAcyclicRelation(edgeKind));
  const composition = compositionAcyclicRelation(registry);
  const relations = [
    ...standalone,
    ...(composition === undefined ? [] : [composition]),
  ].toSorted((left, right) => compareStrings(left.name, right.name));
  const registryCache = byRegistry ?? new WeakMap();
  registryCache.set(registry, relations);
  acyclicEdgeRelationsCache.set(graph, registryCache);
  return relations;
}

/**
 * The relation an edge of this kind belongs to, or `undefined`.
 *
 * Ordinarily an edge kind matches at most one relation. It can match TWO when
 * a composition-realizing edge kind is also independently declared
 * `acyclic: true` on its own registration — a standalone singleton
 * (`standaloneAcyclicRelation`) named after the kind itself, alongside the
 * composition union it already participates in. When that happens the
 * COMPOSITION relation wins, EXPLICITLY (matched by
 * {@link COMPOSITION_RELATION_NAME}), rather than as an artifact of
 * {@link acyclicEdgeRelations}' name sort — `COMPOSITION_RELATION_NAME`'s
 * reserved U+001E prefix happens to sort before every printable kind name,
 * but that is an accident of code-point order, not a decision this function
 * should depend on. Preferring composition is safe for cycle detection: its
 * membership is a strict superset of the standalone singleton's one member,
 * so any cycle the singleton alone could have caught is still caught — the
 * refusal simply names the (correct, wider) `"composition"` relation instead
 * of the kind's own name.
 */
export function acyclicRelationForEdgeKind(
  graph: GraphDef,
  registry: KindRegistry,
  edgeKind: string,
): AcyclicEdgeRelation | undefined {
  const matches = acyclicEdgeRelations(graph, registry).filter((relation) =>
    relation.members.some((member) => member.edgeKind === edgeKind),
  );
  if (matches.length <= 1) return matches[0];
  return (
    matches.find((relation) => relation.name === COMPOSITION_RELATION_NAME) ??
    matches[0]
  );
}

/**
 * Every edge kind that participates in ANY acyclic relation, in code-point
 * order. A projection of {@link acyclicEdgeRelations} for callers that need
 * the flat kind list (a trusted-import capability refusal, an import-time
 * batching decision over more than one candidate edge) rather than the
 * relation structure itself — reading it through this function rather than
 * re-filtering `graph.edges` keeps them from drifting once a relation can
 * have more than one member.
 */
export function acyclicEdgeKinds(
  graph: GraphDef,
  registry: KindRegistry,
): readonly string[] {
  return acyclicEdgeRelations(graph, registry).flatMap((relation) =>
    relation.members.map((member) => member.edgeKind),
  );
}

/**
 * Whether this edge kind participates in ANY acyclic relation. THE predicate
 * every write-eligibility, fused-command, or import-batching decision must
 * consult instead of re-reading `registration.acyclic === true` directly
 * (AGENTS.md "one predicate, one owner": a second inline spelling of an
 * existing decision drifts even while the copies still agree). This is wider
 * than `registration.acyclic === true`: the composition relation is an
 * oriented union, so a composition-realizing edge kind answers `true` here
 * even though its OWN registration carries no `acyclic` field.
 */
export function edgeKindIsInAcyclicRelation(
  graph: GraphDef,
  registry: KindRegistry,
  edgeKind: string,
): boolean {
  return acyclicRelationForEdgeKind(graph, registry, edgeKind) !== undefined;
}

/** An edge a writer proposes to have in the relation when the frame commits. */
export type ProposedRelationEdge = Readonly<{
  edgeId: string;
  edgeKind: string;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
}>;

/**
 * A proposed edge whose endpoints are the same node: a cycle of length one,
 * answerable without a round trip because the reflexive seed would return it.
 */
function proposedEdgeIsSelfLoop(edge: ProposedRelationEdge): boolean {
  return edge.fromKind === edge.toKind && edge.fromId === edge.toId;
}

/** One acyclic relation's share of a proposed edge set. */
type ProposedAcyclicGroup = Readonly<{
  relation: AcyclicEdgeRelation;
  /** The edges that still need the recursive probe. */
  edges: readonly ProposedRelationEdge[];
  /** Edges already decided by {@link proposedEdgeIsSelfLoop}. */
  selfLoopEdgeIds: readonly string[];
}>;

/**
 * The classification that decides WHAT gets probed, owned once: proposed
 * edges whose kind is in no acyclic relation are dropped, the rest are
 * bucketed by relation in code-point order by name, and the self-loops are
 * separated out. `firstSelfLoop` is the earliest self-loop in `proposed`
 * order, so the write path can refuse exactly the row its caller listed first
 * while the plan-time preview collects every relation's self-loops.
 */
function groupProposedByAcyclicRelation(
  graph: GraphDef,
  registry: KindRegistry,
  proposed: readonly ProposedRelationEdge[],
): Readonly<{
  groups: readonly ProposedAcyclicGroup[];
  firstSelfLoop:
    | Readonly<{ relation: AcyclicEdgeRelation; edge: ProposedRelationEdge }>
    | undefined;
}> {
  const byRelationName = new Map<
    string,
    {
      relation: AcyclicEdgeRelation;
      edges: ProposedRelationEdge[];
      selfLoopEdgeIds: string[];
    }
  >();
  for (const edge of proposed) {
    const relation = acyclicRelationForEdgeKind(graph, registry, edge.edgeKind);
    if (relation === undefined) continue;
    const entry = byRelationName.get(relation.name) ?? {
      relation,
      edges: [],
      selfLoopEdgeIds: [],
    };
    byRelationName.set(relation.name, entry);
    if (proposedEdgeIsSelfLoop(edge)) entry.selfLoopEdgeIds.push(edge.edgeId);
    else entry.edges.push(edge);
  }
  const groups = [...byRelationName.keys()]
    .toSorted((left, right) => compareStrings(left, right))
    .map((name) => requireDefined(byRelationName.get(name)));
  const selfLoopIds = new Set(
    groups.flatMap((group) => [...group.selfLoopEdgeIds]),
  );
  const firstSelfLoopEdge = proposed.find((edge) =>
    selfLoopIds.has(edge.edgeId),
  );
  return {
    groups,
    firstSelfLoop:
      firstSelfLoopEdge === undefined ? undefined : (
        {
          relation: requireDefined(
            acyclicRelationForEdgeKind(
              graph,
              registry,
              firstSelfLoopEdge.edgeKind,
            ),
          ),
          edge: firstSelfLoopEdge,
        }
      ),
  };
}

/**
 * The `edgeAcyclicity` member of `ConstraintFenceViolation`
 * (`src/store/claims/verify.ts`), defined here so the shape has one owner:
 * the family carries no `ClaimTarget` — acyclicity reserves no claim row,
 * so there is nothing shaped like one to name.
 */
export type EdgeAcyclicityViolation = Readonly<{
  family: "edgeAcyclicity";
  /** The declared relation's display name. */
  relation: string;
  /** Live edges of the relation whose `to` reaches their `from`. */
  edgeIds: readonly string[];
}>;

export type AcyclicityProbeContext = Readonly<{
  graphId: string;
  graph: GraphDef;
  /**
   * Needed alongside `graph`: whether an edge kind is IN an acyclic relation,
   * and which one, depends on the composition relation too — a fact `graph`
   * alone cannot answer.
   */
  registry: KindRegistry;
  schema: SqlSchema;
  dialect: DialectAdapter;
  /** The transaction target the frame's row work runs on. */
  target: Pick<
    GraphBackend,
    "capabilities" | "commands" | "dialect" | "execute"
  >;
  /** Compile-time evidence the per-graph fence was taken before any read. */
  lock: GraphWriteLock;
  /** Echoed in every refusal's `details.operation`. */
  operation: string;
}>;

/**
 * What the audit reader needs — `AcyclicityProbeContext` minus `lock` (no
 * write to fence) and `graph` (the relations to probe are passed
 * explicitly, so a caller working from a SERIALIZED schema document rather
 * than a runtime `GraphDef` — the schema-tightening preflight — need not
 * fabricate one just to satisfy this type).
 */
export type AcyclicityAuditContext = Omit<
  AcyclicityProbeContext,
  "lock" | "graph"
>;

function acyclicityProbeStatement(
  ctx: AcyclicityAuditContext,
  relation: AcyclicEdgeRelation,
  seed: AcyclicityProbeSeed,
  excludedEdgeIds: readonly string[],
): SqlFragment {
  return buildEdgeAcyclicityProbe({
    graphId: ctx.graphId,
    members: relation.members,
    seed,
    dialect: ctx.dialect,
    schema: ctx.schema,
    recursiveTraversal: resolveRecursiveTraversal(ctx.target.capabilities),
    operation: ctx.operation,
    excludedEdgeIds,
  });
}

/**
 * How many caller-supplied rows one probe statement may carry: what the
 * engine's bind budget leaves once the statement's own parameters (graph id,
 * kind filters, the packed exclusion list) are paid for. Measured off a
 * rendered one-row statement rather than counted by hand, so it cannot fall
 * behind the builder.
 *
 * `undefined` when the backend declares no `maxBindParameters`: there is no
 * limit to slice against.
 *
 * @throws ConfigurationError when the budget cannot fit a single row.
 */
function acyclicityProbeRowBudget(
  ctx: AcyclicityAuditContext,
  relation: AcyclicEdgeRelation,
  sample: ProposedRelationEdge,
  excludedEdgeIds: readonly string[],
): number | undefined {
  const maxBindParameters = ctx.target.capabilities.maxBindParameters;
  if (maxBindParameters === undefined) return undefined;
  const oneRowStatement = acyclicityProbeStatement(
    ctx,
    relation,
    { kind: "proposed", edges: [sample] },
    excludedEdgeIds,
  );
  const available =
    maxBindParameters -
    (countSqlParameters(oneRowStatement) - ACYCLICITY_SEED_ROW_PARAM_COUNT);
  if (
    available <
    ACYCLICITY_SEED_ROW_PARAM_COUNT + ACYCLICITY_TARGET_ROW_PARAM_COUNT
  ) {
    throw new ConfigurationError(
      `The acyclicity check for the "${displayAcyclicRelationName(relation.name)}" relation does not fit this backend's limit of ${maxBindParameters} bound parameters.`,
      {
        capability: "maxBindParameters",
        maxBindParameters,
        relation: displayAcyclicRelationName(relation.name),
        operation: ctx.operation,
      },
    );
  }
  return available;
}

/**
 * The `"proposed"` form over any number of rows. Each origin is answered on
 * its own (its `to` either reaches its own `from` or does not), so the rows
 * are simply sent in slices that fit the bind budget.
 */
async function readProposedViolatingOriginKeys(
  ctx: AcyclicityAuditContext,
  relation: AcyclicEdgeRelation,
  edges: readonly ProposedRelationEdge[],
): Promise<readonly string[]> {
  // One row is one statement whatever the budget: the common single-edge
  // write pays for no sizing.
  const budget =
    edges.length === 1 ?
      undefined
    : acyclicityProbeRowBudget(ctx, relation, requireDefined(edges[0]), []);
  const slices =
    budget === undefined ?
      [edges]
    : chunk(edges, Math.floor(budget / ACYCLICITY_SEED_ROW_PARAM_COUNT));
  const originKeys: string[] = [];
  for (const slice of slices) {
    originKeys.push(
      ...(await readViolatingOriginKeys(ctx, relation, {
        kind: "proposed",
        edges: slice,
      })),
    );
  }
  return originKeys;
}

/**
 * Every reach among a set of UNWRITTEN edges: one row per pair where the
 * first edge's `to` reaches the second's `from` over the relation's stored
 * edges (less `excludedEdgeIds`).
 *
 * Origins and targets are sliced independently and every origin slice is
 * probed against every target slice, so the answer is the complete pair set
 * however the rows were divided. The split gives origins and targets the
 * shares of the budget that minimize the number of statements; a set that
 * fits one statement costs one.
 */
async function readUnwrittenEdgeReaches(
  ctx: AcyclicityAuditContext,
  relation: AcyclicEdgeRelation,
  edges: readonly ProposedRelationEdge[],
  excludedEdgeIds: readonly string[],
): Promise<readonly ProposedEdgeReach[]> {
  const budget = acyclicityProbeRowBudget(
    ctx,
    relation,
    requireDefined(edges[0]),
    excludedEdgeIds,
  );
  const fitsOneStatement =
    budget === undefined ||
    edges.length *
      (ACYCLICITY_SEED_ROW_PARAM_COUNT + ACYCLICITY_TARGET_ROW_PARAM_COUNT) <=
      budget;
  const [originSlices, targetSlices] =
    fitsOneStatement ?
      [[edges], [edges]]
    : [
        chunk(
          edges,
          Math.max(
            1,
            Math.floor(budget / (2 * ACYCLICITY_SEED_ROW_PARAM_COUNT)),
          ),
        ),
        chunk(
          edges,
          Math.max(
            1,
            Math.floor(budget / (2 * ACYCLICITY_TARGET_ROW_PARAM_COUNT)),
          ),
        ),
      ];
  const reaches: ProposedEdgeReach[] = [];
  for (const origins of originSlices) {
    for (const targets of targetSlices) {
      reaches.push(
        ...(await runAcyclicityProbe<ProposedEdgeReach>(
          ctx,
          relation,
          { kind: "unwritten", edges: origins, targets },
          excludedEdgeIds,
        )),
      );
    }
  }
  return reaches;
}

/**
 * Runs one acyclicity probe statement and returns its rows — one per origin
 * the database reports as reaching its own `from` (empty when the seed's rows
 * are all fine), or the `"unwritten"` form's reach pairs. Shared by the
 * write-path assertions and the audit reader, so a cut-short statement is
 * classified identically by all of them.
 *
 * @throws EdgeAcyclicityIndeterminateError when the engine cut the statement
 *   short.
 */
async function runAcyclicityProbe<Row extends Readonly<{ origin_key: string }>>(
  ctx: AcyclicityAuditContext,
  relation: AcyclicEdgeRelation,
  seed: AcyclicityProbeSeed,
  excludedEdgeIds: readonly string[] = [],
): Promise<readonly Row[]> {
  const fragment = acyclicityProbeStatement(
    ctx,
    relation,
    seed,
    excludedEdgeIds,
  );
  try {
    return await ctx.target.execute<Row>(asCompiledRowsSql(fragment));
  } catch (error) {
    if (!isStatementCutShortError(error)) throw error;
    throw new EdgeAcyclicityIndeterminateError(
      {
        relation: displayAcyclicRelationName(relation.name),
        operation: ctx.operation,
        graphId: ctx.graphId,
      },
      { cause: error },
    );
  }
}

/** The origins one probe reports, for the forms that return nothing else. */
async function readViolatingOriginKeys(
  ctx: AcyclicityAuditContext,
  relation: AcyclicEdgeRelation,
  seed: AcyclicityProbeSeed,
): Promise<readonly string[]> {
  const rows = await runAcyclicityProbe(ctx, relation, seed);
  return rows.map((row) => row.origin_key);
}

/**
 * The acyclicity probe is a lock-only read, so it runs only on a session that
 * observes commits made while it waited for the fence.
 *
 * @throws ConfigurationError (`EDGE_ACYCLICITY_REQUIRES_FRESH_SNAPSHOT`)
 */
function assertFreshSnapshot(ctx: AcyclicityProbeContext): void {
  assertFencedSnapshotIsFresh(
    ctx.target.commands,
    ctx.graphId,
    ctx.lock.coordination,
    {
      code: "EDGE_ACYCLICITY_REQUIRES_FRESH_SNAPSHOT",
      subject: "Edge-acyclicity",
    },
  );
}

/**
 * THE acyclicity predicate for edges a frame has ALREADY made visible to its
 * own transaction, or for a single proposed edge. Refuses with
 * {@link EdgeAcyclicityError} when any proposed edge closes a cycle in its
 * relation; with {@link EdgeAcyclicityIndeterminateError} when the engine cut
 * the search short; with `ConfigurationError`
 * (`RECURSIVE_TRAVERSAL_UNSUPPORTED`) when the backend declares no recursive
 * traversal; with `ConfigurationError`
 * (`EDGE_ACYCLICITY_REQUIRES_FRESH_SNAPSHOT`) when the fenced session cannot
 * observe writes committed while it waited for the fence.
 *
 * The question is "does `from` lie in the reflexive-transitive closure of
 * `to`", and a single proposed edge, present or absent, is never on such a
 * path unless a cycle already exists — so one row may be probed before its
 * insert. MORE than one row is different: two rows of one set can close a
 * cycle through each other, which this form sees only when both are already
 * live. A caller holding several rows it has NOT written yet — every batch
 * that must refuse before its first write — calls
 * {@link assertUnwrittenEdgeRelationsAcyclic} instead.
 *
 * Short-circuits three ways before touching SQL: a proposed row whose kind is
 * in no acyclic relation is dropped; a self-loop
 * (`fromKind === toKind && fromId === toId`) is refused immediately, because
 * the reflexive seed would answer the same question with a round trip; and an
 * empty remaining set returns with no statement.
 */
export async function assertEdgeRelationsAcyclic(
  ctx: AcyclicityProbeContext,
  proposed: readonly ProposedRelationEdge[],
): Promise<void> {
  const probeable = selfLoopFreeAcyclicGroups(ctx, proposed);
  if (probeable.length === 0) return;

  assertFreshSnapshot(ctx);

  for (const { relation, edges } of probeable) {
    const violatingOriginKeys = await readProposedViolatingOriginKeys(
      ctx,
      relation,
      edges,
    );
    if (violatingOriginKeys.length === 0) continue;
    throw cycleRefusal(
      relation,
      edges.find((edge) => violatingOriginKeys.includes(edge.edgeId)) ??
        requireDefined(edges[0]),
    );
  }
}

/**
 * The same predicate over a proposed-edge OVERLAY: the relation's live edges
 * plus `proposed` itself, none of which needs to exist yet. This is what a
 * batch calls BEFORE its insert, so a refusal precedes the first write and a
 * caller that catches it inside an enclosing transaction commits no cycle.
 *
 * A cycle in the overlay alternates proposed edges with (possibly empty) live
 * paths between them, so it is decided in two steps: one walk over the live
 * relation answers "which proposed edges' `from` does each proposed edge's
 * `to` reach" (the `"unwritten"` seed form — an index seek per hop, like the
 * single-row probe), and {@link proposedEdgeOnOverlayCycle} then looks for a
 * cycle among those reaches. A cycle closed entirely by rows of the one batch
 * (`a→b` and `b→a` together) is seen because a row's `to` trivially reaches
 * the next row's `from`.
 *
 * Order-insensitive: a proposed row that is already live only adds reaches,
 * never removes one, so the probe means the same thing before and after the
 * insert.
 *
 * `excludedEdgeIds` names stored edges the same frame retires before it
 * writes `proposed` (a batch of moves), with the meaning
 * {@link readProposedEdgeAcyclicityViolations} gives it: the overlay is the
 * state the frame produces.
 */
export async function assertUnwrittenEdgeRelationsAcyclic(
  ctx: AcyclicityProbeContext,
  proposed: readonly ProposedRelationEdge[],
  excludedEdgeIds: readonly string[] = [],
): Promise<void> {
  const probeable = selfLoopFreeAcyclicGroups(ctx, proposed);
  if (probeable.length === 0) return;

  assertFreshSnapshot(ctx);

  for (const { relation, edges } of probeable) {
    const reaches = await readUnwrittenEdgeReaches(
      ctx,
      relation,
      edges,
      excludedEdgeIds,
    );
    const [violatingEdge] = proposedEdgesOnOverlayCycle(edges, reaches, 1);
    if (violatingEdge === undefined) continue;
    throw cycleRefusal(relation, violatingEdge);
  }
}

/** One `"unwritten"` probe row: `origin_key`'s `to` reaches `reached_key`'s `from` over live edges. */
type ProposedEdgeReach = Readonly<{ origin_key: string; reached_key: string }>;

/**
 * The proposed edges, in the caller's order, that lie on a cycle of the
 * "reaches" digraph (an arc `i → j` per {@link ProposedEdgeReach}) — at most
 * `limit` of them, and none when that digraph is acyclic.
 *
 * Trims every edge no arc enters, repeatedly: whatever survives has an
 * entering arc from another survivor, so survivors exist exactly when a cycle
 * does. The common no-cycle batch therefore costs one linear pass; the
 * per-edge search below runs only to name the edges a refusal reports, and
 * stops at `limit` (the write path names one, the plan preview all).
 */
function proposedEdgesOnOverlayCycle(
  edges: readonly ProposedRelationEdge[],
  reaches: readonly ProposedEdgeReach[],
  limit = Number.POSITIVE_INFINITY,
): readonly ProposedRelationEdge[] {
  const successors = new Map<string, string[]>();
  const enteringArcs = new Map(edges.map((edge) => [edge.edgeId, 0]));
  for (const { origin_key: origin, reached_key: reached } of reaches) {
    const known = successors.get(origin);
    if (known === undefined) successors.set(origin, [reached]);
    else known.push(reached);
    enteringArcs.set(reached, (enteringArcs.get(reached) ?? 0) + 1);
  }
  const trimmable = [...enteringArcs]
    .filter(([, count]) => count === 0)
    .map(([edgeId]) => edgeId);
  while (trimmable.length > 0) {
    const edgeId = requireDefined(trimmable.pop());
    enteringArcs.delete(edgeId);
    for (const successor of successors.get(edgeId) ?? []) {
      const remaining = requireDefined(enteringArcs.get(successor)) - 1;
      enteringArcs.set(successor, remaining);
      if (remaining === 0) trimmable.push(successor);
    }
  }
  const onCycle: ProposedRelationEdge[] = [];
  for (const edge of edges) {
    if (onCycle.length >= limit) break;
    if (
      enteringArcs.has(edge.edgeId) &&
      reachesItself(edge.edgeId, successors)
    ) {
      onCycle.push(edge);
    }
  }
  return onCycle;
}

function reachesItself(
  edgeId: string,
  successors: ReadonlyMap<string, readonly string[]>,
): boolean {
  const visited = new Set<string>();
  const frontier = [...(successors.get(edgeId) ?? [])];
  while (frontier.length > 0) {
    const current = requireDefined(frontier.pop());
    if (current === edgeId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    frontier.push(...(successors.get(current) ?? []));
  }
  return false;
}

/**
 * The shared front half of both write-path assertions: refuses the caller's
 * first self-loop, and returns the relation groups that still owe a probe.
 */
function selfLoopFreeAcyclicGroups(
  ctx: AcyclicityProbeContext,
  proposed: readonly ProposedRelationEdge[],
): readonly ProposedAcyclicGroup[] {
  const { groups, firstSelfLoop } = groupProposedByAcyclicRelation(
    ctx.graph,
    ctx.registry,
    proposed,
  );
  if (firstSelfLoop !== undefined) {
    throw cycleRefusal(firstSelfLoop.relation, firstSelfLoop.edge, true);
  }
  return groups.filter((group) => group.edges.length > 0);
}

function cycleRefusal(
  relation: AcyclicEdgeRelation,
  edge: ProposedRelationEdge,
  selfLoop = false,
): EdgeAcyclicityError {
  return new EdgeAcyclicityError({
    relation: displayAcyclicRelationName(relation.name),
    edgeKind: edge.edgeKind,
    edgeId: edge.edgeId,
    fromKind: edge.fromKind,
    fromId: edge.fromId,
    toKind: edge.toKind,
    toId: edge.toId,
    selfLoop,
  });
}

/**
 * The audit reader: every live edge of `relations` whose `to` endpoint
 * reaches its `from` endpoint. Shared verbatim with `verifyConstraintFences`
 * (`src/store/claims/verify.ts`) and with the `acyclic`-added schema-tightening
 * probe (`src/schema/tightening-preflight.ts`), so there is exactly one
 * implementation of "is there a cycle".
 *
 * Takes no `lock`: this is a read-only diagnostic, never gating a live write
 * against a concurrent race, so it runs no isolation-freshness check.
 */
export async function readEdgeAcyclicityViolations(
  ctx: AcyclicityAuditContext,
  relations: readonly AcyclicEdgeRelation[],
): Promise<readonly EdgeAcyclicityViolation[]> {
  const violations: EdgeAcyclicityViolation[] = [];
  for (const relation of [...relations].toSorted((left, right) =>
    compareStrings(left.name, right.name),
  )) {
    const originKeys = await readViolatingOriginKeys(ctx, relation, {
      kind: "relation",
    });
    if (originKeys.length === 0) continue;
    violations.push({
      family: "edgeAcyclicity",
      relation: displayAcyclicRelationName(relation.name),
      edgeIds: [...originKeys].toSorted(compareStrings),
    });
  }
  return violations;
}

/**
 * The plan-time preview: every violation a caller-proposed edge
 * set would create if it were added to the relation's CURRENT live
 * population. This is what lets the graph-merge planner ask "would this
 * resolved plan's edge writes close a cycle" and surface a typed conflict
 * for review, without ever writing anything.
 *
 * Read-only and lock-free like {@link readEdgeAcyclicityViolations} — this is
 * a PREVIEW, not a write gate, and takes no `lock` for the same reason that
 * function does not: it decides nothing on its own. It runs before any
 * per-graph write lock exists (a merge plan does no write to fence), and its
 * answer is inherently racy against a concurrent writer of the SAME relation
 * — which is fine, because the actual write path
 * ({@link assertEdgeRelationsAcyclic}) re-verifies under the per-graph write
 * lock at commit/apply time regardless, and remains the sole authority.
 *
 * Shares the unwritten-rows probe and its in-memory cycle search with a
 * batch's own pre-write check ({@link assertUnwrittenEdgeRelationsAcyclic}),
 * so a write-path refusal and a plan-time preview cannot disagree about what
 * counts as a cycle; this reader differs only in reporting EVERY proposed
 * edge on a cycle rather than refusing at the first. A self-loop among
 * `proposed` is reported directly, without a round trip.
 *
 * `excludedEdgeIds` names stored edges the same plan removes. They are left
 * out of the walk, so the preview judges the state the plan produces — a
 * reversal (`a → b` deleted, `b → a` added) is acyclic — rather than the
 * proposed edges layered onto rows that will be gone.
 */
export async function readProposedEdgeAcyclicityViolations(
  ctx: AcyclicityAuditContext,
  graph: GraphDef,
  proposed: readonly ProposedRelationEdge[],
  excludedEdgeIds: readonly string[] = [],
): Promise<readonly EdgeAcyclicityViolation[]> {
  const { groups } = groupProposedByAcyclicRelation(
    graph,
    ctx.registry,
    proposed,
  );
  const violations: EdgeAcyclicityViolation[] = [];
  for (const { relation, edges, selfLoopEdgeIds } of groups) {
    const probedIds =
      edges.length === 0 ?
        []
      : proposedEdgesOnOverlayCycle(
          edges,
          await readUnwrittenEdgeReaches(ctx, relation, edges, excludedEdgeIds),
        ).map((edge) => edge.edgeId);
    const edgeIds = [...new Set([...selfLoopEdgeIds, ...probedIds])].toSorted(
      compareStrings,
    );
    if (edgeIds.length === 0) continue;
    violations.push({
      family: "edgeAcyclicity",
      relation: displayAcyclicRelationName(relation.name),
      edgeIds,
    });
  }
  return violations;
}
