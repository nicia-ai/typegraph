import { type GraphBackend, type TransactionBackend } from "../backend/types";
import { type GraphDef } from "../core/define-graph";
import { type ReadCoordinate } from "../core/temporal";
import {
  ConfigurationError,
  IdentityContradictionError,
  type IdentityContradictionErrorDetails,
  NodeNotFoundError,
  ValidationError,
} from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql, asCompiledStatementSql } from "../query/sql-intent";
import { type KindRegistry } from "../registry/kind-registry";
import { runInWriteTransaction } from "../store/operations/write-transaction";
import { toCanonicalIso } from "../store/recorded-capture";
import { withRecordedIdentityMutationTarget } from "../store/recorded-capture";
import { compareCodePoints } from "../utils/compare";
import { nowIso } from "../utils/date";
import { generateId } from "../utils/id";
import { type IdentityAssertionStorageRow } from "./storage-types";
import {
  type GraphNodeRef,
  type IdentityAssertion,
  type IdentityAssertionId,
  type IdentityAssertionResult,
  type IdentityFacade,
  type IdentityNode,
  type IdentityNodeRef,
  type IdentityReadFacade,
  type IdentityRelation,
} from "./types";

type Backend = GraphBackend | TransactionBackend;
type PlainNodeRef = Readonly<{ kind: string; id: string }>;
type IdentityTouch = (
  graphId: string,
  id: string,
  afterImage?: IdentityAssertionStorageRow,
) => void;

const REFERENCE_CHUNK_SIZE = 200;
const CLOSURE_INSERT_CHUNK_SIZE = 100;
const ASSERTION_INSERT_CHUNK_SIZE = 50;

