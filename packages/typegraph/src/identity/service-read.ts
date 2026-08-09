import { type GraphDef } from "../core/define-graph";
import { type ReadCoordinate } from "../core/temporal";
import { KindNotFoundError } from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { chunk } from "../utils/array";
import { compareCodePoints } from "../utils/compare";
import { nowIso } from "../utils/date";
import { requireDefined } from "../utils/presence";
import { spanningDifferentAssertion } from "./different-assertion";
import {
  historicalIdentityReconstructionCtes,
  IDENTITY_ASSERTION_COLUMNS,
  identityAssertionSnapshotSource,
  identityNodeSnapshotSource,
  identityNodeVisibilitySql,
  identitySqlCoordinate,
} from "./historical-sql";
import {
  compareIdentityReferences,
  identityReferenceKey,
  identityReferencesContain,
  normalizeIdentityPair,
} from "./reference";
import {
  normalizeIdentityAssertionRow,
  optionalIdentityTimestamp,
  type RawIdentityAssertionRow,
  toCanonicalIdentityTimestamp,
} from "./row-codec";
import { type IdentityServiceContext } from "./service-types";
import {
  executeIdentityStatement,
  identityChunkSize,
  type IdentityTarget,
  MAX_REFERENCE_CHUNK_SIZE,
  type PlainNodeRef,
} from "./sql-target";
import { type IdentityAssertionStorageRow } from "./storage-types";
import {
  type IdentityAssertion,
  type IdentityAssertionId,
  type IdentityAssertionResult,
  type IdentityNodeReference,
  type IdentityNodeRefInput,
  type IdentityRelation,
} from "./types";

export type Backend = IdentityTarget;

export type IdentityTouch = (
  graphId: string,
  id: string,
  afterImage?: IdentityAssertionStorageRow,
) => void;

export const MAX_CLOSURE_INSERT_CHUNK_SIZE = 100;

export const MAX_ASSERTION_INSERT_CHUNK_SIZE = 50;

type RawNodeSnapshotRow = Readonly<{
  kind: string;
  id: string;
  valid_from: unknown;
  valid_to: unknown;
  created_at: unknown;
  deleted_at: unknown;
}>;

export type RawClosureClassRow = Readonly<{
  member_kind: string;
  member_id: string;
}>;

export type RawSeedClassAnchorRow = Readonly<{
  seed_kind: string;
  seed_id: string;
  class_kind: string;
  class_id: string;
}>;

type RawSeedClassMemberRow = RawClosureClassRow &
  Readonly<{
    seed_kind: string;
    seed_id: string;
  }>;

type RawHistoricalClassMemberRow = RawSeedClassMemberRow &
  Readonly<{ is_visible: unknown }>;

export type NodeSnapshot = Readonly<{
  ref: PlainNodeRef;
  validFrom: string | undefined;
  validTo: string | undefined;
  createdAt: string;
  deletedAt: string | undefined;
}>;

export type IdentitySnapshot = Readonly<{
  nodes: readonly NodeSnapshot[];
  structuralNodes: readonly PlainNodeRef[];
  assertions: readonly IdentityAssertionStorageRow[];
  components: ReadonlyMap<string, readonly PlainNodeRef[]>;
}>;

function plainRef<G extends GraphDef>(
  ref: IdentityNodeRefInput<G>,
): PlainNodeRef {
  return { kind: ref.kind, id: ref.id };
}

export function registeredPlainRef<G extends GraphDef>(
  ctx: Pick<IdentityServiceContext<G>, "graphId" | "registry">,
  ref: IdentityNodeRefInput<G>,
): PlainNodeRef {
  const result = plainRef(ref);
  if (!ctx.registry.nodeKinds.has(result.kind)) {
    throw new KindNotFoundError(result.kind, "node", {
      graphId: ctx.graphId,
    });
  }
  return result;
}

/**
 * The canonical map key for a node reference. Every identity closure map —
 * structural classes, affected-closure sets, loaded-node lookups — is keyed
 * with it, so any caller building or probing one of those maps must produce
 * its keys through this helper rather than re-spelling the serialization.
 */
export function refKey(ref: PlainNodeRef): string {
  return identityReferenceKey(ref);
}

/**
 * Projects a stored assertion row into the interchange transfer shape. The row
 * must already be normalized (see `normalizeIdentityAssertionRow`); raw driver rows
 * carry dialect-specific timestamp and NULL spellings this shape does not.
 */
