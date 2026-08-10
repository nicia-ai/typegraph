import { type GraphDef } from "../core/define-graph";
import {
  ConfigurationError,
  IdentityContradictionError,
  IdentityEndpointValidityError,
} from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { sql } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { withRecordedIdentityMutationTarget } from "../store/recorded-capture";
import { chunk } from "../utils/array";
import { nowIso } from "../utils/date";
import { requireDefined } from "../utils/presence";
import { IDENTITY_ASSERTION_COLUMNS } from "./historical-sql";
import {
  normalizeIdentityAssertionRow,
  optionalIdentityTimestamp,
  type RawIdentityAssertionRow,
} from "./row-codec";
import {
  assertSeparationMatchesProjection,
  buildSeparationProjection,
  readSeparationForGraph,
} from "./separation";
import {
  assertClosureMatchesComponents,
  classHasDisjointKinds,
  closureMismatchError,
  identityActiveKinds,
  loadLiveReferences,
  loadSnapshot,
  validateSnapshotIntegrity,
} from "./service-components";
import { runIdentityMutation } from "./service-facade";
import {
  replaceAffectedClosure,
  replaceClosure,
  snapshotClassKey,
  validateCurrentRelation,
} from "./service-mutation";
import type { Backend, RawClosureClassRow } from "./service-read";
import {
  clampValidTo,
  loadAssertionsTouching,
  loadCurrentStructuralClasses,
  lockIdentityGraph,
  refKey,
} from "./service-read";
import { type IdentityServiceContext } from "./service-types";
import {
  executeIdentityStatement,
  identityChunkSize,
  MAX_REFERENCE_CHUNK_SIZE,
  type PlainNodeRef,
} from "./sql-target";
import { type IdentityAssertionStorageRow } from "./storage-types";

/**
 * The context slice a closure rebuild reads. Narrower than the full
 * {@link IdentityServiceContext} so a schema-transition preflight — which runs
 * below the Store layer and has no node loader or write-transaction settings to
 * offer — can drive the same rebuild the Store drives.
 */
export type IdentityRebuildContext<G extends GraphDef> = Pick<
  IdentityServiceContext<G>,
  "backend" | "graphId" | "registry" | "schema" | "sameIdAcrossKinds"
>;

function requireAtomicIdentityBackend(backend: Backend, graphId: string): void {
  if (!backend.capabilities.transactions) {
    throw new ConfigurationError(
      "Operational Identity requires atomic transaction support.",
      { code: "IDENTITY_REQUIRES_ATOMIC_BACKEND", graphId },
    );
  }
}

/**
 * Runs `fn` against a transactional target. A top-level `GraphBackend` opens
 * one; a `TransactionBackend` is already inside the caller's transaction and
 * has no `transaction` method to nest with, so it runs as-is.
 */
async function runOnTransactionIfSupported(
  backend: Backend,
  fn: (target: Backend) => Promise<void>,
): Promise<void> {
  if ("transaction" in backend) {
    await backend.transaction(async (target) => fn(target));
    return;
  }
  await fn(backend);
}

export async function rebuildIdentityClosureForContext<G extends GraphDef>(
  ctx: IdentityRebuildContext<G>,
): Promise<void> {
  requireAtomicIdentityBackend(ctx.backend, ctx.graphId);

  async function rebuildAtTarget(target: Backend): Promise<void> {
    await lockIdentityGraph(target, ctx.graphId);
    await withRecordedIdentityMutationTarget(target, async (rawTarget) => {
      const activeKinds = identityActiveKinds(ctx.registry);
      const snapshot = await loadSnapshot(
        rawTarget,
        ctx.schema,
        ctx.graphId,
        undefined,
        activeKinds,
        ctx.sameIdAcrossKinds,
      );
      validateSnapshotIntegrity(snapshot, ctx.registry, ctx.graphId);
      await replaceClosure(
        rawTarget,
        ctx.schema,
        ctx.graphId,
        activeKinds,
        ctx.sameIdAcrossKinds,
      );
    });
  }

  await runOnTransactionIfSupported(ctx.backend, async (target) =>
    rebuildAtTarget(target),
  );
}

