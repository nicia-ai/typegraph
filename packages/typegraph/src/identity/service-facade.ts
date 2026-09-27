import { type GraphDef } from "../core/define-graph";
import {
  ConfigurationError,
  IdentityContradictionError,
  type IdentityContradictionErrorDetails,
} from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { getDialect } from "../query/dialect";
import { sql } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { runInWriteTransaction } from "../store/operations/write-transaction";
import { withRecordedIdentityMutationTarget } from "../store/recorded-capture";
import { chunk } from "../utils/array";
import { compareCodePoints } from "../utils/compare";
import { nowIso } from "../utils/date";
import { requireDefined } from "../utils/presence";
import { identityAssertionSemanticKey } from "./assertion-key";
import {
  decodeIdentityClassCursor,
  encodeIdentityClassCursor,
} from "./class-cursor";
import {
  IDENTITY_ASSERTION_COLUMNS,
  identityNodeSnapshotSource,
  identityNodeVisibilitySql,
  identitySqlCoordinate,
} from "./historical-sql";
import {
  normalizeIdentityAssertionRow,
  type RawIdentityAssertionRow,
} from "./row-codec";
import { isSeparated } from "./separation";
import type { DifferentAssertionIndex } from "./service-components";
import {
  classHasDisjointKinds,
  closureMismatchError,
  identityActiveKinds,
  indexDifferentAssertion,
  kindSetsHaveDisjointKinds,
  mergeDifferentAssertionRoots,
  requireLiveEndpoints,
  selfAssertionError,
  UnionFind,
} from "./service-components";
import {
  assertPair,
  buildAssertionRow,
  createIdentityWindowValidator,
  currentAssertionForPair,
  currentClassKey,
  insertAssertionRows,
  replaceAffectedClosure,
  replaceSeparationForReferences,
} from "./service-mutation";
import type { Backend, IdentityTouch } from "./service-read";
import {
  assertionResult,
  clampValidTo,
  compareReferences,
  containsRef,
  isCurrentClosureCoordinate,
  loadAssertionsTouching,
  loadCurrentStructuralClassComponents,
  loadCurrentStructuralClasses,
  loadCurrentVisibleMembers,
  loadHistoricalClasses,
  loadSpanningDifferentAssertion,
  lockIdentityGraph,
  normalizePair,
  publicAssertion,
  publicNodeRef,
  refKey,
  registeredPlainRef,
  visibleMembersAtCoordinate,
} from "./service-read";
import {
  type IdentityServiceContext,
  type IdentityTransferAssertion,
} from "./service-types";
import {
  executeIdentityStatement,
  identityChunkSize,
  MAX_REFERENCE_CHUNK_SIZE,
  type PlainNodeRef,
} from "./sql-target";
import { type IdentityAssertionStorageRow } from "./storage-types";
import {
  type IdentityAssertionResult,
  type IdentityClassPage,
  type IdentityClassPageOptions,
  type IdentityFacade,
  type IdentityNodeRefInput,
  type IdentityReadFacade,
  type IdentityRelation,
  type IdentitySamePathStep,
  type IdentityValidityWindow,
} from "./types";
import {
  hasExplicitIdentityValidityWindow,
  resolveIdentityValidityWindow,
} from "./validity-window";

type WindowedIdentityPair<G extends GraphDef> = Readonly<{
  a: IdentityNodeRefInput<G>;
  b: IdentityNodeRefInput<G>;
}> &
  IdentityValidityWindow;