/**
 * Whether `ref` is one of `members`.
 *
 * Keys the probe once instead of re-serializing it for every member, which
 * an inline `members.some((m) => refKey(m) === refKey(ref))` does.
 */
export function containsRef(
  members: readonly PlainNodeRef[],
  ref: PlainNodeRef,
): boolean {
  return identityReferencesContain(members, ref);
}

export function compareReferences(
  left: PlainNodeRef,
  right: PlainNodeRef,
): number {
  return compareIdentityReferences(left, right);
}

export function normalizePair(
  first: PlainNodeRef,
  second: PlainNodeRef,
): readonly [PlainNodeRef, PlainNodeRef] {
  return normalizeIdentityPair(first, second);
}

// A retraction ends an assertion at "now", but a backward clock skew can make
// now < the row's valid_from — minting an empty (valid_to < valid_from) window
// that validateTransferShape rejects on archival re-import. Clamp the end to
// valid_from so the closed window is at worst zero-width, never negative.
export function clampValidTo(timestamp: string, validFrom: string): string {
  return compareCodePoints(timestamp, validFrom) < 0 ? validFrom : timestamp;
}

/**
 * Canonicalizes a driver timestamp read back from an identity relation. Drivers
 * hand back `Date` objects or zoneless strings depending on dialect; identity
 * rows are compared as canonical UTC strings, so an unrepresentable value is a
 * storage-boundary fault rather than a silently skewed comparison.
 */

export function publicAssertion<G extends GraphDef>(
  row: IdentityAssertionStorageRow,
): IdentityAssertion<G> {
  return {
    id: row.id as IdentityAssertionId,
    relation: row.rel,
    a: publicNodeRef<G>({ kind: row.a_kind, id: row.a_id }),
    b: publicNodeRef<G>({ kind: row.b_kind, id: row.b_id }),
    validFrom: row.valid_from,
    ...(row.valid_to === undefined ? {} : { validTo: row.valid_to }),
  };
}

export function assertionResult<G extends GraphDef>(
  assertion: IdentityAssertion<G>,
  action: IdentityAssertionResult<G>["action"],
): IdentityAssertionResult<G> {
  return { assertion, action };
}

export function publicNodeRef<G extends GraphDef>(
  ref: PlainNodeRef,
): IdentityNodeReference<G> {
  // Every service entry point validates kinds against the graph registry, and
  // persisted assertion/closure rows are constrained to those same endpoints.
  // Reapply the public per-kind NodeId brand at this storage boundary.
  return ref as IdentityNodeReference<G>;
}

/**
 * Serializes identity-affecting writers on one graph (Postgres only).
 *
 * The lock is deliberately whole-graph rather than scoped to the kinds a write
 * touches. Identity closures are transitive: an assertion between two kinds
 * merges their classes, so a "which kinds participate" test would have to
 * evaluate the closure — the very thing the lock protects. A coarse lock is
 * the only scope that is correct without reading what it guards.
 *
 * The cost is a known throughput ceiling: concurrent writers on a single
 * identity-enabled graph serialize even when their kinds share no relation.
 * Scoping the lock to connected components of the assertion graph is the
 * refinement if that ceiling ever binds.
 *
 * SQLITE: no lock is taken because the engine's single writer slot already
 * serializes writers — a premise that holds for every transaction TypeGraph
 * opens itself (`BEGIN IMMEDIATE` takes the slot before the first read) but NOT
 * for one adopted through `store.withTransaction()`, which may have been begun
 * DEFERRED by the caller. There the fold's read→write can lose the upgrade and
 * SQLite refuses the write with a stale snapshot. That case is neither
 * serializable from here (the frame is already open, and its kind is not
 * observable) nor retryable in place (SQLite requires a rollback), so it is
 * refused with a typed error naming the cause and the remedy — see
 * `executeIdentityStatement` (#447).
 */
export async function lockIdentityGraph(
  target: Backend,
  graphId: string,
): Promise<void> {
  if (target.dialect !== "postgres") return;
  await target.execute(
    asCompiledRowsSql(sql`
      SELECT pg_advisory_xact_lock(
        hashtext('typegraph:identity'),
        hashtext(${graphId})
      )
    `),
  );
}

/** Drains in-flight legacy node writes before the first identity snapshot. */
export async function lockIdentityEnablementNodes(
  target: Backend,
  schema: SqlSchema,
): Promise<void> {
  if (target.dialect !== "postgres") return;
  await executeIdentityStatement(
    target,
    sql`LOCK TABLE ${schema.nodesTable} IN SHARE MODE`,
  );
}

