/**
 * The composition cascade's read side: the parts closure of one whole,
 * planned under the per-graph write lock so a concurrent attach cannot slip
 * a part past it (see {@link planCompositionCascade}).
 *
 * This module owns exactly one decision, `compositionEdgeCounts`, and one
 * traversal, `planCompositionCascade`. Everything that deletes a composition
 * whole — the node-delete pipeline's runtime cascade and merge's plan-time
 * and apply-time orphan checks — reads the closure through this module, never
 * by re-walking composition edges itself.
 */
import {
  type EdgeRow,
  type GraphReadBackend,
  isLiveNodeRow,
} from "../../backend/types";
import { CompilerInvariantError, CompositionCycleError } from "../../errors";
import {
  type CompositionPair,
  type CompositionPartSide,
} from "../../registry/composition-relation";
import { type KindRegistry } from "../../registry/kind-registry";
import { edgeCardinalitySpec } from "../claims/edge-claims";
import { type GraphWriteLock } from "../recorded-capture/clock";
import { type CompositionNodeRef } from "../types";

/**
 * One node the cascade will delete, with the composition edge that binds it.
 *
 * Not exported beyond this module: every consumer reaches it only through
 * `CompositionCascadePlan.members`, structurally — exporting it separately
 * would be a public name nothing outside this file names.
 */
type CompositionCascadeMember = Readonly<{
  kind: string;
  id: string;
  /** The composition edge id binding this member to its whole in this cascade. */
  viaEdgeId: string;
  /** The composition edge KIND realizing this member's membership (`row.kind`). */
  viaEdgeKind: string;
  /**
   * This member's OWN immediate whole — the node it is directly a part of,
   * which for a depth >= 2 member is an intermediate part, not the cascade's
   * root. Consumers that need "which composition pair realizes this
   * membership" read `viaEdgeKind`/`whole` off the member rather than
   * re-deriving it via `registry.compositionPairsBetween(member.kind, root.kind)`
   * — that re-derivation is wrong past depth 1 (the root is not necessarily
   * the immediate whole) and is exactly the kind of second spelling this
   * module exists to avoid.
   */
  whole: CascadeNode;
}>;

export type CompositionCascadePlan = Readonly<{
  /**
   * LIVE parts in LEAF-FIRST order. Empty when the whole declares no parts.
   * A member whose node row is already dead (see {@link liveDiscoveredMembers})
   * is excluded — it is not something for a caller to retire/purge, nor a
   * composition orphan for merge to report.
   */
  members: readonly CompositionCascadeMember[];
  /** Every composition edge id the cascade consumes, including the roots'. */
  consumedEdgeIds: ReadonlySet<string>;
}>;

const EMPTY_COMPOSITION_CASCADE_PLAN: CompositionCascadePlan = {
  members: [],
  consumedEdgeIds: new Set(),
};

/**
 * The plan's members as bare `{ kind, id }` refs, leaf-first — what a whole's
 * delete reports to its operation hook and to the transaction receipt
 * (`cascadedParts`).
 *
 * A projection of the plan the cascade ALREADY computes, not a second walk:
 * the exposure and the deletions are the same list by construction, so a
 * consumer invalidating a cache from `cascadedParts` can never be told about
 * a part the cascade did not delete (or miss one it did).
 */
export function cascadedPartReferences(
  plan: CompositionCascadePlan,
): readonly CompositionNodeRef[] {
  return plan.members.map((member) => ({ kind: member.kind, id: member.id }));
}

/**
 * Whether one composition edge row still counts as a live membership under
 * its pair's declared whole-side population.
 *
 * Restated from {@link edgeCardinalitySpec}'s `holderLiveness` for a row
 * already known non-deleted (every reader of this predicate excludes
 * deleted rows before calling it) — imported rather than re-spelled, so a
 * `holderLiveness` value can never disagree with the population this
 * predicate treats as counting.
 *
 * `population: "one"` (`holderLiveness: "live"`) counts unconditionally: the
 * part/whole binding persists for the row's entire life, ended or not.
 * `population: "oneActive"` (`holderLiveness: "liveAndActive"`) counts only
 * an open-ended row (`valid_to === undefined`) — an ended row survives as
 * history for a reparented part and must not re-attach it to a whole that no
 * longer holds it.
 */
