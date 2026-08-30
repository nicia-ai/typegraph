import { getTableName, type SQL, sql } from "drizzle-orm";

import { CompilerInvariantError } from "../../../errors";
import type { FulltextStrategy } from "../../../query/dialect/fulltext-strategy";
import type { SqlDialect } from "../../../query/dialect/types";
import type {
  VectorSlot,
  VectorStrategy,
} from "../../../query/dialect/vector-strategy";
import { chunk as chunkArray } from "../../../utils/array";
import { resolveStampedValidityLowerBound } from "../../../utils/date";
import { encodeTupleKey } from "../../../utils/tuple-key";
import type {
  AtomicNodeBatchEntry,
  AtomicNodeProjection,
  AtomicNodeResolvedUpdateEntry,
} from "../../capabilities/atomic-mutation-program";
import type {
  InsertNodeParams,
  ManagedNodeCreatePlan,
  NodeInsertClaim,
} from "../../types";
import { toDrizzleSql } from "../execution/types";
import { buildInsertNode, buildInsertNodeWithSchemaFence } from "./nodes";
import {
  nodeColumnList,
  quotedColumn,
  quotedTableName,
  sqlNull,
  type Tables,
} from "./shared";
import { buildInsertUniqueFromSource } from "./uniques";

/** The fixed alias shared by the node CTE and all projection strategies. */
export const INSERTED_NODE_PROJECTION_CTE_ALIAS = "inserted_node";

type AtomicNodeProjectionEntry = Readonly<{
  graphId: string;
  kind: string;
  id: string;
  projections: readonly AtomicNodeProjection[];
}>;

function atomicProjectionEntries(
  creates: readonly AtomicNodeBatchEntry[],
  updates: readonly AtomicNodeResolvedUpdateEntry[],
): readonly AtomicNodeProjectionEntry[] {
  return [
    ...creates.map((entry) => ({
      graphId: entry.params.graphId,
      kind: entry.params.kind,
      id: entry.params.id,
      projections: entry.projections ?? [],
    })),
    ...updates.map((entry) => ({
      graphId: entry.graphId,
      kind: entry.kind,
      id: entry.id,
      projections: entry.projections ?? [],
    })),
  ];
}

export type AtomicNodeProjectionRequirements = Readonly<{
  graphId: string;
  fulltext: boolean;
  vectorSlots: readonly VectorSlot[];
}>;

/** One owner for the physical derived-storage requirements of a node program. */
export function resolveAtomicNodeProjectionRequirements(
  creates: readonly AtomicNodeBatchEntry[],
  updates: readonly AtomicNodeResolvedUpdateEntry[],
): AtomicNodeProjectionRequirements | undefined {
  const entries = atomicProjectionEntries(creates, updates);
  const projected = entries.filter((entry) => entry.projections.length > 0);
  const first = projected[0];
  if (first === undefined) return;
  if (projected.some((entry) => entry.graphId !== first.graphId)) {
    throw new CompilerInvariantError(
      "An atomic node projection program crossed graph storage.",
    );
  }
  const vectorSlots = new Map<string, VectorSlot>();
  for (const entry of projected) {
    for (const projection of entry.projections) {
      if (projection.kind !== "embedding") continue;
      const slot = {
        graphId: entry.graphId,
        nodeKind: entry.kind,
        fieldPath: projection.fieldPath,
        dimensions: projection.dimensions,
        metric: projection.metric,
        indexType: projection.indexType,
      };
      vectorSlots.set(
        encodeTupleKey([
          slot.graphId,
          slot.nodeKind,
          slot.fieldPath,
          String(slot.dimensions),
          slot.metric,
          slot.indexType,
        ]),
        slot,
      );
    }
  }
  return {
    graphId: first.graphId,
    fulltext: projected.some((entry) =>
      entry.projections.some((projection) => projection.kind === "fulltext"),
    ),
    vectorSlots: [...vectorSlots.values()],
  };
}

/**
 * Builds every derived-storage statement owed by an atomic node postimage set.
 *
 * Row mutation and this statement list share one atomic transport submission.
 * The terminal row-postimage assertion is the commit gate: stale or moved row
 * work deliberately aborts the submission and rolls these transitions back.
 */