export async function validateIdentityForContext<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
): Promise<void> {
  requireAtomicIdentityBackend(ctx.backend, ctx.graphId);

  async function validateAtTarget(target: Backend): Promise<void> {
    await lockIdentityGraph(target, ctx.graphId);
    const activeKinds = identityActiveKinds(ctx.registry);
    const snapshot = await loadSnapshot(
      target,
      ctx.schema,
      ctx.graphId,
      undefined,
      activeKinds,
      ctx.sameIdAcrossKinds,
    );
    validateSnapshotIntegrity(snapshot, ctx.registry, ctx.graphId);
    await assertClosureMatchesComponents(
      target,
      ctx.schema,
      ctx.graphId,
      snapshot.components,
    );
    assertSeparationMatchesProjection(
      ctx.graphId,
      await readSeparationForGraph(target, ctx.schema, ctx.graphId),
      buildSeparationProjection(snapshot.assertions, (ref) =>
        snapshotClassKey(snapshot, ref),
      ),
    );
  }

  await runOnTransactionIfSupported(ctx.backend, async (target) =>
    validateAtTarget(target),
  );
}

/**
 * The context slice the affected-class assertion reads. Narrower than the full
 * {@link IdentityServiceContext} because the assertion runs inside a
 * caller-owned write transaction and therefore takes its target explicitly
 * instead of opening one from `backend`.
 */
export type IdentityConsistencyContext<G extends GraphDef> = Pick<
  IdentityServiceContext<G>,
  "graphId" | "registry" | "schema" | "sameIdAcrossKinds"
>;

/** The affected identity classes, indexed for the assertion's three scans. */
type AffectedIdentityClasses = Readonly<{
  /** Each distinct affected class, keyed by its code-point-least member. */
  byClassKey: ReadonlyMap<string, readonly PlainNodeRef[]>;
  /** The class key of every affected member, for endpoint lookups. */
  classKeyByMember: ReadonlyMap<string, string>;
  /** Every member of every affected class, deduplicated. */
  members: readonly PlainNodeRef[];
}>;

/**
 * The identity classes the seeds belong to, read through the SAME materialized
 * closure every current identity read resolves through
 * ({@link loadCurrentStructuralClasses}), so the assertion judges the state
 * readers will actually see rather than a private reconstruction of it.
 */
async function loadAffectedIdentityClasses<G extends GraphDef>(
  ctx: IdentityConsistencyContext<G>,
  target: Backend,
  seeds: readonly PlainNodeRef[],
): Promise<AffectedIdentityClasses> {
  const classes = await loadCurrentStructuralClasses(
    target,
    ctx.schema,
    ctx.graphId,
    seeds,
  );
  const byClassKey = new Map<string, readonly PlainNodeRef[]>();
  const classKeyByMember = new Map<string, string>();
  const members = new Map<string, PlainNodeRef>();
  for (const classMembers of classes.values()) {
    // Members come back in {@link compareReferences} order, so the first is
    // the class's code-point-least member — the same canonical label
    // {@link insertClosureComponents} writes, which makes two seeds of one
    // class collapse onto one entry here.
    const classKey = refKey(requireDefined(classMembers[0]));
    byClassKey.set(classKey, classMembers);
    for (const member of classMembers) {
      const memberKey = refKey(member);
      classKeyByMember.set(memberKey, classKey);
      members.set(memberKey, member);
    }
  }
  return { byClassKey, classKeyByMember, members: [...members.values()] };
}

/**
 * What an affected-class scan found: a genuine identity contradiction, or
 * evidence that the materialized closure lags the ledger it is derived from.
 * The two are indistinguishable to a caller reading a stale closure, which is
 * why {@link assertAffectedIdentityClassesConsistent} rebuilds before it
 * believes either.
 */