function assertionSemanticKey(
  relation: IdentityRelation,
  a: PlainNodeRef,
  b: PlainNodeRef,
): string {
  return identityAssertionSemanticKey(relation, a, b);
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

  const classes = await loadCurrentStructuralClassComponents(
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

async function bulkAssertWindowedPairs<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  target: Backend,
  relation: IdentityRelation,
  pairs: readonly WindowedIdentityPair<G>[],
  touch: IdentityTouch,
  operationInstant: string,
): Promise<readonly IdentityAssertionResult<G>[]> {
  const windowRequests = pairs.map((pair) => {
    const first = registeredPlainRef(ctx, pair.a);
    const second = registeredPlainRef(ctx, pair.b);
    return {
      references: normalizePair(first, second),
      window: resolveIdentityValidityWindow(pair, operationInstant),
    };
  });
  const windowValidator = await createIdentityWindowValidator(
    ctx,
    target,
    windowRequests,
    operationInstant,
  );
  const results: IdentityAssertionResult<G>[] = [];
  for (const pair of pairs) {
    const window = hasExplicitIdentityValidityWindow(pair) ? pair : undefined;
    results.push(
      await assertPair(
        ctx,
        target,
        relation,
        pair.a,
        pair.b,
        touch,
        window,
        operationInstant,
        windowValidator,
      ),
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
  return rows[0] === undefined ?
      undefined
    : normalizeIdentityAssertionRow(rows[0]);
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

async function retractCurrentAssertions(
  ctx: IdentityServiceContext<GraphDef>,
  target: Backend,
  ids: readonly string[],
  touch: IdentityTouch,
  resolveValidTo: (
    row: IdentityAssertionStorageRow,
    operationInstant: string,
  ) => string,
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
    current.push(...rows.map((row) => normalizeIdentityAssertionRow(row)));
  }
  if (current.length === 0) return [];
  const operationInstant = nowIso();
  // A single UPDATE cannot clamp per-row against each row's own valid_from, so
  // group ids by the valid_to they need. Ordinary API retractions share the
  // operation clock; merge retractions preserve each reviewed plan boundary.
  const byValidTo = new Map<string, string[]>();
  const endedById = new Map<string, string>();
  for (const row of current) {
    const validTo = resolveValidTo(row, operationInstant);
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
          SET valid_to = ${validTo}, updated_at = ${operationInstant}
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
        updated_at: operationInstant,
      },
    ];
  });
  for (const row of ended) {
    touch(ctx.graphId, row.id, { ...row });
  }
  return ended;
}

async function retractByIds(
  ctx: IdentityServiceContext<GraphDef>,
  target: Backend,
  ids: readonly string[],
  touch: IdentityTouch,
): Promise<readonly IdentityAssertionStorageRow[]> {
  return retractCurrentAssertions(
    ctx,
    target,
    ids,
    touch,
    (row, operationInstant) => clampValidTo(operationInstant, row.valid_from),
  );
}

/** Ends merge assertions at the exact valid-time boundaries in the reviewed plan. */
export async function retractPlannedAssertions(
  ctx: IdentityServiceContext<GraphDef>,
  target: Backend,
  retractions: readonly IdentityTransferAssertion[],
  touch: IdentityTouch,
): Promise<readonly IdentityAssertionStorageRow[]> {
  const retractionById = new Map(
    retractions.map((retraction) => [retraction.id, retraction]),
  );
  return retractCurrentAssertions(
    ctx,
    target,
    retractions.map((retraction) => retraction.id),
    touch,
    (row, operationInstant) => {
      const retraction = requireDefined(retractionById.get(row.id));
      if (retraction.validTo === undefined) {
        throw new ConfigurationError(
          `Identity merge retraction ${retraction.id} is missing validTo.`,
          {
            code: "IDENTITY_MERGE_RETRACTION_REQUIRES_END",
            assertionId: retraction.id,
          },
        );
      }
      return requireDefined(
        resolveIdentityValidityWindow(
          { validFrom: row.valid_from, validTo: retraction.validTo },
          operationInstant,
        ).validTo,
      );
    },
  );
}

