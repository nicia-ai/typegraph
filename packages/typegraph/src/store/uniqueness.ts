/**
 * Uniqueness Constraint Management
 *
 * Handles checking, inserting, updating, and deleting uniqueness constraint entries.
 */
import {
  type GraphBackend,
  type InsertUniqueParams,
  type TransactionBackend,
  type UniqueConstraintBackend,
} from "../backend/types";
import {
  checkWherePredicate,
  computeUniqueKey,
  getKindsForUniquenessCheck,
} from "../constraints";
import { type UniqueConstraint } from "../core/types";
import { UniquenessError } from "../errors";
import { type KindRegistry } from "../registry/kind-registry";
import { requireDefined } from "../utils/presence";

/**
 * Context for uniqueness operations.
 */
export type UniquenessContext = Readonly<{
  graphId: string;
  registry: KindRegistry;
  backend: GraphBackend | TransactionBackend;
}>;

/**
 * Context for the uniqueness PROBE, whose single backend member is the read.
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
 * Builds a uniqueness context — the one constructor every call site shares.
 *
 * Generic in the handle so it yields exactly what it was given: a full backend
 * produces a {@link UniquenessContext} that can also apply the sidecar writes,
 * and a read-only projection produces a {@link UniquenessProbeContext}, which
 * is all the probe needs and all row work can offer.
 */
export function createUniquenessContext<
  T extends Pick<UniqueConstraintBackend, "checkUnique">,
>(
  graphId: string,
  registry: KindRegistry,
  backend: T,
): Readonly<{ graphId: string; registry: KindRegistry; backend: T }> {
  return { graphId, registry, backend };
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
  ctx: UniquenessProbeContext,
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
  ctx: UniquenessProbeContext,
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
 * Drops EVERY uniqueness entry a set of nodes holds under one concrete kind,
 * key-blind, so the rebuild that follows can reinsert from the after-images.
 *
 * The key-blind drop is what a set update needs and the per-key
 * {@link deleteUniquenessEntries} cannot give it: the statement rewrote whole
 * rows without reading their before-images, so nobody knows which keys those
 * rows used to hold.
 *
 * Requiring the member rather than probing it: the only caller
 * ({@link applyNodeSetUpdate}) refuses the write up front when a constrained
 * kind's backend lacks it, with a code that names the operation. A second
 * fallback here would be a quieter answer to a question already asked.
 */
export async function hardDeleteUniquenessEntriesByNodeIds(
  ctx: UniquenessContext,
  concreteKind: string,
  nodeIds: readonly string[],
): Promise<void> {
  await requireDefined(ctx.backend.hardDeleteUniquesByNodeIds)({
    graphId: ctx.graphId,
    concreteKind,
    nodeIds,
  });
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
