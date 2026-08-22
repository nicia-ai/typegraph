import { type SQL, sql } from "drizzle-orm";

import type { FulltextStrategy } from "../../../query/dialect/fulltext-strategy";
import type { SqlDialect } from "../../../query/dialect/types";
import type { VectorStrategy } from "../../../query/dialect/vector-strategy";
import type {
  InsertNodeParams,
  NodeInsertPlan,
} from "../../types";
import { toDrizzleSql } from "../execution/types";
import {
  buildInsertNode,
  buildInsertNodeWithSchemaFence,
} from "./nodes";
import type { Tables } from "./shared";

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

/**
 * Builds one PostgreSQL/PGlite node insert with every requested projection.
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
        if (vectorStrategy === undefined || vectorBuilder === undefined) {
          return;
        }
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

  const nodeInsert = buildNodeInsert(
    tables,
    params,
    plan,
    timestamp,
    schemaLockClause,
  );
  return nodeInsert === undefined ? undefined : buildNodeAndProjections(nodeInsert, projectionSql);
}
