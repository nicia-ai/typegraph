/**
 * Node claims for a RESOLVED WRITE SET — a whole after-image validated at once,
 * then applied.
 *
 * Every other claim path in this directory decides one row at a time, which is
 * what an ordinary write is. Two callers instead know their complete final state
 * before writing any of it — a graph merge's resolved plan
 * ({@link file://../../graph-merge/merge.ts}) and a set update
 * ({@link file://../operations/node-operations.ts}) — and for them "one row at a
 * time" is the wrong verdict: an atomic SWAP of two nodes' keys, or a handoff of
 * one key from a node the set deletes to a node the set writes, is legal in the
 * final state and refused by every intermediate one.
 *
 * So this module reads the set's claims TOGETHER, decides them against each
 * other first and the persisted relation second, and treats every reservation
 * the set itself releases as available. It decides nothing on its own: the
 * entries come from {@link nodeClaimEntries}, the axis fold from
 * {@link uniquenessProbeKinds}, the ownership verdict from
 * {@link isSameClaimOwner} / {@link claimOwnerKey}, and the rebuild from the
 * same claim writer every create-shaped write uses.
 */
import { type UniqueConstraint } from "../../core/types";
import { ConfigurationError, UniquenessError } from "../../errors";
import { encodeTupleKey } from "../../utils/tuple-key";
import {
  type ClaimOwner,
  claimOwnerKey,
  isSameClaimOwner,
  uniquenessProbeKinds,
} from "./axis";
import {
  alreadyAppliedRowWrite,
  isUniquenessClaimEntry,
  type NodeClaimContext,
  nodeClaimEntries,
  type UniquenessClaimEntry,
  type UniquenessContext,
  withNodeCreateClaimsBatch,
} from "./node-claims";

/** A complete node after-image whose claims belong to one resolved write set. */
export type ResolvedNodeUpsert = Readonly<{
  kind: string;
  id: string;
  props: Readonly<Record<string, unknown>>;
  constraints: readonly UniqueConstraint[];
}>;

/** A node whose current claims the resolved write set gives back. */
export type ResolvedNodeRelease = Readonly<{
  kind: string;
  id: string;
}>;

/**
 * One uniqueness claim the set proposes: who takes it, the row it writes, and
 * the rows its probe reads.
 *
 * `probeKinds` is carried rather than recomputed because it is BOTH halves of
 * the conflict test — the persisted probe issues one read per member, and the
 * in-set test asks whether one claim's write lands in another claim's read set.
 */
type ProposedClaim = Readonly<{
  owner: ClaimOwner;
  entry: UniquenessClaimEntry;
  probeKinds: readonly string[];
}>;

/** The claim rows two proposals share a competition for. */
function claimRowKey(entry: UniquenessClaimEntry): string {
  return encodeTupleKey([entry.constraintName, entry.key]);
}

/**
 * Whether two proposals in one set are competing — one writes a row the other
 * reads.
 *
 * Reachability in EITHER direction, not axis equality: after the axis fold a
 * `kind`-scoped constraint writes under the writer's own kind while a
 * `kindWithSubClasses` constraint of the same name writes under the component's
 * fold, so two claims can compete without sharing an axis. The wider scope's
 * probe is what would have caught the narrower one's row had it been persisted,
 * and inside one set neither row is persisted yet — which is the whole reason
 * this test exists rather than leaving it to the relation.
 */
function claimsCompete(left: ProposedClaim, right: ProposedClaim): boolean {
  return (
    claimRowKey(left.entry) === claimRowKey(right.entry) &&
    (right.probeKinds.includes(left.entry.axis) ||
      left.probeKinds.includes(right.entry.axis))
  );
}

function proposedClaimRefusal(
  incumbent: ProposedClaim,
  challenger: ProposedClaim,
): UniquenessError {
  return new UniquenessError({
    constraintName: challenger.entry.constraintName,
    kind: incumbent.owner.concreteKind,
    existingId: incumbent.owner.nodeId,
    newId: challenger.owner.nodeId,
    fields: challenger.entry.refusal.constraint.fields,
  });
}

/**
 * The set's uniqueness claims, with every in-set competition already refused.
 *
 * Reads its work from {@link nodeClaimEntries} at the CREATE extent — the wider
 * of the two, exactly as {@link file://./node-claims.ts checkUniquenessConstraints}
 * does — and narrows to the uniqueness family. The disjointness entries the same
 * list carries are NOT probed here: they have their own probe over node rows,
 * and each write inside the set's `apply()` reaches it. Filtering rather than
 * asking for a narrower list is what keeps that omission a stated decision
 * instead of an absence nobody notices.
 *
 * @throws UniquenessError when two members of the set compete for one claim.
 */
