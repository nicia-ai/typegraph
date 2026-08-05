/**
 * Valid-time window reconciliation for INHERITED rows (issue #369).
 *
 * A branch can end an inherited row's validity — `update(id, {}, { validTo })`
 * is an ordinary write — and until now the merge discarded that statement
 * silently. This module resolves those endings and hands the commit the one
 * instant it must write.
 *
 * WHAT IS RECONCILED, AND WHY ONLY THAT
 *
 * On a row that is live in both the base and the fork, `validTo` is the only
 * window delta a branch can author AND the commit can apply:
 *
 * | observed delta            | reachable how                     | applicable? |
 * | ------------------------- | --------------------------------- | ----------- |
 * | `validTo` set / moved     | `update(id, {}, { validTo })`     | yes         |
 * | `validFrom` changed       | soft-delete + resurrect in a fork | no          |
 * | `validTo` cleared to none | soft-delete + resurrect in a fork | no          |
 *
 * The update SQL writes `valid_from` only under `clearDeleted` (the
 * resurrection path) and can only SET `valid_to`, never clear it — see
 * `buildUpdateNode` in `backend/drizzle/operations/nodes.ts`. Reconciling a
 * value the commit then drops would make the merge report a change that did not
 * happen, so the two unapplicable deltas are REPORTED
 * ({@link WINDOW_NOT_APPLICABLE_DROP_REASON}) rather than staged.
 *
 * THE RESOLUTION RULE
 *
 * An end-of-validity is a monotone claim ("this stopped being true") — the same
 * shape as a deletion — so it is resolved by a fixed least-claim rule rather
 * than by `onPropertyConflict`:
 *
 *   1. no branch changed it        → keep base, write nothing;
 *   2. exactly one branch changed  → that value, INCLUDING an extension to a
 *                                    later instant (a blind `min` against base
 *                                    would make extension impossible);
 *   3. several branches changed    → the preferred (incremental target) branch's
 *                                    value if it is one of them, else the
 *                                    EARLIEST end.
 *
 * `min` over a set is commutative and associative, so determinism holds without
 * consulting `branchRank` at all, and rule 3's preference is the same
 * committed-target precedence `canonicalizeCluster` applies to identity
 * survivors: a user branch never re-windows a row the target itself windowed.
 * Nothing here can raise a new conflict, so no previously-succeeding merge
 * starts failing.
 *
 * Rule 3's preferred half is reached by NOT ACTING: the preferred branch is the
 * committed target itself, so its own end is already the stored one. Resolving
 * to it would write the row back at itself and report an end the merge never
 * decided, which is why a target that moved the end takes this row out of the
 * resolution entirely.
 *
 * DELETION ABSORBS AN ENDING
 *
 * A window-only change is not a "modification" (it is staged in its own bucket),
 * so it never reaches delete/modify resolution. A row one branch deleted and
 * another merely re-windowed is therefore deleted, with no `DeleteModifyConflict`
 * — deleting and ending are both "no longer true", and the stronger statement
 * wins. The callers pass the finally-deleted identity sets so the ending is
 * dropped with the row.
 */
import { requireDefined } from "../utils/presence";
import {
  compareMergeKeys,
  compareStrings,
  type MergeKey,
  mergeKey,
} from "./node-key";
import type { StagedWindowedEdge, StagedWindowedNode } from "./staging";
import type { ValidWindow } from "./state-diff";
import type { EdgeId, NodeId, NodeType } from "./typegraph-internal";
import type { BranchId, DroppedItem, ValidityEndResolution } from "./types";

/** A node id in its untyped (`NodeType`-default) branded form. */
type AnyNodeId = NodeId<NodeType>;

/**
 * Reason recorded on a {@link DroppedItem} for a window delta the commit cannot
 * apply to a live inherited row — a fork `validFrom` divergence, or a `validTo`
 * cleared back to none. Reported rather than silently ignored.
 */
export const WINDOW_NOT_APPLICABLE_DROP_REASON =
  "window-not-applicable" as const;

/**
 * The outcome of window reconciliation over the whole staging set: the end each
 * inherited identity must be written with, plus both report channels.
 */
export type ValidWindowResolution = Readonly<{
  /** `(kind, id) -> validTo` for every inherited NODE the commit must end. */
  nodeEnds: ReadonlyMap<MergeKey, string>;
  /** `(kind, id) -> validTo` for every inherited EDGE the commit must end. */
  edgeEnds: ReadonlyMap<MergeKey, string>;
  resolutions: readonly ValidityEndResolution[];
  dropped: readonly DroppedItem[];
}>;

