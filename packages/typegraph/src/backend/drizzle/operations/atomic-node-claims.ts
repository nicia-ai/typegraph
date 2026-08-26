import { getTableName, type SQL, sql } from "drizzle-orm";

import { CompilerInvariantError } from "../../../errors";
import {
  type ClaimOwnerColumnNames,
  claimOwnerMatchesSql,
} from "../../../store/claims/axis";
import type { AtomicNodeBatchEntry } from "../../capabilities/atomic-node-batch";
import type {
  InsertNodeParams,
  NodeInsertClaim,
  SchemaWriteFenceParams,
  SqlDialect,
} from "../../types";
import {
  castBoundValueForColumn,
  quotedColumn,
  quotedTableName,
  type Tables,
} from "./shared";

/** One node batch member, carrying its stable ordinal into claim SQL. */
export type AtomicNodeClaimEntry = Readonly<{
  ordinal: number;
  entry: AtomicNodeBatchEntry;
}>;

/** The owner pair returned by the claim upsert for each target. */
export type AtomicNodeClaimOwnerRow = Readonly<{
  node_kind: string;
  constraint_name: string;
  key: string;
  node_id: string;
  concrete_kind: string;
}>;

const CLAIM_INPUT_ALIAS = "atomic_node_claim_input";
const SCHEMA_FENCE_ALIAS = "atomic_node_claim_schema_fence";

const CLAIM_INPUT_COLUMNS = [
  "graph_id",
  "axis",
  "constraint_name",
  "key",
  "node_id",
  "concrete_kind",
] as const;

function drizzleSqlTag(
  strings: TemplateStringsArray,
  ...expressions: readonly SQL[]
): SQL {
  return sql(strings, ...expressions);
}

function ownerColumnNames(uniques: Tables["uniques"]): ClaimOwnerColumnNames {
  return {
    nodeId: uniques.nodeId.name,
    concreteKind: uniques.concreteKind.name,
  };
}

/**
 * PostgreSQL qualifies the conflicting row in an upsert; SQLite requires the
 * bare column. This is the only dialect decision in the claim renderer.
 */
function existingColumn(
  tables: Tables,
  dialect: SqlDialect,
  columnName: string,
): SQL {
  const tableName = getTableName(tables.uniques);
  switch (dialect) {
    case "postgres": {
      return sql`${quotedTableName(tableName)}.${quotedColumn({ name: columnName })}`;
    }
    case "sqlite": {
      return quotedColumn({ name: columnName });
    }
    default: {
      return dialect satisfies never;
    }
  }
}

function excludedColumn(columnName: string): SQL {
  return sql`excluded.${quotedColumn({ name: columnName })}`;
}

function assertClaimEntries(
  entries: readonly AtomicNodeClaimEntry[],
  schemaFence: SchemaWriteFenceParams,
): void {
  if (entries.length === 0) {
    throw new CompilerInvariantError(
      "An atomic node claim statement needs at least one claim.",
    );
  }

  const ordinals = entries.map((item) => item.ordinal);
  if (
    ordinals.some((ordinal) => !Number.isSafeInteger(ordinal) || ordinal < 0) ||
    new Set(ordinals).size !== ordinals.length
  ) {
    throw new CompilerInvariantError(
      "Atomic node claim ordinals must be unique non-negative safe integers.",
    );
  }

  const first = entries[0];
  for (const item of entries) {
    const { entry } = item;
    const claim = entry.claim;
    if (
      entry.idSource !== "generated" ||
      claim?.verdict.kind !== "uniqueness" ||
      claim.axis !== entry.params.kind ||
      claim.placement !== "pre-insert" ||
      claim.verdict.probeAxes.length !== 1 ||
      claim.verdict.probeAxes[0] !== claim.axis ||
      entry.params.graphId !== schemaFence.graphId
    ) {
      throw new CompilerInvariantError(
        "Atomic node claims require generated ids and exactly one own-kind uniqueness claim.",
        { ordinal: item.ordinal },
      );
    }
    if (
      first !== undefined &&
      entry.params.graphId !== first.entry.params.graphId
    ) {
      throw new CompilerInvariantError(
        "Atomic node claim entries must belong to one graph.",
        { ordinal: item.ordinal },
      );
    }
  }
}

function claimOf(item: AtomicNodeClaimEntry): NodeInsertClaim {
  const claim = item.entry.claim;
  if (claim === undefined) {
    throw new CompilerInvariantError(
      "An atomic node claim entry is missing its claim.",
      { ordinal: item.ordinal },
    );
  }
  return claim;
}

function paramsOf(item: AtomicNodeClaimEntry): InsertNodeParams {
  return item.entry.params;
}