export async function runIdentityMutation<G extends GraphDef, T>(
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
  //
  // A mutable box, not a bare `let`: `runInWriteTransaction` replays this
  // whole call's body as one attempt under the `"optimistic-retry"` tier
  // (a `row`-mechanism write fence with `conflict: "commit-time"`), so a
  // flag declared OUTSIDE the callback below would carry a failed attempt's
  // verdict into the next one. Resetting `touchedBox.touched` at the top of
  // the callback — itself called fresh once per attempt — keeps `didWrite`
  // reading only the committed (or currently running) attempt's own verdict.
  const touchedBox = { touched: false };
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
      touchedBox.touched = false;
      await lockIdentityGraph(target, ctx.graphId);
      return withRecordedIdentityMutationTarget(target, (rawTarget, touch) =>
        fn(
          rawTarget,
          (graphId, id, afterImage) => {
            touchedBox.touched = true;
            touch(graphId, id, afterImage);
          },
          () => {
            touchedBox.touched = true;
          },
        ),
      );
    },
    { didWrite: () => touchedBox.touched },
  );
}

type CurrentIdentityClassPageRow = Readonly<{
  page_index: number | string;
  representative_kind: string;
  representative_id: string;
  member_kind: string | null;
  member_id: string | null;
}>;

async function loadCurrentIdentityClassPage<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  allKinds: readonly string[],
  kinds: readonly string[],
  limit: number,
  after: PlainNodeRef | undefined,
): Promise<IdentityClassPage<G>> {
  const coordinate = identitySqlCoordinate(ctx.coordinate, nowIso());
  const dialect = getDialect(ctx.backend.dialect);
  const kindValues = sql.join(
    kinds.map((kind) => sql`${kind}`),
    sql`, `,
  );
  const registeredKindValues = sql.join(
    allKinds.map((kind) => sql`${kind}`),
    sql`, `,
  );
  const nodeSource = identityNodeSnapshotSource(
    ctx.schema,
    ctx.graphId,
    coordinate,
  );
  const afterPredicate =
    after === undefined ?
      sql``
    : sql`
      AND (
        ${dialect.binaryText(sql`representative_kind`)} > ${dialect.binaryText(sql`${after.kind}`)}
        OR (
          ${dialect.binaryText(sql`representative_kind`)} = ${dialect.binaryText(sql`${after.kind}`)}
          AND ${dialect.binaryText(sql`representative_id`)} > ${dialect.binaryText(sql`${after.id}`)}
        )
      )
    `;
  const pageLimit = limit === Number.MAX_SAFE_INTEGER ? limit : limit + 1;
  // Ranking, kind eligibility, and page expansion all consume class_members.
  // Without MATERIALIZED, SQLite may inline its node scan into the correlated
  // eligibility check for every representative.
  const rows = await ctx.backend.execute<CurrentIdentityClassPageRow>(
    asCompiledRowsSql(sql`
      WITH node_snapshot AS (${nodeSource}), visible_nodes AS (
        SELECT n.kind, n.id
        FROM node_snapshot n
        WHERE n.kind IN (${registeredKindValues})
          AND ${identityNodeVisibilitySql(coordinate, "n")}
      ), class_members AS MATERIALIZED (
        SELECT
          COALESCE(anchor.class_kind, visible.kind) AS class_kind,
          COALESCE(anchor.class_id, visible.id) AS class_id,
          visible.kind AS member_kind,
          visible.id AS member_id
        FROM visible_nodes visible
        LEFT JOIN ${ctx.schema.identityClosureTable} anchor
          ON anchor.graph_id = ${ctx.graphId}
         AND anchor.member_kind = visible.kind
         AND anchor.member_id = visible.id
      ), ranked_members AS (
        SELECT
          class_kind, class_id, member_kind, member_id,
          ROW_NUMBER() OVER (
            PARTITION BY class_kind, class_id
            ORDER BY ${dialect.binaryText(sql`member_kind`)},
                     ${dialect.binaryText(sql`member_id`)}
          ) AS representative_rank
        FROM class_members
      ), representatives AS (
        SELECT
          ranked.class_kind, ranked.class_id,
          ranked.member_kind AS representative_kind,
          ranked.member_id AS representative_id
        FROM ranked_members ranked
        WHERE ranked.representative_rank = 1
          AND EXISTS (
            SELECT 1
            FROM class_members requested_member
            WHERE requested_member.class_kind = ranked.class_kind
              AND requested_member.class_id = ranked.class_id
              AND requested_member.member_kind IN (${kindValues})
          )
      ), eligible AS (
        SELECT * FROM representatives
        WHERE 1 = 1 ${afterPredicate}
      ), page_candidates AS (
        SELECT
          eligible.*,
          ROW_NUMBER() OVER (
            ORDER BY ${dialect.binaryText(sql`representative_kind`)},
                     ${dialect.binaryText(sql`representative_id`)}
          ) AS page_index
        FROM eligible
        ORDER BY ${dialect.binaryText(sql`representative_kind`)},
                 ${dialect.binaryText(sql`representative_id`)}
        LIMIT ${pageLimit}
      )
      SELECT
        page.page_index,
        page.representative_kind,
        page.representative_id,
        CASE WHEN page.page_index <= ${limit} THEN member.member_kind ELSE NULL END AS member_kind,
        CASE WHEN page.page_index <= ${limit} THEN member.member_id ELSE NULL END AS member_id
      FROM page_candidates page
      LEFT JOIN class_members member
        ON page.page_index <= ${limit}
       AND member.class_kind = page.class_kind
       AND member.class_id = page.class_id
      ORDER BY page.page_index,
               ${dialect.binaryText(sql`member.member_kind`)},
               ${dialect.binaryText(sql`member.member_id`)}
    `),
  );
  const membersByPage = new Map<number, PlainNodeRef[]>();
  const representativesByPage = new Map<number, PlainNodeRef>();
  let hasMore = false;
  for (const row of rows) {
    const pageIndex = Number(row.page_index);
    if (pageIndex > limit) {
      hasMore = true;
      continue;
    }
    representativesByPage.set(pageIndex, {
      kind: row.representative_kind,
      id: row.representative_id,
    });
    if (row.member_kind === null || row.member_id === null) continue;
    const members = membersByPage.get(pageIndex) ?? [];
    members.push({ kind: row.member_kind, id: row.member_id });
    membersByPage.set(pageIndex, members);
  }
  const pageClasses = [...representativesByPage]
    .toSorted(([left], [right]) => left - right)
    .map(([pageIndex, representative]) => {
      const members = requireDefined(membersByPage.get(pageIndex));
      return {
        representative: publicNodeRef<G>(representative),
        members: members.map((member) => publicNodeRef<G>(member)),
      };
    });
  const last = pageClasses.at(-1)?.representative;
  return {
    classes: pageClasses,
    ...(hasMore && last !== undefined ?
      {
        nextCursor: encodeIdentityClassCursor(
          {
            graphId: ctx.graphId,
            coordinate: ctx.coordinate,
            kinds,
          },
          last,
        ),
      }
    : {}),
  };
}

