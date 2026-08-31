/**
 * Node claims — what a node row reserves, and how each reservation moves.
 *
 * A declared constraint is a CLAIM on an axis (see {@link file://./axis.ts}):
 * the write reserves the row `(graph_id, axis, constraint_name, key)` and is
 * refused when that reservation comes back owned by somebody else. This module
 * decides which claims a row owes, probes them, writes them, releases them, and
 * sequences each of those against the primary row write it gates.
 *
 * Two families reserve in that one relation — a uniqueness constraint at its
 * scope's axis, and a `disjointWith` pair at the pair's axis with the node's id
 * as the key — so every path that already maintained uniqueness reservations
 * maintains disjointness reservations too, by reading one list rather than by
 * being edited twice.
 */
import { bindExtraIfReachable } from "../../backend/capabilities/bind";
import { UNIQUE_SIDECAR_BATCH } from "../../backend/capabilities/bundle-registry";
import {
  type BundleVerdictOf,
  type ClaimsVerdictThunk,
} from "../../backend/capabilities/resolve";
import {
  type GraphBackend,
  type InsertUniqueParams,
  type NodeInsertClaim,
  type TransactionBackend,
  type UniqueConstraintBackend,
  type UniqueRow,
} from "../../backend/types";
import { checkWherePredicate, computeUniqueKey } from "../../constraints";
import { type UniqueConstraint } from "../../core/types";
import {
  type ConfigurationError,
  DisjointError,
  UniquenessError,
} from "../../errors";
import { type KindRegistry } from "../../registry/kind-registry";
import { requireDefined } from "../../utils/presence";
import { encodeTupleKey } from "../../utils/tuple-key";
import { constraintFenceRefusal } from "../operations/write-transaction";
import { type GraphWriteLock } from "../recorded-capture/clock";
import {
  type ClaimOwner,
  type ClaimTarget,
  compareClaimTargets,
  isSameClaimOwner,
  uniquenessProbeKinds,
} from "./axis";
import { type ConstraintFenceReason } from "./backing";
import {
  type ClaimPlacement,
  type ClaimRefusal,
  type NodeClaimOperation,
  nodeClaimSites,
} from "./sites";

/**
 * Context for node claim operations.
 */
export type UniquenessContext = Readonly<{
  graphId: string;
  registry: KindRegistry;
  backend: GraphBackend | TransactionBackend;
  /** The threaded `uniqueSidecarBatch` verdict — never re-resolved here. */
  uniqueSidecarBatch: BundleVerdictOf<typeof UNIQUE_SIDECAR_BATCH>;
}>;

/**
 * Context for the claim PROBE, whose single backend member is the read.
 *
 * Stated separately because the probe runs on handles that cannot write: a
 * write frame's row work holds the read-only `WriteTarget`, and pre-checking a
 * key there is the whole point of the probe. Every {@link UniquenessContext}
 * satisfies this one, so a writer passes its own context unchanged.
 */
export type UniquenessProbeContext = Readonly<{
  graphId: string;
  registry: KindRegistry;
  backend: Pick<UniqueConstraintBackend, "checkUnique">;
}>;

/**
 * Builds a claim context — the one constructor every call site shares.
 *
 * Generic in the handle so it yields exactly what it was given: a full backend
 * produces a {@link UniquenessContext} that can also write the claim rows, and
 * a read-only projection produces a {@link UniquenessProbeContext}, which is
 * all the probe needs and all row work can offer.
 */
export function createUniquenessContext<
  T extends Pick<UniqueConstraintBackend, "checkUnique">,
>(
  graphId: string,
  registry: KindRegistry,
  backend: T,
  uniqueSidecarBatch: BundleVerdictOf<typeof UNIQUE_SIDECAR_BATCH>,
): Readonly<{
  graphId: string;
  registry: KindRegistry;
  backend: T;
  uniqueSidecarBatch: BundleVerdictOf<typeof UNIQUE_SIDECAR_BATCH>;
}> {
  return { graphId, registry, backend, uniqueSidecarBatch };
}

/** One claim a node row owes, decided but not written. */
export type NodeClaimEntry = Readonly<{
  /** `uniques.node_kind` — the axis the primary key fences on. */
  axis: string;
  /** `uniques.constraint_name`. */
  constraintName: string;
  /** `uniques.key`. */
  key: string;
  /**
   * WHEN this claim is issued relative to the row write it gates — carried
   * through from the entry's {@link NodeClaimSite}, which is the one owner of
   * the decision. The claim seam issues the two groups on either side of its
   * gated write, and {@link claimFenceRefusal} is keyed on the pre-insert group
   * alone.
   */
  placement: ClaimPlacement;
  /**
   * The class a refusal names when this claim cannot be rolled back — carried
   * through from the site, so no consumer re-derives it.
   */
  refusalReason: ConstraintFenceReason;
  /** Which typed error a foreign owner produces — carried through from the site. */
  refusal: ClaimRefusal;
}>;

/**
 * The key one site reserves for THIS row, or `undefined` when the site does not
 * apply to it.
 *
 * A uniqueness site applies when its `where` predicate holds, and its key is
 * the constraint's own composite key. A disjointness site always applies, and
 * its key is the node's ID — which is the axis `disjointWith` declares: "no two
 * live nodes of these two kinds share an id" is a reservation on the id, taken
 * at the pair.
 */
function claimKeyFor(
  refusal: ClaimRefusal,
  id: string,
  props: Record<string, unknown>,
): string | undefined {
  if (refusal.kind === "disjointness") return id;
  return checkWherePredicate(refusal.constraint, props) ?
      computeUniqueKey(
        props,
        refusal.constraint.fields,
        refusal.constraint.collation,
      )
    : undefined;
}