export function buildAtomicNodeProjectionStatements(
  creates: readonly AtomicNodeBatchEntry[],
  updates: readonly AtomicNodeResolvedUpdateEntry[],
  timestamp: string,
  dialect: SqlDialect,
  fulltextTableName: string,
  fulltextStrategy: FulltextStrategy,
  vectorStrategy: VectorStrategy | undefined,
  chunkSize: number,
): readonly SQL[] | undefined {
  const entries = atomicProjectionEntries(creates, updates);
  const fulltextGroups = new Map<
    string,
    Readonly<{
      graphId: string;
      nodeKind: string;
      upserts: { nodeId: string; content: string; language: string }[];
      deletes: string[];
    }>
  >();
  const embeddingGroups = new Map<
    string,
    Readonly<{
      slot: Readonly<{
        graphId: string;
        nodeKind: string;
        fieldPath: string;
        dimensions: number;
        metric: Extract<AtomicNodeProjection, { kind: "embedding" }>["metric"];
        indexType: Extract<
          AtomicNodeProjection,
          { kind: "embedding" }
        >["indexType"];
      }>;
      upserts: { nodeId: string; embedding: readonly number[] }[];
      deletes: string[];
    }>
  >();

  for (const entry of entries) {
    for (const projection of entry.projections) {
      if (projection.kind === "fulltext") {
        const key = encodeTupleKey([entry.graphId, entry.kind]);
        const group = fulltextGroups.get(key) ?? {
          graphId: entry.graphId,
          nodeKind: entry.kind,
          upserts: [],
          deletes: [],
        };
        if (projection.action === "upsert") {
          group.upserts.push({
            nodeId: entry.id,
            content: projection.content,
            language: projection.language,
          });
        } else {
          group.deletes.push(entry.id);
        }
        fulltextGroups.set(key, group);
        continue;
      }
      if (vectorStrategy === undefined) return;
      const slot = {
        graphId: entry.graphId,
        nodeKind: entry.kind,
        fieldPath: projection.fieldPath,
        dimensions: projection.dimensions,
        metric: projection.metric,
        indexType: projection.indexType,
      };
      const key = encodeTupleKey([
        slot.graphId,
        slot.nodeKind,
        slot.fieldPath,
        String(slot.dimensions),
        slot.metric,
        slot.indexType,
      ]);
      const group = embeddingGroups.get(key) ?? {
        slot,
        upserts: [],
        deletes: [],
      };
      if (projection.action === "upsert") {
        group.upserts.push({
          nodeId: entry.id,
          embedding: projection.embedding,
        });
      } else {
        group.deletes.push(entry.id);
      }
      embeddingGroups.set(key, group);
    }
  }

  const statements: SQL[] = [];
  for (const group of fulltextGroups.values()) {
    for (const rows of chunkArray(group.upserts, chunkSize)) {
      statements.push(
        ...fulltextStrategy
          .buildBatchUpsert(
            fulltextTableName,
            { graphId: group.graphId, nodeKind: group.nodeKind, rows },
            timestamp,
          )
          .map((statement) => toDrizzleSql(statement, dialect)),
      );
    }
    for (const nodeIds of chunkArray(group.deletes, chunkSize)) {
      statements.push(
        ...fulltextStrategy
          .buildBatchDelete(fulltextTableName, {
            graphId: group.graphId,
            nodeKind: group.nodeKind,
            nodeIds,
          })
          .map((statement) => toDrizzleSql(statement, dialect)),
      );
    }
  }
  for (const group of embeddingGroups.values()) {
    for (const rows of chunkArray(group.upserts, chunkSize)) {
      const fragments =
        vectorStrategy?.buildUpsertBatch === undefined ?
          rows.flatMap((row) =>
            vectorStrategy?.buildUpsert(
              group.slot,
              {
                ...group.slot,
                nodeId: row.nodeId,
                embedding: row.embedding,
              },
              timestamp,
            ) ?? [],
          )
        : vectorStrategy.buildUpsertBatch(
            group.slot,
            { ...group.slot, rows },
            timestamp,
          );
      statements.push(
        ...fragments.map((statement) => toDrizzleSql(statement, dialect)),
      );
    }
    for (const nodeIds of chunkArray(group.deletes, chunkSize)) {
      statements.push(
        ...(vectorStrategy?.buildDeleteBatch(group.slot, {
          ...group.slot,
          nodeIds,
        }) ?? []).map((statement) => toDrizzleSql(statement, dialect)),
      );
    }
  }
  return statements;
}

