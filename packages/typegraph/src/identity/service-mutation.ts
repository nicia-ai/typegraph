import { type GraphDef } from "../core/define-graph";
import {
  IdentityContradictionError,
  type IdentityContradictionErrorDetails,
  IdentityEndpointValidityError,
  IdentityValidityWindowError,
  NodeNotFoundError,
} from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { chunk } from "../utils/array";
import { canonicalizeDatabaseTimestamp } from "../utils/date";
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
  loadHistoricalClasses,
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
  type IdentityValidityWindow,
} from "./types";
import {
  type ResolvedIdentityValidityWindow,
  resolveIdentityValidityWindow,
} from "./validity-window";

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

export async function assertionForExactWindow(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  relation: IdentityRelation,
  a: PlainNodeRef,
  b: PlainNodeRef,
  window: ResolvedIdentityValidityWindow,
): Promise<IdentityAssertionStorageRow | undefined> {
  const validToMatch =
    window.validTo === undefined ?
      sql`valid_to IS NULL`
    : sql`valid_to = ${window.validTo}`;
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
        AND valid_from = ${window.validFrom}
        AND ${validToMatch}
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
  operationInstant: string,
  touch: IdentityTouch,
  options?: Readonly<{
    id?: string;
    validFrom?: string;
    validTo?: string;
  }>,
): Promise<IdentityAssertionStorageRow> {
  const row = buildAssertionRow(
    graphId,
    relation,
    a,
    b,
    operationInstant,
    options,
  );
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
  options?: Readonly<{
    id?: string;
    validFrom?: string;
    validTo?: string;
  }>,
): IdentityAssertionStorageRow {
  return {
    graph_id: graphId,
    id: options?.id ?? generateId(),
    rel: relation,
    a_kind: a.kind,
    a_id: a.id,
    b_kind: b.kind,
    b_id: b.id,
    valid_from: options?.validFrom ?? timestamp,
    valid_to: options?.validTo,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: undefined,
    ended_by_kind: undefined,
    ended_by_id: undefined,
  };
}

function canonicalEndpointTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return canonicalizeDatabaseTimestamp(value);
}

export async function requireEndpointsCoverIdentityWindow(
  target: Backend,
  graphId: string,
  references: readonly PlainNodeRef[],
  window: ResolvedIdentityValidityWindow,
): Promise<void> {
  for (const ref of references) {
    const row = await target.getNode(graphId, ref.kind, ref.id);
    if (row === undefined) throw new NodeNotFoundError(ref.kind, ref.id);
    if (window.effective === "empty") continue;
    const validFrom = canonicalEndpointTimestamp(row.valid_from);
    const validTo = canonicalEndpointTimestamp(row.valid_to);
    const deletedAt = canonicalEndpointTimestamp(row.deleted_at);
    const endpointWindow = {
      ...(validFrom === undefined ? {} : { validFrom }),
      ...(validTo === undefined ? {} : { validTo }),
      ...(deletedAt === undefined ? {} : { deletedAt }),
    };
    const startsTooLate =
      endpointWindow.validFrom !== undefined &&
      endpointWindow.validFrom > window.validFrom;
    const effectiveEnd = [endpointWindow.validTo, endpointWindow.deletedAt]
      .filter((value): value is string => value !== undefined)
      .toSorted()[0];
    const endsTooEarly =
      window.validTo === undefined ?
        effectiveEnd !== undefined
      : effectiveEnd !== undefined && effectiveEnd < window.validTo;
    if (!startsTooLate && !endsTooEarly) continue;
    throw new IdentityEndpointValidityError({
      endpoint: ref,
      assertionWindow: {
        validFrom: window.validFrom,
        ...(window.validTo === undefined ? {} : { validTo: window.validTo }),
      },
      endpointWindow,
    });
  }
}

type RawIdentityBoundaryRow = Readonly<{
  valid_from?: unknown;
  valid_to?: unknown;
  created_at?: unknown;
  deleted_at?: unknown;
}>;

