/**
 * Uniqueness Constraint Management
 *
 * Handles checking, inserting, updating, and deleting uniqueness constraint entries.
 */
import {
  type GraphBackend,
  type InsertUniqueParams,
  type TransactionBackend,
} from "../backend/types";
import {
  checkWherePredicate,
  computeUniqueKey,
  getKindsForUniquenessCheck,
} from "../constraints";
import { type UniqueConstraint } from "../core/types";
import { ConfigurationError, UniquenessError } from "../errors";
import { type KindRegistry } from "../registry/kind-registry";
import { encodeTupleKey } from "../utils/tuple-key";

/**
 * Context for uniqueness operations.
 */
export type UniquenessContext = Readonly<{
  graphId: string;
  registry: KindRegistry;
  backend: GraphBackend | TransactionBackend;
}>;

/** Builds a {@link UniquenessContext} — the one constructor every call site shares. */
export function createUniquenessContext(
  graphId: string,
  registry: KindRegistry,
  backend: GraphBackend | TransactionBackend,
): UniquenessContext {
  return { graphId, registry, backend };
}

/** A complete node after-image whose uniqueness claims belong to one resolved write set. */
export type ResolvedNodeUniquenessUpsert = Readonly<{
  kind: string;
  id: string;
  props: Readonly<Record<string, unknown>>;
  constraints: readonly UniqueConstraint[];
}>;

/** A node whose current uniqueness claims the resolved write set releases. */
export type ResolvedNodeUniquenessRelease = Readonly<{
  kind: string;
  id: string;
}>;

type ProposedUniqueClaim = Readonly<{
  kind: string;
  id: string;
  constraint: UniqueConstraint;
  key: string;
  kindsToCheck: readonly string[];
}>;

function nodeIdentityKey(reference: ResolvedNodeUniquenessRelease): string {
  return encodeTupleKey([reference.kind, reference.id]);
}

function proposedUniqueClaims(
  ctx: UniquenessContext,
  upserts: readonly ResolvedNodeUniquenessUpsert[],
): readonly ProposedUniqueClaim[] {
  const claims: ProposedUniqueClaim[] = [];
  const claimsByCheckedKind = new Map<string, ProposedUniqueClaim[]>();
  const claimsByOwnKind = new Map<string, ProposedUniqueClaim[]>();
  const orderedConstraints: UniqueConstraint[] = [];
  const seenConstraints = new Set<UniqueConstraint>();
  for (const upsert of upserts) {
    for (const constraint of upsert.constraints) {
      if (seenConstraints.has(constraint)) continue;
      seenConstraints.add(constraint);
      orderedConstraints.push(constraint);
    }
  }
  for (const constraint of orderedConstraints) {
    for (const upsert of upserts) {
      if (!upsert.constraints.includes(constraint)) continue;
      if (!checkWherePredicate(constraint, upsert.props)) continue;
      const claim = {
        kind: upsert.kind,
        id: upsert.id,
        constraint,
        key: computeUniqueKey(
          upsert.props,
          constraint.fields,
          constraint.collation,
        ),
        kindsToCheck: getKindsForUniquenessCheck(
          upsert.kind,
          constraint.scope,
          ctx.registry,
        ),
      } satisfies ProposedUniqueClaim;
      const identity = nodeIdentityKey(claim);
      const candidateGroups = [
        claimsByCheckedKind.get(
          encodeTupleKey([constraint.name, claim.key, claim.kind]),
        ) ?? [],
        ...claim.kindsToCheck.map(
          (kind) =>
            claimsByOwnKind.get(
              encodeTupleKey([constraint.name, claim.key, kind]),
            ) ?? [],
        ),
      ];
      const collision = candidateGroups
        .flat()
        .find((existing) => nodeIdentityKey(existing) !== identity);
      if (collision !== undefined) {
        throw new UniquenessError({
          constraintName: constraint.name,
          kind: collision.kind,
          existingId: collision.id,
          newId: upsert.id,
          fields: constraint.fields,
        });
      }
      claims.push(claim);
      const ownKindKey = encodeTupleKey([
        constraint.name,
        claim.key,
        claim.kind,
      ]);
      const sameKindClaims = claimsByOwnKind.get(ownKindKey);
      if (sameKindClaims === undefined) {
        claimsByOwnKind.set(ownKindKey, [claim]);
      } else {
        sameKindClaims.push(claim);
      }
      for (const kind of claim.kindsToCheck) {
        const checkedKindKey = encodeTupleKey([
          constraint.name,
          claim.key,
          kind,
        ]);
        const sameDomainClaims = claimsByCheckedKind.get(checkedKindKey);
        if (sameDomainClaims === undefined) {
          claimsByCheckedKind.set(checkedKindKey, [claim]);
        } else {
          sameDomainClaims.push(claim);
        }
      }
    }
  }
  return claims;
}