type AffectedClassInconsistency =
  | Readonly<{ kind: "contradiction"; error: IdentityContradictionError }>
  | Readonly<{
      kind: "stale-closure";
      detail: Readonly<Record<string, unknown>>;
    }>;

function firstMemberOfKind(
  members: readonly PlainNodeRef[],
  kind: string,
): PlainNodeRef {
  return requireDefined(
    members.find((member) => member.kind === kind),
    `Identity class carries no ${kind} member`,
  );
}

/**
 * The first inconsistency in the affected classes, or `undefined` when they
 * are consistent. Three scans, all scoped to the affected members:
 *
 *  - a class whose member kinds the ontology declares disjoint;
 *  - a CURRENT `different` assertion whose endpoints share one class;
 *  - closure lag, as a current `same` assertion (or, under `"fold"`, a live
 *    same-id row) whose endpoints the closure has NOT merged — the one shape
 *    that could hide a contradiction from the two scans above, because both
 *    resolve classes through that same closure.
 */
async function findAffectedClassInconsistency<G extends GraphDef>(
  ctx: IdentityConsistencyContext<G>,
  target: Backend,
  seeds: readonly PlainNodeRef[],
): Promise<AffectedClassInconsistency | undefined> {
  const classes = await loadAffectedIdentityClasses(ctx, target, seeds);
  for (const members of classes.byClassKey.values()) {
    // Self-pairs are safe: `areDisjoint(kind, kind)` is false by construction.
    const conflictingKinds = classHasDisjointKinds(
      ctx.registry,
      members,
      members,
    );
    if (conflictingKinds === undefined) continue;
    const [leftKind, rightKind] = conflictingKinds;
    return {
      kind: "contradiction",
      error: new IdentityContradictionError({
        operation: "merge",
        a: firstMemberOfKind(members, leftKind),
        b: firstMemberOfKind(members, rightKind),
        reason: "disjoint-kinds",
        conflictingKinds,
      }),
    };
  }

  const assertions = await loadAssertionsTouching(
    target,
    ctx.schema,
    ctx.graphId,
    classes.members,
    undefined,
  );
  // Current `same` rows the closure has NOT merged into one class. An endpoint
  // outside every affected class is only evidence of lag when its node is
  // live — a class legitimately excludes a deleted member — so the liveness of
  // those endpoints is read once, after the scan, instead of per row.
  const unmerged: Readonly<{
    assertionId: string;
    a: PlainNodeRef;
    b: PlainNodeRef;
    outside: PlainNodeRef;
  }>[] = [];
  for (const assertion of assertions) {
    const a = { kind: assertion.a_kind, id: assertion.a_id };
    const b = { kind: assertion.b_kind, id: assertion.b_id };
    const aClassKey = classes.classKeyByMember.get(refKey(a));
    const bClassKey = classes.classKeyByMember.get(refKey(b));
    if (assertion.rel === "different") {
      if (aClassKey === undefined || aClassKey !== bClassKey) continue;
      return {
        kind: "contradiction",
        error: new IdentityContradictionError({
          operation: "merge",
          a,
          b,
          reason: "same-class",
          conflictingAssertionId: assertion.id,
        }),
      };
    }
    if (aClassKey !== undefined && bClassKey !== undefined) {
      if (aClassKey === bClassKey) continue;
      return {
        kind: "stale-closure",
        detail: { assertionId: assertion.id, a, b },
      };
    }
    // The row reached this scan by touching an affected member, so exactly one
    // endpoint can be outside the affected classes.
    unmerged.push({
      assertionId: assertion.id,
      a,
      b,
      outside: aClassKey === undefined ? a : b,
    });
  }
  if (unmerged.length > 0) {
    const liveOutside = await loadLiveReferences(
      target,
      ctx.schema,
      ctx.graphId,
      unmerged.map((row) => row.outside),
    );
    const liveKeys = new Set(liveOutside.map((ref) => refKey(ref)));
    const lagging = unmerged.find((row) => liveKeys.has(refKey(row.outside)));
    if (lagging !== undefined) {
      return {
        kind: "stale-closure",
        detail: {
          assertionId: lagging.assertionId,
          a: lagging.a,
          b: lagging.b,
        },
      };
    }
  }

  if (ctx.sameIdAcrossKinds !== "fold") return undefined;
  // The structural half of closure truth: under `"fold"` every live row
  // sharing an affected member's id belongs to that member's class. A row the
  // closure never folded reads as `undefined` here, which is the lag this
  // scan exists to catch.
  const liveKindsById = await liveNodeKindsSharingIds(
    ctx,
    target,
    classes.members.map((member) => member.id),
  );
  for (const [id, kinds] of liveKindsById) {
    const classKeys = new Set<string | undefined>();
    for (const kind of kinds) {
      classKeys.add(classes.classKeyByMember.get(refKey({ kind, id })));
    }
    if (classKeys.size > 1) {
      return {
        kind: "stale-closure",
        detail: { sharedId: id, kinds: [...kinds] },
      };
    }
  }
  return undefined;
}