function refuseUnknownManagedNodeMode(mode: never): never {
  throw new CompilerInvariantError(
    "A managed node create plan names an unknown mode.",
    { capability: "commands", command: "node.create", mode },
  );
}

function buildNodeInsert(
  tables: Tables,
  params: InsertNodeParams,
  plan: ManagedNodeCreatePlan,
  timestamp: string,
  schemaLockClause: SQL | undefined,
): SQL | undefined {
  switch (plan.mode.kind) {
    case "ordinary": {
      return buildInsertNode(tables, params, timestamp);
    }
    case "schema-fenced": {
      if (schemaLockClause === undefined) return;
      return buildInsertNodeWithSchemaFence(
        tables,
        params,
        timestamp,
        plan.mode.schemaFence,
        schemaLockClause,
      );
    }
    default: {
      return refuseUnknownManagedNodeMode(plan.mode);
    }
  }
}

function buildNodeAndProjections(
  nodeInsert: SQL,
  projections: readonly SQL[],
): SQL {
  if (projections.length === 0) return nodeInsert;
  const projectionCtes = projections.map(
    (projection, index) =>
      sql`${sql.identifier(`node_projection_${index}`)} AS (${projection})`,
  );
  return sql`
    WITH ${sql.identifier(INSERTED_NODE_PROJECTION_CTE_ALIAS)} AS MATERIALIZED (
      ${nodeInsert}
    ), ${sql.join(projectionCtes, sql`, `)}
    SELECT * FROM ${sql.identifier(INSERTED_NODE_PROJECTION_CTE_ALIAS)}
  `;
}

const CLAIM_INPUT_COLUMNS = [
  "ordinal",
  "graph_id",
  "axis",
  "constraint_name",
  "key",
  "node_id",
  "concrete_kind",
] as const;

function claimInputCte(
  alias: string,
  claims: readonly NodeInsertClaim[],
  params: InsertNodeParams,
): SQL {
  const values = sql.join(
    claims.map(
      (claim, ordinal) =>
        sql`(${ordinal}, ${params.graphId}, ${claim.axis}, ${claim.constraintName}, ${claim.key}, ${params.id}, ${params.kind})`,
    ),
    sql`, `,
  );
  const columns = sql.join(
    CLAIM_INPUT_COLUMNS.map((column) => sql.identifier(column)),
    sql`, `,
  );
  return sql`${sql.identifier(alias)} (${columns}) AS (VALUES ${values})`;
}

function claimVerdictCte(
  alias: string,
  inputAlias: string,
  claimedAlias: string,
): SQL {
  const input = sql.identifier(inputAlias);
  const claimed = sql.identifier(claimedAlias);
  return sql`
    ${sql.identifier(alias)} AS (
      SELECT
        ${input}.${sql.identifier("ordinal")} AS ordinal,
        ${input}.${sql.identifier("axis")} AS axis,
        ${input}.${sql.identifier("constraint_name")} AS constraint_name,
        ${input}.${sql.identifier("key")} AS key,
        ${input}.${sql.identifier("node_id")} AS new_node_id,
        ${input}.${sql.identifier("concrete_kind")} AS new_concrete_kind,
        ${claimed}.${sql.identifier("node_id")} AS holder_id,
        ${claimed}.${sql.identifier("concrete_kind")} AS holder_kind,
        ${claimed}.${sql.identifier("node_id")} = ${input}.${sql.identifier("node_id")}
          AND ${claimed}.${sql.identifier("concrete_kind")} = ${input}.${sql.identifier("concrete_kind")} AS accepted
      FROM ${input}
      JOIN ${claimed}
        ON ${claimed}.${sql.identifier("axis")} = ${input}.${sql.identifier("axis")}
       AND ${claimed}.${sql.identifier("constraint_name")} = ${input}.${sql.identifier("constraint_name")}
       AND ${claimed}.${sql.identifier("key")} = ${input}.${sql.identifier("key")}
    )
  `;
}

