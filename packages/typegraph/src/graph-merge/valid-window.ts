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
 * window field a branch can author AND the commit can apply:
 *
 * | observed delta            | reachable how                     | applicable? |
 * | ------------------------- | --------------------------------- | ----------- |
 * | `validTo` set / moved     | `update(id, {}, { validTo })`     | yes         |
 * | `validTo` cleared to none | `update(id, {}, { clearValidTo: true })` | yes |
 * | `validFrom` changed       | soft-delete + resurrect in a fork | no          |
 *
 * The update SQL writes `valid_from` only under `clearDeleted` (the
 * resurrection path), so a changed lower bound still cannot be applied to a
 * live inherited row. Reconciling a value the commit then drops would make the
 * merge report a change that did not happen, so that delta is REPORTED
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
 *                                    would make extension impossible), or clear;
 *   3. several branches changed    → the preferred (incremental target) branch's
 *                                    value if it is one of them, else the
 *                                    EARLIEST end; an end beats a concurrent
 *                                    clear as the stronger monotone claim, and
 *                                    unanimous clears reopen the row.
 *
 * `min` over the set claims plus the all-clear check is commutative and
 * associative, so determinism holds without consulting `branchRank` at all, and
 * rule 3's preference is the same
 * committed-target precedence `canonicalizeCluster` applies to identity
 * survivors: a user branch never re-windows a row the target itself windowed.
 * Nothing here can raise a new conflict, so no previously-succeeding merge
 * starts failing.
 *
 * Rule 3's preferred half is reached by NOT ACTING: the preferred branch is the
 * committed target itself, so its own end is already the stored one. Resolving
 * to it would write the row back at itself and report an end the merge never
 * decided, which is why a target that moved the end takes this row out of the
 * WRITES entirely.
 *
 * It does not take it out of the REPORT (issue #409). Discarding a claim is an
 * arbitration outcome, and the merge report's honesty principle is that every
 * observable-but-unapplied delta is visible: the claim that merely LOST the
 * least-claim rule already appears in `ValidityEndResolution.claimedBy`, so a claim
 * target precedence threw away must not be less visible than that. Such a row gets a
 * resolution naming the TARGET's own instant, its discarded claimants, and
 * `precedence: {@link VALIDITY_END_TARGET_PRECEDENCE}` — the discriminator that keeps
 * "the merge wrote this end" and "the target already held this end" distinguishable.
 * A row NO branch claimed produces no entry at all: there was nothing to discard.
 *
 * DELETION ABSORBS AN ENDING
 *
 * A window-only change is not a "modification" (it is staged in its own bucket),
 * so it never reaches delete/modify resolution. A row one branch deleted and
 * another merely re-windowed is therefore deleted, with no `DeleteModifyConflict`
 * — deleting and ending are both "no longer true", and the stronger statement
 * wins. The callers pass the finally-deleted identity sets so the ending is
 * dropped with the row.
 *
 * WHO GETS PROVENANCE CREDIT
 *
 * An ending is authored state, so the branch that authored it contributed to the
 * committed row and must appear in the merge's provenance — even when the ending
 * is its ONLY change to that row (issue #402). This module is the authority on
 * that: it decided which claim was committed, so it also emits the credit
 * ({@link ValidWindowResolution.nodeCredits} / `edgeCredits`), rather than leaving
 * the commit to re-derive it from staging and lose the claim that won.
 *
 * Credit goes to exactly the branches whose claim IS the resolved end — the `min`
 * winner and anyone who tied with it. Provenance records contribution to
 * COMMITTED state, and a branch whose later end lost the least-claim rule
 * contributed none of it; its claim is still visible in the report
 * (`ValidityEndResolution.claimedBy` names every claimant, winning or not), which
 * is where "who asked for what" belongs. The alternative — crediting every
 * claimant — would make provenance answer "who spoke about this row" instead, a
 * different question that the report already answers.
 *
 * By the same rule a target-precedence row credits NOBODY: the merge committed none
 * of that end, so its resolution is report-only and mints no credit.
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
import { VALIDITY_END_TARGET_PRECEDENCE } from "./types";

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
  /** `(kind, id) -> validTo change` for every inherited NODE to re-window. */
  nodeEnds: ReadonlyMap<MergeKey, ValidToChange>;
  /** `(kind, id) -> validTo change` for every inherited EDGE to re-window. */
  edgeEnds: ReadonlyMap<MergeKey, ValidToChange>;
  /**
   * `(kind, id) -> the branches that AUTHORED the resolved node end`: the
   * claimants whose claim equals {@link ValidWindowResolution.nodeEnds}, sorted
   * and deduped. The provenance credit for a window change, keyed identically to
   * `nodeEnds` so the two are read together. Never empty for an identity present
   * in `nodeEnds` — an end exists only because some branch claimed it.
   */
  nodeCredits: ReadonlyMap<MergeKey, readonly BranchId[]>;
  /** The edge half of {@link ValidWindowResolution.nodeCredits}. */
  edgeCredits: ReadonlyMap<MergeKey, readonly BranchId[]>;
  /**
   * Every row whose upper-bound change this phase RESOLVED, nodes then edges — a
   * superset of the changes above: a row target precedence decided appears here (marked
   * {@link VALIDITY_END_TARGET_PRECEDENCE}) with no entry in `nodeEnds`/`edgeEnds`
   * and none in the credits.
   */
  resolutions: readonly ValidityEndResolution[];
  dropped: readonly DroppedItem[];
}>;

/** An explicit upper-bound change; absence from a plan means preserve. */
export type ValidToChange =
  Readonly<{ kind: "set"; validTo: string }> | Readonly<{ kind: "clear" }>;

/** One branch's claim about a row's upper validity bound. */
export type EndClaim = Readonly<{
  branchId: BranchId;
  change: ValidToChange;
}>;

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
    if (claim.change.kind !== "set") continue;
    if (
      earliest === undefined ||
      compareStrings(claim.change.validTo, earliest) < 0
    ) {
      earliest = claim.change.validTo;
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
): ValidToChange | undefined {
  const preferred = claims.filter(
    (claim) => claim.branchId === preferredBranchId,
  );
  const candidates = preferred.length > 0 ? preferred : claims;
  const earliest = earliestEnd(candidates);
  return (
    earliest === undefined ?
      candidates.some((claim) => claim.change.kind === "clear") ?
        { kind: "clear" }
      : undefined
    : { kind: "set", validTo: earliest }
  );
}

/** The claiming branches of a resolved end, deduped and sorted. */
function claimingBranches(claims: readonly EndClaim[]): readonly BranchId[] {
  return [...new Set(claims.map((claim) => claim.branchId))].sort(
    (left, right) => compareStrings(left, right),
  );
}

/** Whether two explicit upper-bound changes request the same stored state. */
function sameValidToChange(left: ValidToChange, right: ValidToChange): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "clear") return true;
  return right.kind === "set" && left.validTo === right.validTo;
}

