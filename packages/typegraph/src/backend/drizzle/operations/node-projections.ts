import { type SQL, sql } from "drizzle-orm";

import type { FulltextStrategy } from "../../../query/dialect/fulltext-strategy";
import type { SqlDialect } from "../../../query/dialect/types";
import type { VectorStrategy } from "../../../query/dialect/vector-strategy";
import { resolveStampedValidityLowerBound } from "../../../utils/date";
import type {
  InsertNodeParams,
  NodeInsertClaim,
  NodeInsertPlan,
} from "../../types";
import { toDrizzleSql } from "../execution/types";
import { buildInsertNode, buildInsertNodeWithSchemaFence } from "./nodes";
import { nodeColumnList, sqlNull, type Tables } from "./shared";
import { buildInsertUniqueFromSource } from "./uniques";

/** The fixed alias shared by the node CTE and all projection strategies. */
export const INSERTED_NODE_PROJECTION_CTE_ALIAS = "inserted_node";

function buildNodeInsert(
  tables: Tables,
  params: InsertNodeParams,
  plan: NodeInsertPlan,
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
      return plan.mode satisfies never;
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

function buildGatedNodeInsert(
  tables: Tables,
  params: InsertNodeParams,
  plan: NodeInsertPlan,
  timestamp: string,
  gateAlias: string,
  schemaLockClause: SQL | undefined,
): SQL | undefined {
  const { nodes, schemaVersions } = tables;
  const propsJson = JSON.stringify(params.props);
  const columns = nodeColumnList(nodes);
  const gate = sql.identifier(gateAlias);

  switch (plan.mode.kind) {
    case "ordinary": {
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
    case "schema-fenced": {
      if (schemaLockClause === undefined) return;
      return sql`
        INSERT INTO ${nodes} (${columns})
        SELECT
          ${params.graphId}, ${params.kind}, ${params.id}, ${propsJson},
          1, ${sqlNull(resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp))}, ${sqlNull(params.validTo)},
          ${timestamp}, ${timestamp}
        FROM (
          SELECT ${schemaVersions.version}
          FROM ${schemaVersions}
          WHERE ${schemaVersions.graphId} = ${plan.mode.schemaFence.graphId}
            AND ${schemaVersions.version} = ${plan.mode.schemaFence.expectedVersion}
            AND ${schemaVersions.isActive} = TRUE
          ${schemaLockClause}
        ) AS "schema_fence"
        CROSS JOIN ${gate}
        RETURNING *
      `;
    }
    default: {
      return plan.mode satisfies never;
    }
  }
}

function buildNodeClaimsAndProjections(
  tables: Tables,
  params: InsertNodeParams,
  plan: NodeInsertPlan,
  timestamp: string,
  dialect: SqlDialect,
  fulltextTableName: string,
  fulltextStrategy: FulltextStrategy,
  vectorStrategy: VectorStrategy | undefined,
  schemaLockClause: SQL | undefined,
): SQL | undefined {
  const claims = plan.claims ?? [];
  const preClaims = claims.filter(
    (claim) => claim.placement === "pre-insert",
  );
  const postClaims = claims.filter(
    (claim) => claim.placement === "post-insert",
  );
  const ctes: SQL[] = [];
  const preInputAlias = "node_pre_claim_input";
  const preClaimedAlias = "node_pre_claimed";
  const preVerdictAlias = "node_pre_claim_verdict";

  if (preClaims.length > 0) {
    ctes.push(
      claimInputCte(preInputAlias, preClaims, params),
      sql`${sql.identifier(preClaimedAlias)} AS (${buildInsertUniqueFromSource(tables, dialect, preInputAlias)})`,
      claimVerdictCte(preVerdictAlias, preInputAlias, preClaimedAlias),
    );
  }

  const preGateAlias = "node_pre_gate";
  ctes.push(
    preClaims.length === 0 ?
      sql`${sql.identifier(preGateAlias)} AS (SELECT 1 AS gate)`
    : sql`
      ${sql.identifier(preGateAlias)} AS (
        SELECT 1 AS gate
        WHERE NOT EXISTS (
          SELECT 1
          FROM ${sql.identifier(preVerdictAlias)}
          WHERE accepted = FALSE
        )
      )
    `,
  );

  const nodeInsert = buildGatedNodeInsert(
    tables,
    params,
    plan,
    timestamp,
    preGateAlias,
    schemaLockClause,
  );
  if (nodeInsert === undefined) return;
  const nodeInsertedAlias = "node_inserted";
  ctes.push(
    sql`${sql.identifier(nodeInsertedAlias)} AS MATERIALIZED (${nodeInsert})`,
  );

  const postInputAlias = "node_post_claim_input";
  const postClaimedAlias = "node_post_claimed";
  const postVerdictAlias = "node_post_claim_verdict";
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
  }

  const insertedNodeAlias = INSERTED_NODE_PROJECTION_CTE_ALIAS;
  const nodeInserted = sql.identifier(nodeInsertedAlias);
  ctes.push(
    postClaims.length === 0 ?
      sql`${sql.identifier(insertedNodeAlias)} AS MATERIALIZED (SELECT * FROM ${nodeInserted})`
    : sql`
      ${sql.identifier(insertedNodeAlias)} AS MATERIALIZED (
        SELECT *
        FROM ${nodeInserted}
        WHERE NOT EXISTS (
          SELECT 1
          FROM ${sql.identifier(postVerdictAlias)}
          WHERE accepted = FALSE
        )
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
  ctes.push(...projectionSql.map((projection, index) =>
    sql`${sql.identifier(`node_projection_${index}`)} AS (${projection})`,
  ));

  const conflictQueries: SQL[] = [];
  if (preClaims.length > 0) {
    conflictQueries.push(
      sql`SELECT ordinal, 0 AS phase, axis, constraint_name, key, holder_id, holder_kind FROM ${sql.identifier(preVerdictAlias)} WHERE accepted = FALSE`,
    );
  }
  if (postClaims.length > 0) {
    conflictQueries.push(
      sql`SELECT ordinal, 1 AS phase, axis, constraint_name, key, holder_id, holder_kind FROM ${sql.identifier(postVerdictAlias)} WHERE accepted = FALSE`,
    );
  }
  const conflictAlias = "node_claim_conflicts";
  if (conflictQueries.length === 0) {
    ctes.push(
      sql`${sql.identifier(conflictAlias)} AS (SELECT NULL::integer AS ordinal, NULL::integer AS phase, NULL::text AS axis, NULL::text AS constraint_name, NULL::text AS key, NULL::text AS holder_id, NULL::text AS holder_kind WHERE FALSE)`,
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
        ORDER BY phase, ordinal
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
  plan: NodeInsertPlan,
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
  plan: NodeInsertPlan,
  timestamp: string,
  dialect: SqlDialect,
  fulltextTableName: string,
  fulltextStrategy: FulltextStrategy,
  vectorStrategy: VectorStrategy | undefined,
  schemaLockClause?: SQL,
): SQL | undefined {
  if ((plan.claims?.length ?? 0) > 0) {
    return buildNodeClaimsAndProjections(
      tables,
      params,
      plan,
      timestamp,
      dialect,
      fulltextTableName,
      fulltextStrategy,
      vectorStrategy,
      schemaLockClause,
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
  return nodeInsert === undefined ? undefined : buildNodeAndProjections(nodeInsert, projectionSql);
}