const CLAIM_PROBE_COLUMNS = [
  "ordinal",
  "probe_ordinal",
  "axis",
  "constraint_name",
  "key",
  "node_id",
  "concrete_kind",
] as const;

/**
 * Reads live uniqueness claims that predate the canonical shared-scope axis.
 *
 * The canonical upsert remains the write fence. These rows are read-only
 * compatibility evidence: the axis fold intentionally required no migration,
 * so a current writer must still see a live foreign owner under every covered
 * concrete kind. The store computes and carries `probeAxes`; this SQL layer
 * must not reconstruct hierarchy membership independently.
 */
function legacyUniqueProbeCte(
  tables: Tables,
  alias: string,
  claims: readonly NodeInsertClaim[],
  params: InsertNodeParams,
): SQL | undefined {
  const values = claims.flatMap((claim, ordinal) => {
    if (claim.verdict.kind !== "uniqueness") return [];
    return claim.verdict.probeAxes.flatMap((probeAxis, probeOrdinal) => {
      if (probeAxis === claim.axis) return [];
      return [
        sql`(${ordinal}, ${probeOrdinal}, ${probeAxis}, ${claim.constraintName}, ${claim.key}, ${params.id}, ${params.kind})`,
      ];
    });
  });
  if (values.length === 0) return;

  const columns = sql.join(
    CLAIM_PROBE_COLUMNS.map((column) => sql.identifier(column)),
    sql`, `,
  );
  const probe = sql.identifier(alias);
  const uniques = sql.identifier("legacy_unique_rows");
  const tableName = getTableName(tables.uniques);
  const qualified = (column: Readonly<{ name: string }>): SQL =>
    sql`${uniques}.${quotedColumn(column)}`;

  return sql`
    ${probe} (${columns}) AS (
      SELECT
        ${probe}.${sql.identifier("ordinal")}::integer,
        ${probe}.${sql.identifier("probe_ordinal")}::integer,
        ${probe}.${sql.identifier("axis")},
        ${probe}.${sql.identifier("constraint_name")},
        ${probe}.${sql.identifier("key")},
        ${qualified(tables.uniques.nodeId)} AS node_id,
        ${qualified(tables.uniques.concreteKind)} AS concrete_kind
      FROM (VALUES ${sql.join(values, sql`, `)}) AS ${probe} (${columns})
      JOIN ${quotedTableName(tableName)} AS ${uniques}
        ON ${qualified(tables.uniques.graphId)} = ${params.graphId}
       AND ${qualified(tables.uniques.nodeKind)} = ${probe}.${sql.identifier("axis")}
       AND ${qualified(tables.uniques.constraintName)} = ${probe}.${sql.identifier("constraint_name")}
       AND ${qualified(tables.uniques.key)} = ${probe}.${sql.identifier("key")}
       AND ${qualified(tables.uniques.deletedAt)} IS NULL
    )
  `;
}

const DISJOINT_PROBE_COLUMNS = [
  "ordinal",
  "probe_ordinal",
  "axis",
  "constraint_name",
  "key",
  "node_id",
  "concrete_kind",
  "conflicting_kind",
] as const;

/**
 * Reads live node rows for disjoint claims. This is deliberately separate
 * from the claim relation: pre-upgrade databases can contain a live overlap
 * without a disjointness claim row. The graph write lock is acquired before
 * this statement for disjoint claims, so this read and the canonical claim
 * upsert retain the same cross-kind race protection as the old probe.
 */
