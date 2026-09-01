/** Current-state population statistics and declared-schema validation. */
import { type z } from "zod";

import {
  type GraphBackend,
  type RowProps,
  rowPropsToObject,
} from "../backend/types";
import type { GraphDef } from "../core/define-graph";
import type { KindEntity } from "../core/types";
import {
  SchemaMismatchError,
  StaleVersionError,
  TypeGraphError,
  ValidationError,
} from "../errors";
import type { SqlSchema } from "../query/compiler/schema";
import { compileTemporalFilter } from "../query/compiler/temporal";
import { decodeCursor, encodeCursor } from "../query/cursor";
import { getDialect } from "../query/dialect";
import {
  encodeJsonPointerSegment,
  type JsonPointer,
} from "../query/json-pointer";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { sortedReplacer } from "../schema/canonical";
import { serializeSchemaProperties } from "../schema/serializer";
import type { JsonSchema } from "../schema/types";
import { nowIso } from "../utils/date";
import { sha256Hex } from "../utils/hash";
import type { SchemaIntrospection } from "./introspect";

const DEFAULT_VALIDATION_PAGE_SIZE = 100;
const MAX_VALIDATION_PAGE_SIZE = 1000;
const VALIDATION_CURSOR_COLUMNS = [
  "typegraph.validateStore.entity",
  "typegraph.validateStore.kind",
  "typegraph.validateStore.schemaFence",
  "typegraph.validateStore.afterId",
] as const;

export type StoreAnalysisSnapshot = Readonly<{
  schemaVersion?: number;
  schemaHash?: string;
  /** Fingerprint of both the Store declarations and active schema row. */
  schemaFence: string;
}>;

export type PropertyPopulationStatistics = Readonly<{
  /** RFC 6901 JSON pointer to a directly addressable declared property. */
  path: string;
  /** Rows in which the property exists, including explicit JSON null. */
  presentCount: number;
  /** Rows in which the property exists and is the JSON null literal. */
  nullCount: number;
  nonNullCount: number;
  /** `nonNullCount / count`; zero for an empty kind. */
  coverage: number;
}>;

export type KindPopulationStatistics = Readonly<{
  entity: KindEntity;
  kind: string;
  count: number;
  properties: readonly PropertyPopulationStatistics[];
}>;

export type StorePopulationStatistics = Readonly<{
  /** Schema coordinate observed before and after the aggregate statement. */
  snapshot: StoreAnalysisSnapshot;
  nodes: readonly KindPopulationStatistics[];
  edges: readonly KindPopulationStatistics[];
}>;

export type StoreDescription = Readonly<{
  schema: SchemaIntrospection;
  statistics: StorePopulationStatistics;
}>;

export type ValidateStoreOptions = Readonly<{
  entity: KindEntity;
  kind: string;
  /** Number of records to scan. Default 100; maximum 1000. */
  pageSize?: number;
  /** Opaque keyset cursor returned by the preceding page. */
  cursor?: string;
}>;

export type StoreValidationFailure = Readonly<{
  entity: KindEntity;
  kind: string;
  id: string;
  /** RFC 6901 path; the empty string denotes a whole-record rule. */
  path: string;
  /** Top-level declared property, absent for a whole-record rule. */
  property?: string;
  code: string;
  reason: string;
}>;

export type StoreValidationPage = Readonly<{
  /** Schema coordinate observed before and after this page scan. */
  snapshot: StoreAnalysisSnapshot;
  /** Number of records scanned, independent of the number of violations. */
  scannedCount: number;
  violations: readonly StoreValidationFailure[];
  nextCursor?: string;
}>;

export type StoreAnalysisCursorStaleErrorDetails = Readonly<{
  entity: KindEntity;
  kind: string;
  expectedSchemaFence: string;
  actualSchemaFence: string;
}>;

/** A validation cursor cannot be resumed after the active schema changes. */
export class StoreAnalysisCursorStaleError extends TypeGraphError {
  declare readonly details: StoreAnalysisCursorStaleErrorDetails;

  constructor(details: StoreAnalysisCursorStaleErrorDetails) {
    super(
      `The validation cursor for ${details.entity} kind "${details.kind}" is stale.`,
      "STORE_ANALYSIS_CURSOR_STALE",
      {
        category: "user",
        details,
        suggestion:
          "Restart validateStore() without a cursor after the schema change.",
      },
    );
    this.name = "StoreAnalysisCursorStaleError";
    this.details = details;
  }
}

type AnalysisContext<G extends GraphDef> = Readonly<{
  graph: G;
  graphId: string;
  backend: GraphBackend;
  schema: SqlSchema;
  introspect: () => SchemaIntrospection;
}>;

