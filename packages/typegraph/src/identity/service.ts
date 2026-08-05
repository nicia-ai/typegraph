import { type GraphDef } from "../core/define-graph";
import { type ReadCoordinate } from "../core/temporal";
import {
  ConfigurationError,
  IdentityContradictionError,
  type IdentityContradictionErrorDetails,
  KindNotFoundError,
  NodeNotFoundError,
  ValidationError,
} from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { type KindRegistry } from "../registry/kind-registry";
import { runInWriteTransaction } from "../store/operations/write-transaction";
import { withRecordedIdentityMutationTarget } from "../store/recorded-capture";
import { type GraphNodeReference } from "../store/types";
import { chunk } from "../utils/array";
import { compareCodePoints } from "../utils/compare";
import { canonicalizeDatabaseTimestamp, nowIso } from "../utils/date";
import { generateId } from "../utils/id";
import { requireDefined } from "../utils/presence";
import {
  historicalIdentityReconstructionCtes,
  IDENTITY_ASSERTION_COLUMNS,
  identityAssertionSnapshotSource,
  identityNodeSnapshotSource,
  identityNodeVisibilitySql,
  identitySqlCoordinate,
} from "./historical-sql";
import {
  assertSeparationMatchesProjection,
  buildSeparationProjection,
  deleteSeparationForClassKeys,
  deleteSeparationForGraph,
  identityClassKey,
  insertSeparationRows,
  isSeparated,
  readSeparationForGraph,
  unexpectedSeparationError,
} from "./separation";
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
  type IdentityFacade,
  type IdentityNode,
  type IdentityNodeRefInput,
  type IdentityReadFacade,
  type IdentityRelation,
} from "./types";

type Backend = IdentityTarget;
type IdentityTouch = (
  graphId: string,
  id: string,
  afterImage?: IdentityAssertionStorageRow,
) => void;

const MAX_CLOSURE_INSERT_CHUNK_SIZE = 100;
const MAX_ASSERTION_INSERT_CHUNK_SIZE = 50;

export type IdentityServiceContext<G extends GraphDef> = Readonly<{
  graph: G;
  graphId: string;
  schemaVersion: number | undefined;
  registry: KindRegistry;
  backend: Backend;
  schema: SqlSchema;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
  sameIdAcrossKinds: "fold" | "ignore";
  coordinate?: ReadCoordinate;
  loadNodes: (
    references: readonly PlainNodeRef[],
    coordinate?: ReadCoordinate,
  ) => Promise<readonly (IdentityNode<G> | undefined)[]>;
}>;

export type IdentityTransferAssertion = Readonly<{
  id: string;
  relation: IdentityRelation;
  a: PlainNodeRef;
  b: PlainNodeRef;
  validFrom: string;
  validTo?: string | undefined;
}>;

export type IdentityImportSummary = Readonly<{
  created: number;
  skipped: number;
}>;

type IdentityInterchangeReadOptions = Readonly<{
  nodeKinds?: readonly string[];
  includeDeleted?: boolean;
}>;

type RawIdentityAssertionRow = Readonly<{
  graph_id: string;
  id: string;
  rel: IdentityRelation;
  a_kind: string;
  a_id: string;
  b_kind: string;
  b_id: string;
  valid_from: unknown;
  valid_to: unknown;
  created_at: unknown;
  updated_at: unknown;
  deleted_at: unknown;
}>;

type RawNodeSnapshotRow = Readonly<{
  kind: string;
  id: string;
  valid_from: unknown;
  valid_to: unknown;
  created_at: unknown;
  deleted_at: unknown;
}>;

type RawClosureClassRow = Readonly<{
  member_kind: string;
  member_id: string;
}>;