/**
 * THE single owner of "what claims does THIS ROW owe, and when is each due?":
 * the kind's claim sites ({@link nodeClaimSites}, the declaration-level extent
 * for this operation) filtered to the ones that apply to this row and completed
 * with each one's key. `placement`, `refusalReason` and `refusal` are carried
 * through unchanged; this function decides none of them.
 *
 * Every path that maintains a node's reservations — create, update diff,
 * resurrect, delete, batch, import — reads its work from this one list, so no
 * path can compute a key one way and an axis another, and no path that
 * remembers one family can forget the other.
 *
 * `operation` is threaded rather than assumed because the sites function needs
 * it twice: to place each claim (a transition claims before the row it gates for
 * every scope, while a create only does so for an axis spanning kinds beyond its
 * own) and to decide the disjointness arm, which only a write bringing a node
 * into existence under a kind owes — `"create"` and `"resurrect"` alike, never
 * `"update"`.
 */
export function nodeClaimEntries(
  registry: KindRegistry,
  kind: string,
  id: string,
  props: Record<string, unknown>,
  constraints: readonly UniqueConstraint[],
  operation: NodeClaimOperation,
): readonly NodeClaimEntry[] {
  return nodeClaimSites(registry, kind, constraints, operation).flatMap(
    (site) => {
      const key = claimKeyFor(site.refusal, id, props);
      return key === undefined ?
          []
        : [
            {
              axis: site.axis,
              constraintName: site.constraintName,
              key,
              placement: site.placement,
              refusalReason: site.refusalReason,
              refusal: site.refusal,
            },
          ];
    },
  );
}

/** An entry whose family is disjointness — the one family that needs mapping. */
type DisjointnessClaimEntry = NodeClaimEntry &
  Readonly<{ refusal: Extract<ClaimRefusal, { kind: "disjointness" }> }>;

/**
 * THE one place a backend claim refusal becomes the refusal its FAMILY
 * declares.
 *
 * Both families reserve in the `uniques` relation, and `insertUnique` /
 * `insertUniqueBatch` report every foreign owner the same way — as a
 * `UniquenessError` naming the constraint, the holder's concrete kind and the
 * two ids. That contract is deliberately unchanged (a third-party backend
 * implementing it keeps working), so the translation happens here, once, where
 * the entries that produced the claim are still in hand.
 *
 * The reserved `constraintName` alone locates the FAMILY (any entry it matches
 * is a disjointness entry, never a declared constraint's — `assertClaimAxisSafe`
 * makes the name unspellable by one), but not the PAIR: every `disjointWith`
 * pair shares that one literal, so a batch carrying disjointness entries for
 * two different pairs that happen to claim the same id (`Person "X"` disjoint
 * with `Company`, `Vehicle "X"` disjoint with `Boat`, same batch) would match
 * either indiscriminately on `(constraintName, key)` alone. The entry is
 * additionally required to have written the SAME claim axis the backend
 * reports — the row's actual primary key, and therefore unambiguous — so the
 * one located is provably the one that lost. `error.details.axis` is optional
 * (a third-party backend need not carry it to keep working); when a backend
 * omits it the match falls back to `(constraintName, key)` alone, which is
 * HEAD's behavior and no worse than today's. The payload is built from what
 * the BACKEND reported — the holder's own concrete kind — so the fence's error
 * is identical to the probe's, which is what makes a caller unable to tell
 * which layer refused.
 */
function mapClaimRefusal(
  error: UniquenessError,
  entries: readonly NodeClaimEntry[],
  verdicts: readonly NodeCreateClaimVerdict[] = [],
): never {
  const verdict = verdicts.find(
    (candidate) =>
      candidate.claim.constraintName === error.details.constraintName &&
      (candidate.refusal.kind === "uniqueness" ||
        candidate.claim.key === error.details.newId) &&
      (error.details.axis === undefined ||
        candidate.claim.axis === error.details.axis ||
        (candidate.claim.verdict.kind === "uniqueness" &&
          candidate.claim.verdict.probeAxes.includes(error.details.axis))),
  );
  const uniquenessVerdict =
    verdict !== undefined && isNodeCreateUniquenessVerdict(verdict) ?
      verdict
    : undefined;
  if (uniquenessVerdict !== undefined && error.details.fields.length === 0) {
    throw new UniquenessError(
      {
        ...error.details,
        fields: uniquenessVerdict.refusal.constraint.fields,
      },
      { cause: error },
    );
  }
  const owed = entries.find(
    (entry): entry is DisjointnessClaimEntry =>
      entry.refusal.kind === "disjointness" &&
      entry.constraintName === error.details.constraintName &&
      entry.key === error.details.newId &&
      (error.details.axis === undefined || entry.axis === error.details.axis),
  );
  if (owed === undefined) throw error;
  throw new DisjointError(
    {
      nodeId: error.details.newId,
      attemptedKind: owed.refusal.ownKind,
      conflictingKind: error.details.kind,
    },
    { cause: error },
  );
}

/** Re-raises a planned claim failure through the claim family's typed error. */
export function refuseNodeCreateClaimError(
  error: unknown,
  plan: NodeCreateClaimPlan,
): never {
  if (error instanceof UniquenessError) {
    mapClaimRefusal(error, plan.entries, plan.verdicts);
  }
  throw error;
}

/**
 * Runs a claim statement, re-raising a foreign owner as the declared refusal of
 * whichever family owed the claim.
 *
 * One wrapper around every claim write, rather than a translation at each of
 * them: a claim statement that skipped it would report a `disjointWith`
 * violation as a uniqueness violation on a constraint name no caller ever
 * declared. Both the CREATE seam's `withNodeCreateClaimsIssuedBy` and the
 * transition seam's {@link claimUniqueKeysThen} reuse it — a resurrect's plan
 * can carry a disjointness entry exactly as a create's claim list does (see
 * {@link planNodeClaimReinsert}), so the transition seam needs the same
 * translation the create seam always did. For a plan whose claims are all
 * uniqueness (an in-place update's diff), `mapClaimRefusal` finds no
 * disjointness entry to remap and rethrows the original `UniquenessError`
 * unchanged, so this is a no-op there.
 */
async function issuingClaims(
  entries: readonly NodeClaimEntry[],
  issue: () => Promise<void>,
): Promise<void> {
  try {
    await issue();
  } catch (error) {
    if (error instanceof UniquenessError) mapClaimRefusal(error, entries);
    throw error;
  }
}

