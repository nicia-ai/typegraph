import { type SQL, sql } from "drizzle-orm";

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
  type IdentityFacade,
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

export type IdentityServiceContext<G extends GraphDef> = Readonly<{
  graph: G;
  graphId: string;
  registry: KindRegistry;
  backend: Backend;
  schema: SqlSchema;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
  coordinate?: ReadCoordinate;
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
  visibleNodeKeys: ReadonlySet<string>;
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
    a: { kind: row.a_kind, id: row.a_id },
    b: { kind: row.b_kind, id: row.b_id },
    validFrom: row.valid_from,
    ...(row.valid_to === undefined ? {} : { validTo: row.valid_to }),
  };
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
  statement: SQL,
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

function nodeVisibility(
  node: NodeSnapshot,
  coordinate: ReadCoordinate | undefined,
  currentInstant: string,
): boolean {
  const mode = coordinate?.valid.mode ?? "current";
  if (mode === "includeTombstones") return true;
  if (node.deletedAt !== undefined) return false;
  if (mode === "includeEnded") return true;
  const instant =
    mode === "asOf" ?
      (coordinate?.valid.asOf ?? currentInstant)
    : currentInstant;
  return (
    (node.validFrom === undefined || node.validFrom <= instant) &&
    (node.validTo === undefined || node.validTo > instant)
  );
}

async function loadNodeSnapshot(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  coordinate: ReadCoordinate | undefined,
): Promise<readonly NodeSnapshot[]> {
  const recordedAsOf = coordinate?.recorded?.asOf;
  const source =
    recordedAsOf === undefined ?
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
  const rows = await target.execute<RawNodeSnapshotRow>(
    asCompiledRowsSql(source),
  );
  return rows.map((row) => ({
    ref: { kind: row.kind, id: row.id },
    validFrom: optionalTimestamp(row.valid_from),
    validTo: optionalTimestamp(row.valid_to),
    createdAt: toCanonicalIso(row.created_at),
    deletedAt: optionalTimestamp(row.deleted_at),
  }));
}

function assertionValidityFilter(
  coordinate: ReadCoordinate | undefined,
  currentInstant: string,
): Readonly<{ instant: string; includeEnded: boolean }> {
  const mode = coordinate?.valid.mode ?? "current";
  return {
    instant:
      mode === "asOf" ?
        (coordinate?.valid.asOf ?? currentInstant)
      : (coordinate?.recorded?.asOf ?? currentInstant),
    includeEnded: mode === "includeEnded" || mode === "includeTombstones",
  };
}

