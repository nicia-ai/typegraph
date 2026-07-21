import { type GraphBackend } from "../../backend/types";
import { ConfigurationError } from "../../errors";
import { type SqlSchema } from "../../query/compiler/schema";
import { sql } from "../../query/sql-fragment";
import { asCompiledRowsSql } from "../../query/sql-intent";

type ColumnRow = Readonly<{ name: unknown; type: unknown }>;

type RecordedColumnKind = "revision" | "wall-time";

type RequiredRecordedColumn = Readonly<{
  column: string;
  kind: RecordedColumnKind;
  table: string;
}>;

function normalizedColumnType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0 ? undefined : normalized;
}

async function readColumnTypes(
  backend: Pick<GraphBackend, "dialect" | "execute">,
  table: string,
): Promise<ReadonlyMap<string, string>> {
  const rows =
    backend.dialect === "sqlite" ?
      await backend.execute<ColumnRow>(
        asCompiledRowsSql(sql`PRAGMA table_info(${sql.identifier(table)})`),
      )
    : await backend.execute<ColumnRow>(
        asCompiledRowsSql(sql`
          SELECT column_name AS name, data_type AS type
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = ${table}
        `),
      );
  return new Map(
    rows.flatMap((row) => {
      if (typeof row.name !== "string") return [];
      const type = normalizedColumnType(row.type);
      return type === undefined ? [] : [[row.name, type] as const];
    }),
  );
}

function hasSqliteAffinity(
  declaredType: string,
  kind: RecordedColumnKind,
): boolean {
  if (kind === "revision") return declaredType.includes("int");
  return (
    declaredType.includes("char") ||
    declaredType.includes("clob") ||
    declaredType.includes("text")
  );
}

function isCompatibleColumnType(
  dialect: GraphBackend["dialect"],
  declaredType: string,
  kind: RecordedColumnKind,
): boolean {
  if (dialect === "sqlite") return hasSqliteAffinity(declaredType, kind);
  return kind === "revision" ?
      declaredType === "bigint"
    : declaredType === "timestamp with time zone";
}

function requiredRecordedColumns(
  schema: SqlSchema,
  includeIdentity: boolean,
): readonly RequiredRecordedColumn[] {
  const identityColumns: readonly RequiredRecordedColumn[] =
    includeIdentity ?
      [
        {
          table: schema.tables.recordedIdentityAssertions,
          column: "recorded_from",
          kind: "revision",
        },
        {
          table: schema.tables.recordedIdentityAssertions,
          column: "recorded_to",
          kind: "revision",
        },
      ]
    : [];
  return [
    {
      table: schema.tables.recordedNodes,
      column: "recorded_from",
      kind: "revision",
    },
    {
      table: schema.tables.recordedNodes,
      column: "recorded_to",
      kind: "revision",
    },
    {
      table: schema.tables.recordedEdges,
      column: "recorded_from",
      kind: "revision",
    },
    {
      table: schema.tables.recordedEdges,
      column: "recorded_to",
      kind: "revision",
    },
    {
      table: schema.tables.recordedClock,
      column: "revision",
      kind: "revision",
    },
    {
      table: schema.tables.recordedClock,
      column: "recorded_at",
      kind: "wall-time",
    },
    ...identityColumns,
  ];
}

/**
 * Verifies that a history-enabled async store open targets the current
 * physical recorded schema. The synchronous `createStore` attach path cannot
 * perform this I/O and retains its fail-loud first-operation behavior.
 *
 * `includeIdentity` extends the check to the recorded identity relation, which
 * only exists for graphs that enable the TypeGraph Identity Profile.
 */
export async function assertCurrentRecordedSchema(
  backend: Pick<GraphBackend, "dialect" | "execute">,
  schema: SqlSchema,
  includeIdentity = false,
): Promise<void> {
  const requirements = requiredRecordedColumns(schema, includeIdentity);
  const tables = [...new Set(requirements.map((entry) => entry.table))];
  const columnTypes = new Map(
    await Promise.all(
      tables.map(
        async (table) =>
          [table, await readColumnTypes(backend, table)] as const,
      ),
    ),
  );
  const incompatible = requirements.flatMap((requirement) => {
    const actual = columnTypes.get(requirement.table)?.get(requirement.column);
    if (
      actual !== undefined &&
      isCompatibleColumnType(backend.dialect, actual, requirement.kind)
    ) {
      return [];
    }
    return [{ ...requirement, actual: actual ?? "missing" }];
  });
  if (incompatible.length === 0) return;

  throw new ConfigurationError(
    "Recorded-time schema is incompatible with history capture.",
    {
      code: "RECORDED_SCHEMA_INCOMPATIBLE",
      dialect: backend.dialect,
      incompatible,
    },
    {
      suggestion:
        "Run migrateLegacyRecordedTime({ backend }) before opening a store with history: true. If these are not preview-schema tables, provision the current recorded relations first.",
    },
  );
}