/**
 * THE refusal for "this write owes a claim it must issue BEFORE the row that
 * claim gates, and this backend cannot roll that pair back together".
 *
 * A claim row that outlives the write it was taken for is invisible to every
 * read path and blocks its key forever, with no repair path: `deleteUnique` is
 * reached only by a node whose row exists. So a write that would open that
 * window on a backend with no transactions is refused, exactly as a write whose
 * fence is the per-graph lock has been since the lock became the fence. A
 * claim that follows its row opens no such window — a leaked ENTITY row is
 * visible, deletable, and is what that backend already does today — which is
 * why the subject is the pre-insert group and not the claim set.
 *
 * Takes the ENTRIES this write is about to issue rather than the kind's sites:
 * a row whose `where` predicates all fail writes no claim and must not be
 * refused. For a batch, any member's non-empty pre-insert group makes the batch
 * constrained — the same "any member" shape the batch lock probe uses.
 *
 * Delegates the error itself to {@link constraintFenceRefusal}, so there is one
 * refusal body, one code and one advice map.
 */
function claimFenceRefusal(
  ctx: Readonly<{ graphId: string }>,
  backend: GraphBackend | TransactionBackend,
  entries: readonly NodeClaimEntry[],
): ConfigurationError | undefined {
  const gating = entries.find((entry) => entry.placement === "pre-insert");
  if (gating === undefined) return undefined;
  return constraintFenceRefusal(ctx, backend, gating.refusalReason);
}

/** An entry whose family is uniqueness — the only family a claim probe reads. */
export type UniquenessClaimEntry = NodeClaimEntry &
  Readonly<{ refusal: Extract<ClaimRefusal, { kind: "uniqueness" }> }>;

/**
 * THE narrowing to the uniqueness family, for every path that probes claim rows.
 *
 * Disjointness entries have their own probe (`checkDisjointnessConstraint`,
 * which reads the NODE rows the constraint is declared over) and deliberately
 * do not get a second one here: a claim-row read would be a second spelling of
 * that verdict, and the two would drift.
 *
 * Exported because it is also what "an ingestion branch defers node UNIQUENESS
 * and nothing else" means, operationally: the clone's registrations produce
 * claim entries and this predicate is false for every one of them, while the
 * disjointness entries the same list carries are unaffected (see
 * {@link file://../../graph-merge/working-copy.ts graphWithoutNodeUniqueness}).
 */
export function isUniquenessClaimEntry(
  entry: NodeClaimEntry,
): entry is UniquenessClaimEntry {
  return entry.refusal.kind === "uniqueness";
}

/** One set-oriented uniqueness read shared by every batch probe consumer. */
export type NodeUniquenessProbeGroup = Readonly<{
  nodeKind: string;
  constraintName: string;
  keys: readonly string[];
}>;

/**
 * THE owner of grouping node uniqueness entries into backend batch reads.
 *
 * Preparation-cache priming and post-rollback diagnosis consume the same
 * groups, including every canonical and legacy axis covered by a scoped claim.
 * Keeping the grouping here prevents one path from silently probing a narrower
 * hierarchy than the other.
 */
export function groupNodeUniquenessProbes(
  registry: KindRegistry,
  items: readonly Readonly<{
    kind: string;
    entries: readonly NodeClaimEntry[];
  }>[],
): readonly NodeUniquenessProbeGroup[] {
  type MutableProbeGroup = Readonly<{
    nodeKind: string;
    constraintName: string;
    keys: Set<string>;
  }>;
  const groups = new Map<string, MutableProbeGroup>();
  for (const item of items) {
    for (const entry of item.entries) {
      if (!isUniquenessClaimEntry(entry)) continue;
      for (const nodeKind of uniquenessProbeKinds(
        item.kind,
        entry.refusal.constraint.scope,
        registry,
      )) {
        const identity = encodeTupleKey([nodeKind, entry.constraintName]);
        const group = groups.get(identity) ?? {
          nodeKind,
          constraintName: entry.constraintName,
          keys: new Set<string>(),
        };
        group.keys.add(entry.key);
        groups.set(identity, group);
      }
    }
  }
  return [...groups.values()].map((group) => ({
    nodeKind: group.nodeKind,
    constraintName: group.constraintName,
    keys: [...group.keys],
  }));
}

/**
 * Probes ONE entry's key across every kind its scope covers, the axis first.
 *
 * THE SINGLE OWNER of "is this key available to this node?" — the conflict
 * verdict and the ownership reading are one read, so no caller can consult one
 * without the other. {@link checkUniquenessConstraints} is this probe run for
 * its refusal alone; the plan builders below additionally keep what it read.
 *
 * Ownership is the pair `(concrete_kind, node_id)`, never the id alone: ids are
 * unique only per kind, so a namesake under another kind holds a DIFFERENT
 * node's reservation and must be refused — which is exactly what a scope
 * spanning kinds exists to catch. The refusal reports the holder's concrete
 * kind rather than the axis it was found at, because the axis need not be that
 * node's kind and, after this move, usually is not.
 *
 * @returns whether THIS node already holds the key live AT THE AXIS it is about
 *   to claim, in which case a claim would be a no-op and a compensating release
 *   would strip a reservation the node is entitled to. A row this node owns at
 *   a LEGACY axis deliberately does not suppress the claim: the axis row is a
 *   genuinely new reservation whose compensation must run.
 * @throws UniquenessError when a DIFFERENT node holds the key under any kind in
 *   scope.
 */
export async function probeUniqueKey(
  ctx: UniquenessProbeContext,
  kind: string,
  id: string,
  entry: UniquenessClaimEntry,
  lookup: (
    nodeKind: string,
    entry: UniquenessClaimEntry,
  ) => UniqueRow | undefined | Promise<UniqueRow | undefined> = async (
    nodeKind,
    claimEntry,
  ) =>
    ctx.backend.checkUnique({
      graphId: ctx.graphId,
      nodeKind,
      constraintName: claimEntry.constraintName,
      key: claimEntry.key,
    }),
): Promise<boolean> {
  // `let` earns its place: the loop must visit EVERY kind in scope to reach its
  // refusal, so the ownership reading cannot be an early return.
  let heldByThisNode = false;
  for (const kindToCheck of uniquenessProbeKinds(
    kind,
    entry.refusal.constraint.scope,
    ctx.registry,
  )) {
    const existing = await lookup(kindToCheck, entry);

    if (existing === undefined) continue;
    const refusal = uniquenessClaimRefusal(kind, id, entry, existing);
    if (refusal !== undefined) throw refusal;
    if (kindToCheck === entry.axis) heldByThisNode = true;
  }
  return heldByThisNode;
}