export async function loadNodeSnapshot(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  coordinate: ReadCoordinate | undefined,
): Promise<readonly NodeSnapshot[]> {
  const sqlCoordinate = identitySqlCoordinate(coordinate, nowIso());
  const rows = await target.execute<RawNodeSnapshotRow>(
    asCompiledRowsSql(
      identityNodeSnapshotSource(schema, graphId, sqlCoordinate),
    ),
  );
  return rows.map((row) => ({
    ref: { kind: row.kind, id: row.id },
    validFrom: optionalIdentityTimestamp(row.valid_from),
    validTo: optionalIdentityTimestamp(row.valid_to),
    createdAt: toCanonicalIdentityTimestamp(row.created_at),
    deletedAt: optionalIdentityTimestamp(row.deleted_at),
  }));
}

export function isCurrentClosureCoordinate(
  coordinate: ReadCoordinate | undefined,
): boolean {
  return (
    coordinate?.recorded === undefined &&
    (coordinate?.valid.mode ?? "current") === "current"
  );
}

export async function loadCurrentStructuralClasses(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  references: readonly PlainNodeRef[],
): Promise<ReadonlyMap<string, readonly PlainNodeRef[]>> {
  const uniqueByKey = new Map<string, PlainNodeRef>();
  for (const ref of references) uniqueByKey.set(refKey(ref), ref);
  const uniqueReferences = [...uniqueByKey.values()];
  if (uniqueReferences.length === 0) return new Map();
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 2,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 2,
  });
  if (uniqueReferences.length > chunkSize) {
    const combined = new Map<string, readonly PlainNodeRef[]>();
    for (const refChunk of chunk(uniqueReferences, chunkSize)) {
      const classes = await loadCurrentStructuralClasses(
        target,
        schema,
        graphId,
        refChunk,
      );
      for (const [key, members] of classes) combined.set(key, members);
    }
    return combined;
  }
  const seedRows = sql.join(
    uniqueReferences.map((ref) => sql`(${ref.kind}, ${ref.id})`),
    sql`, `,
  );
  const rows = await target.execute<RawSeedClassMemberRow>(
    asCompiledRowsSql(sql`
      WITH seeds(seed_kind, seed_id) AS (
        VALUES ${seedRows}
      ), anchors AS (
        SELECT seeds.seed_kind, seeds.seed_id,
               COALESCE(anchor.class_kind, seeds.seed_kind) AS class_kind,
               COALESCE(anchor.class_id, seeds.seed_id) AS class_id
        FROM seeds
        LEFT JOIN ${schema.identityClosureTable} anchor
          ON anchor.graph_id = ${graphId}
         AND anchor.member_kind = seeds.seed_kind
         AND anchor.member_id = seeds.seed_id
      )
      SELECT anchors.seed_kind, anchors.seed_id,
             COALESCE(member.member_kind, anchors.seed_kind) AS member_kind,
             COALESCE(member.member_id, anchors.seed_id) AS member_id
      FROM anchors
      LEFT JOIN ${schema.identityClosureTable} member
        ON member.graph_id = ${graphId}
       AND member.class_kind = anchors.class_kind
       AND member.class_id = anchors.class_id
    `),
  );
  const classes = new Map<string, PlainNodeRef[]>();
  for (const row of rows) {
    const seedKey = refKey({ kind: row.seed_kind, id: row.seed_id });
    const members = classes.get(seedKey) ?? [];
    members.push({ kind: row.member_kind, id: row.member_id });
    classes.set(seedKey, members);
  }
  return new Map(
    [...classes].map(([seedKey, members]) => [
      seedKey,
      members.toSorted((left, right) => compareReferences(left, right)),
    ]),
  );
}

