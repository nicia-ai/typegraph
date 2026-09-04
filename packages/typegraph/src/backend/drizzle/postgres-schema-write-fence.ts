/**
 * PostgreSQL's fused schema-version + graph-advisory write fence: a single
 * statement whose graph lock only acquires once the expected active schema
 * row has been read `FOR SHARE`, so a stale schema version can never win the
 * advisory lock ahead of the read that would have diagnosed it as stale.
 * `createPostgresOperationStrategy`'s only PostgreSQL-only strategy
 * override.
 *
 * This needs `drizzle-orm` to reach the schema table, so — unlike every
 * other write-fence site — it cannot be built from `./postgres-fence-sql`'s
 * `FenceSql` bag directly; that module stays outside the Drizzle zone so
 * portable code can import it. Instead this statement calls back into that
 * module's exported bare expressions (`advisoryLockExpression`,
 * `isolationFactExpression`) and converts each to Drizzle's own `SQL` at the
 * embedding boundary, so the lock and the isolation read keep the exact
 * spelling every other PostgreSQL fence site uses without a second copy of
 * either token living here.
 */
import { type SQL, sql } from "drizzle-orm";

import type { SchemaWriteFenceParams } from "../types";
import { toDrizzleSql } from "./execution/types";
import {
  advisoryLockExpression,
  isolationFactExpression,
} from "./postgres-fence-sql";
import type { PostgresTables } from "./schema/postgres";

/**
 * PostgreSQL's successful schema + graph write fence in one statement.
 *
 * Both CTEs are `MATERIALIZED`, and `graph_write_lock` reads exclusively from
 * `schema_fence`: PostgreSQL therefore must finish the expected active-row
 * `FOR SHARE` lock before it may acquire the advisory lock. A stale fence
 * yields no rows and cannot acquire the graph lock. The caller interprets that
 * zero-row result through the ordinary active-version diagnostic.
 */
export function buildLockSchemaVersionAndGraphWrite(
  tables: PostgresTables,
  params: SchemaWriteFenceParams,
  advisoryLockNamespace: string,
): SQL {
  const { schemaVersions } = tables;
  return sql`
    WITH "schema_fence" AS MATERIALIZED (
      SELECT ${schemaVersions.version}
      FROM ${schemaVersions}
      WHERE ${schemaVersions.graphId} = ${params.graphId}
        AND ${schemaVersions.version} = ${params.expectedVersion}
        AND ${schemaVersions.isActive} = TRUE
      FOR SHARE
    ),
    "graph_write_lock" AS MATERIALIZED (
      SELECT ${toDrizzleSql(advisoryLockExpression(advisoryLockNamespace, params.graphId), "postgres")} AS "lock_token"
      FROM "schema_fence"
    )
    SELECT
      TRUE AS "fence_acquired",
      ${toDrizzleSql(isolationFactExpression(), "postgres")} AS "transaction_isolation"
    FROM "graph_write_lock"
  `;
}