/**
 * THE owner of the conflict verdict for one uniqueness probe result.
 *
 * The scalar probe and post-rollback batch diagnosis both call this function,
 * so owner-pair equality and the public error payload cannot drift between the
 * portable preflight and the native program's exceptional diagnostic path.
 */
function uniquenessClaimRefusal(
  kind: string,
  id: string,
  entry: UniquenessClaimEntry,
  existing: UniqueRow,
): UniquenessError | undefined {
  const proposedOwner: ClaimOwner = { concreteKind: kind, nodeId: id };
  if (
    isSameClaimOwner(
      { concreteKind: existing.concrete_kind, nodeId: existing.node_id },
      proposedOwner,
    )
  ) {
    return;
  }
  return new UniquenessError({
    constraintName: entry.constraintName,
    kind: existing.concrete_kind,
    existingId: existing.node_id,
    newId: id,
    fields: entry.refusal.constraint.fields,
  });
}

/**
 * Checks uniqueness constraints for a new or existing node.
 *
 * @throws ValidationError if any constraint is violated
 */
export async function checkUniquenessConstraints(
  ctx: UniquenessProbeContext,
  kind: string,
  id: string,
  props: Record<string, unknown>,
  constraints: readonly UniqueConstraint[],
): Promise<void> {
  // The create extent, which is the wider of the two: a probe wants every claim
  // this row could owe, and placement — the only thing the operation decides
  // for a uniqueness site — says nothing about what is read. The disjointness
  // entries the create extent also carries belong to the other probe, which
  // reads node rows rather than claim rows.
  for (const entry of nodeClaimEntries(
    ctx.registry,
    kind,
    id,
    props,
    constraints,
    "create",
  )) {
    if (isUniquenessClaimEntry(entry))
      await probeUniqueKey(ctx, kind, id, entry);
  }
}

/**
 * What the create claim seam needs from its caller.
 *
 * `lock` is compile-time evidence that the per-graph write-lock discipline was
 * satisfied BEFORE any row work (see {@link GraphWriteLock}); the seam performs
 * no locking of its own, so requiring the token here makes "claim before lock"
 * a type error at the call site instead of a lock-order inversion in review.
 *
 * `claimsVerdict` is the `claims` bundle's memoized, at-most-once verdict
 * thunk (ruling B7 refinement 2). This module's own uniqueness/disjointness
 * claims never read it — they are a different fence family, backed by the
 * `uniques` relation — but `node-write-pipeline.ts`'s hard-delete cascade
 * shares this same context and calls `purgeEdgeClaims` (the `claims` bundle's
 * edge-cardinality housekeeping) off it, so the field lives here rather than
 * on a second, parallel context only that one caller would build.
 */
export type NodeClaimContext = Readonly<{
  graphId: string;
  registry: KindRegistry;
  lock: GraphWriteLock;
  claimsVerdict: ClaimsVerdictThunk;
  /** Threaded `uniqueSidecarBatch` verdict — never re-resolved here. */
  uniqueSidecarBatch: BundleVerdictOf<typeof UNIQUE_SIDECAR_BATCH>;
}>;

/** One row whose claims a create-shaped write is about to issue. */
export type NodeClaimItem = Readonly<{
  kind: string;
  id: string;
  props: Record<string, unknown>;
  constraints: readonly UniqueConstraint[];
}>;

/**
 * The ownership verdict metadata a planned claim would have produced if the
 * store had read the claim relation first.
 *
 * The authoritative insert uses the claim row's primary key instead of these
 * probe coordinates, but carrying the coordinates with the plan keeps the
 * typed refusal complete: uniqueness errors regain their declared fields, and
 * disjoint errors retain the exact partner kind that made the claim apply.
 */
type NodeCreateClaimVerdict =
  | Readonly<{
      claim: NodeInsertClaim;
      probeKinds: readonly string[];
      disjointOtherKind: undefined;
      refusal: Extract<ClaimRefusal, { kind: "uniqueness" }>;
    }>
  | Readonly<{
      claim: NodeInsertClaim;
      probeKinds: readonly string[];
      disjointOtherKind: string;
      refusal: Extract<ClaimRefusal, { kind: "disjointness" }>;
    }>;

function isNodeCreateUniquenessVerdict(
  verdict: NodeCreateClaimVerdict,
): verdict is Extract<
  NodeCreateClaimVerdict,
  { refusal: { kind: "uniqueness" } }
> {
  return verdict.refusal.kind === "uniqueness";
}

/** One row's claim, with the owner it will be written under. */
type PlacedClaim = Readonly<{
  item: NodeClaimItem;
  entry: NodeClaimEntry;
  target: ClaimTarget;
}>;

/** The complete, canonically ordered claim portion of one node insert plan. */
export type NodeCreateClaimPlan = Readonly<{
  entries: readonly NodeClaimEntry[];
  claims: readonly NodeInsertClaim[];
  verdicts: readonly NodeCreateClaimVerdict[];
}>;

/**
 * How one placement group.s statements are issued.
 *
 * `onIssued` reports which claims actually landed, and it is optional because
 * only the pre-insert group has a use for the answer: that group is compensated
 * when its gated write fails, while a post-insert claim belongs to a row that is
 * already written and has nothing to undo.
 */
type ClaimIssuer = (
  ctx: UniquenessContext,
  claims: readonly PlacedClaim[],
  onIssued?: (issued: readonly PlacedClaim[]) => void,
) => Promise<void>;

function claimTarget(graphId: string, entry: NodeClaimEntry): ClaimTarget {
  return {
    relation: "uniques",
    graphId,
    axis: entry.axis,
    constraintName: entry.constraintName,
    key: entry.key,
  };
}