/**
 * Asserts that the identity classes a write TOUCHED are contradiction-free, in
 * the caller's write transaction and against the state the write just left
 * behind. Scoped to the affected classes — the seeds plus everything the
 * closure links them to — so the cost is O(affected classes), not O(graph).
 *
 * This is the applier-owned half of identity correctness: unlike a caller's
 * plan-time simulation, it reads the post-write database, so a plan validated
 * against state that has since moved cannot commit a contradictory ledger. Any
 * refusal propagates out of the caller's transaction, which rolls the whole
 * write back — there is no partial commit.
 *
 * Both failure kinds go through ONE rebuild-and-recheck: the scans resolve
 * classes through the materialized closure, so a lagging closure can invent a
 * contradiction as easily as it can hide one. On any inconsistency the closure
 * is rebuilt from the base relations INSIDE the caller's transaction and the
 * scans re-run against it. A clean second pass means the closure was stale and
 * is now repaired (atomically with the caller's write); a repeated
 * contradiction is real and aborts; a repeated lag means the closure and the
 * ledger disagree in a way a rebuild cannot fix, which is corruption.
 */
export async function assertAffectedIdentityClassesConsistent<
  G extends GraphDef,
>(
  ctx: IdentityConsistencyContext<G>,
  target: Backend,
  seeds: readonly PlainNodeRef[],
): Promise<void> {
  if (seeds.length === 0) return;
  await lockIdentityGraph(target, ctx.graphId);
  const observed = await findAffectedClassInconsistency(ctx, target, seeds);
  if (observed === undefined) return;
  await withRecordedIdentityMutationTarget(target, async (rawTarget) => {
    await replaceClosure(
      rawTarget,
      ctx.schema,
      ctx.graphId,
      identityActiveKinds(ctx.registry),
      ctx.sameIdAcrossKinds,
    );
  });
  const rebuilt = await findAffectedClassInconsistency(ctx, target, seeds);
  if (rebuilt === undefined) return;
  if (rebuilt.kind === "contradiction") throw rebuilt.error;
  throw closureMismatchError(ctx.graphId, rebuilt.detail);
}

/**
 * Hard-deletes every assertion row (current AND ended) touching any of the
 * given node kinds, touching each removed row for recorded capture. Shared by
 * {@link removeIdentityKindsForContext} (Store.removeKinds) and the schema
 * commit preflight for kind-dropping migrations — the closure rebuild those
 * paths run afterwards silently FILTERS rows with unregistered kinds, so
 * without this cascade a dropped kind's assertions would survive as current
 * orphans: invisible to closure and live-endpoint interchange reads, yet
 * still present to raw ledger reads and merge staging.
 *
 * @internal
 */