type RawSeedClassAnchorRow = Readonly<{
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

type NodeSnapshot = Readonly<{
  ref: PlainNodeRef;
  validFrom: string | undefined;
  validTo: string | undefined;
  createdAt: string;
  deletedAt: string | undefined;
}>;

type IdentitySnapshot = Readonly<{
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

function registeredPlainRef<G extends GraphDef>(
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
  return JSON.stringify([ref.kind, ref.id]);
}

/**
 * Projects a stored assertion row into the interchange transfer shape. The row
 * must already be normalized (see `normalizeAssertionRow`); raw driver rows
 * carry dialect-specific timestamp and NULL spellings this shape does not.
 */
export function toTransferAssertion(
  row: IdentityAssertionStorageRow,
): IdentityTransferAssertion {
  return {
    id: row.id,
    relation: row.rel,
    a: { kind: row.a_kind, id: row.a_id },
    b: { kind: row.b_kind, id: row.b_id },
    validFrom: row.valid_from,
    ...(row.valid_to === undefined ? {} : { validTo: row.valid_to }),
  };
}

/**
 * Whether `ref` is one of `members`.
 *
 * Keys the probe once instead of re-serializing it for every member, which
 * an inline `members.some((m) => refKey(m) === refKey(ref))` does.
 */
function containsRef(
  members: readonly PlainNodeRef[],
  ref: PlainNodeRef,
): boolean {
  const key = refKey(ref);
  return members.some((member) => refKey(member) === key);
}

function compareReferences(left: PlainNodeRef, right: PlainNodeRef): number {
  const kindOrder = compareCodePoints(left.kind, right.kind);
  return kindOrder === 0 ? compareCodePoints(left.id, right.id) : kindOrder;
}

function normalizePair(
  first: PlainNodeRef,
  second: PlainNodeRef,
): readonly [PlainNodeRef, PlainNodeRef] {
  return compareReferences(first, second) <= 0 ?
      [first, second]
    : [second, first];
}

// A retraction ends an assertion at "now", but a backward clock skew can make
// now < the row's valid_from — minting an empty (valid_to < valid_from) window
// that validateTransferShape rejects on archival re-import. Clamp the end to
// valid_from so the closed window is at worst zero-width, never negative.
function clampValidTo(timestamp: string, validFrom: string): string {
  return compareCodePoints(timestamp, validFrom) < 0 ? validFrom : timestamp;
}

/**
 * Canonicalizes a driver timestamp read back from an identity relation. Drivers
 * hand back `Date` objects or zoneless strings depending on dialect; identity
 * rows are compared as canonical UTC strings, so an unrepresentable value is a
 * storage-boundary fault rather than a silently skewed comparison.
 */
function toCanonicalIso(value: unknown): string {
  const canonical = canonicalizeDatabaseTimestamp(value);
  if (canonical === undefined) {
    throw new ConfigurationError(
      "Identity relation returned a timestamp that is not a representable instant.",
      { value },
      {
        suggestion:
          "Inspect the identity assertion rows for a corrupt timestamp column.",
      },
    );
  }
  return canonical;
}

function optionalTimestamp(value: unknown): string | undefined {
  return value === undefined || value === null ?
      undefined
    : toCanonicalIso(value);
}

function normalizeAssertionRow(
  row: RawIdentityAssertionRow,
): IdentityAssertionStorageRow {
  return {
    graph_id: row.graph_id,
    id: row.id,
    rel: row.rel,
    a_kind: row.a_kind,
    a_id: row.a_id,
    b_kind: row.b_kind,
    b_id: row.b_id,
    valid_from: toCanonicalIso(row.valid_from),
    valid_to: optionalTimestamp(row.valid_to),
    created_at: toCanonicalIso(row.created_at),
    updated_at: toCanonicalIso(row.updated_at),
    deleted_at: optionalTimestamp(row.deleted_at),
  };
}

function publicAssertion<G extends GraphDef>(
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

function assertionResult<G extends GraphDef>(
  assertion: IdentityAssertion<G>,
  action: IdentityAssertionResult<G>["action"],
): IdentityAssertionResult<G> {
  return { assertion, action };
}

function publicNodeRef<G extends GraphDef>(
  ref: PlainNodeRef,
): GraphNodeReference<G> {
  // Every service entry point validates kinds against the graph registry, and
  // persisted assertion/closure rows are constrained to those same endpoints.
  // Reapply the public per-kind NodeId brand at this storage boundary.
  return ref as GraphNodeReference<G>;
}

/**
 * Serializes identity-affecting writers on one graph (Postgres only; SQLite
 * writers are already serialized by its single-writer lock).
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

async function loadNodeSnapshot(
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
    validFrom: optionalTimestamp(row.valid_from),
    validTo: optionalTimestamp(row.valid_to),
    createdAt: toCanonicalIso(row.created_at),
    deletedAt: optionalTimestamp(row.deleted_at),
  }));
}

function isCurrentClosureCoordinate(
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

async function loadCurrentVisibleMembers(
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

type HistoricalClass = Readonly<{
  structural: readonly PlainNodeRef[];
  visible: readonly PlainNodeRef[];
}>;

async function loadHistoricalClasses(
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

function visibleMembersAtCoordinate<G extends GraphDef>(
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

async function loadAssertions(
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
  return rows.map((row) => normalizeAssertionRow(row));
}

function referenceCondition(
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

async function loadAssertionsTouching(
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
  return rows.map((row) => normalizeAssertionRow(row));
}

async function loadSpanningDifferentAssertion(
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

/** @internal Exported for the stack-safety / union-by-size regression test. */
export class UnionFind {
  readonly #parents = new Map<string, string>();
  readonly #sizes = new Map<string, number>();
  readonly #refs = new Map<string, PlainNodeRef>();

  add(ref: PlainNodeRef): void {
    const key = refKey(ref);
    if (this.#parents.has(key)) return;
    this.#parents.set(key, key);
    this.#sizes.set(key, 1);
    this.#refs.set(key, ref);
  }

  // Iterative walk-then-compress: an adversarially ordered chain of unions can
  // build O(N) depth, which a recursive find would blow the stack on.
  #find(key: string): string {
    let root = key;
    for (;;) {
      const parent = this.#parents.get(root);
      if (parent === undefined) {
        throw new Error(`Unknown identity member ${root}`);
      }
      if (parent === root) break;
      root = parent;
    }
    let cursor = key;
    while (cursor !== root) {
      const next = requireDefined(
        this.#parents.get(cursor),
        `Unknown identity member ${cursor}`,
      );
      this.#parents.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  // Union by size keeps trees shallow. Canonical member selection is
  // independent of root identity — components() sorts each group and takes the
  // code-point-least member — so linking by size never changes the closure.
  union(first: PlainNodeRef, second: PlainNodeRef): void {
    this.add(first);
    this.add(second);
    const firstRoot = this.#find(refKey(first));
    const secondRoot = this.#find(refKey(second));
    if (firstRoot === secondRoot) return;
    const firstSize = requireDefined(this.#sizes.get(firstRoot));
    const secondSize = requireDefined(this.#sizes.get(secondRoot));
    const [root, child] =
      firstSize >= secondSize ?
        [firstRoot, secondRoot]
      : [secondRoot, firstRoot];
    this.#parents.set(child, root);
    this.#sizes.set(root, firstSize + secondSize);
  }

  // Public root accessor for callers that maintain their own member index
  // incrementally (bulkAssertPairs) rather than re-deriving components().
  root(ref: PlainNodeRef): string {
    return this.#find(refKey(ref));
  }

  components(): ReadonlyMap<string, readonly PlainNodeRef[]> {
    const groups = new Map<string, PlainNodeRef[]>();
    for (const [key, ref] of this.#refs) {
      const root = this.#find(key);
      const group = groups.get(root) ?? [];
      group.push(ref);
      groups.set(root, group);
    }
    const byMember = new Map<string, readonly PlainNodeRef[]>();
    for (const group of groups.values()) {
      const sorted = group.toSorted((left, right) =>
        compareReferences(left, right),
      );
      for (const member of sorted) byMember.set(refKey(member), sorted);
    }
    return byMember;
  }
}

function buildComponents(
  structuralNodes: readonly PlainNodeRef[],
  assertions: readonly IdentityAssertionStorageRow[],
  sameIdAcrossKinds: "fold" | "ignore",
): ReadonlyMap<string, readonly PlainNodeRef[]> {
  const unionFind = new UnionFind();
  const byId = new Map<string, PlainNodeRef[]>();
  for (const ref of structuralNodes) {
    unionFind.add(ref);
    const group = byId.get(ref.id) ?? [];
    group.push(ref);
    byId.set(ref.id, group);
  }
  if (sameIdAcrossKinds === "fold") {
    for (const group of byId.values()) {
      const first = group[0];
      if (first === undefined) continue;
      for (const member of group.slice(1)) unionFind.union(first, member);
    }
  }
  for (const assertion of assertions) {
    if (assertion.rel !== "same") continue;
    unionFind.union(
      { kind: assertion.a_kind, id: assertion.a_id },
      { kind: assertion.b_kind, id: assertion.b_id },
    );
  }
  return unionFind.components();
}

async function loadSnapshot(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  coordinate?: ReadCoordinate,
  allowedKinds?: ReadonlySet<string>,
  sameIdAcrossKinds: "fold" | "ignore" = "fold",
): Promise<IdentitySnapshot> {
  const currentInstant = nowIso();
  const [nodes, assertions] = await Promise.all([
    loadNodeSnapshot(target, schema, graphId, coordinate),
    loadAssertions(target, schema, graphId, coordinate, currentInstant),
  ]);
  const scopedNodes =
    allowedKinds === undefined ? nodes : (
      nodes.filter((node) => allowedKinds.has(node.ref.kind))
    );
  const scopedAssertions =
    allowedKinds === undefined ? assertions : (
      assertions.filter(
        (assertion) =>
          allowedKinds.has(assertion.a_kind) &&
          allowedKinds.has(assertion.b_kind),
      )
    );
  const structuralNodes = scopedNodes
    .filter((node) => node.deletedAt === undefined)
    .map((node) => node.ref);
  return {
    nodes: scopedNodes,
    structuralNodes,
    assertions: scopedAssertions,
    components: buildComponents(
      structuralNodes,
      scopedAssertions,
      sameIdAcrossKinds,
    ),
  };
}

function componentFor(
  snapshot: IdentitySnapshot,
  ref: PlainNodeRef,
): readonly PlainNodeRef[] {
  return snapshot.components.get(refKey(ref)) ?? [ref];
}

function sameComponent(
  snapshot: IdentitySnapshot,
  first: PlainNodeRef,
  second: PlainNodeRef,
): boolean {
  return containsRef(componentFor(snapshot, first), second);
}

function kindsOf(members: readonly PlainNodeRef[]): ReadonlySet<string> {
  return new Set(members.map((member) => member.kind));
}

/**
 * Disjointness is a property of kinds, not of members, so an identity class of
 * n members carries at most as many distinct kinds as the registry declares.
 * Collapsing each class to its kind set before the pairwise scan keeps the check
 * quadratic in kinds instead of in class size. `Set` preserves first-insertion
 * order, so the reported pair is the same one the member-pair scan found.
 */
function classHasDisjointKinds(
  registry: KindRegistry,
  first: readonly PlainNodeRef[],
  second: readonly PlainNodeRef[],
): readonly [string, string] | undefined {
  return kindSetsHaveDisjointKinds(registry, kindsOf(first), kindsOf(second));
}

function kindSetsHaveDisjointKinds(
  registry: KindRegistry,
  first: ReadonlySet<string>,
  second: ReadonlySet<string>,
): readonly [string, string] | undefined {
  for (const left of first) {
    for (const right of second) {
      if (registry.areDisjoint(left, right)) return [left, right];
    }
  }
  return undefined;
}

type DifferentAssertionIndex = Map<
  string,
  Map<string, IdentityAssertionStorageRow>
>;

function indexDifferentAssertion(
  index: DifferentAssertionIndex,
  firstRoot: string,
  secondRoot: string,
  assertion: IdentityAssertionStorageRow,
): void {
  const firstNeighbors =
    index.get(firstRoot) ?? new Map<string, IdentityAssertionStorageRow>();
  const secondNeighbors =
    index.get(secondRoot) ?? new Map<string, IdentityAssertionStorageRow>();
  if (!firstNeighbors.has(secondRoot)) {
    firstNeighbors.set(secondRoot, assertion);
  }
  if (!secondNeighbors.has(firstRoot)) {
    secondNeighbors.set(firstRoot, assertion);
  }
  index.set(firstRoot, firstNeighbors);
  index.set(secondRoot, secondNeighbors);
}

function mergeDifferentAssertionRoots(
  index: DifferentAssertionIndex,
  survivingRoot: string,
  retiredRoot: string,
): void {
  const survivingNeighbors =
    index.get(survivingRoot) ?? new Map<string, IdentityAssertionStorageRow>();
  const retiredNeighbors = index.get(retiredRoot);
  survivingNeighbors.delete(retiredRoot);
  if (retiredNeighbors !== undefined) {
    for (const [neighborRoot, assertion] of retiredNeighbors) {
      if (neighborRoot === survivingRoot) continue;
      const canonicalAssertion =
        survivingNeighbors.get(neighborRoot) ?? assertion;
      survivingNeighbors.set(neighborRoot, canonicalAssertion);
      const neighborMap = index.get(neighborRoot);
      if (neighborMap !== undefined) {
        neighborMap.delete(retiredRoot);
        neighborMap.set(survivingRoot, canonicalAssertion);
      }
    }
  }
  index.delete(retiredRoot);
  if (survivingNeighbors.size === 0) {
    index.delete(survivingRoot);
  } else {
    index.set(survivingRoot, survivingNeighbors);
  }
}

function spanningDifferentAssertion(
  assertions: readonly IdentityAssertionStorageRow[],
  first: readonly PlainNodeRef[],
  second: readonly PlainNodeRef[],
): IdentityAssertionStorageRow | undefined {
  const firstKeys = new Set(first.map((ref) => refKey(ref)));
  const secondKeys = new Set(second.map((ref) => refKey(ref)));
  return assertions.find((assertion) => {
    if (assertion.rel !== "different") return false;
    const a = refKey({ kind: assertion.a_kind, id: assertion.a_id });
    const b = refKey({ kind: assertion.b_kind, id: assertion.b_id });
    return (
      (firstKeys.has(a) && secondKeys.has(b)) ||
      (firstKeys.has(b) && secondKeys.has(a))
    );
  });
}

function validateSnapshotIntegrity(
  snapshot: IdentitySnapshot,
  registry: KindRegistry,
  graphId: string,
): void {
  const structuralKeys = new Set(
    snapshot.structuralNodes.map((ref) => refKey(ref)),
  );
  for (const assertion of snapshot.assertions) {
    const a = { kind: assertion.a_kind, id: assertion.a_id };
    const b = { kind: assertion.b_kind, id: assertion.b_id };
    if (!structuralKeys.has(refKey(a)) || !structuralKeys.has(refKey(b))) {
      throw new ConfigurationError(
        "Operational Identity contains a current assertion with a missing or deleted endpoint.",
        {
          code: "IDENTITY_SCHEMA_CONTRADICTION",
          graphId,
          assertionId: assertion.id,
          a,
          b,
        },
      );
    }
    if (assertion.rel === "different" && sameComponent(snapshot, a, b)) {
      throw new ConfigurationError(
        "Operational Identity contains a different assertion within one identity class.",
        {
          code: "IDENTITY_SCHEMA_CONTRADICTION",
          graphId,
          assertionId: assertion.id,
          a,
          b,
        },
      );
    }
  }

  const visited = new Set<string>();
  for (const [memberKey, component] of snapshot.components) {
    if (visited.has(memberKey)) continue;
    for (const member of component) visited.add(refKey(member));
    // Self-pairs are safe to include: `areDisjoint(kind, kind)` is false by
    // construction, so scanning the component's kind set against itself finds
    // exactly the member pairs an upper-triangle member scan would.
    const conflictingKinds = classHasDisjointKinds(
      registry,
      component,
      component,
    );
    if (conflictingKinds !== undefined) {
      throw new ConfigurationError(
        "Operational Identity class conflicts with ontology disjointness.",
        {
          code: "IDENTITY_SCHEMA_CONTRADICTION",
          graphId,
          classMembers: component,
          conflictingKinds,
        },
      );
    }
  }
}

type RawClosureRow = RawClosureClassRow &
  Readonly<{ class_kind: string; class_id: string }>;

function closureMismatchError(
  graphId: string,
  detail: Record<string, unknown>,
): ConfigurationError {
  return new ConfigurationError(
    "Operational Identity materialized closure does not match computed identity components.",
    { code: "IDENTITY_SCHEMA_CONTRADICTION", graphId, ...detail },
    {
      suggestion:
        "Run rebuildIdentityClosure(store) to rebuild the materialized identity closure.",
    },
  );
}

/**
 * Asserts the persisted `identityClosureTable` matches the closure the engine
 * derives from the current snapshot, so a stale or corrupted materialized
 * closure — which every current read trusts — cannot pass verification
 * silently. The expected rows are emitted by the same rule as
 * {@link insertClosureComponents}: only components with two or more members
 * carry rows, each member labeled with the component's code-point-least member;
 * singletons carry none.
 */
async function assertClosureMatchesComponents(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  components: ReadonlyMap<string, readonly PlainNodeRef[]>,
): Promise<void> {
  const expected = new Map<
    string,
    Readonly<{ member: PlainNodeRef; classRef: PlainNodeRef }>
  >();
  const emitted = new Set<string>();
  for (const [memberKey, component] of components) {
    if (emitted.has(memberKey) || component.length < 2) continue;
    const canonical = requireDefined(component[0]);
    for (const member of component) {
      const key = refKey(member);
      emitted.add(key);
      expected.set(key, { member, classRef: canonical });
    }
  }

  const rows = await target.execute<RawClosureRow>(
    asCompiledRowsSql(sql`
      SELECT member_kind, member_id, class_kind, class_id
      FROM ${schema.identityClosureTable}
      WHERE graph_id = ${graphId}
    `),
  );
  const seen = new Set<string>();
  for (const row of rows) {
    const member = { kind: row.member_kind, id: row.member_id };
    const memberKey = refKey(member);
    const match = expected.get(memberKey);
    if (
      match?.classRef.kind !== row.class_kind ||
      match.classRef.id !== row.class_id
    ) {
      throw closureMismatchError(graphId, {
        member,
        class: { kind: row.class_kind, id: row.class_id },
        expectedClass: match?.classRef,
      });
    }
    seen.add(memberKey);
  }
  for (const [memberKey, { member, classRef }] of expected) {
    if (seen.has(memberKey)) continue;
    throw closureMismatchError(graphId, {
      member,
      expectedClass: classRef,
      reason: "missing-closure-row",
    });
  }
}

function selfAssertionError(relation: IdentityRelation): ValidationError {
  return new ValidationError(
    `Identity ${relation} assertions require two distinct node references.`,
    {
      issues: [
        {
          path: "pair",
          message: "Identity self-assertions are not allowed",
          code: "IDENTITY_SELF_ASSERTION",
        },
      ],
    },
    {
      suggestion:
        "Filter reflexive pairs before calling an identity assertion method.",
    },
  );
}

async function requireLiveEndpoint(
  target: Backend,
  graphId: string,
  ref: PlainNodeRef,
): Promise<void> {
  const row = await target.getNode(graphId, ref.kind, ref.id);
  if (row === undefined || row.deleted_at !== undefined) {
    throw new NodeNotFoundError(ref.kind, ref.id);
  }
}

async function loadLiveReferences(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  references: readonly PlainNodeRef[],
): Promise<readonly PlainNodeRef[]> {
  if (references.length === 0) return [];
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 1,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 2,
  });
  if (references.length > chunkSize) {
    const byKey = new Map<string, PlainNodeRef>();
    for (const refChunk of chunk(references, chunkSize)) {
      const live = await loadLiveReferences(target, schema, graphId, refChunk);
      for (const ref of live) byKey.set(refKey(ref), ref);
    }
    return [...byKey.values()];
  }
  const matches = referenceCondition(sql`kind`, sql`id`, references);
  const rows = await target.execute<Readonly<{ kind: string; id: string }>>(
    asCompiledRowsSql(sql`
      SELECT kind, id
      FROM ${schema.nodesTable}
      WHERE graph_id = ${graphId}
        AND deleted_at IS NULL
        AND ${matches}
    `),
  );
  return rows.map((row) => ({ kind: row.kind, id: row.id }));
}

async function requireLiveEndpoints(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  references: readonly PlainNodeRef[],
): Promise<void> {
  const uniqueByKey = new Map<string, PlainNodeRef>();
  for (const ref of references) uniqueByKey.set(refKey(ref), ref);
  const live = await loadLiveReferences(target, schema, graphId, references);
  const liveKeys = new Set(live.map((ref) => refKey(ref)));
  for (const [key, ref] of uniqueByKey) {
    if (!liveKeys.has(key)) throw new NodeNotFoundError(ref.kind, ref.id);
  }
}

/**
 * Requires every reference to name a node ROW — deleted or not. Ended
 * assertions take the raw-INSERT import branch and never touch the closure,
 * but historical reconstruction still conducts identity through them, so an
 * endpoint that never existed would become a phantom bridge: two real nodes
 * reporting `areSame` at an `asOf` coordinate via a node no one ever wrote.
 * The store's own archival exports satisfy this by construction (hard
 * deletion removes the assertions touching the node), so only hand-built
 * documents are refused.
 */
async function requireStructuralEndpoints(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  references: readonly PlainNodeRef[],
): Promise<void> {
  if (references.length === 0) return;
  const uniqueByKey = new Map<string, PlainNodeRef>();
  for (const ref of references) uniqueByKey.set(refKey(ref), ref);
  const unique = [...uniqueByKey.values()];
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 1,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 2,
  });
  const presentKeys = new Set<string>();
  for (const refChunk of chunk(unique, chunkSize)) {
    const matches = referenceCondition(sql`kind`, sql`id`, refChunk);
    const rows = await target.execute<Readonly<{ kind: string; id: string }>>(
      asCompiledRowsSql(sql`
        SELECT kind, id
        FROM ${schema.nodesTable}
        WHERE graph_id = ${graphId}
          AND ${matches}
      `),
    );
    for (const row of rows) {
      presentKeys.add(refKey({ kind: row.kind, id: row.id }));
    }
  }
  for (const [key, ref] of uniqueByKey) {
    if (!presentKeys.has(key)) throw new NodeNotFoundError(ref.kind, ref.id);
  }
}

async function validateCurrentRelation(
  ctx: Pick<
    IdentityServiceContext<GraphDef>,
    "graphId" | "registry" | "schema"
  >,
  target: Backend,
  relation: IdentityRelation,
  operation: IdentityContradictionErrorDetails["operation"],
  a: PlainNodeRef,
  b: PlainNodeRef,
): Promise<void> {
  const classes = await loadCurrentStructuralClasses(
    target,
    ctx.schema,
    ctx.graphId,
    [a, b],
  );
  const aClass = requireDefined(classes.get(refKey(a)));
  const bClass = requireDefined(classes.get(refKey(b)));
  if (relation === "different") {
    if (!containsRef(aClass, b)) return;
    throw new IdentityContradictionError({
      operation,
      a,
      b,
      reason: "same-class",
    });
  }

  // Whether the two classes are held apart is a single index probe on the
  // derived separation relation. Every caller reaches here with the relation in
  // step with the ledger: each one repairs it inside the same transaction as
  // the write it validates, before the next validation runs.
  const aKey = currentClassKey(aClass);
  const bKey = currentClassKey(bClass);
  if (await isSeparated(target, ctx.schema, ctx.graphId, aKey, bKey)) {
    // The relation records THAT the classes are separated, not which assertion
    // separates them, and the typed error names one — so the ledger answers
    // that single question, on the refusal path only.
    const different = await loadSpanningDifferentAssertion(
      target,
      ctx.schema,
      ctx.graphId,
      aClass,
      bClass,
    );
    if (different === undefined)
      throw unexpectedSeparationError(ctx.graphId, aKey, bKey);
    throw new IdentityContradictionError({
      operation,
      a,
      b,
      reason: "different-assertion",
      conflictingAssertionId: different.id,
    });
  }
  const disjointKinds = classHasDisjointKinds(ctx.registry, aClass, bClass);
  if (disjointKinds === undefined) return;
  throw new IdentityContradictionError({
    operation,
    a,
    b,
    reason: "disjoint-kinds",
    conflictingKinds: disjointKinds,
  });
}

async function currentAssertionForPair(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  relation: IdentityRelation,
  a: PlainNodeRef,
  b: PlainNodeRef,
): Promise<IdentityAssertionStorageRow | undefined> {
  const rows = await target.execute<RawIdentityAssertionRow>(
    asCompiledRowsSql(sql`
      SELECT ${IDENTITY_ASSERTION_COLUMNS}
      FROM ${schema.identityAssertionsTable}
      WHERE graph_id = ${graphId}
        AND rel = ${relation}
        AND a_kind = ${a.kind}
        AND a_id = ${a.id}
        AND b_kind = ${b.kind}
        AND b_id = ${b.id}
        AND valid_to IS NULL
        AND deleted_at IS NULL
      LIMIT 1
    `),
  );
  return rows[0] === undefined ? undefined : normalizeAssertionRow(rows[0]);
}

async function insertAssertion(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  relation: IdentityRelation,
  a: PlainNodeRef,
  b: PlainNodeRef,
  timestamp: string,
  touch: IdentityTouch,
  preserved?: Readonly<{ id: string; validFrom: string }>,
): Promise<IdentityAssertionStorageRow> {
  const row = buildAssertionRow(graphId, relation, a, b, timestamp, preserved);
  await insertAssertionRows(target, schema, [row]);
  touch(graphId, row.id, row);
  return row;
}

function buildAssertionRow(
  graphId: string,
  relation: IdentityRelation,
  a: PlainNodeRef,
  b: PlainNodeRef,
  timestamp: string,
  preserved?: Readonly<{ id: string; validFrom: string }>,
): IdentityAssertionStorageRow {
  return {
    graph_id: graphId,
    id: preserved?.id ?? generateId(),
    rel: relation,
    a_kind: a.kind,
    a_id: a.id,
    b_kind: b.kind,
    b_id: b.id,
    valid_from: preserved?.validFrom ?? timestamp,
    valid_to: undefined,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: undefined,
  };
}

async function insertAssertionRows(
  target: Backend,
  schema: SqlSchema,
  rows: readonly IdentityAssertionStorageRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 0,
    maxItems: MAX_ASSERTION_INSERT_CHUNK_SIZE,
    parametersPerItem: 12,
  });
  for (const rowChunk of chunk(rows, chunkSize)) {
    const values = rowChunk.map((row) => {
      const validTo =
        row.valid_to === undefined ? sql`NULL` : sql`${row.valid_to}`;
      const deletedAt =
        row.deleted_at === undefined ? sql`NULL` : sql`${row.deleted_at}`;
      return sql`
        (
                ${row.graph_id}, ${row.id}, ${row.rel}, ${row.a_kind}, ${row.a_id},
                ${row.b_kind}, ${row.b_id}, ${row.valid_from}, ${validTo},
                ${row.created_at}, ${row.updated_at}, ${deletedAt}
              )
      `;
    });
    await executeIdentityStatement(
      target,
      sql`
        INSERT INTO ${schema.identityAssertionsTable} (${IDENTITY_ASSERTION_COLUMNS}) VALUES ${sql.join(values, sql`, `)}
      `,
    );
  }
}

export async function loadAssertionsByIds(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  ids: readonly string[],
): Promise<Map<string, IdentityAssertionStorageRow>> {
  const uniqueIds = [...new Set(ids)];
  const byId = new Map<string, IdentityAssertionStorageRow>();
  if (uniqueIds.length === 0) return byId;
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
    const rows = await target.execute<RawIdentityAssertionRow>(
      asCompiledRowsSql(sql`
        SELECT ${IDENTITY_ASSERTION_COLUMNS}
        FROM ${schema.identityAssertionsTable}
        WHERE graph_id = ${graphId} AND id IN (${idList})
      `),
    );
    for (const row of rows) {
      byId.set(row.id, normalizeAssertionRow(row));
    }
  }
  return byId;
}