export type IdentityServiceContext<G extends GraphDef> = Readonly<{
  graph: G;
  graphId: string;
  registry: KindRegistry;
  backend: Backend;
  schema: SqlSchema;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
  sameIdAcrossKinds: "fold" | "ignore";
  coordinate?: ReadCoordinate;
  loadNode: (
    ref: PlainNodeRef,
    coordinate?: ReadCoordinate,
  ) => Promise<IdentityNode<G> | undefined>;
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

type RawIdentityMemberRow = RawNodeSnapshotRow &
  Readonly<{ kind: string; id: string }>;

type RawClosureClassRow = Readonly<{
  member_kind: string;
  member_id: string;
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

function plainRef<G extends GraphDef>(ref: GraphNodeRef<G>): PlainNodeRef {
  return { kind: ref.kind, id: ref.id };
}

function refKey(ref: PlainNodeRef): string {
  return JSON.stringify([ref.kind, ref.id]);
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
  return { ...assertion, assertion, action };
}

function publicNodeRef<G extends GraphDef>(
  ref: PlainNodeRef,
): IdentityNodeRef<G> {
  // Every service entry point validates kinds against the graph registry, and
  // persisted assertion/closure rows are constrained to those same endpoints.
  // Reapply the public per-kind NodeId brand at this storage boundary.
  return ref as IdentityNodeRef<G>;
}

function requireStatementTarget(target: Backend): asserts target is Backend & {
  executeStatement: NonNullable<GraphBackend["executeStatement"]>;
} {
  if (target.executeStatement === undefined) {
    throw new ConfigurationError(
      "Operational Identity requires statement execution support.",
      { code: "IDENTITY_REQUIRES_STATEMENT_EXECUTION" },
      {
        suggestion:
          "Use a built-in transactional SQLite or PostgreSQL backend.",
      },
    );
  }
}

async function executeStatement(
  target: Backend,
  statement: SqlFragment,
): Promise<void> {
  requireStatementTarget(target);
  await target.executeStatement(asCompiledStatementSql(statement));
}

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
  await executeStatement(
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
  const rows = await target.execute<RawNodeSnapshotRow>(
    asCompiledRowsSql(nodeSnapshotSource(schema, graphId, coordinate)),
  );
  return rows.map((row) => ({
    ref: { kind: row.kind, id: row.id },
    validFrom: optionalTimestamp(row.valid_from),
    validTo: optionalTimestamp(row.valid_to),
    createdAt: toCanonicalIso(row.created_at),
    deletedAt: optionalTimestamp(row.deleted_at),
  }));
}

// Assertions are class structure, not tombstonable nodes: an ended assertion
// no longer defines class membership at the read instant even when the read
// mode widens *node* visibility (includeEnded / includeTombstones). So the
// validity window is applied unconditionally — only the instant it is measured
// against tracks the read coordinate.
function assertionValidityInstant(
  coordinate: ReadCoordinate | undefined,
  currentInstant: string,
): string {
  const mode = coordinate?.valid.mode ?? "current";
  return mode === "asOf" ?
      (coordinate?.valid.asOf ?? currentInstant)
    : (coordinate?.recorded?.asOf ?? currentInstant);
}

function nodeSnapshotSource(
  schema: SqlSchema,
  graphId: string,
  coordinate: ReadCoordinate | undefined,
): SqlFragment {
  const recordedAsOf = coordinate?.recorded?.asOf;
  return recordedAsOf === undefined ?
      sql`
        SELECT kind, id, valid_from, valid_to, created_at, deleted_at
        FROM ${schema.nodesTable}
        WHERE graph_id = ${graphId}
      `
    : sql`
      SELECT kind, id, valid_from, valid_to, created_at, deleted_at
      FROM ${schema.recordedNodesTable}
      WHERE graph_id = ${graphId}
        AND recorded_from <= ${recordedAsOf}
        AND recorded_to > ${recordedAsOf}
    `;
}

function assertionSnapshotSource(
  schema: SqlSchema,
  graphId: string,
  coordinate: ReadCoordinate | undefined,
  currentInstant: string,
  relation: IdentityRelation | undefined,
): SqlFragment {
  const recordedAsOf = coordinate?.recorded?.asOf;
  const instant = assertionValidityInstant(coordinate, currentInstant);
  const validity = sql`AND valid_from <= ${instant} AND (valid_to IS NULL OR valid_to > ${instant})`;
  const relationFilter =
    relation === undefined ? sql`` : sql`AND rel = ${relation}`;
  return recordedAsOf === undefined ?
      sql`
        SELECT graph_id, id, rel, a_kind, a_id, b_kind, b_id,
               valid_from, valid_to, created_at, updated_at, deleted_at
        FROM ${schema.identityAssertionsTable}
        WHERE graph_id = ${graphId}
          AND deleted_at IS NULL
          ${relationFilter}
          ${validity}
      `
    : sql`
      SELECT graph_id, id, rel, a_kind, a_id, b_kind, b_id,
             valid_from, valid_to, created_at, updated_at, deleted_at
      FROM ${schema.recordedIdentityAssertionsTable}
      WHERE graph_id = ${graphId}
        AND recorded_from <= ${recordedAsOf}
        AND recorded_to > ${recordedAsOf}
        AND deleted_at IS NULL
        ${relationFilter}
        ${validity}
    `;
}

function nodeVisibilitySql(
  coordinate: ReadCoordinate | undefined,
  currentInstant: string,
): SqlFragment {
  const mode = coordinate?.valid.mode ?? "current";
  if (mode === "includeTombstones") return sql`1 = 1`;
  if (mode === "includeEnded") return sql`n.deleted_at IS NULL`;
  const instant =
    mode === "asOf" ?
      (coordinate?.valid.asOf ?? currentInstant)
    : (coordinate?.recorded?.asOf ?? currentInstant);
  return sql`
    n.deleted_at IS NULL
    AND (n.valid_from IS NULL OR n.valid_from <= ${instant})
    AND (n.valid_to IS NULL OR n.valid_to > ${instant})
  `;
}

function normalizeMemberRow(row: RawIdentityMemberRow): NodeSnapshot {
  return {
    ref: { kind: row.kind, id: row.id },
    validFrom: optionalTimestamp(row.valid_from),
    validTo: optionalTimestamp(row.valid_to),
    createdAt: toCanonicalIso(row.created_at),
    deletedAt: optionalTimestamp(row.deleted_at),
  };
}

function isCurrentClosureCoordinate(
  coordinate: ReadCoordinate | undefined,
): boolean {
  return (
    coordinate?.recorded === undefined &&
    (coordinate?.valid.mode ?? "current") === "current"
  );
}

async function loadCurrentStructuralClasses(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  references: readonly PlainNodeRef[],
): Promise<ReadonlyMap<string, readonly PlainNodeRef[]>> {
  const uniqueByKey = new Map<string, PlainNodeRef>();
  for (const ref of references) uniqueByKey.set(refKey(ref), ref);
  const uniqueReferences = [...uniqueByKey.values()];
  if (uniqueReferences.length === 0) return new Map();
  if (uniqueReferences.length > REFERENCE_CHUNK_SIZE) {
    const combined = new Map<string, readonly PlainNodeRef[]>();
    for (
      let offset = 0;
      offset < uniqueReferences.length;
      offset += REFERENCE_CHUNK_SIZE
    ) {
      const chunk = uniqueReferences.slice(
        offset,
        offset + REFERENCE_CHUNK_SIZE,
      );
      const classes = await loadCurrentStructuralClasses(
        target,
        schema,
        graphId,
        chunk,
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
  const rows = await target.execute<RawIdentityMemberRow>(
    asCompiledRowsSql(sql`
      WITH anchor AS (
        SELECT class_kind, class_id
        FROM ${schema.identityClosureTable}
        WHERE graph_id = ${graphId}
          AND member_kind = ${ref.kind}
          AND member_id = ${ref.id}
      ), members(kind, id) AS (
        SELECT member_kind, member_id
        FROM ${schema.identityClosureTable}
        WHERE graph_id = ${graphId}
          AND (class_kind, class_id) IN (
            SELECT class_kind, class_id FROM anchor
          )
        UNION ALL
        SELECT ${ref.kind}, ${ref.id}
        WHERE NOT EXISTS (SELECT 1 FROM anchor)
      )
      SELECT n.kind, n.id, n.valid_from, n.valid_to, n.created_at, n.deleted_at
      FROM members m
      JOIN ${schema.nodesTable} n
        ON n.graph_id = ${graphId}
       AND n.kind = m.kind
       AND n.id = m.id
      WHERE ${nodeVisibilitySql(undefined, now)}
    `),
  );
  const members = rows
    .map((row) => normalizeMemberRow(row).ref)
    .toSorted((left, right) => compareReferences(left, right));
  return members.some((member) => refKey(member) === refKey(ref)) ? members : (
      []
    );
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
  return classes.get(refKey(ref))!.visible;
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
  const currentInstant = nowIso();
  const nodes = nodeSnapshotSource(schema, graphId, coordinate);
  const assertions = assertionSnapshotSource(
    schema,
    graphId,
    coordinate,
    currentInstant,
    "same",
  );
  const seeds = sql.join(
    uniqueReferences.map((ref) => sql`(${ref.kind}, ${ref.id})`),
    sql`, `,
  );
  const sameIdEdges =
    sameIdAcrossKinds === "fold" ?
      sql`
        UNION ALL
        SELECT left_node.kind, left_node.id, right_node.kind, right_node.id
        FROM node_snapshot left_node
        JOIN node_snapshot right_node
          ON right_node.id = left_node.id
         AND (right_node.kind <> left_node.kind OR right_node.id <> left_node.id)
        WHERE left_node.deleted_at IS NULL
          AND right_node.deleted_at IS NULL
      `
    : sql``;
  const rows = await target.execute<RawHistoricalClassMemberRow>(
    asCompiledRowsSql(sql`
      WITH RECURSIVE
      seeds(seed_kind, seed_id) AS (
        VALUES ${seeds}
      ),
      node_snapshot(kind, id, valid_from, valid_to, created_at, deleted_at) AS (
        ${nodes}
      ),
      same_assertions(a_kind, a_id, b_kind, b_id) AS (
        SELECT a_kind, a_id, b_kind, b_id FROM (${assertions}) identity_assertions
      ),
      identity_edges(a_kind, a_id, b_kind, b_id) AS (
        SELECT a_kind, a_id, b_kind, b_id FROM same_assertions
        UNION ALL
        SELECT b_kind, b_id, a_kind, a_id FROM same_assertions
        ${sameIdEdges}
      ),
      identity_members(seed_kind, seed_id, kind, id) AS (
        SELECT seeds.seed_kind, seeds.seed_id, seeds.seed_kind, seeds.seed_id
        FROM seeds
        JOIN node_snapshot n
          ON n.kind = seeds.seed_kind AND n.id = seeds.seed_id
        WHERE ${nodeVisibilitySql(coordinate, currentInstant)}
        UNION
        SELECT member.seed_kind, member.seed_id, edge.b_kind, edge.b_id
        FROM identity_members member
        JOIN identity_edges edge
          ON edge.a_kind = member.kind
         AND edge.a_id = member.id
      )
      SELECT member.seed_kind, member.seed_id,
             member.kind AS member_kind, member.id AS member_id,
             CASE WHEN ${nodeVisibilitySql(coordinate, currentInstant)}
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
  if (isCurrentClosureCoordinate(ctx.coordinate)) {
    return loadCurrentVisibleMembers(ctx.backend, ctx.schema, ctx.graphId, ref);
  }
  return loadHistoricalVisibleMembers(
    ctx.backend,
    ctx.schema,
    ctx.graphId,
    ref,
    ctx.coordinate!,
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
  const source = assertionSnapshotSource(
    schema,
    graphId,
    coordinate,
    currentInstant,
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
  if (references.length > REFERENCE_CHUNK_SIZE) {
    const byId = new Map<string, IdentityAssertionStorageRow>();
    for (
      let offset = 0;
      offset < references.length;
      offset += REFERENCE_CHUNK_SIZE
    ) {
      const chunk = references.slice(offset, offset + REFERENCE_CHUNK_SIZE);
      const assertions = await loadAssertionsTouching(
        target,
        schema,
        graphId,
        chunk,
        coordinate,
        relation,
      );
      for (const assertion of assertions) byId.set(assertion.id, assertion);
    }
    return [...byId.values()];
  }
  const source = assertionSnapshotSource(
    schema,
    graphId,
    coordinate,
    nowIso(),
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
      SELECT graph_id, id, rel, a_kind, a_id, b_kind, b_id,
             valid_from, valid_to, created_at, updated_at, deleted_at
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
      const next = this.#parents.get(cursor)!;
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
    const firstSize = this.#sizes.get(firstRoot)!;
    const secondSize = this.#sizes.get(secondRoot)!;
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
  return componentFor(snapshot, first).some(
    (member) => refKey(member) === refKey(second),
  );
}

function classHasDisjointKinds(
  registry: KindRegistry,
  first: readonly PlainNodeRef[],
  second: readonly PlainNodeRef[],
): readonly [string, string] | undefined {
  for (const left of first) {
    for (const right of second) {
      if (registry.areDisjoint(left.kind, right.kind)) {
        return [left.kind, right.kind];
      }
    }
  }
  return undefined;
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
    for (let leftIndex = 0; leftIndex < component.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < component.length;
        rightIndex += 1
      ) {
        const left = component[leftIndex]!;
        const right = component[rightIndex]!;
        if (!registry.areDisjoint(left.kind, right.kind)) continue;
        throw new ConfigurationError(
          "Operational Identity class conflicts with ontology disjointness.",
          {
            code: "IDENTITY_SCHEMA_CONTRADICTION",
            graphId,
            classMembers: component,
            conflictingKinds: [left.kind, right.kind],
          },
        );
      }
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
    const canonical = component[0]!;
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
  if (references.length > REFERENCE_CHUNK_SIZE) {
    const byKey = new Map<string, PlainNodeRef>();
    for (
      let offset = 0;
      offset < references.length;
      offset += REFERENCE_CHUNK_SIZE
    ) {
      const chunk = references.slice(offset, offset + REFERENCE_CHUNK_SIZE);
      const live = await loadLiveReferences(target, schema, graphId, chunk);
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
  const aClass = classes.get(refKey(a))!;
  const bClass = classes.get(refKey(b))!;
  if (relation === "different") {
    if (!aClass.some((member) => refKey(member) === refKey(b))) return;
    throw new IdentityContradictionError({
      operation,
      a,
      b,
      reason: "same-class",
    });
  }

  const different = await loadSpanningDifferentAssertion(
    target,
    ctx.schema,
    ctx.graphId,
    aClass,
    bClass,
  );
  if (different !== undefined) {
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
      SELECT graph_id, id, rel, a_kind, a_id, b_kind, b_id,
             valid_from, valid_to, created_at, updated_at, deleted_at
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
  for (
    let offset = 0;
    offset < rows.length;
    offset += ASSERTION_INSERT_CHUNK_SIZE
  ) {
    const values = rows
      .slice(offset, offset + ASSERTION_INSERT_CHUNK_SIZE)
      .map((row) => {
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
    await executeStatement(
      target,
      sql`
        INSERT INTO ${schema.identityAssertionsTable} (
          graph_id, id, rel, a_kind, a_id, b_kind, b_id,
          valid_from, valid_to, created_at, updated_at, deleted_at
        ) VALUES ${sql.join(values, sql`, `)}
      `,
    );
  }
}

async function loadAssertionsByIds(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  ids: readonly string[],
): Promise<Map<string, IdentityAssertionStorageRow>> {
  const uniqueIds = [...new Set(ids)];
  const byId = new Map<string, IdentityAssertionStorageRow>();
  for (
    let offset = 0;
    offset < uniqueIds.length;
    offset += REFERENCE_CHUNK_SIZE
  ) {
    const idChunk = uniqueIds.slice(offset, offset + REFERENCE_CHUNK_SIZE);
    const idList = sql.join(
      idChunk.map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = await target.execute<RawIdentityAssertionRow>(
      asCompiledRowsSql(sql`
        SELECT graph_id, id, rel, a_kind, a_id, b_kind, b_id,
               valid_from, valid_to, created_at, updated_at, deleted_at
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
  await executeStatement(
    target,
    sql`DELETE FROM ${schema.identityClosureTable} WHERE graph_id = ${graphId}`,
  );
  await insertClosureComponents(target, schema, graphId, snapshot.components);
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
    const canonical = component[0]!;
    for (const member of component) {
      emitted.add(refKey(member));
      values.push(
        sql`(${graphId}, ${member.kind}, ${member.id}, ${canonical.kind}, ${canonical.id})`,
      );
    }
  }
  if (values.length === 0) return;
  for (
    let offset = 0;
    offset < values.length;
    offset += CLOSURE_INSERT_CHUNK_SIZE
  ) {
    await executeStatement(
      target,
      sql`
        INSERT INTO ${schema.identityClosureTable} (
          graph_id, member_kind, member_id, class_kind, class_id
        ) VALUES ${sql.join(
          values.slice(offset, offset + CLOSURE_INSERT_CHUNK_SIZE),
          sql`, `,
        )}
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
    for (const member of classes.get(refKey(ref))!) {
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
  for (
    let offset = 0;
    offset < affected.length;
    offset += REFERENCE_CHUNK_SIZE
  ) {
    const matches = referenceCondition(
      sql`member_kind`,
      sql`member_id`,
      affected.slice(offset, offset + REFERENCE_CHUNK_SIZE),
    );
    await executeStatement(
      target,
      sql`
        DELETE FROM ${schema.identityClosureTable}
        WHERE graph_id = ${graphId} AND ${matches}
      `,
    );
  }
  await insertClosureComponents(
    target,
    schema,
    graphId,
    buildComponents(structuralNodes, assertions, sameIdAcrossKinds),
  );
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
  const aClass = classes.get(refKey(a))!;
  const bClass = classes.get(refKey(b))!;
  if (aClass.some((member) => refKey(member) === refKey(b))) return;

  const [smaller, larger] =
    aClass.length <= bClass.length ? [aClass, bClass] : [bClass, aClass];
  const canonical = [...aClass, ...bClass].toSorted((left, right) =>
    compareReferences(left, right),
  )[0]!;

  async function relabelExistingClass(
    members: readonly PlainNodeRef[],
  ): Promise<void> {
    if (members.length < 2) return;
    const previousCanonical = members[0]!;
    if (refKey(previousCanonical) === refKey(canonical)) return;
    await executeStatement(
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
  const singletonMembers = [smaller, larger]
    .filter((members) => members.length === 1)
    .map((members) => members[0]!);
  if (singletonMembers.length === 0) return;
  const values = singletonMembers.map(
    (member) =>
      sql`(${graphId}, ${member.kind}, ${member.id}, ${canonical.kind}, ${canonical.id})`,
  );
  await executeStatement(
    target,
    sql`
      INSERT INTO ${schema.identityClosureTable} (
        graph_id, member_kind, member_id, class_kind, class_id
      ) VALUES ${sql.join(values, sql`, `)}
    `,
  );
}

async function assertPair<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  target: Backend,
  relation: IdentityRelation,
  firstInput: GraphNodeRef<G>,
  secondInput: GraphNodeRef<G>,
  touch: IdentityTouch,
): Promise<IdentityAssertionResult<G>> {
  const first = plainRef(firstInput);
  const second = plainRef(secondInput);
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
    a: GraphNodeRef<G>;
    b: GraphNodeRef<G>;
  }>[],
  touch: IdentityTouch,
): Promise<readonly IdentityAssertionResult<G>[]> {
  if (pairs.length === 0) return [];
  const normalizedPairs = pairs.map((pair) => {
    const first = plainRef(pair.a);
    const second = plainRef(pair.b);
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
  // same-assertions), then union each accepted same pair into it — instead of
  // rebuilding the whole partition per pair (the old O(P²)). Different
  // assertions live in their own list so the spanning-conflict check scans
  // only them, and a per-root member index keeps class lookups O(1).
  const unionFind = new UnionFind();
  const differentAssertions: IdentityAssertionStorageRow[] = [];
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
      differentAssertions.push(assertion);
    }
    allReferences.set(refKey(endpointA), endpointA);
    allReferences.set(refKey(endpointB), endpointB);
  }
  const membersByRoot = new Map<string, PlainNodeRef[]>();
  for (const ref of allReferences.values()) {
    const root = unionFind.root(ref);
    const group = membersByRoot.get(root) ?? [];
    group.push(ref);
    membersByRoot.set(root, group);
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
      const spanning = differentAssertions.find((assertion) => {
        const spanA = unionFind.root({
          kind: assertion.a_kind,
          id: assertion.a_id,
        });
        const spanB = unionFind.root({
          kind: assertion.b_kind,
          id: assertion.b_id,
        });
        return (
          (spanA === rootA && spanB === rootB) ||
          (spanA === rootB && spanB === rootA)
        );
      });
      if (spanning !== undefined) {
        throw new IdentityContradictionError({
          operation,
          a,
          b,
          reason: "different-assertion",
          conflictingAssertionId: spanning.id,
        });
      }
      const disjointKinds = classHasDisjointKinds(
        ctx.registry,
        membersByRoot.get(rootA) ?? [a],
        membersByRoot.get(rootB) ?? [b],
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
        const mergedRoot = unionFind.root(a);
        const merged = [
          ...(membersByRoot.get(rootA) ?? [a]),
          ...(membersByRoot.get(rootB) ?? [b]),
        ];
        membersByRoot.delete(rootA);
        membersByRoot.delete(rootB);
        membersByRoot.set(mergedRoot, merged);
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
      SELECT graph_id, id, rel, a_kind, a_id, b_kind, b_id,
             valid_from, valid_to, created_at, updated_at, deleted_at
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
  touch: (
    graphId: string,
    assertionId: string,
    afterImage?: IdentityAssertionStorageRow,
  ) => void,
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
  await executeStatement(
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
  for (
    let offset = 0;
    offset < uniqueIds.length;
    offset += REFERENCE_CHUNK_SIZE
  ) {
    const chunk = uniqueIds.slice(offset, offset + REFERENCE_CHUNK_SIZE);
    const placeholders = sql.join(
      chunk.map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = await target.execute<RawIdentityAssertionRow>(
      asCompiledRowsSql(sql`
        SELECT graph_id, id, rel, a_kind, a_id, b_kind, b_id,
               valid_from, valid_to, created_at, updated_at, deleted_at
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
  for (const [validTo, ids] of byValidTo) {
    for (let offset = 0; offset < ids.length; offset += REFERENCE_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + REFERENCE_CHUNK_SIZE);
      const placeholders = sql.join(
        chunk.map((id) => sql`${id}`),
        sql`, `,
      );
      await executeStatement(
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
  for (const row of current) {
    const ended = {
      ...row,
      valid_to: endedById.get(row.id)!,
      updated_at: now,
    };
    touch(ctx.graphId, row.id, ended);
  }
  return current.map((row) => ({
    ...row,
    valid_to: endedById.get(row.id)!,
    updated_at: now,
  }));
}

async function runIdentityMutation<G extends GraphDef, T>(
  ctx: IdentityServiceContext<G>,
  fn: (
    target: Backend,
    touch: (
      graphId: string,
      id: string,
      afterImage?: IdentityAssertionStorageRow,
    ) => void,
  ) => Promise<T>,
): Promise<T> {
  // Track whether the mutation actually touched a row: a successful no-op
  // (retracting an unknown id, an idempotent reassert) must not advance the
  // durable revision clock on revision-tracking stores.
  let touched = false;
  return runInWriteTransaction(
    {
      graphId: ctx.graphId,
      historyEnabled: ctx.historyEnabled,
      revisionTrackingEnabled: ctx.revisionTrackingEnabled,
      revisionSchema: ctx.schema,
    },
    ctx.backend,
    async (target) => {
      await lockIdentityGraph(target, ctx.graphId);
      return withRecordedIdentityMutationTarget(target, (rawTarget, touch) =>
        fn(rawTarget, (graphId, id, afterImage) => {
          touched = true;
          touch(graphId, id, afterImage);
        }),
      );
    },
    { shouldAdvanceRevision: () => touched },
  );
}

export function createIdentityReadFacade<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
): IdentityReadFacade<G> {
  return {
    async representativeOf(input) {
      const members = await visibleMembersAtCoordinate(ctx, plainRef(input));
      return members[0] === undefined ? undefined : publicNodeRef(members[0]);
    },

    async membersOf(input) {
      const members = await visibleMembersAtCoordinate(ctx, plainRef(input));
      return members.map((member) => publicNodeRef<G>(member));
    },

    async nodesOf(input) {
      const members = await visibleMembersAtCoordinate(ctx, plainRef(input));
      const nodes = await Promise.all(
        members.map((member) => ctx.loadNode(member, ctx.coordinate)),
      );
      return nodes.filter((node) => node !== undefined);
    },

    async areSame(firstInput, secondInput) {
      const first = plainRef(firstInput);
      const second = plainRef(secondInput);
      const members = await visibleMembersAtCoordinate(ctx, first);
      return members.some((member) => refKey(member) === refKey(second));
    },

    async areDifferent(firstInput, secondInput) {
      const first = plainRef(firstInput);
      const second = plainRef(secondInput);
      if (isCurrentClosureCoordinate(ctx.coordinate)) {
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
        const firstClass = classes.get(refKey(first))!;
        const secondClass = classes.get(refKey(second))!;
        const different = await loadSpanningDifferentAssertion(
          ctx.backend,
          ctx.schema,
          ctx.graphId,
          firstClass,
          secondClass,
        );
        return (
          different !== undefined ||
          classHasDisjointKinds(ctx.registry, firstClass, secondClass) !==
            undefined
        );
      }
      const classes = await loadHistoricalClasses(
        ctx.backend,
        ctx.schema,
        ctx.graphId,
        [first, second],
        ctx.coordinate!,
        ctx.sameIdAcrossKinds,
      );
      const firstClass = classes.get(refKey(first))!;
      const secondClass = classes.get(refKey(second))!;
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
      const ref = plainRef(input);
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
        if (ended?.rel === "same") {
          await replaceAffectedClosure(
            target,
            ctx.schema,
            ctx.graphId,
            [
              { kind: ended.a_kind, id: ended.a_id },
              { kind: ended.b_kind, id: ended.b_id },
            ],
            ctx.sameIdAcrossKinds,
          );
        }
        return ended === undefined ? undefined : publicAssertion<G>(ended);
      });
    },

    retractSameAssertion(firstInput, secondInput) {
      return runIdentityMutation(ctx, async (target, touch) => {
        const [a, b] = normalizePair(
          plainRef(firstInput),
          plainRef(secondInput),
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
          plainRef(firstInput),
          plainRef(secondInput),
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
        return ended === undefined ? undefined : publicAssertion<G>(ended);
      });
    },

    bulkRetractAssertions(ids) {
      return runIdentityMutation(ctx, async (target, touch) => {
        const retracted = await retractByIds(ctx, target, ids, touch);
        const closureReferences: PlainNodeRef[] = [];
        for (const existing of retracted) {
          if (existing.rel === "same") {
            closureReferences.push(
              { kind: existing.a_kind, id: existing.a_id },
              { kind: existing.b_kind, id: existing.b_id },
            );
          }
        }
        if (closureReferences.length > 0) {
          await replaceAffectedClosure(
            target,
            ctx.schema,
            ctx.graphId,
            closureReferences,
            ctx.sameIdAcrossKinds,
          );
        }
        return retracted.map((assertion) => publicAssertion<G>(assertion));
      });
    },
  };
}

export async function rebuildIdentityClosureForContext<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
): Promise<void> {
  if (!ctx.backend.capabilities.transactions) {
    throw new ConfigurationError(
      "Operational Identity requires atomic transaction support.",
      { code: "IDENTITY_REQUIRES_ATOMIC_BACKEND" },
    );
  }

  async function rebuildAtTarget(target: Backend): Promise<void> {
    await lockIdentityGraph(target, ctx.graphId);
    await withRecordedIdentityMutationTarget(target, async (rawTarget) => {
      const snapshot = await loadSnapshot(
        rawTarget,
        ctx.schema,
        ctx.graphId,
        undefined,
        undefined,
        ctx.sameIdAcrossKinds,
      );
      validateSnapshotIntegrity(snapshot, ctx.registry, ctx.graphId);
      await replaceClosure(
        rawTarget,
        ctx.schema,
        ctx.graphId,
        undefined,
        ctx.sameIdAcrossKinds,
      );
    });
  }

  if ("transaction" in ctx.backend) {
    await ctx.backend.transaction(async (target) => rebuildAtTarget(target));
    return;
  }
  await rebuildAtTarget(ctx.backend);
}

export async function validateIdentityForContext<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
): Promise<void> {
  if (!ctx.backend.capabilities.transactions) {
    throw new ConfigurationError(
      "Operational Identity requires atomic transaction support.",
      { code: "IDENTITY_REQUIRES_ATOMIC_BACKEND" },
    );
  }

  async function validateAtTarget(target: Backend): Promise<void> {
    await lockIdentityGraph(target, ctx.graphId);
    const snapshot = await loadSnapshot(
      target,
      ctx.schema,
      ctx.graphId,
      undefined,
      undefined,
      ctx.sameIdAcrossKinds,
    );
    validateSnapshotIntegrity(snapshot, ctx.registry, ctx.graphId);
    await assertClosureMatchesComponents(
      target,
      ctx.schema,
      ctx.graphId,
      snapshot.components,
    );
  }

  if ("transaction" in ctx.backend) {
    await ctx.backend.transaction(async (target) => validateAtTarget(target));
    return;
  }
  await validateAtTarget(ctx.backend);
}

export async function removeIdentityKindsForContext<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  kinds: readonly string[],
): Promise<void> {
  if (kinds.length === 0) return;
  const removedKinds = [...new Set(kinds)];
  await runIdentityMutation(ctx, async (target, touch) => {
    const matched = new Map<string, IdentityAssertionStorageRow>();
    for (
      let offset = 0;
      offset < removedKinds.length;
      offset += REFERENCE_CHUNK_SIZE
    ) {
      const kindChunk = removedKinds.slice(
        offset,
        offset + REFERENCE_CHUNK_SIZE,
      );
      const kindList = sql.join(
        kindChunk.map((kind) => sql`${kind}`),
        sql`, `,
      );
      const rows = await target.execute<RawIdentityAssertionRow>(
        asCompiledRowsSql(sql`
          SELECT graph_id, id, rel, a_kind, a_id, b_kind, b_id,
                 valid_from, valid_to, created_at, updated_at, deleted_at
          FROM ${ctx.schema.identityAssertionsTable}
          WHERE graph_id = ${ctx.graphId}
            AND (a_kind IN (${kindList}) OR b_kind IN (${kindList}))
        `),
      );
      for (const rawRow of rows) {
        matched.set(rawRow.id, normalizeAssertionRow(rawRow));
      }
    }
    const ids = [...matched.keys()];
    for (let offset = 0; offset < ids.length; offset += REFERENCE_CHUNK_SIZE) {
      const idChunk = ids.slice(offset, offset + REFERENCE_CHUNK_SIZE);
      const idList = sql.join(
        idChunk.map((id) => sql`${id}`),
        sql`, `,
      );
      await executeStatement(
        target,
        sql`
          DELETE FROM ${ctx.schema.identityAssertionsTable}
          WHERE graph_id = ${ctx.graphId} AND id IN (${idList})
        `,
      );
    }
    for (const row of matched.values()) touch(ctx.graphId, row.id);
    await replaceClosure(
      target,
      ctx.schema,
      ctx.graphId,
      new Set(ctx.registry.nodeKinds.keys()),
      ctx.sameIdAcrossKinds,
    );
  });
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
    const ids = [...new Set(references.map((ref) => ref.id))];
    // Deliberately per-kind (no global id index): one chunked SELECT per node
    // kind over ALL created ids, rather than getNode per (ref, kind) pair.
    const liveIdsByKind = new Map<string, Set<string>>();
    for (const kind of ctx.registry.nodeKinds.keys()) {
      const liveIds = new Set<string>();
      for (
        let offset = 0;
        offset < ids.length;
        offset += REFERENCE_CHUNK_SIZE
      ) {
        const idChunk = ids.slice(offset, offset + REFERENCE_CHUNK_SIZE);
        const idList = sql.join(
          idChunk.map((id) => sql`${id}`),
          sql`, `,
        );
        const rows = await rawTarget.execute<
          Readonly<{ kind: string; id: string }>
        >(
          asCompiledRowsSql(sql`
            SELECT kind, id
            FROM ${ctx.schema.nodesTable}
            WHERE graph_id = ${ctx.graphId}
              AND kind = ${kind}
              AND id IN (${idList})
              AND deleted_at IS NULL
          `),
        );
        for (const row of rows) liveIds.add(row.id);
      }
      if (liveIds.size > 0) liveIdsByKind.set(kind, liveIds);
    }
    const closureReferences: PlainNodeRef[] = [];
    for (const ref of references) {
      const peers: PlainNodeRef[] = [];
      for (const [kind, liveIds] of liveIdsByKind) {
        if (kind === ref.kind) continue;
        if (liveIds.has(ref.id)) peers.push({ kind, id: ref.id });
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
        SELECT graph_id, id, rel, a_kind, a_id, b_kind, b_id,
               valid_from, valid_to, created_at, updated_at, deleted_at
        FROM ${ctx.schema.identityAssertionsTable}
        WHERE graph_id = ${ctx.graphId}
          ${scope}
          AND ${touchesNode}
      `),
    );
    const now = nowIso();
    for (const rawRow of rows) {
      const row = normalizeAssertionRow(rawRow);
      if (mode === "hard") {
        await executeStatement(
          rawTarget,
          sql`
            DELETE FROM ${ctx.schema.identityAssertionsTable}
            WHERE graph_id = ${ctx.graphId} AND id = ${row.id}
          `,
        );
        touch(ctx.graphId, row.id);
      } else {
        const validTo = clampValidTo(now, row.valid_from);
        const ended = { ...row, valid_to: validTo, updated_at: now };
        await executeStatement(
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
): Promise<readonly IdentityTransferAssertion[]> {
  const rows = await ctx.backend.execute<RawIdentityAssertionRow>(
    asCompiledRowsSql(sql`
      SELECT graph_id, id, rel, a_kind, a_id, b_kind, b_id,
             valid_from, valid_to, created_at, updated_at, deleted_at
      FROM ${ctx.schema.identityAssertionsTable}
      WHERE graph_id = ${ctx.graphId}
        AND deleted_at IS NULL
        ${mode === "state" ? sql`AND valid_to IS NULL` : sql``}
    `),
  );
  return rows
    .map((row): IdentityTransferAssertion => {
      const assertion = normalizeAssertionRow(row);
      return {
        id: assertion.id,
        relation: assertion.rel,
        a: { kind: assertion.a_kind, id: assertion.a_id },
        b: { kind: assertion.b_kind, id: assertion.b_id },
        validFrom: assertion.valid_from,
        ...(assertion.valid_to === undefined ?
          {}
        : { validTo: assertion.valid_to }),
      };
    })
    .toSorted((left, right) => compareCodePoints(left.id, right.id));
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
    throw new ValidationError(
      "Identity import references an unknown node kind.",
      {
        issues: [
          {
            path: "identity.assertions",
            message: `Unknown identity endpoint kind in assertion ${assertion.id}`,
            code: "IDENTITY_IMPORT_UNKNOWN_KIND",
          },
        ],
      },
    );
  }
  if (refKey(assertion.a) === refKey(assertion.b)) {
    throw selfAssertionError(assertion.relation);
  }
  const normalized = normalizePair(assertion.a, assertion.b);
  if (
    refKey(normalized[0]) !== refKey(assertion.a) ||
    refKey(normalized[1]) !== refKey(assertion.b)
  ) {
    throw new ValidationError("Identity import pairs must be normalized.", {
      issues: [
        {
          path: "identity.assertions",
          message: `Assertion ${assertion.id} endpoints are not in code-point order`,
          code: "IDENTITY_IMPORT_PAIR_NOT_NORMALIZED",
        },
      ],
    });
  }
  if (mode === "state" && assertion.validTo !== undefined) {
    throw new ValidationError(
      "State identity import cannot contain ended assertions.",
      {
        issues: [
          {
            path: "identity.assertions",
            message: `Assertion ${assertion.id} is ended`,
            code: "IDENTITY_STATE_IMPORT_ENDED_ASSERTION",
          },
        ],
      },
    );
  }
  // A state row is asserted as current-truth "now"; a future validFrom would
  // insert a row the closure filter (valid_from <= now) excludes yet
  // currentAssertionForPair (valid_to IS NULL only) treats as current —
  // two conflicting definitions of "current". Archival rows carry their own
  // historical validFrom and are not subject to this.
  if (
    mode === "state" &&
    compareCodePoints(assertion.validFrom, nowIso()) > 0
  ) {
    throw new ValidationError(
      "State identity import cannot contain future-dated assertions.",
      {
        issues: [
          {
            path: "identity.assertions",
            message: `Assertion ${assertion.id} validFrom is in the future`,
            code: "IDENTITY_IMPORT_FUTURE_VALID_FROM",
          },
        ],
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
    throw new ValidationError("Identity assertion validity window is empty.", {
      issues: [
        {
          path: "identity.assertions",
          message: `Assertion ${assertion.id} validTo must not precede validFrom`,
          code: "IDENTITY_IMPORT_INVALID_WINDOW",
        },
      ],
    });
  }
  return normalized;
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
    const normalizedPairs = assertions.map((assertion) =>
      validateTransferShape(ctx, assertion, mode),
    );
    const existingById = await loadAssertionsByIds(
      rawTarget,
      ctx.schema,
      ctx.graphId,
      assertions.map((assertion) => assertion.id),
    );
    const currentEndpoints: PlainNodeRef[] = [];
    for (const [index, assertion] of assertions.entries()) {
      if (assertion.validTo !== undefined) continue;
      const [a, b] = normalizedPairs[index]!;
      currentEndpoints.push(a, b);
    }
    await requireLiveEndpoints(
      rawTarget,
      ctx.schema,
      ctx.graphId,
      currentEndpoints,
    );

    for (const [index, assertion] of assertions.entries()) {
      const [a, b] = normalizedPairs[index]!;
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
        await executeStatement(
          rawTarget,
          sql`
            INSERT INTO ${ctx.schema.identityAssertionsTable} (
              graph_id, id, rel, a_kind, a_id, b_kind, b_id,
              valid_from, valid_to, created_at, updated_at, deleted_at
            ) VALUES (
              ${row.graph_id}, ${row.id}, ${row.rel}, ${row.a_kind}, ${row.a_id},
              ${row.b_kind}, ${row.b_id}, ${row.valid_from}, ${row.valid_to},
              ${row.created_at}, ${row.updated_at}, NULL
            )
          `,
        );
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
      }
    }
  });
  return { created, skipped };
}

export async function applyIdentityChangesForContext<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  retractionIds: readonly string[],
  assertions: readonly IdentityTransferAssertion[],
): Promise<void> {
  if (retractionIds.length === 0 && assertions.length === 0) return;
  await runIdentityMutation(ctx, async (target, touch) => {
    const closureReferences: PlainNodeRef[] = [];
    for (const id of retractionIds) {
      const ended = await retractById(ctx, target, id, touch);
      if (ended?.rel === "same") {
        closureReferences.push(
          { kind: ended.a_kind, id: ended.a_id },
          { kind: ended.b_kind, id: ended.b_id },
        );
      }
    }
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
    await importIdentityAssertionsIntoTarget(ctx, target, assertions, "state");
  });
}
