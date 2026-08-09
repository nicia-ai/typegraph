/**
 * Node claims — what a node row reserves, and how each reservation moves.
 *
 * A declared uniqueness constraint is a CLAIM on an axis (see
 * {@link file://./axis.ts}): the write reserves the row
 * `(graph_id, axis, constraint_name, key)` and is refused when that reservation
 * comes back owned by somebody else. This module decides which claims a row
 * owes, probes them, writes them, releases them, and sequences each of those
 * against the primary row write it gates.
 */
import {
  type GraphBackend,
  type InsertUniqueParams,
  type TransactionBackend,
} from "../../backend/types";
import { checkWherePredicate, computeUniqueKey } from "../../constraints";
import { type UniqueConstraint } from "../../core/types";
import { UniquenessError } from "../../errors";
import { type KindRegistry } from "../../registry/kind-registry";
import {
  type ClaimOwner,
  isSameClaimOwner,
  uniquenessProbeKinds,
} from "./axis";
import { nodeClaimSites } from "./sites";

/**
 * Context for node claim operations.
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

/** One claim a node row owes, decided but not written. */
export type NodeClaimEntry = Readonly<{
  /** `uniques.node_kind` — the axis the primary key fences on. */
  axis: string;
  /** `uniques.constraint_name`. */
  constraintName: string;
  /** `uniques.key`. */
  key: string;
  /** The constraint this entry came from. */
  constraint: UniqueConstraint;
}>;

/**
 * THE single owner of "what claims does THIS ROW owe?": the kind's claim sites
 * ({@link nodeClaimSites}, the declaration-level extent) filtered by each
 * constraint's `where` predicate and completed with this row's key.
 *
 * Every path that maintains a node's reservations — create, update diff,
 * resurrect, delete, batch, import — reads its work from this one list, so no
 * path can compute a key one way and an axis another.
 */
export function nodeClaimEntries(
  registry: KindRegistry,
  kind: string,
  props: Record<string, unknown>,
  constraints: readonly UniqueConstraint[],
): readonly NodeClaimEntry[] {
  return nodeClaimSites(registry, kind, constraints).flatMap((site) =>
    checkWherePredicate(site.constraint, props) ?
      [
        {
          axis: site.axis,
          constraintName: site.constraintName,
          key: computeUniqueKey(
            props,
            site.constraint.fields,
            site.constraint.collation,
          ),
          constraint: site.constraint,
        },
      ]
    : [],
  );
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
async function probeUniqueKey(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  entry: NodeClaimEntry,
): Promise<boolean> {
  const mine: ClaimOwner = { concreteKind: kind, nodeId: id };

  // `let` earns its place: the loop must visit EVERY kind in scope to reach its
  // refusal, so the ownership reading cannot be an early return.
  let heldByThisNode = false;
  for (const kindToCheck of uniquenessProbeKinds(
    kind,
    entry.constraint.scope,
    ctx.registry,
  )) {
    const existing = await ctx.backend.checkUnique({
      graphId: ctx.graphId,
      nodeKind: kindToCheck,
      constraintName: entry.constraintName,
      key: entry.key,
    });

    if (existing === undefined) continue;
    if (
      !isSameClaimOwner(
        { concreteKind: existing.concrete_kind, nodeId: existing.node_id },
        mine,
      )
    ) {
      throw new UniquenessError({
        constraintName: entry.constraintName,
        kind: existing.concrete_kind,
        existingId: existing.node_id,
        newId: id,
        fields: entry.constraint.fields,
      });
    }
    if (kindToCheck === entry.axis) heldByThisNode = true;
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
  for (const entry of nodeClaimEntries(
    ctx.registry,
    kind,
    props,
    constraints,
  )) {
    await probeUniqueKey(ctx, kind, id, entry);
  }
}

/**
 * Inserts the claim rows a newly created node owes.
 */
export async function insertUniquenessEntries(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  props: Record<string, unknown>,
  constraints: readonly UniqueConstraint[],
): Promise<void> {
  for (const entry of nodeClaimEntries(
    ctx.registry,
    kind,
    props,
    constraints,
  )) {
    await ctx.backend.insertUnique({
      graphId: ctx.graphId,
      nodeKind: entry.axis,
      constraintName: entry.constraintName,
      key: entry.key,
      nodeId: id,
      concreteKind: kind,
    });
  }
}

/**
 * Inserts the claim rows a batch of newly created nodes owes through one
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
    for (const entry of nodeClaimEntries(
      ctx.registry,
      item.kind,
      item.props,
      item.constraints,
    )) {
      entries.push({
        graphId: ctx.graphId,
        nodeKind: entry.axis,
        constraintName: entry.constraintName,
        key: entry.key,
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
  await releaseOwnedUniqueKeys(
    ctx,
    kind,
    id,
    nodeClaimEntries(ctx.registry, kind, props, constraints),
  );
}

/** The row a write is about to reserve, named in full. */
type ClaimTarget = Readonly<{ axis: string; key: string }>;

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
   * The row to reserve before the primary write; undefined = none, either
   * because the constraint stopped applying or because {@link probeUniqueKey}
   * found this node already holding it live. It carries the axis it will be
   * written at, so the compensation names the row this transition wrote instead
   * of re-deriving which axis that was.
   */
  claim: ClaimTarget | undefined;
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
    nodeClaimEntries(ctx.registry, kind, oldProps, constraints).map((entry) => [
      entry.constraintName,
      entry.key,
    ]),
  );
  const newEntries = new Map(
    nodeClaimEntries(ctx.registry, kind, newProps, constraints).map((entry) => [
      entry.constraintName,
      entry,
    ]),
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
      claim:
        newEntry === undefined || alreadyHeld ?
          undefined
        : { axis: newEntry.axis, key: newEntry.key },
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
 * {@link planNodeClaimUpdate} cannot be used here: it would skip an unchanged
 * key and leave the revived node holding NO reservation, letting a later create
 * silently duplicate the value.
 *
 * @throws UniquenessError if a key this node held was taken while it was
 *   tombstoned
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
    props,
    constraints,
  )) {
    const alreadyHeld = await probeUniqueKey(ctx, kind, id, entry);

    pending.push({
      constraintName: entry.constraintName,
      release: undefined,
      claim: alreadyHeld ? undefined : { axis: entry.axis, key: entry.key },
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
      await ctx.backend.insertUnique({
        graphId: ctx.graphId,
        nodeKind: claim.axis,
        constraintName: mutation.constraintName,
        key: claim.key,
        nodeId: id,
        concreteKind: kind,
      });
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
 */
export async function withNodeClaimTransition<T>(
  ctx: UniquenessContext,
  kind: string,
  id: string,
  plan: UniquenessUpdatePlan,
  gatedWrite: () => Promise<T>,
): Promise<T> {
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