export function compositionEdgeCounts(
  pair: Pick<CompositionPair, "partSide" | "population">,
  row: Pick<EdgeRow, "valid_to">,
): boolean {
  const ref =
    pair.partSide === "from" ?
      ({ direction: "source", cardinality: pair.population } as const)
    : ({ direction: "target", cardinality: pair.population } as const);
  return (
    edgeCardinalitySpec(ref).holderLiveness !== "liveAndActive" ||
    row.valid_to === undefined
  );
}

type CascadeNode = Readonly<{ kind: string; id: string }>;

function memberKey(node: CascadeNode): string {
  return `${node.kind} ${node.id}`;
}

/** Which endpoint of `edgeKind` carries the WHOLE — the mirror of `compositionPartSide`. */
function wholeSide(partSide: CompositionPartSide): "from" | "to" {
  return partSide === "from" ? "to" : "from";
}

/** {@link readWholeSideEdges}'s result: the rows, and whether the set-read port answered. */
type WholeSideEdgesResult = Readonly<{
  rows: readonly EdgeRow[];
  /**
   * Whether `findEdgesByHeterogeneousEndpointSet` answered this round at
   * all — with rows, or with a caller-trusted empty result. `false` only
   * when the port is unavailable, or when this round paid the one-time
   * fallback confirmation itself. The caller uses this to stop asking for
   * that confirmation once the port has proven itself for this cascade.
   */
  setReadAnswered: boolean;
}>;

/**
 * Reads one round's whole-side composition edges: every live composition
 * edge (of the given kinds) whose WHOLE endpoint is a member of `frontier`.
 *
 * Prefers `findEdgesByHeterogeneousEndpointSet` — the same set read
 * `findConnectedEdgesForNodeBatch` (`node-operations.ts`) uses — split into
 * (at most) two calls, one per orientation, since one call's `side` applies
 * uniformly to every edge kind it names, and always combined into ONE
 * result before any trust decision: an empty result is judged on the
 * COMBINED rows across both orientations, never per-orientation, so a
 * nonempty `from`-side never short-circuits trust of an empty `to`-side (or
 * vice versa) — the same disposition applies uniformly to both.
 *
 * Falls back to the kind-blind `findEdgesConnectedTo`, filtered to this
 * round's edge kinds and their whole-side orientation, only when the set
 * read is unavailable, or when `trustEmptyResult` is `false` AND the set
 * read came back with no rows at all: no licensed rows is insufficient
 * evidence that none exist (the same disposition `findConnectedEdgesForNodeBatch`
 * states) until the caller has confirmed it once for this cascade.
 * `trustEmptyResult: true` (every round after the first has confirmed the
 * port) skips that confirmation — an unbounded closure would otherwise pay
 * one extra per-frontier-node read at EVERY childless round, not just the
 * first, for evidence the first round already established.
 * `findEdgesByHeterogeneousEndpointSet` itself applies no temporal filter
 * beyond `excludeDeleted` (see `buildTemporalConditions`), so it always
 * returns an ended-but-undeleted row exactly as `findEdgesConnectedTo`
 * does — the population decision is `compositionEdgeCounts`' alone, applied
 * to whichever read answered. See `tests/composition-cascade.test.ts`'s
 * direct assertion on the set read.
 */