function disjointNodeProbeCte(
  tables: Tables,
  alias: string,
  claims: readonly NodeInsertClaim[],
  params: InsertNodeParams,
): SQL | undefined {
  const values = claims.flatMap((claim, ordinal) => {
    if (claim.verdict.kind !== "disjointness") return [];
    return claim.verdict.conflictingKinds.map(
      (conflictingKind, probeOrdinal) =>
        sql`(${ordinal}, ${probeOrdinal}, ${claim.axis}, ${claim.constraintName}, ${claim.key}, ${params.id}, ${params.kind}, ${conflictingKind})`,
    );
  });
  if (values.length === 0) return;

  const columns = sql.join(
    DISJOINT_PROBE_COLUMNS.map((column) => sql.identifier(column)),
    sql`, `,
  );
  const probe = sql.identifier(alias);
  const nodes = sql.identifier("legacy_disjoint_nodes");
  const tableName = getTableName(tables.nodes);
  const qualified = (column: Readonly<{ name: string }>): SQL =>
    sql`${nodes}.${quotedColumn(column)}`;

  return sql`
    ${probe} (${columns}) AS (
      SELECT
        ${probe}.${sql.identifier("ordinal")}::integer,
        ${probe}.${sql.identifier("probe_ordinal")}::integer,
        ${probe}.${sql.identifier("axis")},
        ${probe}.${sql.identifier("constraint_name")},
        ${probe}.${sql.identifier("key")},
        ${qualified(tables.nodes.id)} AS node_id,
        ${qualified(tables.nodes.kind)} AS concrete_kind,
        ${probe}.${sql.identifier("conflicting_kind")}
      FROM (VALUES ${sql.join(values, sql`, `)}) AS ${probe} (${columns})
      JOIN ${quotedTableName(tableName)} AS ${nodes}
        ON ${qualified(tables.nodes.graphId)} = ${params.graphId}
       AND ${qualified(tables.nodes.kind)} = ${probe}.${sql.identifier("conflicting_kind")}
       AND ${qualified(tables.nodes.id)} = ${probe}.${sql.identifier("key")}
       AND ${qualified(tables.nodes.deletedAt)} IS NULL
    )
  `;
}

function buildGatedNodeInsert(
  tables: Tables,
  params: InsertNodeParams,
  timestamp: string,
  gateAlias: string,
): SQL {
  const { nodes } = tables;
  const propsJson = JSON.stringify(params.props);
  const columns = nodeColumnList(nodes);
  const gate = sql.identifier(gateAlias);

  return sql`
    INSERT INTO ${nodes} (${columns})
    SELECT
      ${params.graphId}, ${params.kind}, ${params.id}, ${propsJson},
      1, ${sqlNull(resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp))}, ${sqlNull(params.validTo)},
      ${timestamp}, ${timestamp}
    FROM ${gate}
    RETURNING *
  `;
}