function claimInsertParams(
  graphId: string,
  claim: PlacedClaim,
): InsertUniqueParams {
  return {
    graphId,
    nodeKind: claim.entry.axis,
    constraintName: claim.entry.constraintName,
    key: claim.entry.key,
    nodeId: claim.item.id,
    concreteKind: claim.item.kind,
  };
}

function placedNodeCreateClaims(
  ctx: Pick<NodeClaimContext, "graphId" | "registry">,
  items: readonly NodeClaimItem[],
): readonly PlacedClaim[] {
  return items.flatMap((item) =>
    nodeClaimEntries(
      ctx.registry,
      item.kind,
      item.id,
      item.props,
      item.constraints,
      "create",
    ).map((entry) => ({
      item,
      entry,
      target: claimTarget(ctx.graphId, entry),
    })),
  );
}

/**
 * Resolves one create's claims once for either the atomic plan or fallback
 * seam. The returned list preserves the claim-site placement decision and the
 * same canonical target order standalone claim statements use.
 */
export function planNodeCreateClaims(
  ctx: Pick<NodeClaimContext, "graphId" | "registry">,
  item: NodeClaimItem,
): NodeCreateClaimPlan {
  const placed = placedNodeCreateClaims(ctx, [item]).toSorted((left, right) => {
    if (left.entry.placement !== right.entry.placement) {
      return left.entry.placement === "pre-insert" ? -1 : 1;
    }
    return compareClaimTargets(left.target, right.target);
  });
  const verdicts = placed.map((claim) => {
    const baseClaim = {
      axis: claim.entry.axis,
      constraintName: claim.entry.constraintName,
      key: claim.entry.key,
      placement: claim.entry.placement,
    };
    if (claim.entry.refusal.kind === "uniqueness") {
      const probeKinds = uniquenessProbeKinds(
        claim.item.kind,
        claim.entry.refusal.constraint.scope,
        ctx.registry,
      );
      return {
        claim: {
          ...baseClaim,
          verdict: {
            kind: "uniqueness" as const,
            probeAxes: probeKinds,
            fields: claim.entry.refusal.constraint.fields,
          },
        } satisfies NodeInsertClaim,
        probeKinds,
        disjointOtherKind: undefined,
        refusal: claim.entry.refusal,
      } satisfies NodeCreateClaimVerdict;
    }
    return {
      claim: {
        ...baseClaim,
        verdict: {
          kind: "disjointness" as const,
          conflictingKinds: [claim.entry.refusal.otherKind],
        },
      } satisfies NodeInsertClaim,
      probeKinds: [],
      disjointOtherKind: claim.entry.refusal.otherKind,
      refusal: claim.entry.refusal,
    } satisfies NodeCreateClaimVerdict;
  });
  return {
    entries: placed.map((claim) => claim.entry),
    claims: verdicts.map((verdict) => verdict.claim),
    verdicts,
  };
}

/** One statement per claim — the shape the single-row create path ships. */
async function issueClaimsIndividually(
  ctx: UniquenessContext,
  claims: readonly PlacedClaim[],
  onIssued?: (issued: readonly PlacedClaim[]) => void,
): Promise<void> {
  for (const claim of claims) {
    await issuingClaims([claim.entry], () =>
      ctx.backend.insertUnique(claimInsertParams(ctx.graphId, claim)),
    );
    onIssued?.([claim]);
  }
}

/**
 * ONE statement for the whole group, which is also what makes it deadlock-free
 * against itself: a single multi-row statement takes its row locks in a fixed
 * order. Falls back to the per-claim shape on a backend with no batch
 * primitive.
 */
async function issueClaimsBatched(
  ctx: UniquenessContext,
  claims: readonly PlacedClaim[],
  onIssued?: (issued: readonly PlacedClaim[]) => void,
): Promise<void> {
  if (claims.length === 0) return;
  const bound = bindExtraIfReachable(
    ctx.backend,
    ctx.uniqueSidecarBatch.extras.insertUniqueBatch,
    UNIQUE_SIDECAR_BATCH.id,
  );
  if (bound === undefined) {
    await issueClaimsIndividually(ctx, claims, onIssued);
    return;
  }
  await issuingClaims(
    claims.map((claim) => claim.entry),
    async () => {
      await bound.insertUniqueBatch(
        claims.map((claim) => claimInsertParams(ctx.graphId, claim)),
      );
    },
  );
  onIssued?.(claims);
}

/**
 * Reserves the gating group, runs the row write it gates, and gives those
 * reservations back if the write does not land.
 *
 * Compensate, not swallow — the same give-back {@link withNodeClaimTransition}
 * makes, for the same reason: the reservations this write took are returned and
 * the original failure is rethrown, so the caller sees the error it would have
 * seen with no reservation attempted at all. Only rows that actually landed are
 * given back, and each is named in full (owner pair and claim axis), so nothing
 * a namesake under another kind or an older axis holds is touched.
 */
async function claimGroupThenWrite<T>(
  ctx: UniquenessContext,
  issue: ClaimIssuer,
  gating: readonly PlacedClaim[],
  gatedWrite: () => Promise<T>,
): Promise<T> {
  const issued: PlacedClaim[] = [];
  try {
    await issue(ctx, gating, (landed) => {
      issued.push(...landed);
    });
    return await gatedWrite();
  } catch (error) {
    for (const claim of issued.toReversed()) {
      await releaseClaimedUniqueKeys(ctx, claim.item.kind, claim.item.id, [
        {
          axis: claim.entry.axis,
          constraintName: claim.entry.constraintName,
          key: claim.entry.key,
        },
      ]);
    }
    throw error;
  }
}