/**
 * The class REPRESENTATIVE of each reference — the closure anchor row, or the
 * reference itself when it is a singleton.
 *
 * {@link loadCurrentStructuralClasses} answers the same question but also
 * materializes every member of every class; the separation projection needs
 * only the label, so this stops at the anchor join.
 */
async function loadCurrentClassAnchors(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  references: readonly PlainNodeRef[],
): Promise<ReadonlyMap<string, PlainNodeRef>> {
  const uniqueByKey = new Map<string, PlainNodeRef>();
  for (const ref of references) uniqueByKey.set(refKey(ref), ref);
  const uniqueReferences = [...uniqueByKey.values()];
  const anchors = new Map<string, PlainNodeRef>();
  if (uniqueReferences.length === 0) return anchors;
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 1,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 2,
  });
  for (const refChunk of chunk(uniqueReferences, chunkSize)) {
    const seedRows = sql.join(
      refChunk.map((ref) => sql`(${ref.kind}, ${ref.id})`),
      sql`, `,
    );
    const rows = await target.execute<RawSeedClassAnchorRow>(
      asCompiledRowsSql(sql`
        WITH seeds(seed_kind, seed_id) AS (
          VALUES ${seedRows}
        )
        SELECT seeds.seed_kind, seeds.seed_id,
               COALESCE(anchor.class_kind, seeds.seed_kind) AS class_kind,
               COALESCE(anchor.class_id, seeds.seed_id) AS class_id
        FROM seeds
        LEFT JOIN ${schema.identityClosureTable} anchor
          ON anchor.graph_id = ${graphId}
         AND anchor.member_kind = seeds.seed_kind
         AND anchor.member_id = seeds.seed_id
      `),
    );
    for (const row of rows) {
      anchors.set(refKey({ kind: row.seed_kind, id: row.seed_id }), {
        kind: row.class_kind,
        id: row.class_id,
      });
    }
  }
  return anchors;
}