export function createIdentityReadFacade<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
): IdentityReadFacade<G> {
  const activeKinds = identityActiveKinds(ctx.registry);
  return {
    async classes(options: IdentityClassPageOptions) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1)
        throw new ConfigurationError(
          "identity.classes limit must be a positive safe integer.",
        );
      const allKinds = [...activeKinds];
      const kinds = options.kinds ?? allKinds;
      for (const kind of kinds) {
        if (!ctx.registry.nodeKinds.has(kind))
          throw new ConfigurationError(
            `identity.classes received unregistered node kind ${kind}.`,
          );
      }
      let after: PlainNodeRef | undefined;
      if (options.cursor !== undefined) {
        after = decodeIdentityClassCursor(options.cursor, {
          graphId: ctx.graphId,
          coordinate: ctx.coordinate,
          kinds,
        });
      }
      if (kinds.length === 0) return { classes: [] };
      if (
        ctx.coordinate === undefined ||
        isCurrentClosureCoordinate(ctx.coordinate)
      ) {
        if (!ctx.backend.capabilities.windowFunctions)
          throw new ConfigurationError(
            "identity.classes current page requires SQL window functions, but this backend profile declares windowFunctions: false.",
            {
              capability: "windowFunctions",
              operation: "identity.classes current page",
              windowFunctions: false,
            },
            {
              suggestion:
                "Use a backend profile that supports SQL window functions, or avoid this query shape.",
            },
          );
        return loadCurrentIdentityClassPage(
          ctx,
          allKinds,
          kinds,
          options.limit,
          after,
        );
      }
      const coordinate = identitySqlCoordinate(ctx.coordinate, nowIso());
      const kindValues = sql.join(
        allKinds.map((kind) => sql`${kind}`),
        sql`, `,
      );
      const nodeSource = identityNodeSnapshotSource(
        ctx.schema,
        ctx.graphId,
        coordinate,
      );
      const rows = await ctx.backend.execute<PlainNodeRef>(
        asCompiledRowsSql(sql`
          WITH node_snapshot AS (${nodeSource})
          SELECT n.kind, n.id
          FROM node_snapshot n
          WHERE n.kind IN (${kindValues})
            AND ${identityNodeVisibilitySql(coordinate, "n")}
          ORDER BY n.kind, n.id
        `),
      );
      const seeds = rows.map((row) => ({ kind: row.kind, id: row.id }));
      const grouped = new Map<string, Map<string, PlainNodeRef>>();
      const historical = await loadHistoricalClasses(
        ctx.backend,
        ctx.schema,
        ctx.graphId,
        seeds,
        ctx.coordinate,
        ctx.sameIdAcrossKinds,
        activeKinds,
      );
      for (const value of historical.values()) {
        const members = value.visible;
        if (members.length === 0) continue;
        if (!members.some((member) => kinds.includes(member.kind))) continue;
        const representative = members[0];
        if (representative === undefined) continue;
        const key = refKey(representative);
        if (grouped.has(key)) continue;
        grouped.set(
          key,
          new Map(members.map((member) => [refKey(member), member])),
        );
      }
      const sorted = [...grouped.values()]
        .map((members) =>
          [...members.values()].toSorted((left, right) =>
            compareReferences(left, right),
          ),
        )
        .toSorted((left, right) =>
          compareReferences(requireDefined(left[0]), requireDefined(right[0])),
        );
      const remaining = sorted.filter((members) => {
        const first = requireDefined(members[0]);
        return after === undefined || compareReferences(first, after) > 0;
      });
      const selected = remaining.slice(0, options.limit);
      const classes = selected.map((members) => ({
        representative: publicNodeRef<G>(requireDefined(members[0])),
        members: members.map((member) => publicNodeRef<G>(member)),
      }));
      const last = selected.at(-1)?.[0];
      return {
        classes,
        ...(remaining.length > selected.length && last !== undefined ?
          {
            nextCursor: encodeIdentityClassCursor(
              {
                graphId: ctx.graphId,
                coordinate: ctx.coordinate,
                kinds,
              },
              last,
            ),
          }
        : {}),
      };
    },
    async representativeOf(input) {
      const members = await visibleMembersAtCoordinate(
        ctx,
        registeredPlainRef(ctx, input),
        activeKinds,
      );
      return members[0] === undefined ? undefined : publicNodeRef(members[0]);
    },

    async membersOf(input) {
      const members = await visibleMembersAtCoordinate(
        ctx,
        registeredPlainRef(ctx, input),
        activeKinds,
      );
      return members.map((member) => publicNodeRef<G>(member));
    },

    async nodesOf(input) {
      const members = await visibleMembersAtCoordinate(
        ctx,
        registeredPlainRef(ctx, input),
        activeKinds,
      );
      const nodes = await ctx.loadNodes(members, ctx.coordinate);
      return nodes.filter((node) => node !== undefined);
    },

    async areSame(firstInput, secondInput) {
      const first = registeredPlainRef(ctx, firstInput);
      const second = registeredPlainRef(ctx, secondInput);
      const members = await visibleMembersAtCoordinate(ctx, first, activeKinds);
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
          ctx.registry,
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
        activeKinds,
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
      const members = await visibleMembersAtCoordinate(ctx, ref, activeKinds);
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

    async explainSame(firstInput, secondInput) {
      const first = registeredPlainRef(ctx, firstInput);
      const second = registeredPlainRef(ctx, secondInput);
      let structuralMembers: readonly PlainNodeRef[];
      let foldEligibleMembers: readonly PlainNodeRef[];
      if (
        ctx.coordinate === undefined ||
        isCurrentClosureCoordinate(ctx.coordinate)
      ) {
        const visibleMembers = await visibleMembersAtCoordinate(
          ctx,
          first,
          activeKinds,
        );
        if (!containsRef(visibleMembers, second)) return;
        if (refKey(first) === refKey(second)) return [];
        const classes = await loadCurrentStructuralClassComponents(
          ctx.backend,
          ctx.schema,
          ctx.graphId,
          [first],
        );
        structuralMembers = [...classes.values()].find((members) =>
          containsRef(members, first),
        ) ?? [first];
        foldEligibleMembers = structuralMembers;
      } else {
        const classes = await loadHistoricalClasses(
          ctx.backend,
          ctx.schema,
          ctx.graphId,
          [first],
          ctx.coordinate,
          ctx.sameIdAcrossKinds,
          activeKinds,
        );
        const historicalClass = requireDefined(classes.get(refKey(first)));
        if (!containsRef(historicalClass.visible, second)) return;
        if (refKey(first) === refKey(second)) return [];
        structuralMembers = historicalClass.structural;
        foldEligibleMembers = historicalClass.foldEligible;
      }
      if (!containsRef(structuralMembers, second))
        throw closureMismatchError(
          ctx.graphId,
          { first, second, invariant: "class member missing from structure" },
          (
            ctx.coordinate === undefined ||
              isCurrentClosureCoordinate(ctx.coordinate)
          ) ?
            "current"
          : "historical",
        );
      const classKeys = new Set(
        structuralMembers.map((member) => refKey(member)),
      );
      const classAssertions = await loadAssertionsTouching(
        ctx.backend,
        ctx.schema,
        ctx.graphId,
        structuralMembers,
        ctx.coordinate,
        "same",
      );

      type Previous = Readonly<{
        ref: PlainNodeRef;
        step: IdentitySamePathStep<G>;
      }>;
      const structuralById = new Map<string, PlainNodeRef[]>();
      for (const ref of foldEligibleMembers) {
        const group = structuralById.get(ref.id) ?? [];
        group.push(ref);
        structuralById.set(ref.id, group);
      }
      const assertionEdges = classAssertions
        .filter(
          (assertion) =>
            assertion.rel === "same" &&
            classKeys.has(
              refKey({ kind: assertion.a_kind, id: assertion.a_id }),
            ) &&
            classKeys.has(
              refKey({ kind: assertion.b_kind, id: assertion.b_id }),
            ),
        )
        .map((assertion) => ({
          a: { kind: assertion.a_kind, id: assertion.a_id },
          b: { kind: assertion.b_kind, id: assertion.b_id },
          assertion,
        }));
      const assertionAdjacency = new Map<
        string,
        { ref: PlainNodeRef; via: Previous["step"]["via"] }[]
      >();
      for (const edge of assertionEdges) {
        const edgeValue = publicAssertion<G>(edge.assertion);
        const neighborsA = assertionAdjacency.get(refKey(edge.a)) ?? [];
        neighborsA.push({
          ref: edge.b,
          via: { type: "assertion", assertion: edgeValue },
        });
        assertionAdjacency.set(refKey(edge.a), neighborsA);
        const neighborsB = assertionAdjacency.get(refKey(edge.b)) ?? [];
        neighborsB.push({
          ref: edge.a,
          via: { type: "assertion", assertion: edgeValue },
        });
        assertionAdjacency.set(refKey(edge.b), neighborsB);
      }
      for (const members of structuralById.values()) {
        members.sort((left, right) => compareReferences(left, right));
      }
      const visited = new Set([refKey(first)]);
      const previous = new Map<string, Previous>();
      const queue = [first];
      for (
        let index = 0;
        index < queue.length && !visited.has(refKey(second));
        index += 1
      ) {
        const current = queue[index];
        if (current === undefined) continue;
        const neighbors: readonly Readonly<{
          ref: PlainNodeRef;
          via: Previous["step"]["via"];
        }>[] = [
          ...(assertionAdjacency.get(refKey(current)) ?? []),
          ...(ctx.sameIdAcrossKinds === "fold" ?
            (structuralById.get(current.id) ?? [])
              .filter((member) => member.kind !== current.kind)
              .map((member) => ({
                ref: member,
                via: { type: "same-id-fold" as const },
              }))
          : []),
        ];
        const orderedNeighbors = [...neighbors].toSorted((left, right) => {
          const refOrder = compareReferences(left.ref, right.ref);
          if (refOrder !== 0) return refOrder;
          if (left.via.type === "same-id-fold") return -1;
          if (right.via.type === "same-id-fold") return 1;
          return compareCodePoints(
            left.via.assertion.id,
            right.via.assertion.id,
          );
        });
        for (const neighbor of orderedNeighbors) {
          const key = refKey(neighbor.ref);
          if (visited.has(key)) continue;
          visited.add(key);
          previous.set(key, {
            ref: current,
            step: {
              from: publicNodeRef<G>(current),
              to: publicNodeRef<G>(neighbor.ref),
              via: neighbor.via,
            },
          });
          queue.push(neighbor.ref);
        }
      }
      const path: IdentitySamePathStep<G>[] = [];
      let cursor = refKey(second);
      while (cursor !== refKey(first)) {
        const entry = previous.get(cursor);
        if (entry === undefined)
          throw closureMismatchError(
            ctx.graphId,
            { first, second, invariant: "same-class pair has no proof" },
            (
              ctx.coordinate === undefined ||
                isCurrentClosureCoordinate(ctx.coordinate)
            ) ?
              "current"
            : "historical",
          );
        path.push(entry.step);
        cursor = refKey(entry.ref);
      }
      return path.toReversed();
    },
  };
}