/**
 * Issues a create's claims on the two sides of the row write they gate, and
 * compensates the PRE-INSERT ones away if that write does not land.
 *
 * The entries are partitioned by their {@link ClaimPlacement} and the two
 * groups are issued around `gatedInsert`:
 *
 *  1. the `pre-insert` group — the create path's twin of
 *     {@link withNodeClaimTransition}, with the same claim → gated write →
 *     compensate sequence and the same reasoning: the claim is the only fence
 *     for that axis, and a fence issued after the write it fences is not a
 *     fence. A refusal here therefore happens with zero rows written, and a
 *     refusal from the write compensates the reservations away;
 *  2. `gatedInsert()`;
 *  3. the `post-insert` group — the position those entries ship in, unchanged,
 *     and with that position's failure behavior: a throw propagates and nothing
 *     compensates it, because the row it belongs to is already written and
 *     visible.
 *
 * Each group is sorted by {@link compareClaimTargets} and the pre-insert group
 * is always issued first, so every writer of a given row computes the same
 * acquisition order. A row owing claims in both groups therefore emits two
 * claim statements where one placement alone emits one.
 */
async function withNodeCreateClaimsIssuedBy<T>(
  ctx: NodeClaimContext,
  items: readonly NodeClaimItem[],
  backend: GraphBackend | TransactionBackend,
  issue: ClaimIssuer,
  gatedInsert: () => Promise<T>,
): Promise<T> {
  const claimContext = createUniquenessContext(
    ctx.graphId,
    ctx.registry,
    backend,
    ctx.uniqueSidecarBatch,
  );
  const claims = placedNodeCreateClaims(ctx, items);

  const refusal = claimFenceRefusal(
    ctx,
    backend,
    claims.map((claim) => claim.entry),
  );
  if (refusal !== undefined) throw refusal;

  const inPlacement = (placement: ClaimPlacement): readonly PlacedClaim[] =>
    claims
      .filter((claim) => claim.entry.placement === placement)
      .toSorted((left, right) =>
        compareClaimTargets(left.target, right.target),
      );

  const result = await claimGroupThenWrite(
    claimContext,
    issue,
    inPlacement("pre-insert"),
    gatedInsert,
  );
  await issue(claimContext, inPlacement("post-insert"));
  return result;
}

/**
 * The create claim seam for ONE row: one statement per claim, matching the
 * statement shape the single-row create path ships.
 */
export function withNodeCreateClaims<T>(
  ctx: NodeClaimContext,
  item: NodeClaimItem,
  backend: GraphBackend | TransactionBackend,
  gatedInsert: () => Promise<T>,
): Promise<T> {
  return withNodeCreateClaimsIssuedBy(
    ctx,
    [item],
    backend,
    issueClaimsIndividually,
    gatedInsert,
  );
}

/**
 * The create claim seam for a BATCH: one statement per placement group across
 * every row, instead of the per-row statement fan.
 */
export function withNodeCreateClaimsBatch<T>(
  ctx: NodeClaimContext,
  items: readonly NodeClaimItem[],
  backend: GraphBackend | TransactionBackend,
  gatedInsert: () => Promise<T>,
): Promise<T> {
  return withNodeCreateClaimsIssuedBy(
    ctx,
    items,
    backend,
    issueClaimsBatched,
    gatedInsert,
  );
}

/**
 * The gate for a claim set whose row write has ALREADY been applied — a
 * re-claim after a set update, or a test seeding a reservation.
 *
 * Such a write reaches the seam with nothing left to gate, which is exactly why
 * it owes no pre-insert claim: there is no row write left for a claim to
 * precede. Naming it makes that reading explicit at the call site instead of
 * leaving an inline no-op for a reader to interpret.
 */
export function alreadyAppliedRowWrite(): Promise<undefined> {
  return Promise.resolve(undefined);
}

/**
 * Releases the claims a node being deleted holds — the LIFECYCLE shape: every
 * claim this node owns for each applying constraint's key, at whatever axis the
 * claim sits on.
 */
export async function deleteUniquenessEntries(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  props: Record<string, unknown>,
  constraints: readonly UniqueConstraint[],
): Promise<void> {
  // The create extent: a delete gives back everything a create wrote, so the
  // release must be read from the wider of the two lists.
  await releaseOwnedUniqueKeys(
    ctx,
    kind,
    id,
    nodeClaimEntries(ctx.registry, kind, id, props, constraints, "create"),
  );
}

/**
 * Drops EVERY claim a set of nodes holds under one concrete kind, key-blind, so
 * the rebuild that follows can re-claim from the after-images.
 *
 * The key-blind drop is what a set update needs and the per-key
 * {@link deleteUniquenessEntries} cannot give it: the statement rewrote whole
 * rows without reading their before-images, so nobody knows which keys those
 * rows used to hold. It drops BOTH families — every claim the owner pair holds —
 * which is why the rebuild must go back through {@link withNodeCreateClaimsBatch}
 * rather than a uniqueness-only reinsert.
 *
 * Requiring the member rather than probing it: the only caller
 * ({@link file://../operations/node-write-pipeline.ts applyNodeSetUpdate})
 * refuses the write up front when a constrained kind's backend lacks it, with a
 * code that names the operation. A second fallback here would be a quieter
 * answer to a question already asked.
 */
export async function hardDeleteClaimsByNodeIds(
  ctx: UniquenessContext,
  concreteKind: string,
  nodeIds: readonly string[],
): Promise<void> {
  await requireDefined(
    bindExtraIfReachable(
      ctx.backend,
      ctx.uniqueSidecarBatch.extras.hardDeleteUniquesByNodeIds,
      UNIQUE_SIDECAR_BATCH.id,
    )?.hardDeleteUniquesByNodeIds,
  )({
    graphId: ctx.graphId,
    concreteKind,
    nodeIds,
  });
}

/**
 * A single constraint's sidecar transition, decided by a plan builder and
 * carried out by {@link withNodeClaimTransition}.
 *
 * The two keys move at DIFFERENT times relative to the primary row write, so
 * they are named for when they move rather than for old/new:
 * `claim` is reserved BEFORE the write (it is the write's conflict gate),
 * `release` is given up AFTER it (it is history the write supersedes).
 */
type PendingUniqueMutation = Readonly<{
  constraintName: string;
  /** The key to give up once the primary write lands; undefined = none. */
  release: string | undefined;
  /**
   * The entry to reserve before the primary write; undefined = none, either
   * because the constraint stopped applying or because {@link probeUniqueKey}
   * found this node already holding it live. It is the whole entry rather than
   * a bare key so the compensation names the row this transition wrote instead
   * of re-deriving which axis that was, and so the refusal reads the placement
   * and class the entry's site decided.
   */
  claim: NodeClaimEntry | undefined;
}>;