/**
 * The separation class key of an already-RESOLVED current class.
 *
 * A class is labelled by its code-point-least member: `insertClosureComponents`
 * and `mergeCurrentClasses` both anchor a class on the first member of its
 * `compareReferences` ordering, and {@link loadCurrentStructuralClasses}
 * returns members in that same ordering — so `members[0]` is the anchor
 * {@link loadCurrentClassAnchors} hands the separation writer, without a second
 * round trip to fetch it. {@link snapshotClassKey} reads a snapshot the same
 * way.
 */
function currentClassKey(members: readonly PlainNodeRef[]): string {
  return identityClassKey(requireDefined(members[0]));
}

/** The class key a full snapshot assigns to a reference. */
function snapshotClassKey(
  snapshot: IdentitySnapshot,
  ref: PlainNodeRef,
): string {
  return identityClassKey(requireDefined(componentFor(snapshot, ref)[0]));
}

/**
 * Rewrites every separation row whose class pair could have moved, given the
 * members of the classes a mutation touched.
 *
 * Deleting by MEMBER key rather than by class key is what makes this complete:
 * a fuse retires one of the two class keys, and rows carrying the retired key
 * are reachable only through the member it used to label.
 */
async function replaceSeparationForMembers(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  members: readonly PlainNodeRef[],
): Promise<void> {
  const uniqueByKey = new Map<string, PlainNodeRef>();
  for (const member of members) uniqueByKey.set(refKey(member), member);
  const unique = [...uniqueByKey.values()];
  if (unique.length === 0) return;
  await deleteSeparationForClassKeys(
    target,
    schema,
    graphId,
    unique.map((member) => identityClassKey(member)),
  );
  const assertions = await loadAssertionsTouching(
    target,
    schema,
    graphId,
    unique,
    undefined,
    "different",
  );
  if (assertions.length === 0) return;
  const endpoints = assertions.flatMap((assertion) => [
    { kind: assertion.a_kind, id: assertion.a_id },
    { kind: assertion.b_kind, id: assertion.b_id },
  ]);
  const anchors = await loadCurrentClassAnchors(
    target,
    schema,
    graphId,
    endpoints,
  );
  await insertSeparationRows(
    target,
    schema,
    graphId,
    buildSeparationProjection(assertions, (ref) =>
      identityClassKey(requireDefined(anchors.get(refKey(ref)))),
    ),
  );
}

/**
 * The separation repair for a mutation that changed no identity class — a
 * `different` assertion arriving or ending. The classes stay put, so the
 * affected members are simply the members of the endpoints' current classes.
 */
async function replaceSeparationForReferences(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  references: readonly PlainNodeRef[],
): Promise<void> {
  if (references.length === 0) return;
  const classes = await loadCurrentStructuralClasses(
    target,
    schema,
    graphId,
    references,
  );
  await replaceSeparationForMembers(
    target,
    schema,
    graphId,
    [...classes.values()].flat(),
  );
}

async function replaceClosure(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  allowedKinds?: ReadonlySet<string>,
  sameIdAcrossKinds: "fold" | "ignore" = "fold",
): Promise<void> {
  const snapshot = await loadSnapshot(
    target,
    schema,
    graphId,
    undefined,
    allowedKinds,
    sameIdAcrossKinds,
  );
  await executeIdentityStatement(
    target,
    sql`DELETE FROM ${schema.identityClosureTable} WHERE graph_id = ${graphId}`,
  );
  await insertClosureComponents(target, schema, graphId, snapshot.components);
  await deleteSeparationForGraph(target, schema, graphId);
  await insertSeparationRows(
    target,
    schema,
    graphId,
    buildSeparationProjection(snapshot.assertions, (ref) =>
      snapshotClassKey(snapshot, ref),
    ),
  );
}

async function insertClosureComponents(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  components: ReadonlyMap<string, readonly PlainNodeRef[]>,
): Promise<void> {
  const emitted = new Set<string>();
  const values: SqlFragment[] = [];
  for (const [memberKey, component] of components) {
    if (emitted.has(memberKey) || component.length < 2) continue;
    const canonical = requireDefined(component[0]);
    for (const member of component) {
      emitted.add(refKey(member));
      values.push(
        sql`(${graphId}, ${member.kind}, ${member.id}, ${canonical.kind}, ${canonical.id})`,
      );
    }
  }
  if (values.length === 0) return;
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 0,
    maxItems: MAX_CLOSURE_INSERT_CHUNK_SIZE,
    parametersPerItem: 5,
  });
  for (const valueChunk of chunk(values, chunkSize)) {
    await executeIdentityStatement(
      target,
      sql`
        INSERT INTO ${schema.identityClosureTable} (
          graph_id, member_kind, member_id, class_kind, class_id
        ) VALUES ${sql.join(valueChunk, sql`, `)}
      `,
    );
  }
}

async function replaceAffectedClosure(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  references: readonly PlainNodeRef[],
  sameIdAcrossKinds: "fold" | "ignore" = "fold",
): Promise<void> {
  if (references.length === 0) return;
  const affectedByKey = new Map<string, PlainNodeRef>();
  const classes = await loadCurrentStructuralClasses(
    target,
    schema,
    graphId,
    references,
  );
  for (const ref of references) {
    for (const member of requireDefined(classes.get(refKey(ref)))) {
      affectedByKey.set(refKey(member), member);
    }
  }
  const affected = [...affectedByKey.values()];
  const structuralNodes = await loadLiveReferences(
    target,
    schema,
    graphId,
    affected,
  );
  const assertions = await loadAssertionsTouching(
    target,
    schema,
    graphId,
    affected,
    undefined,
    "same",
  );
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 1,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 2,
  });
  for (const affectedChunk of chunk(affected, chunkSize)) {
    const matches = referenceCondition(
      sql`member_kind`,
      sql`member_id`,
      affectedChunk,
    );
    await executeIdentityStatement(
      target,
      sql`
        DELETE FROM ${schema.identityClosureTable}
        WHERE graph_id = ${graphId} AND ${matches}
      `,
    );
  }
  const components = buildComponents(
    structuralNodes,
    assertions,
    sameIdAcrossKinds,
  );
  await insertClosureComponents(target, schema, graphId, components);
  // A recomputed component can ABSORB a member that was outside the affected
  // set — only when the ledger disagrees with the materialized closure, which
  // is exactly the state the separation relation exists to catch. Its old
  // singleton class is gone, so its rows must be rewritten too.
  const separationMembers = [...affected, ...[...components.values()].flat()];
  await replaceSeparationForMembers(target, schema, graphId, separationMembers);
}