async function identityWindowCheckpoints(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  window: ResolvedIdentityValidityWindow,
  operationInstant: string,
): Promise<readonly string[]> {
  if (window.effective === "empty") return [];
  const upperBoundary = window.validTo ?? operationInstant;
  const [assertionRows, nodeRows] = await Promise.all([
    target.execute<RawIdentityBoundaryRow>(
      asCompiledRowsSql(sql`
        SELECT valid_from, valid_to
        FROM ${schema.identityAssertionsTable}
        WHERE graph_id = ${graphId}
          AND deleted_at IS NULL
          AND (
            (valid_from >= ${window.validFrom} AND valid_from < ${upperBoundary})
            OR (valid_to >= ${window.validFrom} AND valid_to < ${upperBoundary})
          )
      `),
    ),
    target.execute<RawIdentityBoundaryRow>(
      asCompiledRowsSql(sql`
        SELECT valid_from, valid_to, created_at, deleted_at
        FROM ${schema.nodesTable}
        WHERE graph_id = ${graphId}
          AND (
            (valid_from >= ${window.validFrom} AND valid_from < ${upperBoundary})
            OR (valid_to >= ${window.validFrom} AND valid_to < ${upperBoundary})
            OR (created_at >= ${window.validFrom} AND created_at < ${upperBoundary})
            OR (deleted_at >= ${window.validFrom} AND deleted_at < ${upperBoundary})
          )
      `),
    ),
  ]);
  const checkpoints = new Set([window.validFrom]);
  if (window.validTo === undefined) checkpoints.add(operationInstant);
  for (const row of [...assertionRows, ...nodeRows]) {
    for (const value of [
      row.valid_from,
      row.valid_to,
      row.created_at,
      row.deleted_at,
    ]) {
      const boundary = canonicalEndpointTimestamp(value);
      if (boundary === undefined || boundary < window.validFrom) continue;
      if (window.validTo !== undefined && boundary >= window.validTo) continue;
      if (boundary > operationInstant) continue;
      checkpoints.add(boundary);
    }
  }
  return [...checkpoints].toSorted();
}

export async function validateRelationThroughoutIdentityWindow(
  ctx: Pick<
    IdentityServiceContext<GraphDef>,
    "graphId" | "registry" | "sameIdAcrossKinds" | "schema"
  >,
  target: Backend,
  relation: IdentityRelation,
  operation: IdentityContradictionErrorDetails["operation"],
  a: PlainNodeRef,
  b: PlainNodeRef,
  window: ResolvedIdentityValidityWindow,
  operationInstant: string,
): Promise<void> {
  const checkpoints = await identityWindowCheckpoints(
    target,
    ctx.schema,
    ctx.graphId,
    window,
    operationInstant,
  );
  for (const instant of checkpoints) {
    const coordinate = {
      valid: { mode: "asOf" as const, asOf: instant },
    };
    const classes = await loadHistoricalClasses(
      target,
      ctx.schema,
      ctx.graphId,
      [a, b],
      coordinate,
      ctx.sameIdAcrossKinds,
    );
    const aClass = requireDefined(classes.get(refKey(a))).structural;
    const bClass = requireDefined(classes.get(refKey(b))).structural;
    if (relation === "different") {
      if (!containsRef(aClass, b)) continue;
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
      coordinate,
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
    if (disjointKinds === undefined) continue;
    throw new IdentityContradictionError({
      operation,
      a,
      b,
      reason: "disjoint-kinds",
      conflictingKinds: disjointKinds,
    });
  }
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
  windowInput: IdentityValidityWindow | undefined,
  operationInstant: string,
): Promise<IdentityAssertionResult<G>> {
  const first = registeredPlainRef(ctx, firstInput);
  const second = registeredPlainRef(ctx, secondInput);
  if (refKey(first) === refKey(second)) throw selfAssertionError(relation);
  const [a, b] = normalizePair(first, second);
  if (windowInput === undefined) {
    const current = await currentAssertionForPair(
      target,
      ctx.schema,
      ctx.graphId,
      relation,
      a,
      b,
    );
    if (current !== undefined) {
      return assertionResult(publicAssertion(current), "existing");
    }
    await Promise.all([
      requireLiveEndpoint(target, ctx.graphId, a),
      requireLiveEndpoint(target, ctx.graphId, b),
    ]);
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
      operationInstant,
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
  const window = resolveIdentityValidityWindow(windowInput, operationInstant);
  await requireEndpointsCoverIdentityWindow(
    target,
    ctx.graphId,
    [a, b],
    window,
  );
  const existing = await assertionForExactWindow(
    target,
    ctx.schema,
    ctx.graphId,
    relation,
    a,
    b,
    window,
  );
  if (existing !== undefined) {
    return assertionResult(publicAssertion(existing), "existing");
  }
  if (window.effective === "current") {
    const current = await currentAssertionForPair(
      target,
      ctx.schema,
      ctx.graphId,
      relation,
      a,
      b,
    );
    if (current !== undefined) {
      throw new IdentityValidityWindowError({
        reason: "overlapping-open-window",
        validFrom: window.validFrom,
        operationInstant,
      });
    }
  }

  await validateRelationThroughoutIdentityWindow(
    ctx,
    target,
    relation,
    relation === "same" ? "assertSame" : "assertDifferent",
    a,
    b,
    window,
    operationInstant,
  );
  const row = await insertAssertion(
    target,
    ctx.schema,
    ctx.graphId,
    relation,
    a,
    b,
    operationInstant,
    touch,
    {
      validFrom: window.validFrom,
      ...(window.validTo === undefined ? {} : { validTo: window.validTo }),
    },
  );
  if (window.effective !== "current") {
    return assertionResult(publicAssertion(row), "created");
  }
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