function proposedClaims(
  ctx: UniquenessContext,
  upserts: readonly ResolvedNodeUpsert[],
): readonly ProposedClaim[] {
  const accepted: ProposedClaim[] = [];
  for (const upsert of upserts) {
    const owner: ClaimOwner = {
      concreteKind: upsert.kind,
      nodeId: upsert.id,
    };
    const entries = nodeClaimEntries(
      ctx.registry,
      upsert.kind,
      upsert.id,
      { ...upsert.props },
      upsert.constraints,
      "create",
    );
    for (const entry of entries) {
      if (!isUniquenessClaimEntry(entry)) continue;
      const proposal: ProposedClaim = {
        owner,
        entry,
        probeKinds: uniquenessProbeKinds(
          upsert.kind,
          entry.refusal.constraint.scope,
          ctx.registry,
        ),
      };
      const incumbent = accepted.find(
        (candidate) =>
          !isSameClaimOwner(candidate.owner, proposal.owner) &&
          claimsCompete(candidate, proposal),
      );
      if (incumbent !== undefined) {
        throw proposedClaimRefusal(incumbent, proposal);
      }
      accepted.push(proposal);
    }
  }
  return accepted;
}

/** One `checkUniqueBatch` round trip: every key this set claims at one axis. */
type ClaimProbeGroup = Readonly<{
  probeKind: string;
  constraintName: string;
  claimsByKey: ReadonlyMap<string, ProposedClaim>;
}>;

/**
 * Folds the proposals into one probe per `(kind in scope, constraint)`.
 *
 * Keyed on {@link uniquenessProbeKinds} rather than on the axis alone for the
 * reason that function documents: rows written before the axis move sit under
 * their own concrete kind, so a probe that read only the axis would not see them
 * and the move would need a data migration.
 */
function groupClaimsForProbe(
  claims: readonly ProposedClaim[],
): readonly ClaimProbeGroup[] {
  const groups = new Map<
    string,
    {
      probeKind: string;
      constraintName: string;
      claimsByKey: Map<string, ProposedClaim>;
    }
  >();
  for (const claim of claims) {
    for (const probeKind of claim.probeKinds) {
      const groupKey = encodeTupleKey([probeKind, claim.entry.constraintName]);
      const existing = groups.get(groupKey);
      if (existing === undefined) {
        groups.set(groupKey, {
          probeKind,
          constraintName: claim.entry.constraintName,
          claimsByKey: new Map([[claim.entry.key, claim]]),
        });
        continue;
      }
      existing.claimsByKey.set(claim.entry.key, claim);
    }
  }
  return [...groups.values()];
}

/** The batch probe this validation is defined in terms of, or a typed refusal. */
function requireBatchProbe(
  ctx: UniquenessContext,
): NonNullable<UniquenessContext["backend"]["checkUniqueBatch"]> {
  const checkUniqueBatch = ctx.backend.checkUniqueBatch;
  if (checkUniqueBatch === undefined) {
    throw new ConfigurationError(
      "Resolved node writes require batched uniqueness probes",
      { code: "RESOLVED_NODE_UNIQUENESS_UNSUPPORTED" },
    );
  }
  return checkUniqueBatch;
}

/**
 * Validates node uniqueness against the FINAL state of a resolved write set.
 *
 * All proposed after-images are compared together before persisted claim rows
 * are consulted. Owners the set itself releases or replaces are ignored, which
 * permits atomic swaps and handoffs while still refusing every owner outside the
 * set. The probe is batch-only by contract: a caller that needs this set
 * semantic must not quietly degrade to sequential checks.
 */