type UniqueProbeGroup = Readonly<{
  nodeKind: string;
  constraintName: string;
  claimsByKey: ReadonlyMap<string, ProposedUniqueClaim>;
}>;

function groupUniqueClaimsForBatchProbe(
  claims: readonly ProposedUniqueClaim[],
): readonly UniqueProbeGroup[] {
  const groups = new Map<
    string,
    {
      nodeKind: string;
      constraintName: string;
      claimsByKey: Map<string, ProposedUniqueClaim>;
    }
  >();
  for (const claim of claims) {
    for (const nodeKind of claim.kindsToCheck) {
      const groupKey = encodeTupleKey([nodeKind, claim.constraint.name]);
      const existing = groups.get(groupKey);
      if (existing === undefined) {
        groups.set(groupKey, {
          nodeKind,
          constraintName: claim.constraint.name,
          claimsByKey: new Map([[claim.key, claim]]),
        });
        continue;
      }
      existing.claimsByKey.set(claim.key, claim);
    }
  }
  return [...groups.values()];
}

/**
 * Validates node uniqueness against the FINAL state of a resolved write set.
 *
 * All proposed after-images are compared together before persisted sidecars
 * are consulted. Persisted owners released or replaced by this same set are
 * ignored, which permits atomic swaps and handoffs while still refusing every
 * owner outside the set. The backend probe is batch-only by contract: callers
 * that need this set semantic must not quietly degrade to sequential checks.
 */
export async function validateResolvedNodeUniqueness(
  ctx: UniquenessContext,
  upserts: readonly ResolvedNodeUniquenessUpsert[],
  releases: readonly ResolvedNodeUniquenessRelease[] = [],
): Promise<void> {
  const checkUniqueBatch = ctx.backend.checkUniqueBatch;
  if (checkUniqueBatch === undefined) {
    throw new ConfigurationError(
      "Resolved node writes require batched uniqueness probes",
      { code: "RESOLVED_NODE_UNIQUENESS_UNSUPPORTED" },
    );
  }
  const claims = proposedUniqueClaims(ctx, upserts);
  if (claims.length === 0) return;

  const affectedOwners = new Set(
    [...upserts, ...releases].map((reference) => nodeIdentityKey(reference)),
  );
  for (const group of groupUniqueClaimsForBatchProbe(claims)) {
    const existingRows = await checkUniqueBatch({
      graphId: ctx.graphId,
      nodeKind: group.nodeKind,
      constraintName: group.constraintName,
      keys: [...group.claimsByKey.keys()],
    });
    for (const existing of existingRows) {
      if (
        affectedOwners.has(
          nodeIdentityKey({
            kind: existing.concrete_kind,
            id: existing.node_id,
          }),
        )
      ) {
        continue;
      }
      const claim = group.claimsByKey.get(existing.key);
      if (claim === undefined) continue;
      throw new UniquenessError({
        constraintName: group.constraintName,
        kind: group.nodeKind,
        existingId: existing.node_id,
        newId: claim.id,
        fields: claim.constraint.fields,
      });
    }
  }
}