type ValidationCursor = Readonly<{
  entity: KindEntity;
  kind: string;
  schemaFence: string;
  afterId: string;
}>;

type ValidationRow = Readonly<{ id: string; props: RowProps }>;
type PopulationRow = Readonly<{
  entity: KindEntity;
  kind: string;
  row_count: number | string | bigint;
}> &
  Readonly<Record<string, unknown>>;
type SchemaCoordinate = StoreAnalysisSnapshot;

/**
 * Only ordinary nested `properties` members have an unambiguous portable SQL
 * address. `$ref`, unions, intersections, arrays, and conditionals remain in
 * the authoritative Zod validation pass rather than receiving fake coverage.
 */
function declaredPropertyPaths(
  schema: JsonSchema,
  parent: readonly string[] = [],
): readonly (readonly string[])[] {
  const paths: (readonly string[])[] = [];
  for (const [name, propertySchema] of Object.entries(
    schema.properties ?? {},
  )) {
    const path = [...parent, name];
    paths.push(path, ...declaredPropertyPaths(propertySchema, path));
  }
  return paths;
}

function pathToPointer(path: readonly PropertyKey[]): string {
  return path
    .map((segment) => `/${encodeJsonPointerSegment(String(segment))}`)
    .join("");
}

function normalizePageSize(pageSize: number | undefined): number {
  const resolved = pageSize ?? DEFAULT_VALIDATION_PAGE_SIZE;
  if (
    !Number.isInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_VALIDATION_PAGE_SIZE
  ) {
    throw new ValidationError(
      `validateStore pageSize must be an integer between 1 and ${MAX_VALIDATION_PAGE_SIZE}.`,
      {
        issues: [
          {
            path: "pageSize",
            message: `Expected an integer between 1 and ${MAX_VALIDATION_PAGE_SIZE}`,
          },
        ],
      },
    );
  }
  return resolved;
}

function decodeValidationCursor(cursor: string): ValidationCursor {
  const decoded = decodeCursor(cursor);
  if (
    decoded.d !== "f" ||
    decoded.cols.length !== VALIDATION_CURSOR_COLUMNS.length ||
    !decoded.cols.every(
      (column, index) => column === VALIDATION_CURSOR_COLUMNS[index],
    )
  ) {
    throw new ValidationError("Invalid validateStore cursor scope.", {
      issues: [
        {
          path: "cursor",
          message: "Cursor was not created by validateStore",
        },
      ],
    });
  }
  const [entity, kind, schemaFence, afterId] = decoded.vals;
  if (
    (entity !== "node" && entity !== "edge") ||
    typeof kind !== "string" ||
    typeof schemaFence !== "string" ||
    typeof afterId !== "string"
  ) {
    throw new ValidationError("Invalid validateStore cursor payload.", {
      issues: [{ path: "cursor", message: "Cursor payload is malformed" }],
    });
  }
  return { entity, kind, schemaFence, afterId };
}

function encodeValidationCursor(cursor: ValidationCursor): string {
  return encodeCursor({
    v: 1,
    d: "f",
    cols: VALIDATION_CURSOR_COLUMNS,
    vals: [cursor.entity, cursor.kind, cursor.schemaFence, cursor.afterId],
  });
}

async function schemaCoordinateFor<G extends GraphDef>(
  ctx: AnalysisContext<G>,
): Promise<SchemaCoordinate> {
  const active = await ctx.backend.getActiveSchema(ctx.graphId);
  const declaration = ctx.introspect();
  if (
    declaration.schemaVersion !== undefined &&
    active?.version !== declaration.schemaVersion
  ) {
    throw new StaleVersionError({
      graphId: ctx.graphId,
      expected: declaration.schemaVersion,
      actual: active?.version ?? 0,
    });
  }
  if (
    declaration.schemaHash !== undefined &&
    active !== undefined &&
    active.schema_hash !== declaration.schemaHash
  ) {
    throw new SchemaMismatchError({
      graphId: ctx.graphId,
      expectedHash: declaration.schemaHash,
      actualHash: active.schema_hash,
    });
  }
  const declarationShape = {
    graphId: declaration.graphId,
    kinds: declaration.kinds.map((kind) => ({
      name: kind.name,
      properties: kind.properties,
    })),
    edges: declaration.edges.map((edge) => ({
      name: edge.name,
      from: edge.from,
      to: edge.to,
      properties: edge.properties,
    })),
  };
  const schemaFence = await sha256Hex(
    JSON.stringify(
      {
        active:
          active === undefined ? undefined : (
            [active.version, active.schema_hash]
          ),
        declaration: declarationShape,
      },
      sortedReplacer,
    ),
    16,
  );
  return {
    ...(active === undefined ? {} : { schemaVersion: active.version }),
    ...(active === undefined ? {} : { schemaHash: active.schema_hash }),
    schemaFence,
  };
}