async function mergeCurrentClasses(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  a: PlainNodeRef,
  b: PlainNodeRef,
): Promise<void> {
  const classes = await loadCurrentStructuralClasses(target, schema, graphId, [
    a,
    b,
  ]);
  const aClass = requireDefined(classes.get(refKey(a)));
  const bClass = requireDefined(classes.get(refKey(b)));
  if (containsRef(aClass, b)) return;

  const fusedMembers = [...aClass, ...bClass];
  const [smaller, larger] =
    aClass.length <= bClass.length ? [aClass, bClass] : [bClass, aClass];
  const canonical = requireDefined(
    [...aClass, ...bClass].toSorted((left, right) =>
      compareReferences(left, right),
    )[0],
  );

  async function relabelExistingClass(
    members: readonly PlainNodeRef[],
  ): Promise<void> {
    if (members.length < 2) return;
    const previousCanonical = requireDefined(members[0]);
    if (refKey(previousCanonical) === refKey(canonical)) return;
    await executeIdentityStatement(
      target,
      sql`
        UPDATE ${schema.identityClosureTable}
        SET class_kind = ${canonical.kind}, class_id = ${canonical.id}
        WHERE graph_id = ${graphId}
          AND class_kind = ${previousCanonical.kind}
          AND class_id = ${previousCanonical.id}
      `,
    );
  }

  await relabelExistingClass(smaller);
  await relabelExistingClass(larger);
  const singletonMembers = [smaller, larger].flatMap((members) =>
    members.length === 1 ? members : [],
  );
  if (singletonMembers.length > 0) {
    const values = singletonMembers.map(
      (member) =>
        sql`(${graphId}, ${member.kind}, ${member.id}, ${canonical.kind}, ${canonical.id})`,
    );
    await executeIdentityStatement(
      target,
      sql`
        INSERT INTO ${schema.identityClosureTable} (
          graph_id, member_kind, member_id, class_kind, class_id
        ) VALUES ${sql.join(values, sql`, `)}
      `,
    );
  }
  // Relabelled in the SAME statement batch as the closure: if the two fused
  // classes were separated, both sides of their row become `canonical` and the
  // relation's CHECK aborts the transaction.
  await replaceSeparationForMembers(target, schema, graphId, fusedMembers);
}

async function assertPair<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  target: Backend,
  relation: IdentityRelation,
  firstInput: IdentityNodeRefInput<G>,
  secondInput: IdentityNodeRefInput<G>,
  touch: IdentityTouch,
): Promise<IdentityAssertionResult<G>> {
  const first = registeredPlainRef(ctx, firstInput);
  const second = registeredPlainRef(ctx, secondInput);
  if (refKey(first) === refKey(second)) throw selfAssertionError(relation);
  const [a, b] = normalizePair(first, second);
  await Promise.all([
    requireLiveEndpoint(target, ctx.graphId, a),
    requireLiveEndpoint(target, ctx.graphId, b),
  ]);
  const existing = await currentAssertionForPair(
    target,
    ctx.schema,
    ctx.graphId,
    relation,
    a,
    b,
  );
  if (existing !== undefined) {
    return assertionResult(publicAssertion(existing), "existing");
  }

  await validateCurrentRelation(
    ctx,
    target,
    relation,
    relation === "same" ? "assertSame" : "assertDifferent",
    a,
    b,
  );
  const row = await insertAssertion(
    target,
    ctx.schema,
    ctx.graphId,
    relation,
    a,
    b,
    nowIso(),
    touch,
  );
  if (relation === "same") {
    await mergeCurrentClasses(target, ctx.schema, ctx.graphId, a, b);
  } else {
    await replaceSeparationForReferences(target, ctx.schema, ctx.graphId, [
      a,
      b,
    ]);
  }
  return assertionResult(publicAssertion(row), "created");
}

function assertionSemanticKey(
  relation: IdentityRelation,
  a: PlainNodeRef,
  b: PlainNodeRef,
): string {
  return JSON.stringify([relation, a.kind, a.id, b.kind, b.id]);
}

async function bulkAssertPairs<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  target: Backend,
  relation: IdentityRelation,
  pairs: readonly Readonly<{
    a: IdentityNodeRefInput<G>;
    b: IdentityNodeRefInput<G>;
  }>[],
  touch: IdentityTouch,
): Promise<readonly IdentityAssertionResult<G>[]> {
  if (pairs.length === 0) return [];
  const normalizedPairs = pairs.map((pair) => {
    const first = registeredPlainRef(ctx, pair.a);
    const second = registeredPlainRef(ctx, pair.b);
    if (refKey(first) === refKey(second)) throw selfAssertionError(relation);
    return normalizePair(first, second);
  });
  const endpoints = normalizedPairs.flatMap(([a, b]) => [a, b]);
  await requireLiveEndpoints(target, ctx.schema, ctx.graphId, endpoints);

  const classes = await loadCurrentStructuralClasses(
    target,
    ctx.schema,
    ctx.graphId,
    endpoints,
  );
  const structuralByKey = new Map<string, PlainNodeRef>();
  for (const members of classes.values()) {
    for (const member of members) structuralByKey.set(refKey(member), member);
  }
  const structuralNodes = [...structuralByKey.values()];
  const persistedAssertions = await loadAssertionsTouching(
    target,
    ctx.schema,
    ctx.graphId,
    structuralNodes,
    undefined,
  );
  const bySemanticKey = new Map(
    persistedAssertions.map((assertion) => [
      assertionSemanticKey(
        assertion.rel,
        { kind: assertion.a_kind, id: assertion.a_id },
        { kind: assertion.b_kind, id: assertion.b_id },
      ),
      assertion,
    ]),
  );

  // Build the union-find ONCE (structural nodes + same-id groups + persisted
  // same-assertions), then union each accepted same pair into it. Per-root kind
  // sets make disjointness independent of class cardinality, and the symmetric
  // different-root index avoids rescanning every persisted assertion per pair.
  const unionFind = new UnionFind();
  const allReferences = new Map<string, PlainNodeRef>();
  const byId = new Map<string, PlainNodeRef[]>();
  for (const ref of structuralNodes) {
    unionFind.add(ref);
    allReferences.set(refKey(ref), ref);
    const group = byId.get(ref.id) ?? [];
    group.push(ref);
    byId.set(ref.id, group);
  }
  if (ctx.sameIdAcrossKinds === "fold") {
    for (const group of byId.values()) {
      const first = group[0];
      if (first === undefined) continue;
      for (const member of group.slice(1)) unionFind.union(first, member);
    }
  }
  for (const assertion of persistedAssertions) {
    const endpointA = { kind: assertion.a_kind, id: assertion.a_id };
    const endpointB = { kind: assertion.b_kind, id: assertion.b_id };
    if (assertion.rel === "same") {
      unionFind.union(endpointA, endpointB);
    } else {
      unionFind.add(endpointA);
      unionFind.add(endpointB);
    }
    allReferences.set(refKey(endpointA), endpointA);
    allReferences.set(refKey(endpointB), endpointB);
  }
  const kindsByRoot = new Map<string, Set<string>>();
  for (const ref of allReferences.values()) {
    const root = unionFind.root(ref);
    const kinds = kindsByRoot.get(root) ?? new Set<string>();
    kinds.add(ref.kind);
    kindsByRoot.set(root, kinds);
  }
  const differentByRoot: DifferentAssertionIndex = new Map();
  for (const assertion of persistedAssertions) {
    if (assertion.rel !== "different") continue;
    const rootA = unionFind.root({
      kind: assertion.a_kind,
      id: assertion.a_id,
    });
    const rootB = unionFind.root({
      kind: assertion.b_kind,
      id: assertion.b_id,
    });
    indexDifferentAssertion(differentByRoot, rootA, rootB, assertion);
  }

  const createdRows: IdentityAssertionStorageRow[] = [];
  const results: IdentityAssertionResult<G>[] = [];
  const closureReferences: PlainNodeRef[] = [];
  const timestamp = nowIso();
  const operation: IdentityContradictionErrorDetails["operation"] =
    relation === "same" ? "assertSame" : "assertDifferent";

  for (const [a, b] of normalizedPairs) {
    const semanticKey = assertionSemanticKey(relation, a, b);
    const existing = bySemanticKey.get(semanticKey);
    if (existing !== undefined) {
      results.push(assertionResult(publicAssertion(existing), "existing"));
      continue;
    }
    const rootA = unionFind.root(a);
    const rootB = unionFind.root(b);
    if (relation === "different") {
      if (rootA === rootB) {
        throw new IdentityContradictionError({
          operation,
          a,
          b,
          reason: "same-class",
        });
      }
    } else {
      const spanning = differentByRoot.get(rootA)?.get(rootB);
      if (spanning !== undefined) {
        throw new IdentityContradictionError({
          operation,
          a,
          b,
          reason: "different-assertion",
          conflictingAssertionId: spanning.id,
        });
      }
      const disjointKinds = kindSetsHaveDisjointKinds(
        ctx.registry,
        kindsByRoot.get(rootA) ?? new Set([a.kind]),
        kindsByRoot.get(rootB) ?? new Set([b.kind]),
      );
      if (disjointKinds !== undefined) {
        throw new IdentityContradictionError({
          operation,
          a,
          b,
          reason: "disjoint-kinds",
          conflictingKinds: disjointKinds,
        });
      }
    }
    const row = buildAssertionRow(ctx.graphId, relation, a, b, timestamp);
    createdRows.push(row);
    bySemanticKey.set(semanticKey, row);
    results.push(assertionResult(publicAssertion(row), "created"));
    if (relation === "same") {
      closureReferences.push(a, b);
      if (rootA !== rootB) {
        unionFind.union(a, b);
        const survivingRoot = unionFind.root(a);
        const retiredRoot = survivingRoot === rootA ? rootB : rootA;
        const survivingKinds =
          kindsByRoot.get(survivingRoot) ?? new Set<string>();
        const retiredKinds = kindsByRoot.get(retiredRoot);
        if (retiredKinds !== undefined) {
          for (const kind of retiredKinds) survivingKinds.add(kind);
        }
        kindsByRoot.delete(retiredRoot);
        kindsByRoot.set(survivingRoot, survivingKinds);
        mergeDifferentAssertionRoots(
          differentByRoot,
          survivingRoot,
          retiredRoot,
        );
      }
    }
  }

  await insertAssertionRows(target, ctx.schema, createdRows);
  for (const row of createdRows) touch(ctx.graphId, row.id, row);
  if (closureReferences.length > 0) {
    await replaceAffectedClosure(
      target,
      ctx.schema,
      ctx.graphId,
      closureReferences,
      ctx.sameIdAcrossKinds,
    );
  } else {
    await replaceSeparationForReferences(
      target,
      ctx.schema,
      ctx.graphId,
      createdRows.flatMap((row) => [
        { kind: row.a_kind, id: row.a_id },
        { kind: row.b_kind, id: row.b_id },
      ]),
    );
  }
  return results;
}

async function findCurrentAssertionById(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  id: string,
): Promise<IdentityAssertionStorageRow | undefined> {
  const rows = await target.execute<RawIdentityAssertionRow>(
    asCompiledRowsSql(sql`
      SELECT ${IDENTITY_ASSERTION_COLUMNS}
      FROM ${schema.identityAssertionsTable}
      WHERE graph_id = ${graphId}
        AND id = ${id}
        AND valid_to IS NULL
        AND deleted_at IS NULL
      LIMIT 1
    `),
  );
  return rows[0] === undefined ? undefined : normalizeAssertionRow(rows[0]);
}

