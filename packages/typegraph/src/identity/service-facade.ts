import { type GraphDef } from "../core/define-graph";
import {
  ConfigurationError,
  IdentityContradictionError,
  type IdentityContradictionErrorDetails,
} from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { sql } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { runInWriteTransaction } from "../store/operations/write-transaction";
import { withRecordedIdentityMutationTarget } from "../store/recorded-capture";
import { chunk } from "../utils/array";
import { compareCodePoints } from "../utils/compare";
import { nowIso } from "../utils/date";
import { requireDefined } from "../utils/presence";
import { identityAssertionSemanticKey } from "./assertion-key";
import { IDENTITY_ASSERTION_COLUMNS } from "./historical-sql";
import {
  normalizeIdentityAssertionRow,
  type RawIdentityAssertionRow,
} from "./row-codec";
import { isSeparated } from "./separation";
import type { DifferentAssertionIndex } from "./service-components";
import {
  classHasDisjointKinds,
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
  containsRef,
  isCurrentClosureCoordinate,
  loadAssertionsTouching,
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
  type IdentityFacade,
  type IdentityNodeRefInput,
  type IdentityReadFacade,
  type IdentityRelation,
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