/**
 * The sidecar transition a node write owes, decided but not yet performed.
 *
 * Opaque to its holder on purpose: the only thing a caller does with a plan is
 * hand it to {@link withNodeClaimTransition} together with the primary row
 * write it belongs to.
 */
export type UniquenessUpdatePlan = readonly PendingUniqueMutation[];

/**
 * Decides the claim changes a node's new props require, WITHOUT writing any of
 * them.
 *
 * Preflights EVERY changed constraint before anything is written. A node can
 * carry several unique constraints; probing them one at a time as they are
 * applied would let a later constraint's conflict throw after earlier sidecars
 * already moved. Probing all of them first means a refusal here happens with
 * zero writes, and the probes are independent per `constraintName`, so one
 * constraint's verdict is unaffected by the others' still-unapplied changes.
 *
 * Handles the cases where a constraint starts applying, stops applying, or
 * keeps applying under a different key.
 *
 * @throws UniquenessError if an updated value is already held by another node
 */
export async function planNodeClaimUpdate(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  oldProps: Record<string, unknown>,
  newProps: Record<string, unknown>,
  constraints: readonly UniqueConstraint[],
): Promise<UniquenessUpdatePlan> {
  // Both sides of the diff are read from the one entries function, so the key
  // a release names is computed exactly the way the key a claim names is.
  const oldKeys = new Map(
    nodeClaimEntries(
      ctx.registry,
      kind,
      id,
      oldProps,
      constraints,
      "update",
    ).map((entry) => [entry.constraintName, entry.key]),
  );
  const newEntries = new Map(
    nodeClaimEntries(ctx.registry, kind, id, newProps, constraints, "update")
      .filter((entry): entry is UniquenessClaimEntry =>
        isUniquenessClaimEntry(entry),
      )
      .map((entry) => [entry.constraintName, entry]),
  );

  const pending: PendingUniqueMutation[] = [];
  for (const constraint of constraints) {
    const oldKey = oldKeys.get(constraint.name);
    const newEntry = newEntries.get(constraint.name);

    // No change - constraint didn't apply and still doesn't
    if (oldKey === undefined && newEntry === undefined) continue;

    // Key is the same and the constraint still applies - nothing to do
    if (oldKey !== undefined && oldKey === newEntry?.key) continue;

    // Probe the new key: refuse a value another node holds, and note a value
    // this node somehow holds already so the transition neither re-claims nor
    // releases it.
    const alreadyHeld =
      newEntry === undefined ? false : (
        await probeUniqueKey(ctx, kind, id, newEntry)
      );

    pending.push({
      constraintName: constraint.name,
      release: oldKey,
      claim: newEntry === undefined || alreadyHeld ? undefined : newEntry,
    });
  }

  return pending;
}

/**
 * The plan a RESURRECTING write needs: every applying constraint re-reserved
 * from scratch, uniqueness AND disjointness alike.
 *
 * A tombstoned node holds no live reservations — {@link deleteUniquenessEntries}
 * released them at soft-delete time, reading the wider `"create"` extent that
 * already covers both families — so the diff-based {@link planNodeClaimUpdate}
 * cannot be used here: it would skip an unchanged key and leave the revived
 * node holding NO reservation, letting a later create (of this node's own key,
 * or of a disjoint partner under this node's id) silently duplicate the value.
 *
 * Reads its entries at `"resurrect"`, the {@link NodeClaimOperation} that owes
 * the same disjointness sites a create owes (see `nodeClaimSites`) — a
 * resurrect brings a node back into existence under its kind exactly as a
 * create does, so it owes the same cross-kind claim. A disjointness entry can
 * never already be held by THIS node (its own reservation was released at
 * soft-delete time, and nothing else could have taken it under this node's
 * OWN id/kind pair), so unlike a uniqueness entry it needs no "already held by
 * myself" probe — it is claimed fresh, exactly as a create claims it fresh.
 *
 * @throws UniquenessError if a key this node held was taken while it was
 *   tombstoned
 * @throws DisjointError if a disjoint partner now holds this id (translated by
 *   {@link claimUniqueKeysThen} from the `UniquenessError` `insertUnique`
 *   itself reports)
 */
export async function planNodeClaimReinsert(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  props: Record<string, unknown>,
  constraints: readonly UniqueConstraint[],
): Promise<UniquenessUpdatePlan> {
  const pending: PendingUniqueMutation[] = [];
  for (const entry of nodeClaimEntries(
    ctx.registry,
    kind,
    id,
    props,
    constraints,
    "resurrect",
  )) {
    const alreadyHeld =
      isUniquenessClaimEntry(entry) ?
        await probeUniqueKey(ctx, kind, id, entry)
      : false;

    pending.push({
      constraintName: entry.constraintName,
      release: undefined,
      claim: alreadyHeld ? undefined : entry,
    });
  }
  return pending;
}

/** One reservation a release names. */
type ReleasableKey = Readonly<{ constraintName: string; key: string }>;

/**
 * A reservation a write actually took, remembered together with the claim axis
 * it was written at so the compensation can name the same row rather than
 * re-deriving it.
 */
type ClaimedKey = ReleasableKey & Readonly<{ axis: string }>;

/**
 * LIFECYCLE release: gives up every reservation THIS node holds for each
 * `(constraintName, key)`, in plan order, whatever axis the reservation sits
 * on.
 *
 * Scoping to the owner pair `(concreteKind, id)` rather than to the axis is
 * what lets a claim written under an older axis be released by newer code, and
 * what keeps a namesake — same id, different kind — holding its own.
 */
async function releaseOwnedUniqueKeys(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  keys: readonly ReleasableKey[],
): Promise<void> {
  for (const entry of keys) {
    await ctx.backend.deleteUnique({
      graphId: ctx.graphId,
      constraintName: entry.constraintName,
      key: entry.key,
      concreteKind: kind,
      nodeId: id,
    });
  }
}