export async function deleteAssertionsTouchingKinds(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  kinds: readonly string[],
  touch: (graphId: string, id: string) => void,
): Promise<void> {
  const removedKinds = [...new Set(kinds)];
  if (removedKinds.length === 0) return;
  const matched = new Map<string, IdentityAssertionStorageRow>();
  const kindChunkSize = identityChunkSize(target, {
    fixedParameters: 1,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 2,
  });
  for (const kindChunk of chunk(removedKinds, kindChunkSize)) {
    const kindList = sql.join(
      kindChunk.map((kind) => sql`${kind}`),
      sql`, `,
    );
    const rows = await target.execute<RawIdentityAssertionRow>(
      asCompiledRowsSql(sql`
        SELECT ${IDENTITY_ASSERTION_COLUMNS}
        FROM ${schema.identityAssertionsTable}
        WHERE graph_id = ${graphId}
          AND (a_kind IN (${kindList}) OR b_kind IN (${kindList}))
      `),
    );
    for (const rawRow of rows) {
      matched.set(rawRow.id, normalizeIdentityAssertionRow(rawRow));
    }
  }
  const ids = [...matched.keys()];
  if (ids.length > 0) {
    const idChunkSize = identityChunkSize(target, {
      fixedParameters: 1,
      maxItems: MAX_REFERENCE_CHUNK_SIZE,
      parametersPerItem: 1,
    });
    for (const idChunk of chunk(ids, idChunkSize)) {
      const idList = sql.join(
        idChunk.map((id) => sql`${id}`),
        sql`, `,
      );
      await executeIdentityStatement(
        target,
        sql`
          DELETE FROM ${schema.identityAssertionsTable}
          WHERE graph_id = ${graphId} AND id IN (${idList})
        `,
      );
    }
  }
  for (const row of matched.values()) touch(graphId, row.id);
}

/**
 * Whether the ledger holds any assertion — current or ended — touching one of
 * the given node kinds. Lets a caller decide whether a cascade is needed at all
 * before it commits to a code path that can run one.
 *
 * @internal
 */
export async function hasAssertionsTouchingKinds(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  kinds: readonly string[],
): Promise<boolean> {
  const probedKinds = [...new Set(kinds)];
  if (probedKinds.length === 0) return false;
  const kindChunkSize = identityChunkSize(target, {
    fixedParameters: 1,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 2,
  });
  for (const kindChunk of chunk(probedKinds, kindChunkSize)) {
    const kindList = sql.join(
      kindChunk.map((kind) => sql`${kind}`),
      sql`, `,
    );
    const rows = await target.execute<Readonly<{ id: string }>>(
      asCompiledRowsSql(sql`
        SELECT id
        FROM ${schema.identityAssertionsTable}
        WHERE graph_id = ${graphId}
          AND (a_kind IN (${kindList}) OR b_kind IN (${kindList}))
        LIMIT 1
      `),
    );
    if (rows.length > 0) return true;
  }
  return false;
}

/**
 * Hard-deletes every assertion row touching a node kind that is not registered
 * on the graph, so a first enablement (or a profile re-enablement) never adopts
 * orphans it cannot see. The closure rebuild that follows FILTERS unregistered
 * kinds, which would leave such rows current but invisible — the same stranding
 * {@link deleteAssertionsTouchingKinds} prevents on the drop path, arriving
 * instead from a database that already contained strays.
 *
 * @internal
 */
export async function purgeAssertionsWithUnregisteredKinds(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  registeredKinds: ReadonlySet<string>,
  touch: (graphId: string, id: string) => void,
): Promise<void> {
  const pairs = await target.execute<
    Readonly<{ a_kind: string; b_kind: string }>
  >(
    asCompiledRowsSql(sql`
      SELECT DISTINCT a_kind, b_kind
      FROM ${schema.identityAssertionsTable}
      WHERE graph_id = ${graphId}
    `),
  );
  const unregistered = new Set<string>();
  for (const pair of pairs) {
    if (!registeredKinds.has(pair.a_kind)) unregistered.add(pair.a_kind);
    if (!registeredKinds.has(pair.b_kind)) unregistered.add(pair.b_kind);
  }
  if (unregistered.size === 0) return;
  await deleteAssertionsTouchingKinds(
    target,
    schema,
    graphId,
    [...unregistered],
    touch,
  );
}