function nodeSnapshotSource(
  schema: SqlSchema,
  graphId: string,
  coordinate: ReadCoordinate | undefined,
): SQL {
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
): SQL {
  const recordedAsOf = coordinate?.recorded?.asOf;
  const { instant, includeEnded } = assertionValidityFilter(
    coordinate,
    currentInstant,
  );
  const validity =
    includeEnded ?
      sql``
    : sql`AND valid_from <= ${instant} AND (valid_to IS NULL OR valid_to > ${instant})`;
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
): SQL {
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
): Promise<readonly PlainNodeRef[]> {
  const classes = await loadHistoricalClasses(
    target,
    schema,
    graphId,
    [ref],
    coordinate,
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
        UNION ALL
        SELECT left_node.kind, left_node.id, right_node.kind, right_node.id
        FROM node_snapshot left_node
        JOIN node_snapshot right_node
          ON right_node.id = left_node.id
         AND (right_node.kind <> left_node.kind OR right_node.id <> left_node.id)
        WHERE left_node.deleted_at IS NULL
          AND right_node.deleted_at IS NULL
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
  kindColumn: SQL,
  idColumn: SQL,
  references: readonly PlainNodeRef[],
): SQL {
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

class UnionFind {
  readonly #parents = new Map<string, string>();
  readonly #refs = new Map<string, PlainNodeRef>();

  add(ref: PlainNodeRef): void {
    const key = refKey(ref);
    if (this.#parents.has(key)) return;
    this.#parents.set(key, key);
    this.#refs.set(key, ref);
  }

  #find(key: string): string {
    const parent = this.#parents.get(key);
    if (parent === undefined) throw new Error(`Unknown identity member ${key}`);
    if (parent === key) return key;
    const root = this.#find(parent);
    this.#parents.set(key, root);
    return root;
  }

  union(first: PlainNodeRef, second: PlainNodeRef): void {
    this.add(first);
    this.add(second);
    const firstRoot = this.#find(refKey(first));
    const secondRoot = this.#find(refKey(second));
    if (firstRoot === secondRoot) return;
    const firstRef = this.#refs.get(firstRoot)!;
    const secondRef = this.#refs.get(secondRoot)!;
    if (compareReferences(firstRef, secondRef) <= 0) {
      this.#parents.set(secondRoot, firstRoot);
    } else {
      this.#parents.set(firstRoot, secondRoot);
    }
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
): ReadonlyMap<string, readonly PlainNodeRef[]> {
  const unionFind = new UnionFind();
  const byId = new Map<string, PlainNodeRef[]>();
  for (const ref of structuralNodes) {
    unionFind.add(ref);
    const group = byId.get(ref.id) ?? [];
    group.push(ref);
    byId.set(ref.id, group);
  }
  for (const group of byId.values()) {
    const first = group[0];
    if (first === undefined) continue;
    for (const member of group.slice(1)) unionFind.union(first, member);
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
  const visibleNodeKeys = new Set(
    scopedNodes
      .filter((node) => nodeVisibility(node, coordinate, currentInstant))
      .map((node) => refKey(node.ref)),
  );
  return {
    nodes: scopedNodes,
    structuralNodes,
    visibleNodeKeys,
    assertions: scopedAssertions,
    components: buildComponents(structuralNodes, scopedAssertions),
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

function validateRelationAgainstSnapshot(
  snapshot: IdentitySnapshot,
  registry: KindRegistry,
  relation: IdentityRelation,
  operation: IdentityContradictionErrorDetails["operation"],
  a: PlainNodeRef,
  b: PlainNodeRef,
): void {
  const aClass = componentFor(snapshot, a);
  const bClass = componentFor(snapshot, b);
  if (relation === "different") {
    if (!sameComponent(snapshot, a, b)) return;
    throw new IdentityContradictionError({
      operation,
      a,
      b,
      reason: "same-class",
    });
  }

  const different = spanningDifferentAssertion(
    snapshot.assertions,
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

  const disjointKinds = classHasDisjointKinds(registry, aClass, bClass);
  if (disjointKinds === undefined) return;
  throw new IdentityContradictionError({
    operation,
    a,
    b,
    reason: "disjoint-kinds",
    conflictingKinds: disjointKinds,
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
  const chunkSize = 50;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const values = rows.slice(offset, offset + chunkSize).map((row) => {
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

async function assertionById(
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
      WHERE graph_id = ${graphId} AND id = ${id}
      LIMIT 1
    `),
  );
  return rows[0] === undefined ? undefined : normalizeAssertionRow(rows[0]);
}

async function replaceClosure(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  allowedKinds?: ReadonlySet<string>,
): Promise<void> {
  const snapshot = await loadSnapshot(
    target,
    schema,
    graphId,
    undefined,
    allowedKinds,
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
  const values: SQL[] = [];
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
    buildComponents(structuralNodes, assertions),
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
): Promise<IdentityAssertion<G>> {
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
  if (existing !== undefined) return publicAssertion(existing);

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
  return publicAssertion(row);
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
): Promise<readonly IdentityAssertion<G>[]> {
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
  const assertions = [...persistedAssertions];
  const bySemanticKey = new Map(
    assertions.map((assertion) => [
      assertionSemanticKey(
        assertion.rel,
        { kind: assertion.a_kind, id: assertion.a_id },
        { kind: assertion.b_kind, id: assertion.b_id },
      ),
      assertion,
    ]),
  );
  const createdRows: IdentityAssertionStorageRow[] = [];
  const results: IdentityAssertion<G>[] = [];
  const closureReferences: PlainNodeRef[] = [];
  const timestamp = nowIso();

  for (const [a, b] of normalizedPairs) {
    const semanticKey = assertionSemanticKey(relation, a, b);
    const existing = bySemanticKey.get(semanticKey);
    if (existing !== undefined) {
      results.push(publicAssertion(existing));
      continue;
    }
    const snapshot: IdentitySnapshot = {
      nodes: [],
      structuralNodes,
      visibleNodeKeys: new Set(structuralNodes.map((ref) => refKey(ref))),
      assertions,
      components: buildComponents(structuralNodes, assertions),
    };
    validateRelationAgainstSnapshot(
      snapshot,
      ctx.registry,
      relation,
      relation === "same" ? "assertSame" : "assertDifferent",
      a,
      b,
    );
    const row = buildAssertionRow(ctx.graphId, relation, a, b, timestamp);
    assertions.push(row);
    createdRows.push(row);
    bySemanticKey.set(semanticKey, row);
    results.push(publicAssertion(row));
    if (relation === "same") closureReferences.push(a, b);
  }

  await insertAssertionRows(target, ctx.schema, createdRows);
  for (const row of createdRows) touch(ctx.graphId, row.id, row);
  if (closureReferences.length > 0) {
    await replaceAffectedClosure(
      target,
      ctx.schema,
      ctx.graphId,
      closureReferences,
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

async function retractById(
  ctx: IdentityServiceContext<GraphDef>,
  target: Backend,
  id: string,
  touch: (
    graphId: string,
    assertionId: string,
    afterImage?: IdentityAssertionStorageRow,
  ) => void,
): Promise<boolean> {
  const existing = await findCurrentAssertionById(
    target,
    ctx.schema,
    ctx.graphId,
    id,
  );
  if (existing === undefined) return false;
  const timestamp = nowIso();
  const ended = { ...existing, valid_to: timestamp, updated_at: timestamp };
  await executeStatement(
    target,
    sql`
      UPDATE ${ctx.schema.identityAssertionsTable}
      SET valid_to = ${timestamp}, updated_at = ${timestamp}
      WHERE graph_id = ${ctx.graphId}
        AND id = ${id}
        AND valid_to IS NULL
    `,
  );
  touch(ctx.graphId, id, ended);
  return existing.rel === "same";
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
  const timestamp = nowIso();
  for (
    let offset = 0;
    offset < current.length;
    offset += REFERENCE_CHUNK_SIZE
  ) {
    const chunk = current.slice(offset, offset + REFERENCE_CHUNK_SIZE);
    const placeholders = sql.join(
      chunk.map((row) => sql`${row.id}`),
      sql`, `,
    );
    await executeStatement(
      target,
      sql`
        UPDATE ${ctx.schema.identityAssertionsTable}
        SET valid_to = ${timestamp}, updated_at = ${timestamp}
        WHERE graph_id = ${ctx.graphId}
          AND id IN (${placeholders})
          AND valid_to IS NULL
      `,
    );
  }
  for (const row of current) {
    touch(ctx.graphId, row.id, {
      ...row,
      valid_to: timestamp,
      updated_at: timestamp,
    });
  }
  return current;
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
      return withRecordedIdentityMutationTarget(target, fn);
    },
  );
}

export function createIdentityReadFacade<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
): IdentityReadFacade<G> {
  return {
    async representativeOf(input) {
      const members = await visibleMembersAtCoordinate(ctx, plainRef(input));
      return members[0];
    },

    async membersOf(input) {
      return visibleMembersAtCoordinate(ctx, plainRef(input));
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
        const existing = await findCurrentAssertionById(
          target,
          ctx.schema,
          ctx.graphId,
          id,
        );
        const rebuild = await retractById(ctx, target, id, touch);
        if (rebuild && existing !== undefined) {
          await replaceAffectedClosure(target, ctx.schema, ctx.graphId, [
            { kind: existing.a_kind, id: existing.a_id },
            { kind: existing.b_kind, id: existing.b_id },
          ]);
        }
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
        await retractById(ctx, target, existing.id, touch);
        await replaceAffectedClosure(target, ctx.schema, ctx.graphId, [a, b]);
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
        await retractById(ctx, target, existing.id, touch);
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
          );
        }
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
      const snapshot = await loadSnapshot(rawTarget, ctx.schema, ctx.graphId);
      validateSnapshotIntegrity(snapshot, ctx.registry, ctx.graphId);
      await replaceClosure(rawTarget, ctx.schema, ctx.graphId);
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
    const snapshot = await loadSnapshot(target, ctx.schema, ctx.graphId);
    validateSnapshotIntegrity(snapshot, ctx.registry, ctx.graphId);
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
  const removed = new Set(kinds);
  await runIdentityMutation(ctx, async (target, touch) => {
    const rows = await target.execute<RawIdentityAssertionRow>(
      asCompiledRowsSql(sql`
        SELECT graph_id, id, rel, a_kind, a_id, b_kind, b_id,
               valid_from, valid_to, created_at, updated_at, deleted_at
        FROM ${ctx.schema.identityAssertionsTable}
        WHERE graph_id = ${ctx.graphId}
      `),
    );
    for (const rawRow of rows) {
      const row = normalizeAssertionRow(rawRow);
      if (!removed.has(row.a_kind) && !removed.has(row.b_kind)) continue;
      await executeStatement(
        target,
        sql`
          DELETE FROM ${ctx.schema.identityAssertionsTable}
          WHERE graph_id = ${ctx.graphId} AND id = ${row.id}
        `,
      );
      touch(ctx.graphId, row.id);
    }
    await replaceClosure(
      target,
      ctx.schema,
      ctx.graphId,
      new Set(ctx.registry.nodeKinds.keys()),
    );
  });
}

export async function foldIdentityForCreatedNodes(
  ctx: Pick<
    IdentityServiceContext<GraphDef>,
    "graphId" | "registry" | "schema"
  >,
  target: Backend,
  references: readonly PlainNodeRef[],
): Promise<void> {
  if (references.length === 0) return;
  await lockIdentityGraph(target, ctx.graphId);
  await withRecordedIdentityMutationTarget(target, async (rawTarget) => {
    const closureReferences: PlainNodeRef[] = [];
    for (const ref of references) {
      const peers: PlainNodeRef[] = [];
      for (const kind of ctx.registry.nodeKinds.keys()) {
        if (kind === ref.kind) continue;
        const row = await rawTarget.getNode(ctx.graphId, kind, ref.id);
        if (row !== undefined && row.deleted_at === undefined) {
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
    );
  });
}

export async function detachIdentityForNode(
  ctx: Pick<IdentityServiceContext<GraphDef>, "graphId" | "schema">,
  target: Backend,
  ref: PlainNodeRef,
  mode: "soft" | "hard",
): Promise<void> {
  await lockIdentityGraph(target, ctx.graphId);
  await withRecordedIdentityMutationTarget(target, async (rawTarget, touch) => {
    const rows = await rawTarget.execute<RawIdentityAssertionRow>(
      asCompiledRowsSql(sql`
        SELECT graph_id, id, rel, a_kind, a_id, b_kind, b_id,
               valid_from, valid_to, created_at, updated_at, deleted_at
        FROM ${ctx.schema.identityAssertionsTable}
        WHERE graph_id = ${ctx.graphId}
          AND valid_to IS NULL
          AND deleted_at IS NULL
          AND (
            (a_kind = ${ref.kind} AND a_id = ${ref.id})
            OR (b_kind = ${ref.kind} AND b_id = ${ref.id})
          )
      `),
    );
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
        const timestamp = nowIso();
        const ended = { ...row, valid_to: timestamp, updated_at: timestamp };
        await executeStatement(
          rawTarget,
          sql`
            UPDATE ${ctx.schema.identityAssertionsTable}
            SET valid_to = ${timestamp}, updated_at = ${timestamp}
            WHERE graph_id = ${ctx.graphId} AND id = ${row.id}
          `,
        );
        touch(ctx.graphId, row.id, ended);
      }
    }
    await replaceAffectedClosure(rawTarget, ctx.schema, ctx.graphId, [ref]);
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
  if (
    assertion.validTo !== undefined &&
    compareCodePoints(assertion.validTo, assertion.validFrom) < 0
  ) {
    throw new ValidationError("Identity assertion validity window is empty.", {
      issues: [
        {
          path: "identity.assertions",
          message: `Assertion ${assertion.id} validTo must be after validFrom`,
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
  let rebuild = false;
  const closureReferences: PlainNodeRef[] = [];
  await withRecordedIdentityMutationTarget(target, async (rawTarget, touch) => {
    for (const assertion of assertions) {
      const [a, b] = validateTransferShape(ctx, assertion, mode);
      const sameId = await assertionById(
        rawTarget,
        ctx.schema,
        ctx.graphId,
        assertion.id,
      );
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
        created += 1;
        continue;
      }

      await requireLiveEndpoints(rawTarget, ctx.schema, ctx.graphId, [a, b]);
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
      await insertAssertion(
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
      created += 1;
      rebuild = rebuild || assertion.relation === "same";
      if (assertion.relation === "same") closureReferences.push(a, b);
    }
    if (rebuild) {
      await replaceAffectedClosure(
        rawTarget,
        ctx.schema,
        ctx.graphId,
        closureReferences,
      );
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
    let rebuildAfterRetraction = false;
    const closureReferences: PlainNodeRef[] = [];
    for (const id of retractionIds) {
      const existing = await findCurrentAssertionById(
        target,
        ctx.schema,
        ctx.graphId,
        id,
      );
      rebuildAfterRetraction =
        (await retractById(ctx, target, id, touch)) || rebuildAfterRetraction;
      if (existing?.rel === "same") {
        closureReferences.push(
          { kind: existing.a_kind, id: existing.a_id },
          { kind: existing.b_kind, id: existing.b_id },
        );
      }
    }
    await importIdentityAssertionsIntoTarget(ctx, target, assertions, "state");
    if (rebuildAfterRetraction) {
      await replaceAffectedClosure(
        target,
        ctx.schema,
        ctx.graphId,
        closureReferences,
      );
    }
  });
}

export type { PlainNodeRef };