/** One branch's claim that a row stopped being valid at an instant. */
export type EndClaim = Readonly<{ branchId: BranchId; validTo: string }>;

/**
 * The least claim in a set: the earliest instant any branch claimed, or
 * `undefined` for an empty set. Canonical ISO 8601 UTC is fixed-width, so its
 * lexicographic order IS chronological order (see `isCanonicalIsoDate`) — every
 * window the diff reports is canonicalized, which is also what keeps the choice
 * identical on SQLite and PostgreSQL despite their different raw timestamp text.
 *
 * Order-independent: `min` over a set is commutative and associative.
 */
function earliestEnd(claims: readonly EndClaim[]): string | undefined {
  let earliest: string | undefined;
  for (const claim of claims) {
    if (earliest === undefined || compareStrings(claim.validTo, earliest) < 0) {
      earliest = claim.validTo;
    }
  }
  return earliest;
}

/**
 * Applies rule 3 to a set of end claims: the preferred branch's claim if it made
 * one, else {@link earliestEnd}. Order-independent — the preferred branch's claims
 * are selected as a SET and reduced by the same `min`, so a fold set holding several
 * preferred rows (distinct edges the repoint collapsed) cannot resolve on which of
 * them the caller happened to list first.
 *
 * Only the edge FOLD needs this form. The inherited-row reconciler never sees a
 * preferred claim (the committed target's own end is already stored, so it is
 * taken out of the resolution rather than resolved to) and calls
 * {@link earliestEnd} directly.
 */
export function resolveEndClaims(
  claims: readonly EndClaim[],
  preferredBranchId: BranchId | undefined,
): string | undefined {
  const preferred = claims.filter(
    (claim) => claim.branchId === preferredBranchId,
  );
  return earliestEnd(preferred.length > 0 ? preferred : claims);
}

/** The claiming branches of a resolved end, deduped and sorted. */
function claimingBranches(claims: readonly EndClaim[]): readonly BranchId[] {
  return [...new Set(claims.map((claim) => claim.branchId))].sort(
    (left, right) => compareStrings(left, right),
  );
}

/**
 * Splits ONE branch's observed window delta into the part the commit can apply
 * (a set or moved `validTo`) and the parts it cannot. A single delta can be
 * both: a fork that soft-deleted and resurrected a row moved `validFrom`
 * (unapplicable) and may have set a new end (applicable) in the same act.
 */
function classifyDelta(
  base: ValidWindow,
  fork: ValidWindow,
): Readonly<{ applicableEnd: string | undefined; unapplicable: boolean }> {
  const endCleared = fork.validTo === undefined && base.validTo !== undefined;
  return {
    applicableEnd:
      fork.validTo !== undefined && fork.validTo !== base.validTo ?
        fork.validTo
      : undefined,
    unapplicable: endCleared || fork.validFrom !== base.validFrom,
  };
}

/** A staged window delta reduced to the fields reconciliation needs. */
type WindowDelta = Readonly<{
  branchId: BranchId;
  kind: string;
  id: string;
  base: ValidWindow;
  fork: ValidWindow;
}>;

/**
 * Reconciles one entity population (nodes or edges), skipping identities the
 * merge finally deletes — deletion absorbs an ending, with no conflict recorded.
 */