export async function validateResolvedNodeClaims(
  ctx: UniquenessContext,
  upserts: readonly ResolvedNodeUpsert[],
  releases: readonly ResolvedNodeRelease[] = [],
): Promise<void> {
  const checkUniqueBatch = requireBatchProbe(ctx);
  const claims = proposedClaims(ctx, upserts);
  if (claims.length === 0) return;

  const affectedOwners = new Set(
    [...upserts, ...releases].map((reference) =>
      claimOwnerKey({ concreteKind: reference.kind, nodeId: reference.id }),
    ),
  );
  for (const group of groupClaimsForProbe(claims)) {
    const existingRows = await checkUniqueBatch({
      graphId: ctx.graphId,
      nodeKind: group.probeKind,
      constraintName: group.constraintName,
      keys: [...group.claimsByKey.keys()],
    });
    for (const existing of existingRows) {
      if (
        affectedOwners.has(
          claimOwnerKey({
            concreteKind: existing.concrete_kind,
            nodeId: existing.node_id,
          }),
        )
      ) {
        continue;
      }
      const claim = group.claimsByKey.get(existing.key);
      if (claim === undefined) continue;
      throw new UniquenessError({
        constraintName: group.constraintName,
        // The holder's own kind, never `group.probeKind`: that is the claim
        // AXIS, which a shared scope folds across kinds and which the caller
        // never wrote. The probe and the fence report the same value.
        kind: existing.concrete_kind,
        existingId: existing.node_id,
        newId: claim.owner.nodeId,
        fields: claim.entry.refusal.constraint.fields,
      });
    }
  }
}

/**
 * Prepares a transaction to apply a resolved write set row by row.
 *
 * Validation happens before any mutation. Once it succeeds, every affected
 * node's claims are batch-cleared so the later per-node upserts can take the
 * validated final keys in any order (including swaps and handoffs).
 */
async function prepareResolvedNodeClaims(
  ctx: UniquenessContext,
  upserts: readonly ResolvedNodeUpsert[],
  releases: readonly ResolvedNodeRelease[],
): Promise<void> {
  const hardDeleteUniquesByNodeIds = ctx.backend.hardDeleteUniquesByNodeIds;
  if (
    ctx.backend.checkUniqueBatch === undefined ||
    ctx.backend.insertUniqueBatch === undefined ||
    hardDeleteUniquesByNodeIds === undefined
  ) {
    throw new ConfigurationError(
      "Resolved node writes require batched uniqueness operations",
      { code: "RESOLVED_NODE_UNIQUENESS_UNSUPPORTED" },
    );
  }
  await validateResolvedNodeClaims(ctx, upserts, releases);

  const idsByKind = new Map<string, Set<string>>();
  for (const reference of [...upserts, ...releases]) {
    const ids = idsByKind.get(reference.kind) ?? new Set<string>();
    ids.add(reference.id);
    idsByKind.set(reference.kind, ids);
  }
  for (const [concreteKind, nodeIds] of idsByKind) {
    await hardDeleteUniquesByNodeIds({
      graphId: ctx.graphId,
      concreteKind,
      nodeIds: [...nodeIds],
    });
  }
}

/**
 * Applies a resolved write set between the set preflight and one final claim
 * rebuild.
 *
 * The rebuild is required even though ordinary upserts take their own claims: an
 * unchanged upsert may be coalesced and skip all of its normal side effects
 * after preparation cleared its reservations. Re-taking every approved claim is
 * idempotent and makes the transition independent of whether individual writes
 * were coalesced.
 *
 * It goes through {@link withNodeCreateClaimsBatch} — the claim writer every
 * create-shaped write uses — and not through a uniqueness-only insert, for a
 * reason the preparation step makes load-bearing: `hardDeleteUniquesByNodeIds`
 * clears every claim the affected nodes OWN, and after WS2 that includes their
 * `disjointWith` reservations. A rebuild that restored only the uniqueness
 * family would leave each merged node unfenced against a disjoint namesake for
 * the rest of the graph's life. The claim writer restores what
 * {@link nodeClaimEntries} says the row owes, both families, so the set's claims
 * cannot fall out of step with an ordinary create's.
 *
 * `lock` is the caller's evidence that the per-graph write lock was taken before
 * any row work; this function performs no locking of its own.
 */
export async function applyResolvedNodeClaims<Output>(
  ctx: NodeClaimContext,
  backend: UniquenessContext["backend"],
  upserts: readonly ResolvedNodeUpsert[],
  releases: readonly ResolvedNodeRelease[],
  apply: () => Promise<Output>,
): Promise<Output> {
  const claimContext: UniquenessContext = {
    graphId: ctx.graphId,
    registry: ctx.registry,
    backend,
  };
  await prepareResolvedNodeClaims(claimContext, upserts, releases);
  const result = await apply();
  await withNodeCreateClaimsBatch(
    ctx,
    upserts.map((upsert) => ({
      kind: upsert.kind,
      id: upsert.id,
      props: { ...upsert.props },
      constraints: upsert.constraints,
    })),
    backend,
    alreadyAppliedRowWrite,
  );
  return result;
}
