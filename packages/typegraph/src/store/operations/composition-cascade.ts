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
import { type EdgeRow, type GraphReadBackend } from "../../backend/types";
import { CompilerInvariantError } from "../../errors";
import {
  type CompositionPair,
  type CompositionPartSide,
} from "../../registry/composition-relation";
import { type KindRegistry } from "../../registry/kind-registry";
import { edgeCardinalitySpec } from "../claims/edge-claims";
import { type GraphWriteLock } from "../recorded-capture/clock";

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
   * re-deriving it via `registry.getCompositionEdge(member.kind, root.kind)`
   * — that re-derivation is wrong past depth 1 (the root is not necessarily
   * the immediate whole) and is exactly the kind of second spelling this
   * module exists to avoid.
   */
  whole: CascadeNode;
}>;

export type CompositionCascadePlan = Readonly<{
  /** Parts in LEAF-FIRST order. Empty when the whole declares no parts. */
  members: readonly CompositionCascadeMember[];
  /** Every composition edge id the cascade consumes, including the roots'. */
  consumedEdgeIds: ReadonlySet<string>;
}>;

const EMPTY_COMPOSITION_CASCADE_PLAN: CompositionCascadePlan = {
  members: [],
  consumedEdgeIds: new Set(),
};

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

/**
 * Reads one round's whole-side composition edges: every live composition
 * edge (of the given kinds) whose WHOLE endpoint is a member of `frontier`.
 *
 * Prefers `findEdgesByHeterogeneousEndpointSet` — the same set read
 * `findConnectedEdgesForNodeBatch` (`node-operations.ts`) uses — split into
 * (at most) two calls, one per orientation, since one call's `side` applies
 * uniformly to every edge kind it names. Falls back to the kind-blind
 * `findEdgesConnectedTo`, filtered to this round's edge kinds and their
 * whole-side orientation, when the set read is unavailable OR comes back
 * with no rows at all: no licensed rows is insufficient evidence that none
 * exist (the same disposition `findConnectedEdgesForNodeBatch` states),
 * never proof a childless round actually is one.
 *
 * DELIBERATE, not a missed capability check: every terminal (childless)
 * round on a set-read-capable backend pays the per-frontier-node fallback
 * read once to confirm the empty result, matching the sibling function's
 * disposition rather than introducing a second way to answer "can this
 * backend/graph answer this read with the set port". `findEdgesByHeterogeneousEndpointSet`
 * itself applies no temporal filter beyond `excludeDeleted` (see
 * `buildTemporalConditions`), so it always returns an ended-but-undeleted
 * row exactly as `findEdgesConnectedTo` does — the population decision is
 * `compositionEdgeCounts`' alone, applied to whichever read answered. See
 * `tests/composition-cascade.test.ts`'s direct assertion on the set read.
 */
async function readWholeSideEdges(
  ctx: Readonly<{ graphId: string; registry: KindRegistry }>,
  frontier: readonly CascadeNode[],
  edgeKinds: readonly string[],
  backend: GraphReadBackend,
): Promise<readonly EdgeRow[]> {
  const wholeIsFromEdgeKinds = edgeKinds.filter(
    (edgeKind) => wholeSide(requirePartSide(ctx.registry, edgeKind)) === "from",
  );
  const wholeIsToEdgeKinds = edgeKinds.filter(
    (edgeKind) => wholeSide(requirePartSide(ctx.registry, edgeKind)) === "to",
  );

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
    if (fromSideRows.length > 0 || toSideRows.length > 0) {
      return [...fromSideRows, ...toSideRows];
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
  return filtered;
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
 * resolves to an ALREADY-visited member is a should-be-impossible library
 * invariant violation — the union-acyclicity fence refuses a kind-level
 * cycle at declaration time, so an instance cycle is unreachable — and
 * throws {@link CompilerInvariantError} rather than silently truncating,
 * which would produce a silent orphan.
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
  while (frontier.length > 0) {
    const rows = await readWholeSideEdges(ctx, frontier, edgeKinds, backend);
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
      const pair = ctx.registry.getCompositionEdge(part.kind, wholeOfRow.kind);
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
        throw new CompilerInvariantError(
          `planCompositionCascade revisited "${part.kind}:${part.id}" while walking the composition parts closure of "${wholeKind}:${wholeId}". Composition cycles are refused at declaration time, so this instance cycle should be unreachable.`,
          {
            wholeKind,
            wholeId,
            revisitedKind: part.kind,
            revisitedId: part.id,
          },
        );
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

  return {
    // Leaf-first: the reverse of BFS discovery order.
    members: discoveryOrder.toReversed(),
    consumedEdgeIds,
  };
}