/**
 * Splits ended assertions by which derived relation their repair belongs to: a
 * `same` retraction splits identity classes (closure repair, which carries the
 * separation repair with it), a `different` retraction removes a separation.
 */
export function partitionRetractedEndpoints(
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

    assertSame(a, b, window) {
      return runIdentityMutation(ctx, (target, touch) => {
        const operationInstant = nowIso();
        return assertPair(
          ctx,
          target,
          "same",
          a,
          b,
          touch,
          hasExplicitIdentityValidityWindow(window) ? window : undefined,
          operationInstant,
        );
      });
    },

    assertDifferent(a, b, window) {
      return runIdentityMutation(ctx, (target, touch) => {
        const operationInstant = nowIso();
        return assertPair(
          ctx,
          target,
          "different",
          a,
          b,
          touch,
          hasExplicitIdentityValidityWindow(window) ? window : undefined,
          operationInstant,
        );
      });
    },

    bulkAssertSame(pairs) {
      return runIdentityMutation(ctx, (target, touch) => {
        if (!pairs.some((pair) => hasExplicitIdentityValidityWindow(pair))) {
          return bulkAssertPairs(ctx, target, "same", pairs, touch);
        }
        return bulkAssertWindowedPairs(
          ctx,
          target,
          "same",
          pairs,
          touch,
          nowIso(),
        );
      });
    },

    bulkAssertDifferent(pairs) {
      return runIdentityMutation(ctx, (target, touch) => {
        if (!pairs.some((pair) => hasExplicitIdentityValidityWindow(pair))) {
          return bulkAssertPairs(ctx, target, "different", pairs, touch);
        }
        return bulkAssertWindowedPairs(
          ctx,
          target,
          "different",
          pairs,
          touch,
          nowIso(),
        );
      });
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