/**
 * Ends the currently-open assertion with the given id, returning the ended
 * pre-image (so callers reuse its endpoints for closure repair instead of
 * re-reading the same row) or `undefined` when no open row matched.
 */
async function retractById(
  ctx: IdentityServiceContext<GraphDef>,
  target: Backend,
  id: string,
  touch: IdentityTouch,
): Promise<IdentityAssertionStorageRow | undefined> {
  const existing = await findCurrentAssertionById(
    target,
    ctx.schema,
    ctx.graphId,
    id,
  );
  if (existing === undefined) return undefined;
  const now = nowIso();
  const validTo = clampValidTo(now, existing.valid_from);
  const ended = { ...existing, valid_to: validTo, updated_at: now };
  await executeIdentityStatement(
    target,
    sql`
      UPDATE ${ctx.schema.identityAssertionsTable}
      SET valid_to = ${validTo}, updated_at = ${now}
      WHERE graph_id = ${ctx.graphId}
        AND id = ${id}
        AND valid_to IS NULL
    `,
  );
  touch(ctx.graphId, id, ended);
  return ended;
}

async function retractByIds(
  ctx: IdentityServiceContext<GraphDef>,
  target: Backend,
  ids: readonly string[],
  touch: IdentityTouch,
): Promise<readonly IdentityAssertionStorageRow[]> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];
  const current: IdentityAssertionStorageRow[] = [];
  const readChunkSize = identityChunkSize(target, {
    fixedParameters: 1,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 1,
  });
  for (const idChunk of chunk(uniqueIds, readChunkSize)) {
    const placeholders = sql.join(
      idChunk.map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = await target.execute<RawIdentityAssertionRow>(
      asCompiledRowsSql(sql`
        SELECT ${IDENTITY_ASSERTION_COLUMNS}
        FROM ${ctx.schema.identityAssertionsTable}
        WHERE graph_id = ${ctx.graphId}
          AND id IN (${placeholders})
          AND valid_to IS NULL
          AND deleted_at IS NULL
      `),
    );
    current.push(...rows.map((row) => normalizeAssertionRow(row)));
  }
  if (current.length === 0) return [];
  const now = nowIso();
  // A single UPDATE cannot clamp per-row against each row's own valid_from, so
  // group ids by the clamped valid_to they need. Rows without skew share the
  // common `now` window; only skewed rows split into their own clamped update.
  const byValidTo = new Map<string, string[]>();
  const endedById = new Map<string, string>();
  for (const row of current) {
    const validTo = clampValidTo(now, row.valid_from);
    endedById.set(row.id, validTo);
    const group = byValidTo.get(validTo) ?? [];
    group.push(row.id);
    byValidTo.set(validTo, group);
  }
  const updateChunkSize = identityChunkSize(target, {
    fixedParameters: 3,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 1,
  });
  for (const [validTo, ids] of byValidTo) {
    for (const idChunk of chunk(ids, updateChunkSize)) {
      const placeholders = sql.join(
        idChunk.map((id) => sql`${id}`),
        sql`, `,
      );
      await executeIdentityStatement(
        target,
        sql`
          UPDATE ${ctx.schema.identityAssertionsTable}
          SET valid_to = ${validTo}, updated_at = ${now}
          WHERE graph_id = ${ctx.graphId}
            AND id IN (${placeholders})
            AND valid_to IS NULL
        `,
      );
    }
  }
  const currentById = new Map(current.map((row) => [row.id, row]));
  const ended = uniqueIds.flatMap((id) => {
    const row = currentById.get(id);
    if (row === undefined) return [];
    return [
      {
        ...row,
        valid_to: requireDefined(endedById.get(row.id)),
        updated_at: now,
      },
    ];
  });
  for (const row of ended) {
    touch(ctx.graphId, row.id, { ...row });
  }
  return ended;
}

async function runIdentityMutation<G extends GraphDef, T>(
  ctx: IdentityServiceContext<G>,
  fn: (
    target: Backend,
    touch: IdentityTouch,
    markWritten: () => void,
  ) => Promise<T>,
): Promise<T> {
  // Track whether the mutation actually touched a row: a successful no-op
  // (retracting an unknown id, an idempotent reassert) must not advance the
  // durable revision clock on revision-tracking stores. `markWritten` is for
  // sub-operations that record their capture touches through their OWN
  // recorded binding (the interchange import does) — the wrapped touch never
  // sees those rows, so the sub-operation must mark the write explicitly or
  // the clock stays unmoved and base@V tokens go stale.
  let touched = false;
  return runInWriteTransaction(
    {
      graphId: ctx.graphId,
      schemaVersion: ctx.schemaVersion,
      historyEnabled: ctx.historyEnabled,
      revisionTrackingEnabled: ctx.revisionTrackingEnabled,
      revisionSchema: ctx.schema,
    },
    ctx.backend,
    async (target) => {
      await lockIdentityGraph(target, ctx.graphId);
      return withRecordedIdentityMutationTarget(target, (rawTarget, touch) =>
        fn(
          rawTarget,
          (graphId, id, afterImage) => {
            touched = true;
            touch(graphId, id, afterImage);
          },
          () => {
            touched = true;
          },
        ),
      );
    },
    { didWrite: () => touched },
  );
}

export function createIdentityReadFacade<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
): IdentityReadFacade<G> {
  return {
    async representativeOf(input) {
      const members = await visibleMembersAtCoordinate(
        ctx,
        registeredPlainRef(ctx, input),
      );
      return members[0] === undefined ? undefined : publicNodeRef(members[0]);
    },

    async membersOf(input) {
      const members = await visibleMembersAtCoordinate(
        ctx,
        registeredPlainRef(ctx, input),
      );
      return members.map((member) => publicNodeRef<G>(member));
    },

    async nodesOf(input) {
      const members = await visibleMembersAtCoordinate(
        ctx,
        registeredPlainRef(ctx, input),
      );
      const nodes = await ctx.loadNodes(members, ctx.coordinate);
      return nodes.filter((node) => node !== undefined);
    },

    async areSame(firstInput, secondInput) {
      const first = registeredPlainRef(ctx, firstInput);
      const second = registeredPlainRef(ctx, secondInput);
      const members = await visibleMembersAtCoordinate(ctx, first);
      return containsRef(members, second);
    },

    async areDifferent(firstInput, secondInput) {
      const first = registeredPlainRef(ctx, firstInput);
      const second = registeredPlainRef(ctx, secondInput);
      const { coordinate } = ctx;
      if (coordinate === undefined || isCurrentClosureCoordinate(coordinate)) {
        const [firstVisible, secondVisible] = await Promise.all([
          loadCurrentVisibleMembers(
            ctx.backend,
            ctx.schema,
            ctx.graphId,
            first,
          ),
          loadCurrentVisibleMembers(
            ctx.backend,
            ctx.schema,
            ctx.graphId,
            second,
          ),
        ]);
        if (firstVisible.length === 0 || secondVisible.length === 0)
          return false;
        const classes = await loadCurrentStructuralClasses(
          ctx.backend,
          ctx.schema,
          ctx.graphId,
          [first, second],
        );
        const firstClass = requireDefined(classes.get(refKey(first)));
        const secondClass = requireDefined(classes.get(refKey(second)));
        // A boolean is the whole answer here, and the separation relation holds
        // exactly that boolean for a pair of current classes — no assertion has
        // to be named, so the ledger is not read at all.
        const separated = await isSeparated(
          ctx.backend,
          ctx.schema,
          ctx.graphId,
          currentClassKey(firstClass),
          currentClassKey(secondClass),
        );
        return (
          separated ||
          classHasDisjointKinds(ctx.registry, firstClass, secondClass) !==
            undefined
        );
      }
      const classes = await loadHistoricalClasses(
        ctx.backend,
        ctx.schema,
        ctx.graphId,
        [first, second],
        coordinate,
        ctx.sameIdAcrossKinds,
      );
      const firstClass = requireDefined(classes.get(refKey(first)));
      const secondClass = requireDefined(classes.get(refKey(second)));
      if (firstClass.visible.length === 0 || secondClass.visible.length === 0)
        return false;
      const different = await loadSpanningDifferentAssertion(
        ctx.backend,
        ctx.schema,
        ctx.graphId,
        firstClass.structural,
        secondClass.structural,
        ctx.coordinate,
      );
      return (
        different !== undefined ||
        classHasDisjointKinds(
          ctx.registry,
          firstClass.structural,
          secondClass.structural,
        ) !== undefined
      );
    },

    async assertionsOf(input) {
      const ref = registeredPlainRef(ctx, input);
      const members = await visibleMembersAtCoordinate(ctx, ref);
      if (members.length === 0) return [];
      const assertions = await loadAssertionsTouching(
        ctx.backend,
        ctx.schema,
        ctx.graphId,
        [ref],
        ctx.coordinate,
      );
      return assertions
        .filter(
          (assertion) =>
            (assertion.a_kind === ref.kind && assertion.a_id === ref.id) ||
            (assertion.b_kind === ref.kind && assertion.b_id === ref.id),
        )
        .toSorted((left, right) => compareCodePoints(left.id, right.id))
        .map((assertion) => publicAssertion<G>(assertion));
    },
  };
}

/**
 * Splits ended assertions by which derived relation their repair belongs to: a
 * `same` retraction splits identity classes (closure repair, which carries the
 * separation repair with it), a `different` retraction removes a separation.
 */
function partitionRetractedEndpoints(
  retracted: readonly IdentityAssertionStorageRow[],
): Readonly<{
  closureReferences: readonly PlainNodeRef[];
  separationReferences: readonly PlainNodeRef[];
}> {
  const closureReferences: PlainNodeRef[] = [];
  const separationReferences: PlainNodeRef[] = [];
  for (const ended of retracted) {
    const endpoints = [
      { kind: ended.a_kind, id: ended.a_id },
      { kind: ended.b_kind, id: ended.b_id },
    ];
    if (ended.rel === "same") {
      closureReferences.push(...endpoints);
    } else {
      separationReferences.push(...endpoints);
    }
  }
  return { closureReferences, separationReferences };
}