export async function loadCurrentVisibleMembers(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  ref: PlainNodeRef,
): Promise<readonly PlainNodeRef[]> {
  const now = nowIso();
  const coordinate = identitySqlCoordinate(undefined, now);
  // Two deliberate deviations keep this read O(class size) instead of
  // O(graph size) on SQLite. A row-value `(class_kind, class_id) IN
  // (subquery)` defeats the closure's class index, so the members CTE joins
  // the anchor row instead. And SQLite's planner, estimating without
  // statistics, likes to drive the visibility join from the nodes table via
  // the `(graph_id, deleted_at)` index — a scan of every live node per call.
  // CROSS JOIN pins the join order on SQLite (a documented planner control)
  // while remaining an ordinary inner join on PostgreSQL, whose planner
  // orders freely from real statistics either way.
  // Only the endpoint identity is projected: the visibility predicate below
  // already consumed this row's timestamps in SQL, so hydrating them into JS
  // would validate columns nothing downstream reads.
  const rows = await target.execute<PlainNodeRef>(
    asCompiledRowsSql(sql`
      WITH anchor AS (
        SELECT class_kind, class_id
        FROM ${schema.identityClosureTable}
        WHERE graph_id = ${graphId}
          AND member_kind = ${ref.kind}
          AND member_id = ${ref.id}
      ), members(kind, id) AS (
        SELECT closure.member_kind, closure.member_id
        FROM anchor
        JOIN ${schema.identityClosureTable} closure
          ON closure.graph_id = ${graphId}
         AND closure.class_kind = anchor.class_kind
         AND closure.class_id = anchor.class_id
        UNION ALL
        SELECT ${ref.kind}, ${ref.id}
        WHERE NOT EXISTS (SELECT 1 FROM anchor)
      )
      SELECT n.kind, n.id
      FROM members m
      CROSS JOIN ${schema.nodesTable} n
      WHERE n.graph_id = ${graphId}
        AND n.kind = m.kind
        AND n.id = m.id
        AND ${identityNodeVisibilitySql(coordinate, "n")}
    `),
  );
  const members = rows
    .map((row) => ({ kind: row.kind, id: row.id }))
    .toSorted((left, right) => compareReferences(left, right));
  return containsRef(members, ref) ? members : [];
}

async function loadHistoricalVisibleMembers(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  ref: PlainNodeRef,
  coordinate: ReadCoordinate,
  sameIdAcrossKinds: "fold" | "ignore",
): Promise<readonly PlainNodeRef[]> {
  const classes = await loadHistoricalClasses(
    target,
    schema,
    graphId,
    [ref],
    coordinate,
    sameIdAcrossKinds,
  );
  return requireDefined(classes.get(refKey(ref))).visible;
}

export type HistoricalClass = Readonly<{
  structural: readonly PlainNodeRef[];
  visible: readonly PlainNodeRef[];
}>;

export async function loadHistoricalClasses(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  references: readonly PlainNodeRef[],
  coordinate: ReadCoordinate,
  sameIdAcrossKinds: "fold" | "ignore",
): Promise<ReadonlyMap<string, HistoricalClass>> {
  const uniqueByKey = new Map<string, PlainNodeRef>();
  for (const ref of references) uniqueByKey.set(refKey(ref), ref);
  const uniqueReferences = [...uniqueByKey.values()];
  const emptyClasses = new Map(
    uniqueReferences.map((ref) => [
      refKey(ref),
      { structural: [], visible: [] } satisfies HistoricalClass,
    ]),
  );
  if (uniqueReferences.length === 0) return emptyClasses;
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 24,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 2,
  });
  if (uniqueReferences.length > chunkSize) {
    const combined = new Map<string, HistoricalClass>();
    for (const refChunk of chunk(uniqueReferences, chunkSize)) {
      const classes = await loadHistoricalClasses(
        target,
        schema,
        graphId,
        refChunk,
        coordinate,
        sameIdAcrossKinds,
      );
      for (const [key, value] of classes) combined.set(key, value);
    }
    return combined;
  }
  const currentInstant = nowIso();
  const sqlCoordinate = identitySqlCoordinate(coordinate, currentInstant);
  const seeds = sql.join(
    uniqueReferences.map((ref) => sql`(${ref.kind}, ${ref.id})`),
    sql`, `,
  );
  const reconstruction = historicalIdentityReconstructionCtes({
    schema,
    graphId,
    coordinate: sqlCoordinate,
    seedSource: sql`VALUES ${seeds}`,
    sameIdAcrossKinds,
  });
  const rows = await target.execute<RawHistoricalClassMemberRow>(
    asCompiledRowsSql(sql`
      WITH RECURSIVE
      ${reconstruction}
      SELECT member.seed_kind, member.seed_id,
             member.kind AS member_kind, member.id AS member_id,
             CASE WHEN ${identityNodeVisibilitySql(sqlCoordinate, "n")}
               THEN 1 ELSE 0 END AS is_visible
      FROM identity_members member
      JOIN node_snapshot n ON n.kind = member.kind AND n.id = member.id
    `),
  );
  const structuralBySeed = new Map<string, PlainNodeRef[]>();
  const visibleBySeed = new Map<string, PlainNodeRef[]>();
  for (const row of rows) {
    const seedKey = refKey({ kind: row.seed_kind, id: row.seed_id });
    const member = { kind: row.member_kind, id: row.member_id };
    const structural = structuralBySeed.get(seedKey) ?? [];
    structural.push(member);
    structuralBySeed.set(seedKey, structural);
    if (!row.is_visible) continue;
    const visible = visibleBySeed.get(seedKey) ?? [];
    visible.push(member);
    visibleBySeed.set(seedKey, visible);
  }
  return new Map(
    uniqueReferences.map((ref) => {
      const key = refKey(ref);
      return [
        key,
        {
          structural: (structuralBySeed.get(key) ?? []).toSorted(
            (left, right) => compareReferences(left, right),
          ),
          visible: (visibleBySeed.get(key) ?? []).toSorted((left, right) =>
            compareReferences(left, right),
          ),
        },
      ];
    }),
  );
}