/**
 * Prepares a transaction to apply a resolved node write set sequentially.
 *
 * Validation happens before any mutation. Once it succeeds, every affected
 * node's old sidecars are batch-cleared so later per-node upserts can claim the
 * validated final keys in any order (including swaps and handoffs).
 */
async function prepareResolvedNodeUniqueness(
  ctx: UniquenessContext,
  upserts: readonly ResolvedNodeUniquenessUpsert[],
  releases: readonly ResolvedNodeUniquenessRelease[],
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
  await validateResolvedNodeUniqueness(ctx, upserts, releases);

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
 * Applies writes between the resolved-set preflight and one final batch
 * sidecar rebuild.
 *
 * The rebuild is required even though ordinary upserts claim their own keys:
 * an unchanged upsert may be coalesced and skip all of its normal side effects
 * after preparation cleared the old reservation. Re-inserting every approved
 * claim is idempotent and makes the resolved-set transition independent of
 * whether individual writes were coalesced.
 */
export async function applyResolvedNodeUniqueness<Output>(
  ctx: UniquenessContext,
  upserts: readonly ResolvedNodeUniquenessUpsert[],
  releases: readonly ResolvedNodeUniquenessRelease[],
  apply: () => Promise<Output>,
): Promise<Output> {
  await prepareResolvedNodeUniqueness(ctx, upserts, releases);
  const result = await apply();
  await insertUniquenessEntriesBatch(ctx, upserts);
  return result;
}

/**
 * Probes ONE constraint's key across every kind its scope covers.
 *
 * THE SINGLE OWNER of "is this key available to this node?" — the conflict
 * verdict and the ownership reading are one read, so no caller can consult one
 * without the other. {@link checkUniquenessConstraints} is this probe run for
 * its refusal alone; the plan builders below additionally keep what it read.
 *
 * @returns whether THIS node already holds the key live under its OWN kind, in
 *   which case a claim would be a no-op and a compensating release would strip
 *   a reservation the node is entitled to.
 * @throws UniquenessError when a DIFFERENT node holds the key under any kind in
 *   scope.
 */
async function probeUniqueKey(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  constraint: UniqueConstraint,
  key: string,
): Promise<boolean> {
  const kindsToCheck = getKindsForUniquenessCheck(
    kind,
    constraint.scope,
    ctx.registry,
  );

  // `let` earns its place: the loop must visit EVERY kind in scope to reach its
  // refusal, so the ownership reading cannot be an early return.
  let heldByThisNode = false;
  for (const kindToCheck of kindsToCheck) {
    const existing = await ctx.backend.checkUnique({
      graphId: ctx.graphId,
      nodeKind: kindToCheck,
      constraintName: constraint.name,
      key,
    });

    if (existing === undefined) continue;
    if (existing.node_id !== id) {
      throw new UniquenessError({
        constraintName: constraint.name,
        kind: kindToCheck,
        existingId: existing.node_id,
        newId: id,
        fields: constraint.fields,
      });
    }
    if (kindToCheck === kind) heldByThisNode = true;
  }
  return heldByThisNode;
}

/**
 * Checks uniqueness constraints for a new or existing node.
 *
 * @throws ValidationError if any constraint is violated
 */
export async function checkUniquenessConstraints(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  props: Record<string, unknown>,
  constraints: readonly UniqueConstraint[],
): Promise<void> {
  for (const constraint of constraints) {
    if (!checkWherePredicate(constraint, props)) {
      continue;
    }

    await probeUniqueKey(
      ctx,
      kind,
      id,
      constraint,
      computeUniqueKey(props, constraint.fields, constraint.collation),
    );
  }
}

/**
 * Inserts uniqueness entries for a newly created node.
 */
export async function insertUniquenessEntries(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  props: Record<string, unknown>,
  constraints: readonly UniqueConstraint[],
): Promise<void> {
  for (const constraint of constraints) {
    if (!checkWherePredicate(constraint, props)) {
      continue;
    }

    const key = computeUniqueKey(
      props,
      constraint.fields,
      constraint.collation,
    );

    await ctx.backend.insertUnique({
      graphId: ctx.graphId,
      nodeKind: kind,
      constraintName: constraint.name,
      key,
      nodeId: id,
      concreteKind: kind,
    });
  }
}

/**
 * Inserts uniqueness entries for a batch of newly created nodes through one
 * `insertUniqueBatch` call (falling back to per-entry `insertUnique` when
 * the backend lacks the batch primitive). Same conflict semantics as the
 * per-node path: the first entry whose key a different live node holds
 * throws `UniquenessError`.
 */
export async function insertUniquenessEntriesBatch(
  ctx: UniquenessContext,
  items: readonly Readonly<{
    kind: string;
    id: string;
    props: Record<string, unknown>;
    constraints: readonly UniqueConstraint[];
  }>[],
): Promise<void> {
  const entries: InsertUniqueParams[] = [];
  for (const item of items) {
    for (const constraint of item.constraints) {
      if (!checkWherePredicate(constraint, item.props)) {
        continue;
      }
      entries.push({
        graphId: ctx.graphId,
        nodeKind: item.kind,
        constraintName: constraint.name,
        key: computeUniqueKey(
          item.props,
          constraint.fields,
          constraint.collation,
        ),
        nodeId: item.id,
        concreteKind: item.kind,
      });
    }
  }
  if (entries.length === 0) return;

  if (ctx.backend.insertUniqueBatch !== undefined) {
    await ctx.backend.insertUniqueBatch(entries);
    return;
  }
  for (const entry of entries) {
    await ctx.backend.insertUnique(entry);
  }
}

/**
 * Deletes uniqueness entries for a node being deleted.
 */
export async function deleteUniquenessEntries(
  ctx: UniquenessContext,
  kind: string,
  props: Record<string, unknown>,
  constraints: readonly UniqueConstraint[],
): Promise<void> {
  for (const constraint of constraints) {
    if (!checkWherePredicate(constraint, props)) {
      continue;
    }

    const key = computeUniqueKey(
      props,
      constraint.fields,
      constraint.collation,
    );

    await ctx.backend.deleteUnique({
      graphId: ctx.graphId,
      nodeKind: kind,
      constraintName: constraint.name,
      key,
    });
  }
}

/**
 * A single constraint's sidecar transition, decided by a plan builder and
 * carried out by {@link withUniquenessTransition}.
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
   * The key to reserve before the primary write; undefined = none, either
   * because the constraint stopped applying or because {@link probeUniqueKey}
   * found this node already holding it live.
   */
  claim: string | undefined;
}>;

