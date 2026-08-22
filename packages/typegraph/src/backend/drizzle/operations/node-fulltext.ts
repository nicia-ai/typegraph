import { type SQL, sql } from "drizzle-orm";

import type { InsertNodeParams, SchemaWriteFenceParams } from "../../types";
import { buildInsertNode, buildInsertNodeWithSchemaFence } from "./nodes";
import type { Tables } from "./shared";

export const INSERTED_NODE_CTE_ALIAS = "inserted_node";

function buildNodeAndFulltext(nodeInsert: SQL, fulltextSync: SQL): SQL {
  return sql`
    WITH ${sql.identifier(INSERTED_NODE_CTE_ALIAS)} AS MATERIALIZED (
      ${nodeInsert}
    ), "fulltext_sync" AS (
      ${fulltextSync}
    )
    SELECT * FROM ${sql.identifier(INSERTED_NODE_CTE_ALIAS)}
  `;
}

export function buildInsertNodeWithFulltext(
  tables: Tables,
  params: InsertNodeParams,
  timestamp: string,
  fulltextSync: SQL,
): SQL {
  return buildNodeAndFulltext(
    buildInsertNode(tables, params, timestamp),
    fulltextSync,
  );
}

export function buildInsertNodeWithSchemaFenceAndFulltext(
  tables: Tables,
  params: InsertNodeParams,
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
  fulltextSync: SQL,
): SQL {
  return buildNodeAndFulltext(
    buildInsertNodeWithSchemaFence(
      tables,
      params,
      timestamp,
      schemaFence,
      schemaLockClause,
    ),
    fulltextSync,
  );
}