export function visibleMembersAtCoordinate<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  ref: PlainNodeRef,
): Promise<readonly PlainNodeRef[]> {
  const { coordinate } = ctx;
  if (coordinate === undefined || isCurrentClosureCoordinate(coordinate)) {
    return loadCurrentVisibleMembers(ctx.backend, ctx.schema, ctx.graphId, ref);
  }
  return loadHistoricalVisibleMembers(
    ctx.backend,
    ctx.schema,
    ctx.graphId,
    ref,
    coordinate,
    ctx.sameIdAcrossKinds,
  );
}

export async function loadAssertions(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  coordinate: ReadCoordinate | undefined,
  currentInstant: string,
): Promise<readonly IdentityAssertionStorageRow[]> {
  const source = identityAssertionSnapshotSource(
    schema,
    graphId,
    identitySqlCoordinate(coordinate, currentInstant),
    undefined,
  );
  const rows = await target.execute<RawIdentityAssertionRow>(
    asCompiledRowsSql(source),
  );
  return rows.map((row) => normalizeIdentityAssertionRow(row));
}

export function referenceCondition(
  kindColumn: SqlFragment,
  idColumn: SqlFragment,
  references: readonly PlainNodeRef[],
): SqlFragment {
  if (references.length === 0) return sql`1 = 0`;
  return sql`(${sql.join(
    references.map(
      (ref) => sql`(${kindColumn} = ${ref.kind} AND ${idColumn} = ${ref.id})`,
    ),
    sql` OR `,
  )})`;
}

export async function loadAssertionsTouching(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  references: readonly PlainNodeRef[],
  coordinate: ReadCoordinate | undefined,
  relation?: IdentityRelation,
): Promise<readonly IdentityAssertionStorageRow[]> {
  if (references.length === 0) return [];
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 16,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 4,
  });
  if (references.length > chunkSize) {
    const byId = new Map<string, IdentityAssertionStorageRow>();
    for (const refChunk of chunk(references, chunkSize)) {
      const assertions = await loadAssertionsTouching(
        target,
        schema,
        graphId,
        refChunk,
        coordinate,
        relation,
      );
      for (const assertion of assertions) byId.set(assertion.id, assertion);
    }
    return [...byId.values()];
  }
  const source = identityAssertionSnapshotSource(
    schema,
    graphId,
    identitySqlCoordinate(coordinate, nowIso()),
    relation,
  );
  const aMatches = referenceCondition(
    sql`identity_assertions.a_kind`,
    sql`identity_assertions.a_id`,
    references,
  );
  const bMatches = referenceCondition(
    sql`identity_assertions.b_kind`,
    sql`identity_assertions.b_id`,
    references,
  );
  const rows = await target.execute<RawIdentityAssertionRow>(
    asCompiledRowsSql(sql`
      SELECT ${IDENTITY_ASSERTION_COLUMNS}
      FROM (${source}) identity_assertions
      WHERE ${aMatches} OR ${bMatches}
    `),
  );
  return rows.map((row) => normalizeIdentityAssertionRow(row));
}

export async function loadSpanningDifferentAssertion(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  firstClass: readonly PlainNodeRef[],
  secondClass: readonly PlainNodeRef[],
  coordinate?: ReadCoordinate,
): Promise<IdentityAssertionStorageRow | undefined> {
  const assertions = await loadAssertionsTouching(
    target,
    schema,
    graphId,
    firstClass,
    coordinate,
    "different",
  );
  return spanningDifferentAssertion(assertions, firstClass, secondClass);
}