/**
 * The sidecar transition a node write owes, decided but not yet performed.
 *
 * Opaque to its holder on purpose: the only thing a caller does with a plan is
 * hand it to {@link withUniquenessTransition} together with the primary row
 * write it belongs to.
 */
export type UniquenessUpdatePlan = readonly PendingUniqueMutation[];

/**
 * Decides the uniqueness-entry changes a node's new props require, WITHOUT
 * writing any of them.
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
export async function planUniquenessUpdate(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  oldProps: Record<string, unknown>,
  newProps: Record<string, unknown>,
  constraints: readonly UniqueConstraint[],
): Promise<UniquenessUpdatePlan> {
  const pending: PendingUniqueMutation[] = [];
  for (const constraint of constraints) {
    const oldApplies = checkWherePredicate(constraint, oldProps);
    const newApplies = checkWherePredicate(constraint, newProps);

    const oldKey =
      oldApplies ?
        computeUniqueKey(oldProps, constraint.fields, constraint.collation)
      : undefined;
    const newKey =
      newApplies ?
        computeUniqueKey(newProps, constraint.fields, constraint.collation)
      : undefined;

    // No change - constraint didn't apply and still doesn't
    if (!oldApplies && !newApplies) {
      continue;
    }

    // Keys are the same and constraint still applies - nothing to do
    if (oldApplies && newApplies && oldKey === newKey) {
      continue;
    }

    // Probe the new key: refuse a value another node holds, and note a value
    // this node somehow holds already so the transition neither re-claims nor
    // releases it.
    const alreadyHeld =
      newKey === undefined ? false : (
        await probeUniqueKey(ctx, kind, id, constraint, newKey)
      );

    pending.push({
      constraintName: constraint.name,
      release: oldKey,
      claim: alreadyHeld ? undefined : newKey,
    });
  }

  return pending;
}

/**
 * The plan a RESURRECTING write needs: every applying constraint re-reserved
 * from scratch.
 *
 * A tombstoned node holds no live reservations — {@link deleteUniquenessEntries}
 * released them at soft-delete time — so the diff-based
 * {@link planUniquenessUpdate} cannot be used here: it would skip an unchanged
 * key and leave the revived node holding NO reservation, letting a later create
 * silently duplicate the value.
 *
 * @throws UniquenessError if a key this node held was taken while it was
 *   tombstoned
 */