async function readWholeSideEdges(
  ctx: Readonly<{ graphId: string; registry: KindRegistry }>,
  frontier: readonly CascadeNode[],
  edgeKinds: readonly string[],
  backend: GraphReadBackend,
  trustEmptyResult: boolean,
): Promise<WholeSideEdgesResult> {
  const wholeIsFromEdgeKinds: string[] = [];
  const wholeIsToEdgeKinds: string[] = [];
  for (const edgeKind of edgeKinds) {
    const bucket =
      wholeSide(requirePartSide(ctx.registry, edgeKind)) === "from" ?
        wholeIsFromEdgeKinds
      : wholeIsToEdgeKinds;
    bucket.push(edgeKind);
  }

  const setRead = backend.findEdgesByHeterogeneousEndpointSet;
  if (setRead !== undefined) {
    const endpoints = frontier.map((node) => ({
      kind: node.kind,
      id: node.id,
    }));
    const [fromSideRows, toSideRows] = await Promise.all([
      wholeIsFromEdgeKinds.length === 0 ?
        Promise.resolve<readonly EdgeRow[]>([])
      : setRead({
          graphId: ctx.graphId,
          side: "from",
          endpoints,
          edgeKinds: wholeIsFromEdgeKinds,
          excludeDeleted: true,
        }),
      wholeIsToEdgeKinds.length === 0 ?
        Promise.resolve<readonly EdgeRow[]>([])
      : setRead({
          graphId: ctx.graphId,
          side: "to",
          endpoints,
          edgeKinds: wholeIsToEdgeKinds,
          excludeDeleted: true,
        }),
    ]);
    const combined = [...fromSideRows, ...toSideRows];
    if (combined.length > 0 || trustEmptyResult) {
      return { rows: combined, setReadAnswered: true };
    }
  }

  const edgeKindSet = new Set(edgeKinds);
  const rowsPerNode = await Promise.all(
    frontier.map((node) =>
      backend.findEdgesConnectedTo({
        graphId: ctx.graphId,
        nodeKind: node.kind,
        nodeId: node.id,
      }),
    ),
  );
  const seenIds = new Set<string>();
  const filtered: EdgeRow[] = [];
  for (const [index, node] of frontier.entries()) {
    for (const row of rowsPerNode[index] ?? []) {
      if (row.deleted_at !== undefined) continue;
      if (!edgeKindSet.has(row.kind)) continue;
      const partSide = requirePartSide(ctx.registry, row.kind);
      const wholeEndpoint =
        wholeSide(partSide) === "from" ?
          { kind: row.from_kind, id: row.from_id }
        : { kind: row.to_kind, id: row.to_id };
      if (wholeEndpoint.kind !== node.kind || wholeEndpoint.id !== node.id) {
        continue;
      }
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      filtered.push(row);
    }
  }
  // The set-read port (if any) is now confirmed for this cascade: this
  // round paid the fallback and it agreed with the port's empty verdict
  // (or there was no port to confirm), so future rounds may trust it.
  return { rows: filtered, setReadAnswered: setRead !== undefined };
}

function requirePartSide(
  registry: KindRegistry,
  edgeKind: string,
): CompositionPartSide {
  const partSide = registry.compositionPartSide(edgeKind);
  if (partSide === undefined) {
    throw new CompilerInvariantError(
      `planCompositionCascade read edge kind "${edgeKind}" as a composition edge, but the registry no longer classifies it as one.`,
      { edgeKind },
    );
  }
  return partSide;
}

/**
 * Drops discovered members whose node row is no longer live.
 *
 * A composition edge row and its endpoint's node row can go stale relative
 * to each other: a direct part delete cleans up its OWN composition edges
 * (see `enforceNodeDeleteBehavior`'s restrict arm, `node-write-pipeline.ts`),
 * but an ended-but-undeleted `oneActive` reparent or a pre-fix write can
 * still leave a live composition edge pointing at an already-tombstoned
 * node. A dead node is not a composition ORPHAN — there is nothing left for
 * a caller to act on — so this is the ONE place that liveness is checked
 * before a member is reported: both the runtime cascade (which retires/
 * purges each `members` entry) and merge's plan/apply-time orphan reports
 * read the SAME filtered closure, rather than each re-deriving "is this
 * member actually still there" on its own. (The runtime cascade's own
 * `target.getNode` preflight per member is therefore a guard against a TRUE
 * concurrent delete racing the walk itself, not this steady-state gap.)
 *
 * One batched read: `discoveryOrder` is already the complete, deduplicated
 * closure, so a single parallel round of `getNode` calls suffices — no need
 * to interleave this with the round-by-round edge traversal above, which
 * must still walk THROUGH a dead member to find any live descendants
 * beneath it (edge reads are keyed by `(kind, id)`, not by the node's own
 * liveness).
 */
async function liveDiscoveredMembers(
  ctx: Readonly<{ graphId: string }>,
  backend: GraphReadBackend,
  discoveryOrder: readonly CompositionCascadeMember[],
): Promise<readonly CompositionCascadeMember[]> {
  const nodeRows = await Promise.all(
    discoveryOrder.map((member) =>
      backend.getNode(ctx.graphId, member.kind, member.id),
    ),
  );
  return discoveryOrder.filter((_member, index) => {
    const row = nodeRows[index];
    return row !== undefined && isLiveNodeRow(row);
  });
}