function assertStableSchema(
  before: SchemaCoordinate,
  after: SchemaCoordinate,
): void {
  if (before.schemaFence === after.schemaFence) return;
  throw new TypeGraphError(
    "The active schema changed while Store analysis was reading data.",
    "STORE_ANALYSIS_SCHEMA_CHANGED",
    {
      category: "user",
      details: {
        beforeSchemaFence: before.schemaFence,
        afterSchemaFence: after.schemaFence,
      },
      suggestion: "Retry the analysis against the new active schema.",
    },
  );
}

function numberFromSql(value: unknown, label: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new TypeGraphError(
      `Store analysis received an invalid ${label} aggregate.`,
      "STORE_ANALYSIS_INVALID_AGGREGATE",
      { category: "system", details: { label, value: String(value) } },
    );
  }
  return converted;
}

function allDeclaredPaths<G extends GraphDef>(graph: G): readonly string[] {
  const paths = new Set<string>();
  for (const registration of Object.values(graph.nodes)) {
    for (const path of declaredPropertyPaths(
      serializeSchemaProperties(registration.type.schema),
    )) {
      paths.add(pathToPointer(path));
    }
  }
  for (const registration of Object.values(graph.edges)) {
    for (const path of declaredPropertyPaths(
      serializeSchemaProperties(registration.type.schema),
    )) {
      paths.add(pathToPointer(path));
    }
  }
  return [...paths].toSorted();
}

function populationSelect<G extends GraphDef>(
  ctx: AnalysisContext<G>,
  entity: KindEntity,
  paths: readonly string[],
  currentTimestamp: string,
): SqlFragment {
  const table =
    entity === "node" ? ctx.schema.nodesTable : ctx.schema.edgesTable;
  const dialect = getDialect(ctx.backend.dialect);
  const temporal = compileTemporalFilter({
    mode: "current",
    currentTimestamp: sql`${currentTimestamp}`,
  });
  const aggregates = paths.flatMap((path, index) => {
    const pointer = path as JsonPointer;
    const presentAlias = sql.identifier(`p${index}_present`);
    const nonNullAlias = sql.identifier(`p${index}_non_null`);
    return [
      sql`SUM(CASE WHEN ${dialect.jsonHasPath(sql`props`, pointer)} THEN 1 ELSE 0 END) AS ${presentAlias}`,
      sql`SUM(CASE WHEN ${dialect.jsonPathIsNotNull(sql`props`, pointer)} THEN 1 ELSE 0 END) AS ${nonNullAlias}`,
    ];
  });
  const aggregateColumns =
    aggregates.length === 0 ? sql`` : sql`, ${sql.join(aggregates, sql`, `)}`;
  return sql`SELECT ${entity} AS entity, kind, COUNT(*) AS row_count${aggregateColumns} FROM ${table} WHERE graph_id = ${ctx.graphId} AND ${temporal} GROUP BY kind`;
}

async function readPopulationRows<G extends GraphDef>(
  ctx: AnalysisContext<G>,
  paths: readonly string[],
): Promise<readonly PopulationRow[]> {
  const currentTimestamp = nowIso();
  const query = sql`${populationSelect(ctx, "node", paths, currentTimestamp)} UNION ALL ${populationSelect(ctx, "edge", paths, currentTimestamp)} ORDER BY entity, kind`;
  return ctx.backend.execute<PopulationRow>(asCompiledRowsSql(query));
}

function populationForKind(
  entity: KindEntity,
  kind: string,
  schema: z.ZodType,
  paths: readonly string[],
  rows: readonly PopulationRow[],
): KindPopulationStatistics {
  const row = rows.find(
    (candidate) => candidate.entity === entity && candidate.kind === kind,
  );
  const count = row === undefined ? 0 : numberFromSql(row.row_count, "count");
  const declaredPaths = new Set(
    declaredPropertyPaths(serializeSchemaProperties(schema)).map((path) =>
      pathToPointer(path),
    ),
  );
  return {
    entity,
    kind,
    count,
    properties: paths.flatMap((path, index) => {
      if (!declaredPaths.has(path)) return [];
      const presentCount =
        row === undefined ? 0 : (
          numberFromSql(row[`p${index}_present`], "present count")
        );
      const nonNullCount =
        row === undefined ? 0 : (
          numberFromSql(row[`p${index}_non_null`], "non-null count")
        );
      return [
        {
          path,
          presentCount,
          nullCount: presentCount - nonNullCount,
          nonNullCount,
          coverage: count === 0 ? 0 : nonNullCount / count,
        },
      ];
    }),
  };
}