function resolvePopulation(
  entity: "node" | "edge",
  deltas: readonly WindowDelta[],
  deletions: ReadonlySet<MergeKey>,
  preferredBranchId: BranchId | undefined,
  dropItem: (id: string) => DroppedItem,
): Readonly<{
  ends: ReadonlyMap<MergeKey, string>;
  resolutions: readonly ValidityEndResolution[];
  dropped: readonly DroppedItem[];
}> {
  const byIdentity = new Map<MergeKey, WindowDelta[]>();
  for (const delta of deltas) {
    const identity = mergeKey(delta.kind, delta.id);
    if (deletions.has(identity)) {
      continue;
    }
    const bucket = byIdentity.get(identity);
    if (bucket === undefined) {
      byIdentity.set(identity, [delta]);
    } else {
      bucket.push(delta);
    }
  }

  const ends = new Map<MergeKey, string>();
  const resolutions: ValidityEndResolution[] = [];
  const dropped: DroppedItem[] = [];

  for (const [identity, group] of byIdentity) {
    const claims: EndClaim[] = [];
    let reportedUnapplicable = false;
    let targetMovedEnd = false;
    for (const delta of group) {
      const { applicableEnd, unapplicable } = classifyDelta(
        delta.base,
        delta.fork,
      );
      // The preferred branch IS the committed incremental target: its delta
      // describes the DESTINATION's own row, not a claim staged against it. A
      // target that already moved this end leaves the merge nothing to apply —
      // that is rule 3's committed-target precedence, reached without writing
      // the row back at itself or reporting an end the merge did not decide.
      // A target-side unapplicable delta is likewise not something the merge
      // failed to carry: it is where the merge writes.
      if (delta.branchId === preferredBranchId) {
        targetMovedEnd ||= applicableEnd !== undefined;
        continue;
      }
      if (applicableEnd !== undefined) {
        claims.push({ branchId: delta.branchId, validTo: applicableEnd });
      }
      // One entry per ROW, not per contributing branch: the report names what
      // the merge could not apply to that row, and a second branch diverging the
      // same way adds no information a caller can act on.
      if (unapplicable && !reportedUnapplicable) {
        reportedUnapplicable = true;
        dropped.push(dropItem(delta.id));
      }
    }
    const resolved = targetMovedEnd ? undefined : earliestEnd(claims);
    if (resolved === undefined) {
      continue;
    }
    ends.set(identity, resolved);
    const first = requireDefined(group[0]);
    resolutions.push({
      entity,
      kind: first.kind,
      id: first.id,
      validTo: resolved,
      claimedBy: claimingBranches(claims),
    });
  }

  // Ordered by the composite `(kind, id)` identity, never a joined string: a
  // caller-supplied id may contain any character, so a separator-joined key
  // would not be a total order and the output would depend on insertion order.
  return {
    ends,
    resolutions: resolutions.sort((left, right) =>
      compareMergeKeys(
        mergeKey(left.kind, left.id),
        mergeKey(right.kind, right.id),
      ),
    ),
    dropped: dropped.sort((left, right) => compareStrings(left.id, right.id)),
  };
}

/**
 * Reconciles every staged inherited window delta into the ends the commit writes.
 *
 * Order-independent: deltas are grouped by `(kind, id)`, resolved by the fixed
 * least-claim rule, and both report channels are sorted by stable keys — so
 * shuffling the branch set yields an identical result.
 *
 * @param staging The provenance-tagged union staging set (T7).
 * @param nodeDeletions The AUTHORITATIVE finally-deleted node identities.
 * @param edgeDeletions The AUTHORITATIVE finally-deleted edge identities.
 * @param preferredBranchId The incremental merge's committed-target branch,
 *   whose own end already stands and so takes its row out of the resolution
 *   (rule 3's preferred half). Absent on the snapshot path.
 */
export function resolveValidWindows(
  staging: Readonly<{
    windowedNodes: readonly StagedWindowedNode[];
    windowedEdges: readonly StagedWindowedEdge[];
  }>,
  nodeDeletions: ReadonlySet<MergeKey>,
  edgeDeletions: ReadonlySet<MergeKey>,
  preferredBranchId?: BranchId,
): ValidWindowResolution {
  const nodes = resolvePopulation(
    "node",
    staging.windowedNodes.map((staged) => ({
      branchId: staged.branchId,
      kind: staged.node.kind,
      id: staged.node.id,
      base: staged.node.base,
      fork: staged.node.fork,
    })),
    nodeDeletions,
    preferredBranchId,
    (id) => ({
      kind: "node",
      id: id as AnyNodeId,
      reason: WINDOW_NOT_APPLICABLE_DROP_REASON,
    }),
  );
  const edges = resolvePopulation(
    "edge",
    staging.windowedEdges.map((staged) => ({
      branchId: staged.branchId,
      kind: staged.edge.kind,
      id: staged.edge.id,
      base: staged.edge.base,
      fork: staged.edge.fork,
    })),
    edgeDeletions,
    preferredBranchId,
    (id) => ({
      kind: "edge",
      id: id as EdgeId,
      reason: WINDOW_NOT_APPLICABLE_DROP_REASON,
    }),
  );

  return {
    nodeEnds: nodes.ends,
    edgeEnds: edges.ends,
    resolutions: [...nodes.resolutions, ...edges.resolutions],
    dropped: [...nodes.dropped, ...edges.dropped],
  };
}