/**
 * THE parts closure of one whole, under the per-graph write lock.
 *
 * `lock` is compile-time evidence the caller took the per-graph write lock
 * before any row read, so a concurrent attach cannot slip a part past the
 * cascade. Breadth-first, one round per level: each round reads the
 * frontier's whole-side composition edges, admits each row through
 * {@link compositionEdgeCounts}, and folds newly-discovered `(kind, id)`
 * pairs into the next frontier.
 *
 * Termination is the VISITED SET, not a kind-level depth bound: §2.7 permits
 * reflexive composition, so a kind-level closure of one edge kind places no
 * bound on instance depth. The visited set is finite because the graph is; a
 * round that discovers no new member ends the walk normally. A row that
 * resolves to an ALREADY-visited member is an INSTANCE-level cycle. The
 * write path refuses one: every composition-realizing edge kind belongs to
 * the oriented composition union (`compositionAcyclicRelation`,
 * `src/store/acyclicity.ts`), probed at write time, so a cycle can only
 * reach this walk through rows written before the relation was declared, by
 * trusted import, or by direct SQL. The walk cannot silently truncate a
 * revisit — that would produce a silent orphan — so it stops and throws the
 * typed, user-facing {@link CompositionCycleError} instead.
 *
 * Deliberately not `buildReachableCte`: one CTE carries one temporal mode,
 * and a closure spanning a `one` level and an `oneActive` level needs both.
 * Level-by-level with the population predicate applied by its one owner is
 * exact on every backend and needs no recursive-traversal capability.
 */
export async function planCompositionCascade(
  ctx: Readonly<{
    graphId: string;
    registry: KindRegistry;
    lock: GraphWriteLock;
  }>,
  wholeKind: string,
  wholeId: string,
  backend: GraphReadBackend,
): Promise<CompositionCascadePlan> {
  const edgeKinds = ctx.registry.compositionEdgeKindsUnder(wholeKind);
  if (edgeKinds.length === 0) return EMPTY_COMPOSITION_CASCADE_PLAN;

  const root: CascadeNode = { kind: wholeKind, id: wholeId };
  const visited = new Set<string>([memberKey(root)]);
  const discoveryOrder: CompositionCascadeMember[] = [];
  const consumedEdgeIds = new Set<string>();

  let frontier: readonly CascadeNode[] = [root];
  let setReadTrusted = false;
  while (frontier.length > 0) {
    const { rows, setReadAnswered } = await readWholeSideEdges(
      ctx,
      frontier,
      edgeKinds,
      backend,
      setReadTrusted,
    );
    setReadTrusted ||= setReadAnswered;
    const nextFrontier: CascadeNode[] = [];
    for (const row of rows) {
      const partSide = requirePartSide(ctx.registry, row.kind);
      const part: CascadeNode =
        partSide === "from" ?
          { kind: row.from_kind, id: row.from_id }
        : { kind: row.to_kind, id: row.to_id };
      const wholeOfRow: CascadeNode =
        partSide === "from" ?
          { kind: row.to_kind, id: row.to_id }
        : { kind: row.from_kind, id: row.from_id };
      // By `row.kind`, not "the first declared pair between these two
      // kinds": two realizing edges may hold the same (part, whole) pair
      // (E-a-2), and their populations are per-edge-kind declarations, so a
      // first-match lookup could admit this row under the OTHER edge's
      // population predicate.
      const pair = ctx.registry.compositionPairVia(
        part.kind,
        wholeOfRow.kind,
        row.kind,
      );
      if (pair === undefined) {
        throw new CompilerInvariantError(
          `planCompositionCascade read composition edge "${row.kind}" between "${part.kind}" and "${wholeOfRow.kind}", but the registry declares no composition pair for that combination.`,
          {
            edgeKind: row.kind,
            partKind: part.kind,
            wholeKind: wholeOfRow.kind,
          },
        );
      }
      if (!compositionEdgeCounts(pair, row)) continue;

      const key = memberKey(part);
      if (visited.has(key)) {
        throw new CompositionCycleError({
          wholeKind,
          wholeId,
          revisitedKind: part.kind,
          revisitedId: part.id,
        });
      }
      visited.add(key);
      nextFrontier.push(part);
      consumedEdgeIds.add(row.id);
      discoveryOrder.push({
        kind: part.kind,
        id: part.id,
        viaEdgeId: row.id,
        viaEdgeKind: row.kind,
        whole: wholeOfRow,
      });
    }
    frontier = nextFrontier;
  }

  const liveMembers = await liveDiscoveredMembers(ctx, backend, discoveryOrder);
  return {
    // Leaf-first: the reverse of BFS discovery order.
    members: liveMembers.toReversed(),
    consumedEdgeIds,
  };
}