function zodFailures(
  entity: KindEntity,
  kind: string,
  schema: z.ZodType,
  rows: readonly ValidationRow[],
): readonly StoreValidationFailure[] {
  const failures: StoreValidationFailure[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(rowPropsToObject(row.props));
    if (parsed.success) continue;
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") continue;
      const path: string[] = [];
      for (const segment of issue.path) path.push(String(segment));
      failures.push({
        entity,
        kind,
        id: row.id,
        path: pathToPointer(path),
        ...(path[0] === undefined ? {} : { property: path[0] }),
        code: issue.code,
        reason: issue.message,
      });
    }
  }
  return failures;
}

async function readValidationRows<G extends GraphDef>(
  ctx: AnalysisContext<G>,
  options: Pick<ValidateStoreOptions, "entity" | "kind">,
  afterId: string | undefined,
  limit: number,
): Promise<readonly ValidationRow[]> {
  const table =
    options.entity === "node" ? ctx.schema.nodesTable : ctx.schema.edgesTable;
  const temporal = compileTemporalFilter({
    mode: "current",
    currentTimestamp: sql`${nowIso()}`,
  });
  const keyset = afterId === undefined ? sql`` : sql` AND id > ${afterId}`;
  const query = sql`SELECT id, props FROM ${table} WHERE graph_id = ${ctx.graphId} AND kind = ${options.kind} AND ${temporal}${keyset} ORDER BY id LIMIT ${limit}`;
  return ctx.backend.execute<ValidationRow>(asCompiledRowsSql(query));
}

export async function describeStore<G extends GraphDef>(
  ctx: AnalysisContext<G>,
): Promise<StoreDescription> {
  const before = await schemaCoordinateFor(ctx);
  const paths = allDeclaredPaths(ctx.graph);
  const rows = await readPopulationRows(ctx, paths);
  const after = await schemaCoordinateFor(ctx);
  assertStableSchema(before, after);
  const nodes = Object.entries(ctx.graph.nodes).map(([kind, registration]) =>
    populationForKind("node", kind, registration.type.schema, paths, rows),
  );
  const edges = Object.entries(ctx.graph.edges).map(([kind, registration]) =>
    populationForKind("edge", kind, registration.type.schema, paths, rows),
  );
  return {
    schema: ctx.introspect(),
    statistics: { snapshot: before, nodes, edges },
  };
}

export async function validateStore<G extends GraphDef>(
  ctx: AnalysisContext<G>,
  options: ValidateStoreOptions,
): Promise<StoreValidationPage> {
  const pageSize = normalizePageSize(options.pageSize);
  const cursor =
    options.cursor === undefined ?
      undefined
    : decodeValidationCursor(options.cursor);
  if (
    cursor !== undefined &&
    (cursor.entity !== options.entity || cursor.kind !== options.kind)
  ) {
    throw new ValidationError(
      "validateStore cursor scope does not match the request.",
      {
        issues: [
          {
            path: "cursor",
            message: `Expected ${options.entity} kind ${options.kind}`,
          },
        ],
      },
    );
  }
  const registration =
    options.entity === "node" ?
      ctx.graph.nodes[options.kind]
    : ctx.graph.edges[options.kind];
  if (registration === undefined) {
    throw new ValidationError(
      `Unknown ${options.entity} kind "${options.kind}".`,
      {
        issues: [{ path: "kind", message: `Unknown ${options.entity} kind` }],
      },
    );
  }

  const before = await schemaCoordinateFor(ctx);
  if (cursor !== undefined && cursor.schemaFence !== before.schemaFence) {
    throw new StoreAnalysisCursorStaleError({
      entity: options.entity,
      kind: options.kind,
      expectedSchemaFence: cursor.schemaFence,
      actualSchemaFence: before.schemaFence,
    });
  }
  const fetched = await readValidationRows(
    ctx,
    options,
    cursor?.afterId,
    pageSize + 1,
  );
  const rows = fetched.slice(0, pageSize);
  const after = await schemaCoordinateFor(ctx);
  assertStableSchema(before, after);
  const hasMore = fetched.length > rows.length;
  const lastRow = rows.at(-1);
  return {
    snapshot: before,
    scannedCount: rows.length,
    violations: zodFailures(
      options.entity,
      options.kind,
      registration.type.schema,
      rows,
    ),
    ...(hasMore && lastRow !== undefined ?
      {
        nextCursor: encodeValidationCursor({
          entity: options.entity,
          kind: options.kind,
          schemaFence: before.schemaFence,
          afterId: lastRow.id,
        }),
      }
    : {}),
  };
}
