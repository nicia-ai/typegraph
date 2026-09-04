import {
  type NormalizedColumnKind,
  requireCatalog,
  REVISION_COLUMN_KINDS,
  WALL_TIME_COLUMN_KINDS,
} from "../../backend/capabilities/catalog";
import { type GraphBackend } from "../../backend/types";
import { ConfigurationError } from "../../errors";
import { type SqlSchema } from "../../query/compiler/schema";

type RecordedColumnKind = "revision" | "wall-time";

type RequiredRecordedColumn = Readonly<{
  column: string;
  kind: RecordedColumnKind;
  table: string;
}>;

async function readColumnTypes(
  backend: Pick<GraphBackend, "catalog">,
  table: string,
): Promise<ReadonlyMap<string, NormalizedColumnKind>> {
  const catalog = requireCatalog(backend, "assertCurrentRecordedSchema");
  const columns = await catalog.columnTypes(table);
  return new Map(columns.map((column) => [column.name, column.kind]));
}

/**
 * Whether a column normalized to `actual` is compatible with the recorded
 * time role `kind` expects, checked against the owned kind set for that
 * role ({@link REVISION_COLUMN_KINDS} / {@link WALL_TIME_COLUMN_KINDS})
 * rather than a dialect branch — the two dialects agree on the revision
 * kind but not on the wall-time one, which is exactly what those two sets
 * already encode.
 */
function isCompatibleColumnKind(
  kind: RecordedColumnKind,
  actual: NormalizedColumnKind,
): boolean {
  const allowed =
    kind === "revision" ? REVISION_COLUMN_KINDS : WALL_TIME_COLUMN_KINDS;
  return allowed.includes(actual);
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
  backend: Pick<GraphBackend, "catalog" | "dialect">,
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
  const recordedIdentityTable = schema.tables.recordedIdentityAssertions;
  if (
    includeIdentity &&
    (columnTypes.get(recordedIdentityTable)?.size ?? 0) === 0
  ) {
    throw new ConfigurationError(
      "Recorded identity history is not provisioned for this database.",
      {
        code: "RECORDED_IDENTITY_SCHEMA_MISSING",
        dialect: backend.dialect,
        table: recordedIdentityTable,
      },
      {
        suggestion:
          "Restore the missing recorded identity ledger from backup. If this is confirmed first-time identity enablement with no identity history to preserve, provision the relation through the backend's privileged setup path before reopening with history: true.",
      },
    );
  }
  const incompatible = requirements.flatMap((requirement) => {
    const actual = columnTypes.get(requirement.table)?.get(requirement.column);
    if (
      actual !== undefined &&
      isCompatibleColumnKind(requirement.kind, actual)
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