function buildNodeClaimsAndProjections(
  tables: Tables,
  params: InsertNodeParams,
  plan: ManagedNodeCreatePlan,
  timestamp: string,
  dialect: SqlDialect,
  fulltextTableName: string,
  fulltextStrategy: FulltextStrategy,
  vectorStrategy: VectorStrategy | undefined,
): SQL | undefined {
  const claims = plan.claims;
  const preClaims = claims.filter((claim) => claim.placement === "pre-insert");
  const postClaims = claims.filter(
    (claim) => claim.placement === "post-insert",
  );
  const ctes: SQL[] = [];
  const preInputAlias = "node_pre_claim_input";
  const preClaimedAlias = "node_pre_claimed";
  const preVerdictAlias = "node_pre_claim_verdict";
  const preLegacyProbeAlias = "node_pre_legacy_unique_probe";
  const preDisjointProbeAlias = "node_pre_disjoint_node_probe";
  const preHasLegacyProbe = preClaims.some(
    (claim) =>
      claim.verdict.kind === "uniqueness" &&
      claim.verdict.probeAxes.some((axis) => axis !== claim.axis),
  );
  const preHasDisjointProbe = preClaims.some(
    (claim) =>
      claim.verdict.kind === "disjointness" &&
      claim.verdict.conflictingKinds.length > 0,
  );

  if (preClaims.length > 0) {
    ctes.push(
      claimInputCte(preInputAlias, preClaims, params),
      sql`${sql.identifier(preClaimedAlias)} AS (${buildInsertUniqueFromSource(tables, dialect, preInputAlias)})`,
      claimVerdictCte(preVerdictAlias, preInputAlias, preClaimedAlias),
    );
    const legacyProbe = legacyUniqueProbeCte(
      tables,
      preLegacyProbeAlias,
      preClaims,
      params,
    );
    if (legacyProbe !== undefined) ctes.push(legacyProbe);
    const disjointProbe = disjointNodeProbeCte(
      tables,
      preDisjointProbeAlias,
      preClaims,
      params,
    );
    if (disjointProbe !== undefined) ctes.push(disjointProbe);
  }

  const preGateAlias = "node_pre_gate";
  const preGateChecks: SQL[] = [
    sql`
      NOT EXISTS (
            SELECT 1
            FROM ${sql.identifier(preVerdictAlias)}
            WHERE accepted = FALSE
          )
    `,
  ];
  if (preHasLegacyProbe) {
    preGateChecks.push(
      sql`NOT EXISTS (SELECT 1 FROM ${sql.identifier(preLegacyProbeAlias)})`,
    );
  }
  if (preHasDisjointProbe) {
    preGateChecks.push(
      sql`NOT EXISTS (SELECT 1 FROM ${sql.identifier(preDisjointProbeAlias)})`,
    );
  }
  ctes.push(
    preClaims.length === 0 ?
      sql`${sql.identifier(preGateAlias)} AS (SELECT 1 AS gate)`
    : sql`
      ${sql.identifier(preGateAlias)} AS (
        SELECT 1 AS gate
        WHERE ${sql.join(preGateChecks, sql` AND `)}
      )
    `,
  );

  const nodeInsert = buildGatedNodeInsert(
    tables,
    params,
    timestamp,
    preGateAlias,
  );
  const nodeInsertedAlias = "node_inserted";
  ctes.push(
    sql`${sql.identifier(nodeInsertedAlias)} AS MATERIALIZED (${nodeInsert})`,
  );

  const postInputAlias = "node_post_claim_input";
  const postClaimedAlias = "node_post_claimed";
  const postVerdictAlias = "node_post_claim_verdict";
  const postLegacyProbeAlias = "node_post_legacy_unique_probe";
  const postDisjointProbeAlias = "node_post_disjoint_node_probe";
  const postHasLegacyProbe = postClaims.some(
    (claim) =>
      claim.verdict.kind === "uniqueness" &&
      claim.verdict.probeAxes.some((axis) => axis !== claim.axis),
  );
  const postHasDisjointProbe = postClaims.some(
    (claim) =>
      claim.verdict.kind === "disjointness" &&
      claim.verdict.conflictingKinds.length > 0,
  );
  if (postClaims.length > 0) {
    const postValuesAlias = "node_post_claim_values";
    ctes.push(claimInputCte(postValuesAlias, postClaims, params));
    const postValues = sql.identifier(postValuesAlias);
    const nodeInserted = sql.identifier(nodeInsertedAlias);
    const columns = sql.join(
      CLAIM_INPUT_COLUMNS.map((column) => sql.identifier(column)),
      sql`, `,
    );
    const qualifiedColumns = sql.join(
      CLAIM_INPUT_COLUMNS.map(
        (column) => sql`${postValues}.${sql.identifier(column)}`,
      ),
      sql`, `,
    );
    ctes.push(
      sql`
        ${sql.identifier(postInputAlias)} (${columns}) AS (
          SELECT ${qualifiedColumns}
          FROM ${postValues}
          CROSS JOIN ${nodeInserted}
        )
      `,
      sql`${sql.identifier(postClaimedAlias)} AS (${buildInsertUniqueFromSource(tables, dialect, postInputAlias)})`,
      claimVerdictCte(postVerdictAlias, postInputAlias, postClaimedAlias),
    );
    const legacyProbe = legacyUniqueProbeCte(
      tables,
      postLegacyProbeAlias,
      postClaims,
      params,
    );
    if (legacyProbe !== undefined) ctes.push(legacyProbe);
    const disjointProbe = disjointNodeProbeCte(
      tables,
      postDisjointProbeAlias,
      postClaims,
      params,
    );
    if (disjointProbe !== undefined) ctes.push(disjointProbe);
  }

  const insertedNodeAlias = INSERTED_NODE_PROJECTION_CTE_ALIAS;
  const nodeInserted = sql.identifier(nodeInsertedAlias);
  const postGateChecks: SQL[] = [
    sql`
      NOT EXISTS (
            SELECT 1
            FROM ${sql.identifier(postVerdictAlias)}
            WHERE accepted = FALSE
          )
    `,
  ];
  if (postHasLegacyProbe) {
    postGateChecks.push(
      sql`NOT EXISTS (SELECT 1 FROM ${sql.identifier(postLegacyProbeAlias)})`,
    );
  }
  if (postHasDisjointProbe) {
    postGateChecks.push(
      sql`NOT EXISTS (SELECT 1 FROM ${sql.identifier(postDisjointProbeAlias)})`,
    );
  }
  ctes.push(
    postClaims.length === 0 ?
      sql`${sql.identifier(insertedNodeAlias)} AS MATERIALIZED (SELECT * FROM ${nodeInserted})`
    : sql`
      ${sql.identifier(insertedNodeAlias)} AS MATERIALIZED (
        SELECT *
        FROM ${nodeInserted}
        WHERE ${sql.join(postGateChecks, sql` AND `)}
      )
    `,
  );

  const projectionSql = buildProjectionSql(
    params,
    plan,
    timestamp,
    dialect,
    fulltextTableName,
    fulltextStrategy,
    vectorStrategy,
  );
  if (projectionSql === undefined) return;
  ctes.push(
    ...projectionSql.map(
      (projection, index) =>
        sql`${sql.identifier(`node_projection_${index}`)} AS (${projection})`,
    ),
  );

  const conflictQueries: SQL[] = [];
  if (preClaims.length > 0) {
    conflictQueries.push(
      sql`SELECT ordinal::integer, 0 AS phase, 0 AS probe_ordinal, axis, constraint_name, key, holder_id, holder_kind FROM ${sql.identifier(preVerdictAlias)} WHERE accepted = FALSE`,
    );
    if (preHasLegacyProbe) {
      conflictQueries.push(
        sql`SELECT ordinal, 0 AS phase, probe_ordinal, axis, constraint_name, key, node_id AS holder_id, concrete_kind AS holder_kind FROM ${sql.identifier(preLegacyProbeAlias)}`,
      );
    }
    if (preHasDisjointProbe) {
      conflictQueries.push(
        sql`SELECT ordinal, 0 AS phase, probe_ordinal, axis, constraint_name, key, node_id AS holder_id, concrete_kind AS holder_kind FROM ${sql.identifier(preDisjointProbeAlias)}`,
      );
    }
  }
  if (postClaims.length > 0) {
    conflictQueries.push(
      sql`SELECT ordinal::integer, 1 AS phase, 0 AS probe_ordinal, axis, constraint_name, key, holder_id, holder_kind FROM ${sql.identifier(postVerdictAlias)} WHERE accepted = FALSE`,
    );
    if (postHasLegacyProbe) {
      conflictQueries.push(
        sql`SELECT ordinal, 1 AS phase, probe_ordinal, axis, constraint_name, key, node_id AS holder_id, concrete_kind AS holder_kind FROM ${sql.identifier(postLegacyProbeAlias)}`,
      );
    }
    if (postHasDisjointProbe) {
      conflictQueries.push(
        sql`SELECT ordinal, 1 AS phase, probe_ordinal, axis, constraint_name, key, node_id AS holder_id, concrete_kind AS holder_kind FROM ${sql.identifier(postDisjointProbeAlias)}`,
      );
    }
  }
  const conflictAlias = "node_claim_conflicts";
  if (conflictQueries.length === 0) {
    ctes.push(
      sql`${sql.identifier(conflictAlias)} AS (SELECT NULL::integer AS ordinal, NULL::integer AS phase, NULL::integer AS probe_ordinal, NULL::text AS axis, NULL::text AS constraint_name, NULL::text AS key, NULL::text AS holder_id, NULL::text AS holder_kind WHERE FALSE)`,
    );
  } else {
    ctes.push(
      sql`${sql.identifier(conflictAlias)} AS (${sql.join(conflictQueries, sql` UNION ALL `)})`,
    );
  }
  const conflicts = sql.identifier(conflictAlias);
  const firstConflict = sql.identifier("first_claim_conflict");
  const outcomeAlias = "node_claim_outcome";
  ctes.push(sql`
    ${sql.identifier(outcomeAlias)} AS (
      SELECT
        CASE WHEN ${firstConflict}.${sql.identifier("axis")} IS NULL
          THEN 'node_inserted' ELSE 'claim_conflict' END AS write_discriminator,
        ${firstConflict}.${sql.identifier("axis")} AS claim_axis,
        ${firstConflict}.${sql.identifier("constraint_name")} AS claim_constraint_name,
        ${firstConflict}.${sql.identifier("key")} AS claim_key,
        ${firstConflict}.${sql.identifier("holder_id")} AS claim_holder_id,
        ${firstConflict}.${sql.identifier("holder_kind")} AS claim_holder_kind
      FROM (SELECT 1 AS sentinel) AS "outcome_sentinel"
      LEFT JOIN LATERAL (
        SELECT *
        FROM ${conflicts}
        ORDER BY phase, ordinal, probe_ordinal
        LIMIT 1
      ) AS ${firstConflict} ON TRUE
    )
  `);

  return sql`
    WITH ${sql.join(ctes, sql`, `)}
    SELECT ${sql.identifier(insertedNodeAlias)}.*,
      ${sql.identifier(outcomeAlias)}.write_discriminator,
      ${sql.identifier(outcomeAlias)}.claim_axis,
      ${sql.identifier(outcomeAlias)}.claim_constraint_name,
      ${sql.identifier(outcomeAlias)}.claim_key,
      ${sql.identifier(outcomeAlias)}.claim_holder_id,
      ${sql.identifier(outcomeAlias)}.claim_holder_kind
    FROM ${sql.identifier(outcomeAlias)}
    LEFT JOIN ${sql.identifier(insertedNodeAlias)} ON TRUE
  `;
}