/**
 * Cascades removed node kinds through the assertion ledger.
 *
 * `repairClosure: false` is for a graph whose identity profile is absent while
 * the ledger storage still exists (identity was disabled without dropping the
 * rows). There is no closure contract to restore without a profile, so the
 * cascade runs alone — the ledger must not keep rows for a kind the schema no
 * longer registers, whether or not identity is currently switched on.
 */
export async function removeIdentityKindsForContext<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  kinds: readonly string[],
  options?: Readonly<{ repairClosure?: boolean }>,
): Promise<void> {
  if (kinds.length === 0) return;
  const removedKinds = [...new Set(kinds)];
  await runIdentityMutation(ctx, async (target, touch) => {
    await deleteAssertionsTouchingKinds(
      target,
      ctx.schema,
      ctx.graphId,
      removedKinds,
      touch,
    );
    if (options?.repairClosure === false) return;
    await replaceClosure(
      target,
      ctx.schema,
      ctx.graphId,
      identityActiveKinds(ctx.registry),
      ctx.sameIdAcrossKinds,
    );
  });
}

/**
 * One chunked bare-id SELECT over ALL requested ids, not one per node kind:
 * `typegraph_nodes_id_idx (graph_id, id)` makes the kind-free probe an indexed
 * seek, so the whole cross-kind live peer set comes back in a single round
 * trip. Rows whose kind is outside the registry are dropped — they never
 * participate in identity.
 */
export async function liveNodeKindsSharingIds(
  ctx: Pick<
    IdentityServiceContext<GraphDef>,
    "graphId" | "registry" | "schema"
  >,
  target: Backend,
  ids: readonly string[],
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const uniqueIds = [...new Set(ids)];
  const liveKindsById = new Map<string, Set<string>>();
  if (uniqueIds.length === 0) return liveKindsById;
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 1,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 1,
  });
  for (const idChunk of chunk(uniqueIds, chunkSize)) {
    const idList = sql.join(
      idChunk.map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = await target.execute<Readonly<{ kind: string; id: string }>>(
      asCompiledRowsSql(sql`
        SELECT kind, id
        FROM ${ctx.schema.nodesTable}
        WHERE graph_id = ${ctx.graphId}
          AND id IN (${idList})
          AND deleted_at IS NULL
      `),
    );
    for (const row of rows) {
      if (!ctx.registry.nodeKinds.has(row.kind)) continue;
      const kinds = liveKindsById.get(row.id) ?? new Set<string>();
      kinds.add(row.kind);
      liveKindsById.set(row.id, kinds);
    }
  }
  return liveKindsById;
}

export async function foldIdentityForCreatedNodes(
  ctx: Pick<
    IdentityServiceContext<GraphDef>,
    "graphId" | "registry" | "sameIdAcrossKinds" | "schema"
  >,
  target: Backend,
  references: readonly PlainNodeRef[],
): Promise<void> {
  if (references.length === 0 || ctx.sameIdAcrossKinds === "ignore") return;
  await lockIdentityGraph(target, ctx.graphId);
  await withRecordedIdentityMutationTarget(target, async (rawTarget) => {
    const liveKindsById = await liveNodeKindsSharingIds(
      ctx,
      rawTarget,
      references.map((ref) => ref.id),
    );
    const closureReferences: PlainNodeRef[] = [];
    for (const ref of references) {
      // Registry order, not row-arrival order: which conflicting peer
      // `validateCurrentRelation` reports first must not depend on how the
      // engine happened to return rows. Iterating the registry also drops
      // rows whose kind is outside it — those never participate in identity.
      const liveKinds = liveKindsById.get(ref.id);
      const peers: PlainNodeRef[] = [];
      if (liveKinds !== undefined) {
        for (const kind of ctx.registry.nodeKinds.keys()) {
          if (kind === ref.kind || !liveKinds.has(kind)) continue;
          peers.push({ kind, id: ref.id });
        }
      }
      if (peers.length === 0) continue;
      for (const peer of peers) {
        await validateCurrentRelation(
          ctx,
          rawTarget,
          "same",
          "fold",
          ref,
          peer,
        );
      }
      closureReferences.push(ref, ...peers);
    }
    await replaceAffectedClosure(
      rawTarget,
      ctx.schema,
      ctx.graphId,
      closureReferences,
      ctx.sameIdAcrossKinds,
    );
  });
}

