import { type GraphDef } from "../core/define-graph";
import {
  IdentityContradictionError,
  type IdentityContradictionErrorDetails,
} from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { chunk } from "../utils/array";
import { nowIso } from "../utils/date";
import { generateId } from "../utils/id";
import { requireDefined } from "../utils/presence";
import { IDENTITY_ASSERTION_COLUMNS } from "./historical-sql";
import {
  normalizeIdentityAssertionRow,
  type RawIdentityAssertionRow,
} from "./row-codec";
import {
  buildSeparationProjection,
  deleteSeparationForClassKeys,
  deleteSeparationForGraph,
  identityClassKey,
  insertSeparationRows,
  isSeparated,
  unexpectedSeparationError,
} from "./separation";
import {
  buildComponents,
  classHasDisjointKinds,
  componentFor,
  loadLiveReferences,
  loadSnapshot,
  requireLiveEndpoint,
  selfAssertionError,
} from "./service-components";
import type {
  Backend,
  IdentitySnapshot,
  IdentityTouch,
  RawSeedClassAnchorRow,
} from "./service-read";
import {
  assertionResult,
  compareReferences,
  containsRef,
  loadAssertionsTouching,
  loadCurrentStructuralClasses,
  loadSpanningDifferentAssertion,
  MAX_ASSERTION_INSERT_CHUNK_SIZE,
  MAX_CLOSURE_INSERT_CHUNK_SIZE,
  normalizePair,
  publicAssertion,
  referenceCondition,
  refKey,
  registeredPlainRef,
} from "./service-read";
import { type IdentityServiceContext } from "./service-types";
import {
  executeIdentityStatement,
  identityChunkSize,
  MAX_REFERENCE_CHUNK_SIZE,
  type PlainNodeRef,
} from "./sql-target";
import { type IdentityAssertionStorageRow } from "./storage-types";
import {
  type IdentityAssertionResult,
  type IdentityNodeRefInput,
  type IdentityRelation,
} from "./types";

export async function validateCurrentRelation(
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
  if (
    await isSeparated(target, ctx.schema, ctx.graphId, aKey, bKey, ctx.registry)
  ) {
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

export async function currentAssertionForPair(
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
  return rows[0] === undefined ?
      undefined
    : normalizeIdentityAssertionRow(rows[0]);
}

export async function insertAssertion(
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

export function buildAssertionRow(
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
    ended_by_kind: undefined,
    ended_by_id: undefined,
  };
}

/**
 * A nullable assertion column. An absent value inlines a literal `NULL` rather
 * than binding one, so the tuple's worst-case bind count is what
 * `parametersPerItem` below assumes.
 */
function nullableAssertionValue(value: string | undefined): SqlFragment {
  return value === undefined ? sql`NULL` : sql`${value}`;
}

export async function insertAssertionRows(
  target: Backend,
  schema: SqlSchema,
  rows: readonly IdentityAssertionStorageRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 0,
    maxItems: MAX_ASSERTION_INSERT_CHUNK_SIZE,
    parametersPerItem: 14,
  });
  for (const rowChunk of chunk(rows, chunkSize)) {
    // Tuple order follows IDENTITY_ASSERTION_COLUMNS, which is also the INSERT's
    // column clause below.
    const values = rowChunk.map(
      (row) => sql`
        (
                ${row.graph_id}, ${row.id}, ${row.rel}, ${row.a_kind}, ${row.a_id},
                ${row.b_kind}, ${row.b_id}, ${row.valid_from},
                ${nullableAssertionValue(row.valid_to)},
                ${row.created_at}, ${row.updated_at},
                ${nullableAssertionValue(row.deleted_at)},
                ${nullableAssertionValue(row.ended_by_kind)},
                ${nullableAssertionValue(row.ended_by_id)}
              )
      `,
    );
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
      byId.set(row.id, normalizeIdentityAssertionRow(row));
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
export function currentClassKey(members: readonly PlainNodeRef[]): string {
  return identityClassKey(requireDefined(members[0]));
}

/** The class key a full snapshot assigns to a reference. */
export function snapshotClassKey(
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
export async function replaceSeparationForReferences(
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

export async function replaceClosure(
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

export async function replaceAffectedClosure(
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

export async function mergeCurrentClasses(
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

export async function assertPair<G extends GraphDef>(
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