function buildProjectionSql(
  params: InsertNodeParams,
  plan: ManagedNodeCreatePlan,
  timestamp: string,
  dialect: SqlDialect,
  fulltextTableName: string,
  fulltextStrategy: FulltextStrategy,
  vectorStrategy: VectorStrategy | undefined,
): readonly SQL[] | undefined {
  const projectionSql: SQL[] = [];
  const fulltextBuilder = fulltextStrategy.buildSyncFromInsertedNode;
  const vectorBuilder = vectorStrategy?.buildUpsertFromInsertedNode;

  for (const projection of plan.projections) {
    switch (projection.kind) {
      case "fulltext": {
        if (fulltextBuilder === undefined) return;
        projectionSql.push(
          toDrizzleSql(
            fulltextBuilder(
              fulltextTableName,
              INSERTED_NODE_PROJECTION_CTE_ALIAS,
              projection,
              timestamp,
            ),
            dialect,
          ),
        );
        break;
      }
      case "embedding": {
        if (vectorStrategy === undefined || vectorBuilder === undefined) return;
        projectionSql.push(
          toDrizzleSql(
            vectorBuilder(
              {
                graphId: params.graphId,
                nodeKind: params.kind,
                fieldPath: projection.fieldPath,
                dimensions: projection.dimensions,
                metric: projection.metric,
                indexType: projection.indexType,
              },
              INSERTED_NODE_PROJECTION_CTE_ALIAS,
              projection.embedding,
              timestamp,
            ),
            dialect,
          ),
        );
        break;
      }
      default: {
        return projection satisfies never;
      }
    }
  }
  return projectionSql;
}