/**
 * Reports whether the node carries a materialized identity class row.
 *
 * {@link insertClosureComponents} emits rows only for components with two or
 * more members, and every current-class read resolves through that table
 * ({@link loadCurrentStructuralClasses} anchors on it and coalesces a missing
 * row to the node itself), so no row means the node is a singleton under every
 * source of identity — assertions AND the same-id structural fold, which
 * `foldIdentityForCreatedNodes` materializes at create time.
 */
async function hasMaterializedIdentityClass(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  ref: PlainNodeRef,
): Promise<boolean> {
  const rows = await target.execute<RawClosureClassRow>(
    asCompiledRowsSql(sql`
      SELECT member_kind, member_id
      FROM ${schema.identityClosureTable}
      WHERE graph_id = ${graphId}
        AND member_kind = ${ref.kind}
        AND member_id = ${ref.id}
      LIMIT 1
    `),
  );
  return rows.length > 0;
}

/**
 * Reads the instant a node was soft-deleted, as stored on its own row.
 *
 * The soft-delete cascade ends the node's open assertions AT THIS INSTANT
 * rather than at a second wall-clock read, so the assertion stops holding at
 * exactly the moment its endpoint stopped existing: a valid-time read at any
 * instant sees the node and its assertions agree. Two `nowIso()` reads inside
 * one transaction can straddle a millisecond boundary, so the instant has to
 * come from the stored value, not from a fresh clock read.
 *
 * Returns `undefined` when the row is gone or still live; callers fall back to
 * their own instant.
 */
async function readNodeDeletionInstant(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  ref: PlainNodeRef,
): Promise<string | undefined> {
  const rows = await target.execute<Readonly<{ deleted_at: unknown }>>(
    asCompiledRowsSql(sql`
      SELECT deleted_at
      FROM ${schema.nodesTable}
      WHERE graph_id = ${graphId}
        AND kind = ${ref.kind}
        AND id = ${ref.id}
      LIMIT 1
    `),
  );
  const row = rows.at(0);
  return row === undefined ? undefined : (
      optionalIdentityTimestamp(row.deleted_at)
    );
}

/** Refuses a finite node window that would strand identity assertion history. */
export async function requireNodeValidityEndCompatible(
  ctx: Pick<IdentityServiceContext<GraphDef>, "graphId" | "schema">,
  target: Backend,
  ref: PlainNodeRef,
  validTo: string,
): Promise<void> {
  const rows = await target.execute<RawIdentityAssertionRow>(
    asCompiledRowsSql(sql`
      SELECT ${IDENTITY_ASSERTION_COLUMNS}
      FROM ${ctx.schema.identityAssertionsTable}
      WHERE graph_id = ${ctx.graphId}
        AND deleted_at IS NULL
        AND (valid_to IS NULL OR valid_to > ${validTo})
        AND (
          (a_kind = ${ref.kind} AND a_id = ${ref.id})
          OR (b_kind = ${ref.kind} AND b_id = ${ref.id})
        )
      ORDER BY id
      LIMIT 1
    `),
  );
  const row = rows.at(0);
  if (row === undefined) return;
  const assertion = normalizeIdentityAssertionRow(row);
  throw new IdentityEndpointValidityError({
    endpoint: ref,
    assertionWindow: {
      validFrom: assertion.valid_from,
      ...(assertion.valid_to === undefined ?
        {}
      : { validTo: assertion.valid_to }),
    },
    endpointWindow: { validTo },
  });
}