export function createIdentityFacade<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
): IdentityFacade<G> {
  return {
    ...createIdentityReadFacade(ctx),

    assertSame(a, b) {
      return runIdentityMutation(ctx, (target, touch) =>
        assertPair(ctx, target, "same", a, b, touch),
      );
    },

    assertDifferent(a, b) {
      return runIdentityMutation(ctx, (target, touch) =>
        assertPair(ctx, target, "different", a, b, touch),
      );
    },

    bulkAssertSame(pairs) {
      return runIdentityMutation(ctx, (target, touch) =>
        bulkAssertPairs(ctx, target, "same", pairs, touch),
      );
    },

    bulkAssertDifferent(pairs) {
      return runIdentityMutation(ctx, (target, touch) =>
        bulkAssertPairs(ctx, target, "different", pairs, touch),
      );
    },

    retractAssertion(id) {
      return runIdentityMutation(ctx, async (target, touch) => {
        const ended = await retractById(ctx, target, id, touch);
        if (ended !== undefined) {
          const endpoints = [
            { kind: ended.a_kind, id: ended.a_id },
            { kind: ended.b_kind, id: ended.b_id },
          ];
          if (ended.rel === "same") {
            await replaceAffectedClosure(
              target,
              ctx.schema,
              ctx.graphId,
              endpoints,
              ctx.sameIdAcrossKinds,
            );
          } else {
            await replaceSeparationForReferences(
              target,
              ctx.schema,
              ctx.graphId,
              endpoints,
            );
          }
        }
        return ended === undefined ? undefined : publicAssertion<G>(ended);
      });
    },

    retractSameAssertion(firstInput, secondInput) {
      return runIdentityMutation(ctx, async (target, touch) => {
        const [a, b] = normalizePair(
          registeredPlainRef(ctx, firstInput),
          registeredPlainRef(ctx, secondInput),
        );
        const existing = await currentAssertionForPair(
          target,
          ctx.schema,
          ctx.graphId,
          "same",
          a,
          b,
        );
        if (existing === undefined) return;
        const ended = await retractById(ctx, target, existing.id, touch);
        await replaceAffectedClosure(
          target,
          ctx.schema,
          ctx.graphId,
          [a, b],
          ctx.sameIdAcrossKinds,
        );
        return ended === undefined ? undefined : publicAssertion<G>(ended);
      });
    },

    retractDifferentAssertion(firstInput, secondInput) {
      return runIdentityMutation(ctx, async (target, touch) => {
        const [a, b] = normalizePair(
          registeredPlainRef(ctx, firstInput),
          registeredPlainRef(ctx, secondInput),
        );
        const existing = await currentAssertionForPair(
          target,
          ctx.schema,
          ctx.graphId,
          "different",
          a,
          b,
        );
        if (existing === undefined) return;
        const ended = await retractById(ctx, target, existing.id, touch);
        await replaceSeparationForReferences(target, ctx.schema, ctx.graphId, [
          a,
          b,
        ]);
        return ended === undefined ? undefined : publicAssertion<G>(ended);
      });
    },

    bulkRetractAssertions(ids) {
      return runIdentityMutation(ctx, async (target, touch) => {
        const retracted = await retractByIds(ctx, target, ids, touch);
        const { closureReferences, separationReferences } =
          partitionRetractedEndpoints(retracted);
        if (closureReferences.length > 0) {
          await replaceAffectedClosure(
            target,
            ctx.schema,
            ctx.graphId,
            closureReferences,
            ctx.sameIdAcrossKinds,
          );
        }
        await replaceSeparationForReferences(
          target,
          ctx.schema,
          ctx.graphId,
          separationReferences,
        );
        return retracted.map((assertion) => publicAssertion<G>(assertion));
      });
    },
  };
}

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
      const activeKinds = new Set(ctx.registry.nodeKinds.keys());
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
    const activeKinds = new Set(ctx.registry.nodeKinds.keys());
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
      new Set(ctx.registry.nodeKinds.keys()),
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
      matched.set(rawRow.id, normalizeAssertionRow(rawRow));
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
      new Set(ctx.registry.nodeKinds.keys()),
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
 * rather than at a second wall-clock read, which makes "this assertion ended
 * because its endpoint died" a derivable fact: a consumer comparing an ended
 * assertion's `valid_to` to the endpoint's `deleted_at` sees equality exactly
 * for cascade endings (graph-merge's state-diff does precisely this to tell a
 * cascade apart from an explicit retraction). Two `nowIso()` reads inside one
 * transaction can straddle a millisecond boundary, so the equality has to come
 * from the stored value, not from a fresh clock read.
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
  return row === undefined ? undefined : optionalTimestamp(row.deleted_at);
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
    // `deleted_at` inside this transaction, and reusing it is what makes a
    // cascade ending distinguishable from an explicit retraction downstream.
    // The read is skipped when there is nothing to end.
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
      const row = normalizeAssertionRow(rawRow);
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
        const ended = { ...row, valid_to: validTo, updated_at: now };
        await executeIdentityStatement(
          rawTarget,
          sql`
            UPDATE ${ctx.schema.identityAssertionsTable}
            SET valid_to = ${validTo}, updated_at = ${now}
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

export async function readIdentityAssertionsForInterchange<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  mode: "state" | "archival",
  options?: IdentityInterchangeReadOptions,
): Promise<readonly IdentityTransferAssertion[]> {
  const nodeKinds =
    options?.nodeKinds === undefined ?
      undefined
    : [...new Set(options.nodeKinds)];
  const kindFilterChunkSize =
    nodeKinds === undefined || nodeKinds.length === 0 ?
      MAX_REFERENCE_CHUNK_SIZE
    : identityChunkSize(ctx.backend, {
        fixedParameters: 16,
        maxItems: MAX_REFERENCE_CHUNK_SIZE,
        parametersPerItem: 2,
      });
  const filterKindsInMemory =
    nodeKinds !== undefined && nodeKinds.length > kindFilterChunkSize;
  const kindFilter =
    nodeKinds === undefined ? sql``
    : nodeKinds.length === 0 ? sql`AND 1 = 0`
    : filterKindsInMemory ? sql``
    : sql`
      AND identity_assertions.a_kind IN (${sql.join(
        nodeKinds.map((kind) => sql`${kind}`),
        sql`, `,
      )})
      AND identity_assertions.b_kind IN (${sql.join(
        nodeKinds.map((kind) => sql`${kind}`),
        sql`, `,
      )})
    `;
  const liveEndpointJoins =
    options?.includeDeleted === false ?
      sql`
        JOIN ${ctx.schema.nodesTable} identity_a_node
          ON identity_a_node.graph_id = identity_assertions.graph_id
         AND identity_a_node.kind = identity_assertions.a_kind
         AND identity_a_node.id = identity_assertions.a_id
         AND identity_a_node.deleted_at IS NULL
        JOIN ${ctx.schema.nodesTable} identity_b_node
          ON identity_b_node.graph_id = identity_assertions.graph_id
         AND identity_b_node.kind = identity_assertions.b_kind
         AND identity_b_node.id = identity_assertions.b_id
         AND identity_b_node.deleted_at IS NULL
      `
    : sql``;
  const rows = await ctx.backend.execute<RawIdentityAssertionRow>(
    asCompiledRowsSql(sql`
      SELECT identity_assertions.graph_id AS graph_id,
             identity_assertions.id AS id,
             identity_assertions.rel AS rel,
             identity_assertions.a_kind AS a_kind,
             identity_assertions.a_id AS a_id,
             identity_assertions.b_kind AS b_kind,
             identity_assertions.b_id AS b_id,
             identity_assertions.valid_from AS valid_from,
             identity_assertions.valid_to AS valid_to,
             identity_assertions.created_at AS created_at,
             identity_assertions.updated_at AS updated_at,
             identity_assertions.deleted_at AS deleted_at
      FROM ${ctx.schema.identityAssertionsTable} identity_assertions
      ${liveEndpointJoins}
      WHERE identity_assertions.graph_id = ${ctx.graphId}
        AND identity_assertions.deleted_at IS NULL
        ${
          mode === "state" ?
            sql`AND identity_assertions.valid_to IS NULL`
          : sql``
        }
        ${kindFilter}
    `),
  );
  const allowedKinds = filterKindsInMemory ? new Set(nodeKinds) : undefined;
  return rows
    .filter(
      (row) =>
        allowedKinds === undefined ||
        (allowedKinds.has(row.a_kind) && allowedKinds.has(row.b_kind)),
    )
    .map((row) => toTransferAssertion(normalizeAssertionRow(row)))
    .toSorted((left, right) => compareCodePoints(left.id, right.id));
}

/**
 * Every transfer-shape rejection reports the same way: one issue against the
 * `identity.assertions` path, attributed to the offending assertion id.
 */
function transferShapeError(
  assertion: IdentityTransferAssertion,
  message: string,
  issue: Readonly<{ message: string; code: string }>,
): ValidationError {
  return new ValidationError(message, {
    issues: [
      {
        path: "identity.assertions",
        assertionId: assertion.id,
        message: issue.message,
        code: issue.code,
      },
    ],
  });
}

function validateTransferShape<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  assertion: IdentityTransferAssertion,
  mode: "state" | "archival",
): readonly [PlainNodeRef, PlainNodeRef] {
  if (
    !ctx.registry.nodeKinds.has(assertion.a.kind) ||
    !ctx.registry.nodeKinds.has(assertion.b.kind)
  ) {
    throw transferShapeError(
      assertion,
      "Identity import references an unknown node kind.",
      {
        message: `Unknown identity endpoint kind in assertion ${assertion.id}`,
        code: "IDENTITY_IMPORT_UNKNOWN_KIND",
      },
    );
  }
  if (refKey(assertion.a) === refKey(assertion.b)) {
    throw transferShapeError(
      assertion,
      `Identity ${assertion.relation} assertions require two distinct node references.`,
      {
        message: `Assertion ${assertion.id} relates a node to itself`,
        code: "IDENTITY_SELF_ASSERTION",
      },
    );
  }
  const normalized = normalizePair(assertion.a, assertion.b);
  if (
    refKey(normalized[0]) !== refKey(assertion.a) ||
    refKey(normalized[1]) !== refKey(assertion.b)
  ) {
    throw transferShapeError(
      assertion,
      "Identity import pairs must be normalized.",
      {
        message: `Assertion ${assertion.id} endpoints are not in code-point order`,
        code: "IDENTITY_IMPORT_PAIR_NOT_NORMALIZED",
      },
    );
  }
  if (mode === "state" && assertion.validTo !== undefined) {
    throw transferShapeError(
      assertion,
      "State identity import cannot contain ended assertions.",
      {
        message: `Assertion ${assertion.id} is ended`,
        code: "IDENTITY_STATE_IMPORT_ENDED_ASSERTION",
      },
    );
  }
  const now = nowIso();
  // An open row is asserted as current-truth "now"; a future validFrom would
  // insert a row the closure filter (valid_from <= now) excludes yet
  // currentAssertionForPair (valid_to IS NULL only) treats as current — two
  // conflicting definitions of "current". That split does not depend on the
  // import mode: an archival open row is just as unended as a state one.
  if (
    assertion.validTo === undefined &&
    compareCodePoints(assertion.validFrom, now) > 0
  ) {
    throw transferShapeError(
      assertion,
      "Identity import cannot contain future-dated open assertions.",
      {
        message: `Assertion ${assertion.id} validFrom is in the future`,
        code: "IDENTITY_IMPORT_FUTURE_VALID_FROM",
      },
    );
  }
  // Reject a NEGATIVE window (validTo strictly before validFrom). A zero-width
  // window (validTo === validFrom) is intentionally allowed: it is what a
  // same-instant retraction legitimately produces (nowIso is millisecond
  // precision) and what the clock-skew clamp in retractById emits, so rejecting
  // it here would break archival round-tripping of the store's own output.
  if (
    assertion.validTo !== undefined &&
    compareCodePoints(assertion.validTo, assertion.validFrom) < 0
  ) {
    throw transferShapeError(
      assertion,
      "Identity assertion validity window is empty.",
      {
        message: `Assertion ${assertion.id} validTo must not precede validFrom`,
        code: "IDENTITY_IMPORT_INVALID_WINDOW",
      },
    );
  }
  // An ended row takes the raw-INSERT branch of the importer, which skips
  // endpoint-liveness validation, contradiction validation and closure
  // maintenance because a row that ended in the past cannot be part of any
  // current identity class. A validTo in the future breaks that premise: the
  // snapshot filter (valid_from <= now AND (valid_to IS NULL OR valid_to > now))
  // reports the row as CURRENT while no closure row backs it, wedging the store
  // — membersOf disagrees with the ledger, validateIdentity() reports a
  // permanent contradiction, and no retraction API can end the row because they
  // all match on valid_to IS NULL.
  if (
    assertion.validTo !== undefined &&
    compareCodePoints(assertion.validTo, now) > 0
  ) {
    throw transferShapeError(
      assertion,
      "Identity import cannot contain assertions that end in the future.",
      {
        message: `Assertion ${assertion.id} validTo is in the future`,
        code: "IDENTITY_IMPORT_FUTURE_VALID_TO",
      },
    );
  }
  return normalized;
}

/**
 * Attribution tag the import coordinator attaches to an error it rethrows:
 * the id of the assertion it was APPLYING when the failure surfaced. Interchange
 * error reporting reads it so an `IdentityContradictionError` or
 * `NodeNotFoundError` is attributed to the failing assertion, not to whichever
 * earlier assertion happens to touch the same endpoints. A non-enumerable
 * symbol so the original error class, message, and details stay byte-identical
 * for direct callers.
 */
export const IDENTITY_IMPORT_FAILED_ASSERTION: unique symbol = Symbol(
  "typegraph.identity.failedAssertionId",
);

function rethrowTaggedWithAssertion(
  error: unknown,
  assertionId: string,
): never {
  if (typeof error === "object" && error !== null) {
    Object.defineProperty(error, IDENTITY_IMPORT_FAILED_ASSERTION, {
      value: assertionId,
      enumerable: false,
      configurable: true,
    });
  }
  throw error;
}

/**
 * Applies interchange identity rows inside the caller-owned write transaction.
 * The caller owns import conflict policy and acquires the graph identity lock;
 * this coordinator owns integrity, persistence, capture, and closure repair.
 */
export async function importIdentityAssertionsIntoTarget<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  target: Backend,
  assertions: readonly IdentityTransferAssertion[],
  mode: "state" | "archival",
): Promise<IdentityImportSummary> {
  let created = 0;
  let skipped = 0;
  await withRecordedIdentityMutationTarget(target, async (rawTarget, touch) => {
    // Pre-pass: validate every shape in input order and normalize endpoints,
    // then batch the two reads the loop would otherwise issue per item — the
    // existing-row-by-id lookup and the current-endpoint liveness check.
    const normalized = assertions.map((assertion) => ({
      assertion,
      endpoints: validateTransferShape(ctx, assertion, mode),
    }));
    const existingById = await loadAssertionsByIds(
      rawTarget,
      ctx.schema,
      ctx.graphId,
      assertions.map((assertion) => assertion.id),
    );
    const currentEndpoints: PlainNodeRef[] = [];
    const endedEndpoints: PlainNodeRef[] = [];
    for (const { assertion, endpoints } of normalized) {
      const [a, b] = endpoints;
      if (assertion.validTo === undefined) {
        currentEndpoints.push(a, b);
      } else {
        endedEndpoints.push(a, b);
      }
    }
    const attributeMissingEndpoint = (
      error: unknown,
      ended: boolean,
    ): never => {
      // The batch checks lose per-assertion context; the first assertion of
      // the checked kind touching the missing ref is the failing candidate.
      if (error instanceof NodeNotFoundError) {
        const missing = { kind: error.details.kind, id: error.details.id };
        const failing = normalized.find(
          ({ assertion, endpoints }) =>
            (assertion.validTo !== undefined) === ended &&
            endpoints.some(
              (endpoint) =>
                endpoint.kind === missing.kind && endpoint.id === missing.id,
            ),
        );
        if (failing !== undefined) {
          rethrowTaggedWithAssertion(error, failing.assertion.id);
        }
      }
      throw error;
    };
    try {
      await requireLiveEndpoints(
        rawTarget,
        ctx.schema,
        ctx.graphId,
        currentEndpoints,
      );
    } catch (error) {
      attributeMissingEndpoint(error, false);
    }
    try {
      await requireStructuralEndpoints(
        rawTarget,
        ctx.schema,
        ctx.graphId,
        endedEndpoints,
      );
    } catch (error) {
      attributeMissingEndpoint(error, true);
    }

    for (const { assertion, endpoints } of normalized) {
      const [a, b] = endpoints;
      try {
        const sameId = existingById.get(assertion.id);
        if (sameId !== undefined) {
          const exact =
            sameId.rel === assertion.relation &&
            sameId.a_kind === a.kind &&
            sameId.a_id === a.id &&
            sameId.b_kind === b.kind &&
            sameId.b_id === b.id &&
            sameId.valid_from === assertion.validFrom &&
            sameId.valid_to === assertion.validTo;
          if (exact) {
            skipped += 1;
            continue;
          }
          throw new ConfigurationError(
            `Identity assertion id ${assertion.id} already identifies different truth.`,
            {
              code: "IDENTITY_IMPORT_ID_CONFLICT",
              graphId: ctx.graphId,
              assertionId: assertion.id,
            },
          );
        }

        if (assertion.validTo !== undefined) {
          const timestamp = assertion.validFrom;
          const row: IdentityAssertionStorageRow = {
            graph_id: ctx.graphId,
            id: assertion.id,
            rel: assertion.relation,
            a_kind: a.kind,
            a_id: a.id,
            b_kind: b.kind,
            b_id: b.id,
            valid_from: assertion.validFrom,
            valid_to: assertion.validTo,
            created_at: timestamp,
            updated_at: assertion.validTo,
            deleted_at: undefined,
          };
          await insertAssertionRows(rawTarget, ctx.schema, [row]);
          touch(ctx.graphId, row.id, row);
          existingById.set(row.id, row);
          created += 1;
          continue;
        }

        const existing = await currentAssertionForPair(
          rawTarget,
          ctx.schema,
          ctx.graphId,
          assertion.relation,
          a,
          b,
        );
        if (existing !== undefined) {
          skipped += 1;
          continue;
        }
        await validateCurrentRelation(
          ctx,
          rawTarget,
          assertion.relation,
          "import",
          a,
          b,
        );
        const inserted = await insertAssertion(
          rawTarget,
          ctx.schema,
          ctx.graphId,
          assertion.relation,
          a,
          b,
          nowIso(),
          touch,
          { id: assertion.id, validFrom: assertion.validFrom },
        );
        existingById.set(inserted.id, inserted);
        created += 1;
        // Repair the closure incrementally, exactly as single assertPair does, so
        // a later validation in this same batch (e.g. a following different(a,b))
        // sees the merge instead of validating against a stale materialized class.
        if (assertion.relation === "same") {
          await mergeCurrentClasses(rawTarget, ctx.schema, ctx.graphId, a, b);
        } else {
          await replaceSeparationForReferences(
            rawTarget,
            ctx.schema,
            ctx.graphId,
            [a, b],
          );
        }
      } catch (error) {
        rethrowTaggedWithAssertion(error, assertion.id);
      }
    }
  });
  return { created, skipped };
}

export async function applyIdentityChangesForContext<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  retractionIds: readonly string[],
  assertions: readonly IdentityTransferAssertion[],
): Promise<Readonly<{ created: number; retracted: number }>> {
  if (retractionIds.length === 0 && assertions.length === 0) {
    return { created: 0, retracted: 0 };
  }
  return runIdentityMutation(ctx, async (target, touch, markWritten) => {
    const retracted = await retractByIds(ctx, target, retractionIds, touch);
    const { closureReferences, separationReferences } =
      partitionRetractedEndpoints(retracted);
    // Repair the closure from the retractions BEFORE importing: a batch that
    // retracts same(a,b) and then asserts different(a,b) must validate the new
    // assertion against a closure that already reflects the split, not the
    // stale merged class the import validation would otherwise reject against.
    if (closureReferences.length > 0) {
      await replaceAffectedClosure(
        target,
        ctx.schema,
        ctx.graphId,
        closureReferences,
        ctx.sameIdAcrossKinds,
      );
    }
    await replaceSeparationForReferences(
      target,
      ctx.schema,
      ctx.graphId,
      separationReferences,
    );
    const summary = await importIdentityAssertionsIntoTarget(
      ctx,
      target,
      assertions,
      "state",
    );
    // The import records capture touches through its OWN recorded binding, so
    // the mutation's wrapped touch never fires for created rows — an
    // identity-only merge would otherwise leave the durable revision clock
    // unmoved and every base@V token stale.
    if (summary.created > 0) markWritten();
    // ACTUAL ledger effects, not planned intents: rows the import created
    // (idempotent exact/pair matches excluded) and rows the retraction ended
    // (already-ended or unknown ids excluded).
    return { created: summary.created, retracted: retracted.length };
  });
}