/**
 * Builds one PostgreSQL/PGlite node insert with every requested plan step.
 * Returning `undefined` is the all-or-nothing capability result: callers must
 * use the ordinary node-plus-sidecar path rather than partially fusing.
 */
export function buildInsertNodeWithProjections(
  tables: Tables,
  params: InsertNodeParams,
  plan: ManagedNodeCreatePlan,
  timestamp: string,
  dialect: SqlDialect,
  fulltextTableName: string,
  fulltextStrategy: FulltextStrategy,
  vectorStrategy: VectorStrategy | undefined,
  schemaLockClause?: SQL,
): SQL | undefined {
  if (plan.claims.length > 0) {
    return buildNodeClaimsAndProjections(
      tables,
      params,
      plan,
      timestamp,
      dialect,
      fulltextTableName,
      fulltextStrategy,
      vectorStrategy,
    );
  }

  const projectionSql = buildProjectionSql(
    params,
    plan,
    timestamp,
    dialect,
    fulltextTableName,
    fulltextStrategy,
    vectorStrategy,
  );
  if (projectionSql === undefined) return;

  const nodeInsert = buildNodeInsert(
    tables,
    params,
    plan,
    timestamp,
    schemaLockClause,
  );
  return nodeInsert === undefined ? undefined : (
      buildNodeAndProjections(nodeInsert, projectionSql)
    );
}