/**
 * Splits ONE branch's observed window delta into the part the commit can apply
 * (a set, move, or authored clear of `validTo`) and the part it cannot. A moved
 * lower bound proves delete+resurrect occurred. Its implicit ended-to-open
 * transition is part of that indivisible resurrection artifact, not an authored
 * clear, so it stays entirely in `window-not-applicable`; an explicit new end
 * remains independently applicable.
 */
function classifyDelta(
  base: ValidWindow,
  fork: ValidWindow,
): Readonly<{
  applicableEnd: ValidToChange | undefined;
  unapplicable: boolean;
}> {
  const lowerBoundMoved = fork.validFrom !== base.validFrom;
  const endCleared = fork.validTo === undefined && base.validTo !== undefined;
  return {
    applicableEnd:
      fork.validTo !== undefined && fork.validTo !== base.validTo ?
        { kind: "set", validTo: fork.validTo }
      : endCleared && !lowerBoundMoved ? { kind: "clear" }
      : undefined,
    unapplicable: lowerBoundMoved,
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
 *
 * `ends` and `credits` cover only the rows the commit must WRITE; `resolutions`
 * additionally reports the rows target precedence decided, so a discarded claim is
 * visible without being staged.
 */
function resolvePopulation(
  entity: "node" | "edge",
  deltas: readonly WindowDelta[],
  deletions: ReadonlySet<MergeKey>,
  preferredBranchId: BranchId | undefined,
  dropItem: (id: string) => DroppedItem,
): Readonly<{
  ends: ReadonlyMap<MergeKey, ValidToChange>;
  credits: ReadonlyMap<MergeKey, readonly BranchId[]>;
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

  const ends = new Map<MergeKey, ValidToChange>();
  const credits = new Map<MergeKey, readonly BranchId[]>();
  const resolutions: ValidityEndResolution[] = [];
  const dropped: DroppedItem[] = [];

  for (const [identity, group] of byIdentity) {
    const claims: EndClaim[] = [];
    let reportedUnapplicable = false;
    let targetEnd: ValidToChange | undefined;
    for (const delta of group) {
      const { applicableEnd, unapplicable } = classifyDelta(
        delta.base,
        delta.fork,
      );
      // The preferred branch IS the committed incremental target: its delta
      // describes the DESTINATION's own row, not a claim staged against it. A
      // target that already moved this end leaves the merge nothing to apply —
      // that is rule 3's committed-target precedence, reached without writing
      // the row back at itself. The instant is kept rather than a flag, because
      // the report has to name the end that actually stands (a group holds at
      // most one delta per branch, so the `??=` records that one delta's end).
      // A target-side unapplicable delta is likewise not something the merge
      // failed to carry: it is where the merge writes.
      if (delta.branchId === preferredBranchId) {
        targetEnd ??= applicableEnd;
        continue;
      }
      if (applicableEnd !== undefined) {
        claims.push({ branchId: delta.branchId, change: applicableEnd });
      }
      // One entry per ROW, not per contributing branch: the report names what
      // the merge could not apply to that row, and a second branch diverging the
      // same way adds no information a caller can act on.
      if (unapplicable && !reportedUnapplicable) {
        reportedUnapplicable = true;
        dropped.push(dropItem(delta.id));
      }
    }
    const first = requireDefined(group[0]);
    if (targetEnd !== undefined) {
      // Target precedence: the committed target already moved this end, so the
      // merge applies nothing and every branch claim is discarded. Say so
      // (issue #409) — a claim the merge observed and did not apply is exactly what
      // the report exists to make visible, and the least-claim LOSER is already
      // visible in `claimedBy`, so a discarded claim must not be less visible than
      // an out-arbitrated one. The entry names the target's own instant and is
      // marked so a consumer can tell it from an end the merge decided. No end is
      // staged and no credit is minted: nothing here was committed by a branch.
      if (claims.length > 0) {
        resolutions.push({
          entity,
          kind: first.kind,
          id: first.id,
          ...(targetEnd.kind === "set" ?
            { validTo: targetEnd.validTo }
          : { clearValidTo: true as const }),
          claimedBy: claimingBranches(claims),
          precedence: VALIDITY_END_TARGET_PRECEDENCE,
        });
      }
      continue;
    }
    const resolved = resolveEndClaims(claims, undefined);
    if (resolved === undefined) {
      continue;
    }
    ends.set(identity, resolved);
    // The AUTHORS of the committed end: every branch whose claim is the resolved
    // instant, including the ones that tied with it. A later claim lost the
    // least-claim rule and put nothing into the committed row, so it earns no
    // credit — it stays visible as a claimant in the resolution below.
    credits.set(
      identity,
      claimingBranches(
        claims.filter((claim) => sameValidToChange(claim.change, resolved)),
      ),
    );
    resolutions.push({
      entity,
      kind: first.kind,
      id: first.id,
      ...(resolved.kind === "set" ?
        { validTo: resolved.validTo }
      : { clearValidTo: true as const }),
      claimedBy: claimingBranches(claims),
    });
  }

  // Ordered by the composite `(kind, id)` identity, never a joined string: a
  // caller-supplied id may contain any character, so a separator-joined key
  // would not be a total order and the output would depend on insertion order.
  return {
    ends,
    credits,
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
 * @param preferredBranchId The incremental merge's committed-target branch, whose
 *   own end already stands and so takes its row out of the ENDS the commit writes
 *   (rule 3's preferred half) while still reporting the claims it discarded.
 *   Absent on the snapshot path.
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
    nodeCredits: nodes.credits,
    edgeCredits: edges.credits,
    resolutions: [...nodes.resolutions, ...edges.resolutions],
    dropped: [...nodes.dropped, ...edges.dropped],
  };
}