export async function detachIdentityForNode(
  ctx: Pick<
    IdentityServiceContext<GraphDef>,
    "graphId" | "sameIdAcrossKinds" | "schema"
  >,
  target: Backend,
  ref: PlainNodeRef,
  mode: "soft" | "hard",
): Promise<void> {
  await lockIdentityGraph(target, ctx.graphId);
  await withRecordedIdentityMutationTarget(target, async (rawTarget, touch) => {
    const touchesNode = sql`
      (
            (a_kind = ${ref.kind} AND a_id = ${ref.id})
            OR (b_kind = ${ref.kind} AND b_id = ${ref.id})
          )
    `;
    // Hard delete physically removes the node, so EVERY assertion touching it —
    // including already-ended and previously soft-deleted rows — must be
    // removed, or a node soft-deleted before its hard delete would leave
    // archival assertions referencing a row that no longer exists. Soft delete
    // only ends the currently-open rows.
    const scope =
      mode === "hard" ?
        sql``
      : sql`AND valid_to IS NULL AND deleted_at IS NULL`;
    const rows = await rawTarget.execute<RawIdentityAssertionRow>(
      asCompiledRowsSql(sql`
        SELECT ${IDENTITY_ASSERTION_COLUMNS}
        FROM ${ctx.schema.identityAssertionsTable}
        WHERE graph_id = ${ctx.graphId}
          ${scope}
          AND ${touchesNode}
      `),
    );
    // Most deletes are of nodes that never participated in identity. Such a
    // node has no assertion rows in scope and no materialized class row, so its
    // component is itself and the closure repair below would delete and
    // reinsert nothing — one indexed lookup replaces its five statements.
    if (
      rows.length === 0 &&
      !(await hasMaterializedIdentityClass(
        rawTarget,
        ctx.schema,
        ctx.graphId,
        ref,
      ))
    ) {
      return;
    }
    const now = nowIso();
    // A soft delete ends its node's open assertions at the node's OWN deletion
    // instant (see readNodeDeletionInstant): the caller has already written
    // `deleted_at` inside this transaction, and reusing it keeps the node and
    // its assertions agreeing at every valid-time instant. The read is skipped
    // when there is nothing to end.
    const cascadeInstant =
      mode === "hard" || rows.length === 0 ?
        now
      : ((await readNodeDeletionInstant(
          rawTarget,
          ctx.schema,
          ctx.graphId,
          ref,
        )) ?? now);
    for (const rawRow of rows) {
      const row = normalizeIdentityAssertionRow(rawRow);
      if (mode === "hard") {
        await executeIdentityStatement(
          rawTarget,
          sql`
            DELETE FROM ${ctx.schema.identityAssertionsTable}
            WHERE graph_id = ${ctx.graphId} AND id = ${row.id}
          `,
        );
        touch(ctx.graphId, row.id);
      } else {
        const validTo = clampValidTo(cascadeInstant, row.valid_from);
        // Stamp the CAUSE of the ending alongside it, in the same statement:
        // this row stopped holding because `ref` was deleted, not because
        // anyone retracted it. Downstream (graph-merge's state-diff) reads the
        // stamp instead of trying to infer the cause from timestamps, which
        // cannot separate a retraction issued in the delete's own millisecond
        // from the cascade itself.
        const ended = {
          ...row,
          valid_to: validTo,
          updated_at: now,
          ended_by_kind: ref.kind,
          ended_by_id: ref.id,
        };
        await executeIdentityStatement(
          rawTarget,
          sql`
            UPDATE ${ctx.schema.identityAssertionsTable}
            SET valid_to = ${validTo},
                updated_at = ${now},
                ended_by_kind = ${ref.kind},
                ended_by_id = ${ref.id}
            WHERE graph_id = ${ctx.graphId} AND id = ${row.id}
          `,
        );
        touch(ctx.graphId, row.id, ended);
      }
    }
    await replaceAffectedClosure(
      rawTarget,
      ctx.schema,
      ctx.graphId,
      [ref],
      ctx.sameIdAcrossKinds,
    );
  });
}