function claimInputValues(
  tables: Tables,
  entries: readonly AtomicNodeClaimEntry[],
): SQL {
  const { uniques } = tables;
  return sql.join(
    entries.map((item) => {
      const params = paramsOf(item);
      const claim = claimOf(item);
      return sql`
        (
                ${castBoundValueForColumn(uniques.graphId, params.graphId)},
                ${castBoundValueForColumn(uniques.nodeKind, claim.axis)},
                ${castBoundValueForColumn(uniques.constraintName, claim.constraintName)},
                ${castBoundValueForColumn(uniques.key, claim.key)},
                ${castBoundValueForColumn(uniques.nodeId, params.id)},
                ${castBoundValueForColumn(uniques.concreteKind, params.kind)}
              )
      `;
    }),
    sql`, `,
  );
}

function claimInputCte(
  tables: Tables,
  entries: readonly AtomicNodeClaimEntry[],
  alias: string,
): SQL {
  const columns = sql.join(
    CLAIM_INPUT_COLUMNS.map((column) => sql.identifier(column)),
    sql`, `,
  );
  return sql`${sql.identifier(alias)} (${columns}) AS (VALUES ${claimInputValues(tables, entries)})`;
}

function schemaFenceCte(
  tables: Tables,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
): SQL {
  const { schemaVersions } = tables;
  return sql`
    ${sql.identifier(SCHEMA_FENCE_ALIAS)} AS (
      SELECT ${schemaVersions.version}
      FROM ${schemaVersions}
      WHERE ${schemaVersions.graphId} = ${schemaFence.graphId}
        AND ${schemaVersions.version} = ${schemaFence.expectedVersion}
        AND ${schemaVersions.isActive} = TRUE
      ${schemaLockClause}
    )
  `;
}

function claimOwnerMatches(tables: Tables, dialect: SqlDialect): SQL {
  const uniques = tables.uniques;
  return claimOwnerMatchesSql(
    drizzleSqlTag,
    (columnName) => existingColumn(tables, dialect, columnName),
    (columnName) => excludedColumn(columnName),
    ownerColumnNames(uniques),
  );
}

/**
 * Builds the schema-fenced batch upsert for the narrow atomic node shape.
 *
 * The returned rows expose the target and the final owner pair for every input
 * claim. A foreign live owner is deliberately left untouched, exactly as the
 * ordinary uniqueness upsert does; the caller compares the returned owner pair
 * with the proposal and translates the refusal.
 */
export function buildAtomicNodeClaimUpsertWithSchemaFence(
  tables: Tables,
  dialect: SqlDialect,
  entries: readonly AtomicNodeClaimEntry[],
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
): SQL {
  assertClaimEntries(entries, schemaFence);
  const { uniques } = tables;
  const columns = sql.raw(
    `"${uniques.graphId.name}", "${uniques.nodeKind.name}", "${uniques.constraintName.name}", "${uniques.key.name}", "${uniques.nodeId.name}", "${uniques.concreteKind.name}", "${uniques.deletedAt.name}"`,
  );
  const conflictColumns = sql.raw(
    `"${uniques.graphId.name}", "${uniques.nodeKind.name}", "${uniques.constraintName.name}", "${uniques.key.name}"`,
  );
  const existing = (column: Readonly<{ name: string }>): SQL =>
    existingColumn(tables, dialect, column.name);
  const ownerMatches = claimOwnerMatches(tables, dialect);
  const input = sql.identifier(CLAIM_INPUT_ALIAS);
  const inputColumn = (name: string): SQL =>
    sql`${input}.${quotedColumn({ name })}`;

  return sql`
    WITH
      ${schemaFenceCte(tables, schemaFence, schemaLockClause)},
      ${claimInputCte(tables, entries, CLAIM_INPUT_ALIAS)}
    INSERT INTO ${uniques} (${columns})
    SELECT
      ${inputColumn("graph_id")},
      ${inputColumn("axis")},
      ${inputColumn("constraint_name")},
      ${inputColumn("key")},
      ${inputColumn("node_id")},
      ${inputColumn("concrete_kind")},
      NULL
    FROM ${input}
    CROSS JOIN ${sql.identifier(SCHEMA_FENCE_ALIAS)}
    WHERE TRUE
    ON CONFLICT (${conflictColumns})
    DO UPDATE SET
      ${quotedColumn(uniques.nodeId)} = CASE
        WHEN ${ownerMatches} THEN ${excludedColumn(uniques.nodeId.name)}
        WHEN ${existing(uniques.deletedAt)} IS NOT NULL THEN ${excludedColumn(uniques.nodeId.name)}
        ELSE ${existing(uniques.nodeId)}
      END,
      ${quotedColumn(uniques.concreteKind)} = CASE
        WHEN ${ownerMatches} THEN ${excludedColumn(uniques.concreteKind.name)}
        WHEN ${existing(uniques.deletedAt)} IS NOT NULL THEN ${excludedColumn(uniques.concreteKind.name)}
        ELSE ${existing(uniques.concreteKind)}
      END,
      ${quotedColumn(uniques.deletedAt)} = CASE
        WHEN ${ownerMatches} THEN NULL
        WHEN ${existing(uniques.deletedAt)} IS NOT NULL THEN NULL
        ELSE ${existing(uniques.deletedAt)}
      END
    RETURNING
      ${quotedColumn(uniques.nodeKind)} AS node_kind,
      ${quotedColumn(uniques.constraintName)} AS constraint_name,
      ${quotedColumn(uniques.key)} AS key,
      ${quotedColumn(uniques.nodeId)} AS node_id,
      ${quotedColumn(uniques.concreteKind)} AS concrete_kind
  `;
}

