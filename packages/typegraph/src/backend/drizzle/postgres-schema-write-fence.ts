/**
 * PostgreSQL's fused schema-version + graph-advisory write fence: a single
 * statement whose graph lock only acquires once the expected active schema
 * row has been read `FOR SHARE`, so a stale schema version can never win the
 * advisory lock ahead of the read that would have diagnosed it as stale.
 * `createPostgresOperationStrategy`'s only PostgreSQL-only strategy
 * override.
 *
 * This needs `drizzle-orm` to reach the schema table, so — unlike every
 * other write-fence site — it cannot be built from a `FenceSql` bag's
 * standalone-statement members directly; `./postgres-fence-sql` stays
 * outside the Drizzle zone so portable code can import it. Instead this
 * statement takes the resolved `FenceSql` it is composing a statement for as
 * a parameter and calls its `advisoryLockExpression` / `isolationFactExpression`
 * members — the composable, no-`SELECT` forms every `FenceSql` declares —
 * converting each to Drizzle's own `SQL` at the embedding boundary. That is
 * what keeps this fused statement locking the SAME key a derived profile's
 * portable lock sites take: both read `fenceSql.advisoryLockExpression`, so
 * neither can drift to a different spelling than the other.
 */
import { type SQL, sql } from "drizzle-orm";

import type { FenceSql } from "../capabilities/write-fence";
import type { SchemaWriteFenceParams } from "../types";
import { toDrizzleSql } from "./execution/types";
import type { PostgresTables } from "./schema/postgres";

/**
 * PostgreSQL's successful schema + graph write fence in one statement.
 *
 * Both CTEs are `MATERIALIZED`, and `graph_write_lock` reads exclusively from
 * `schema_fence`: PostgreSQL therefore must finish the expected active-row
 * `FOR SHARE` lock before it may acquire the advisory lock. A stale fence
 * yields no rows and cannot acquire the graph lock. The caller interprets that
 * zero-row result through the ordinary active-version diagnostic.
 *
 * `fenceSql` is the resolved fence target's OWN spelling — the bundled
 * `postgresFenceSql` for a bundled backend, or a derived profile's own
 * `FenceSql` override — never imported directly, so a derived profile's
 * fused write and its portable lock sites always exclude on the same key.
 */
export function buildLockSchemaVersionAndGraphWrite(
  tables: PostgresTables,
  params: SchemaWriteFenceParams,
  advisoryLockNamespace: string,
  fenceSql: FenceSql,
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
      SELECT ${toDrizzleSql(fenceSql.advisoryLockExpression(advisoryLockNamespace, params.graphId), "postgres")} AS "lock_token"
      FROM "schema_fence"
    )
    SELECT
      TRUE AS "fence_acquired",
      ${toDrizzleSql(fenceSql.isolationFactExpression(), "postgres")} AS "transaction_isolation"
    FROM "graph_write_lock"
  `;
}