export async function planUniquenessReinsert(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  props: Record<string, unknown>,
  constraints: readonly UniqueConstraint[],
): Promise<UniquenessUpdatePlan> {
  const pending: PendingUniqueMutation[] = [];
  for (const constraint of constraints) {
    if (!checkWherePredicate(constraint, props)) continue;

    const key = computeUniqueKey(
      props,
      constraint.fields,
      constraint.collation,
    );
    const alreadyHeld = await probeUniqueKey(ctx, kind, id, constraint, key);

    pending.push({
      constraintName: constraint.name,
      release: undefined,
      claim: alreadyHeld ? undefined : key,
    });
  }
  return pending;
}

/** Gives up the reservations named by `keys`, in plan order. */
async function releaseUniqueKeys(
  ctx: UniquenessContext,
  kind: string,
  keys: readonly Readonly<{ constraintName: string; key: string }>[],
): Promise<void> {
  for (const entry of keys) {
    await ctx.backend.deleteUnique({
      graphId: ctx.graphId,
      nodeKind: kind,
      constraintName: entry.constraintName,
      key: entry.key,
    });
  }
}

/**
 * Reserves the plan's new keys, runs the primary row write they gate, and undoes
 * the reservations if that write does not land.
 */
async function claimUniqueKeysThen<T>(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  plan: UniquenessUpdatePlan,
  gatedWrite: () => Promise<T>,
): Promise<T> {
  const claimed: Readonly<{ constraintName: string; key: string }>[] = [];
  try {
    for (const mutation of plan) {
      if (mutation.claim === undefined) continue;
      await ctx.backend.insertUnique({
        graphId: ctx.graphId,
        nodeKind: kind,
        constraintName: mutation.constraintName,
        key: mutation.claim,
        nodeId: id,
        concreteKind: kind,
      });
      claimed.push({
        constraintName: mutation.constraintName,
        key: mutation.claim,
      });
    }
    return await gatedWrite();
  } catch (error) {
    // Compensate, not swallow: the reservations this transition took are given
    // back and the original failure is rethrown, so the caller sees the SAME
    // error it would have seen with no reservation attempted at all.
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
    await releaseUniqueKeys(ctx, kind, claimed);
    throw error;
  }
}

/**
 * Runs one node's primary row write with its uniqueness transition wrapped
 * around it, so the pair commits or fails AS ONE UNIT.
 *
 * ## Why the sequence is claim, gate, release
 *
 * A node update is two independently fallible writes — the row itself and its
 * uniqueness entries — with no rollback between them: nothing here is
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
 */
export async function withUniquenessTransition<T>(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  plan: UniquenessUpdatePlan,
  gatedWrite: () => Promise<T>,
): Promise<T> {
  const result = await claimUniqueKeysThen(ctx, kind, id, plan, gatedWrite);
  await releaseUniqueKeys(
    ctx,
    kind,
    plan.flatMap((mutation) =>
      mutation.release === undefined ?
        []
      : [{ constraintName: mutation.constraintName, key: mutation.release }],
    ),
  );
  return result;
}