/**
 * COMPENSATING release: undoes exactly the rows a failed write just claimed —
 * the owner's reservation AT the axis it claimed on, and nothing else.
 *
 * Deliberately narrower than {@link releaseOwnedUniqueKeys}: a rollback must
 * touch neither a reservation at another axis that predates this write nor one
 * another node holds. Conflating the two would make a refused write strip
 * claims it never took.
 */
async function releaseClaimedUniqueKeys(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  keys: readonly ClaimedKey[],
): Promise<void> {
  for (const entry of keys) {
    await ctx.backend.deleteUnique({
      graphId: ctx.graphId,
      nodeKind: entry.axis,
      constraintName: entry.constraintName,
      key: entry.key,
      concreteKind: kind,
      nodeId: id,
    });
  }
}

/**
 * Reserves the plan's new keys, runs the primary row write they gate, and undoes
 * the reservations if that write does not land.
 *
 * Each claim statement runs through {@link issuingClaims} — a resurrect's plan
 * can carry a disjointness entry ({@link planNodeClaimReinsert}), and a foreign
 * owner of THAT reservation must surface as `DisjointError`, not the raw
 * `UniquenessError` `insertUnique` reports for every family alike.
 */
async function claimUniqueKeysThen<T>(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  plan: UniquenessUpdatePlan,
  gatedWrite: () => Promise<T>,
): Promise<T> {
  const claimed: ClaimedKey[] = [];
  try {
    for (const mutation of plan) {
      const claim = mutation.claim;
      if (claim === undefined) continue;
      await issuingClaims([claim], () =>
        ctx.backend.insertUnique({
          graphId: ctx.graphId,
          nodeKind: claim.axis,
          constraintName: mutation.constraintName,
          key: claim.key,
          nodeId: id,
          concreteKind: kind,
        }),
      );
      claimed.push({
        axis: claim.axis,
        constraintName: mutation.constraintName,
        key: claim.key,
      });
    }
    return await gatedWrite();
  } catch (error) {
    // Compensate, not swallow: the reservations this transition took are given
    // back and the original failure is rethrown, so the caller sees the SAME
    // error it would have seen with no reservation attempted at all.
    //
    // The give-back names the exact rows this transition wrote — owner pair and
    // claim axis both — so it can strip neither a reservation at another axis
    // that predates this write nor one a namesake under a different kind holds.
    //
    // The give-back is exact because of what a claim can be. `probeUniqueKey`
    // refuses a key another node holds and reports one THIS node already holds
    // (which the plan then does not claim), so every claimed key was free or
    // tombstoned beforehand and releasing it restores precisely that. And no
    // peer can have taken it in between: this transaction holds the row.
    //
    // One detail is restored in kind rather than exactly: a claim that took over
    // a TOMBSTONED reservation rewrites its recorded owner, and the give-back
    // re-tombstones it under THIS node's id instead of the previous holder's.
    // The key reads as free either way — `checkUnique` skips tombstoned rows —
    // and the one reader that looks at them, `getOrCreateByConstraint`'s
    // resurrect-by-key lookup, writes the props it was called with onto whatever
    // row it revives, so the reservation and the row holding the value stay
    // consistent. Which tombstone that lookup revives can differ. If the
    // compensation itself fails the row is genuinely half-written, and the
    // error that then surfaces is a raw backend failure no per-row consumer
    // catches — the enclosing transaction aborts, which is the only honest
    // outcome left.
    await releaseClaimedUniqueKeys(ctx, kind, id, claimed);
    throw error;
  }
}

/**
 * Runs one node's primary row write with its claim transition wrapped around
 * it, so the pair commits or fails AS ONE UNIT.
 *
 * ## Why the sequence is claim, gate, release
 *
 * A node update is two independently fallible writes — the row itself and its
 * claim rows — with no rollback between them: nothing here is
 * savepoint-protected (see `operations/write-transaction.ts`), and the backends
 * this supports do not all have savepoints to reach for. Sequencing is the only
 * atomicity available, and only ONE sequence makes both failures leave zero net
 * effect:
 *
 *  - **Claim first.** `insertUnique` is an upsert that reports the key's final
 *    owner, so claiming IS the conflict gate — and once this transaction holds
 *    the row, no concurrent writer can take the key from under it. Probing and
 *    then claiming later leaves a window (wide open under PostgreSQL READ
 *    COMMITTED, where a peer commits between the two) in which the claim fails
 *    AFTER the row was already updated.
 *  - **Then the row write.** It can legitimately match nothing —
 *    `expectedValidFrom`, `deleted_at` — and callers that catch that per row and
 *    commit the rest (interchange import) must not be left with reservations for
 *    a row that never changed. A refusal here compensates the claims away.
 *  - **Release last.** Giving up the old key before the row write would free a
 *    value for a write that may never land; giving it up after is safe because
 *    nothing can fail on it.
 *
 * The predecessor of this helper ordered the whole sidecar transition after the
 * row write, which closed the second failure and left the first: a caught
 * `UniquenessError` then reported `updated: 0` for a row whose props HAD
 * changed, whose old reservation was gone, and whose new one belonged to someone
 * else.
 *
 * Because that sequence is claim-first for EVERY scope, every claim this seam
 * issues is `pre-insert`, and a backend that cannot roll the pair back together
 * is refused before the first of them — see {@link claimFenceRefusal}. The
 * subject is the plan's claims rather than the kind's constraints: an update
 * that does not move a key issues no reservation and must not be refused.
 */
export async function withNodeClaimTransition<T>(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  plan: UniquenessUpdatePlan,
  gatedWrite: () => Promise<T>,
): Promise<T> {
  const refusal = claimFenceRefusal(
    ctx,
    ctx.backend,
    plan.flatMap((mutation) =>
      mutation.claim === undefined ? [] : [mutation.claim],
    ),
  );
  if (refusal !== undefined) throw refusal;

  const result = await claimUniqueKeysThen(ctx, kind, id, plan, gatedWrite);
  await releaseOwnedUniqueKeys(
    ctx,
    kind,
    id,
    plan.flatMap((mutation) =>
      mutation.release === undefined ?
        []
      : [{ constraintName: mutation.constraintName, key: mutation.release }],
    ),
  );
  return result;
}