/**
 * Builds a schema-fenced predicate suitable for a node INSERT's `WHERE` or
 * gate CTE. It is true only when the fence exists and every exact claim target
 * is live and owned by the proposed `(concrete_kind, node_id)` pair.
 */
export function buildAtomicNodeClaimGatePredicateWithSchemaFence(
  tables: Tables,
  entries: readonly AtomicNodeClaimEntry[],
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
): SQL {
  assertClaimEntries(entries, schemaFence);
  const { uniques } = tables;
  const input = sql.identifier(CLAIM_INPUT_ALIAS);
  const inputColumn = (name: string): SQL =>
    sql`${input}.${quotedColumn({ name })}`;
  const target = sql.identifier("candidate_claim");
  const targetColumn = (column: Readonly<{ name: string }>): SQL =>
    sql`${target}.${quotedColumn(column)}`;

  return sql`
    EXISTS (
      WITH
        ${schemaFenceCte(tables, schemaFence, schemaLockClause)},
        ${claimInputCte(tables, entries, CLAIM_INPUT_ALIAS)}
      SELECT 1
      FROM ${sql.identifier(SCHEMA_FENCE_ALIAS)}
      WHERE NOT EXISTS (
        SELECT 1
        FROM ${input}
        WHERE NOT EXISTS (
          SELECT 1
          FROM ${uniques} AS ${target}
          WHERE ${targetColumn(uniques.graphId)} = ${inputColumn("graph_id")}
            AND ${targetColumn(uniques.nodeKind)} = ${inputColumn("axis")}
            AND ${targetColumn(uniques.constraintName)} = ${inputColumn("constraint_name")}
            AND ${targetColumn(uniques.key)} = ${inputColumn("key")}
            AND ${targetColumn(uniques.nodeId)} = ${inputColumn("node_id")}
            AND ${targetColumn(uniques.concreteKind)} = ${inputColumn("concrete_kind")}
            AND ${targetColumn(uniques.deletedAt)} IS NULL
        )
      )
    )
  `;
}

/**
 * Builds precise claim cleanup for a failed generated node write. Only the
 * exact target rows owned by the proposal are removed, and only when the
 * proposed node is not live. A stale schema fence makes this a no-op.
 */
export function buildAtomicNodeClaimCleanupWithSchemaFence(
  tables: Tables,
  entries: readonly AtomicNodeClaimEntry[],
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
): SQL {
  assertClaimEntries(entries, schemaFence);
  const { nodes, uniques } = tables;
  const input = sql.identifier(CLAIM_INPUT_ALIAS);
  const inputColumn = (name: string): SQL =>
    sql`${input}.${quotedColumn({ name })}`;
  const target = sql.identifier("claim_to_delete");
  const targetColumn = (column: Readonly<{ name: string }>): SQL =>
    sql`${target}.${quotedColumn(column)}`;

  return sql`
    WITH
      ${schemaFenceCte(tables, schemaFence, schemaLockClause)},
      ${claimInputCte(tables, entries, CLAIM_INPUT_ALIAS)}
    DELETE FROM ${uniques} AS ${target}
    WHERE EXISTS (SELECT 1 FROM ${sql.identifier(SCHEMA_FENCE_ALIAS)})
      AND EXISTS (
        SELECT 1
        FROM ${input}
        WHERE ${targetColumn(uniques.graphId)} = ${inputColumn("graph_id")}
          AND ${targetColumn(uniques.nodeKind)} = ${inputColumn("axis")}
          AND ${targetColumn(uniques.constraintName)} = ${inputColumn("constraint_name")}
          AND ${targetColumn(uniques.key)} = ${inputColumn("key")}
          AND ${targetColumn(uniques.nodeId)} = ${inputColumn("node_id")}
          AND ${targetColumn(uniques.concreteKind)} = ${inputColumn("concrete_kind")}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM ${nodes}
        WHERE ${nodes.graphId} = ${targetColumn(uniques.graphId)}
          AND ${nodes.kind} = ${targetColumn(uniques.concreteKind)}
          AND ${nodes.id} = ${targetColumn(uniques.nodeId)}
          AND ${nodes.deletedAt} IS NULL
      )
  `;
}
