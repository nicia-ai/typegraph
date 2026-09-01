/**
 * Snapshot-consistent whole-store description and declared-schema validation.
 *
 * Both operations deliberately read through one repeatable-read transaction.
 * Their cost is independent of vocabulary size: description submits one node
 * scan and one edge scan, while validation submits one scan for the selected
 * kind. Aggregation and Zod diagnostics happen in-process so every SQL backend
 * shares one semantic owner.
 */
import { type z } from "zod";

import type { GraphBackend, TransactionBackend } from "../backend/types";
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
import { sql } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { serializeSchemaProperties } from "../schema/serializer";
import type { JsonSchema } from "../schema/types";
import { nowIso } from "../utils/date";
import { sha256Hex } from "../utils/hash";
import { createDataKeyedBag } from "../utils/object";
import type { SchemaIntrospection } from "./introspect";

const DEFAULT_VALIDATION_PAGE_SIZE = 100;
const MAX_VALIDATION_PAGE_SIZE = 1000;
const VALIDATION_CURSOR_COLUMNS = [
  "typegraph.validateStore.entity",
  "typegraph.validateStore.kind",
  "typegraph.validateStore.schemaFence",
  "typegraph.validateStore.dataFence",
  "typegraph.validateStore.validTime",
  "typegraph.validateStore.offset",
] as const;

type AnalysisRow = Readonly<{
  kind: string;
  id: string;
  props: unknown;
  valid_from: string | undefined;
  valid_to: string | undefined;
  created_at: string;
  updated_at: string;
  deleted_at: string | undefined;
}>;

export type StoreAnalysisSnapshot = Readonly<{
  /** Active persisted schema version, when this graph has one. */
  schemaVersion?: number;
  /** Active persisted schema hash, when this graph has one. */
  schemaHash?: string;
  /** Fingerprint of both the Store's declarations and active schema row. */
  schemaFence: string;
  /** Fingerprint of every row in this operation's data scope. */
  dataFence: string;
  /** Valid-time instant at which current-row membership was evaluated. */
  validTime: string;
}>;

export type PropertyPopulationStatistics = Readonly<{
  /** RFC 6901 JSON pointer to one declared property. */
  path: string;
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
  /** Number of violations to return. Default 100; maximum 1000. */
  pageSize?: number;
  /** Opaque cursor returned by the preceding page. */
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
  snapshot: StoreAnalysisSnapshot;
  violations: readonly StoreValidationFailure[];
  nextCursor?: string;
}>;

export type StoreAnalysisCursorStaleErrorDetails = Readonly<{
  entity: KindEntity;
  kind: string;
  expectedSchemaFence: string;
  actualSchemaFence: string;
  expectedDataFence: string;
  actualDataFence: string;
}>;

/** A validation cursor cannot be resumed against a different snapshot. */
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
          "Restart validateStore() without a cursor to establish a new snapshot.",
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
  dataFence: string;
  validTime: string;
  offset: number;
}>;

function parseProps(props: unknown): Readonly<Record<string, unknown>> {
  if (typeof props === "string") {
    const parsed: unknown = JSON.parse(props);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Readonly<Record<string, unknown>>;
    }
    return {};
  }
  if (typeof props === "object" && props !== null && !Array.isArray(props)) {
    return props as Readonly<Record<string, unknown>>;
  }
  return {};
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalValue(entry));
  }
  if (typeof value !== "object" || value === null) return value;
  const result = createDataKeyedBag<unknown>();
  for (const key of Object.keys(value).toSorted()) {
    result[key] = canonicalValue(
      (value as Readonly<Record<string, unknown>>)[key],
    );
  }
  return result;
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

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

function valueAtPath(
  props: Readonly<Record<string, unknown>>,
  path: readonly string[],
): unknown {
  let current: unknown = props;
  for (const segment of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return current;
}

function pathToPointer(path: readonly PropertyKey[]): string {
  return path
    .map((segment) => `/${escapePointerSegment(String(segment))}`)
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
  const [entity, kind, schemaFence, dataFence, validTime, offset] =
    decoded.vals;
  if (
    (entity !== "node" && entity !== "edge") ||
    typeof kind !== "string" ||
    typeof schemaFence !== "string" ||
    typeof dataFence !== "string" ||
    typeof validTime !== "string" ||
    typeof offset !== "number" ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    throw new ValidationError("Invalid validateStore cursor payload.", {
      issues: [{ path: "cursor", message: "Cursor payload is malformed" }],
    });
  }
  return { entity, kind, schemaFence, dataFence, validTime, offset };
}

function encodeValidationCursor(cursor: ValidationCursor): string {
  return encodeCursor({
    v: 1,
    d: "f",
    cols: VALIDATION_CURSOR_COLUMNS,
    vals: [
      cursor.entity,
      cursor.kind,
      cursor.schemaFence,
      cursor.dataFence,
      cursor.validTime,
      cursor.offset,
    ],
  });
}

async function readRows(
  backend: TransactionBackend,
  schema: SqlSchema,
  graphId: string,
  entity: KindEntity,
  validTime: string,
  kind?: string,
): Promise<readonly AnalysisRow[]> {
  const table = entity === "node" ? schema.nodesTable : schema.edgesTable;
  const temporal = compileTemporalFilter({
    mode: "current",
    currentTimestamp: sql`${validTime}`,
  });
  const kindFilter = kind === undefined ? sql`` : sql` AND kind = ${kind}`;
  const query = sql`SELECT kind, id, props, valid_from, valid_to, created_at, updated_at, deleted_at FROM ${table} WHERE graph_id = ${graphId} AND ${temporal}${kindFilter} ORDER BY kind, id`;
  return backend.execute<AnalysisRow>(asCompiledRowsSql(query));
}

async function schemaFenceFor<G extends GraphDef>(
  ctx: AnalysisContext<G>,
  backend: TransactionBackend,
): Promise<
  Readonly<{
    schemaVersion?: number;
    schemaHash?: string;
    schemaFence: string;
  }>
> {
  const active = await backend.getActiveSchema(ctx.graphId);
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
    JSON.stringify({
      active:
        active === undefined ? undefined : [active.version, active.schema_hash],
      declaration: canonicalValue(declarationShape),
    }),
    16,
  );
  return {
    ...(active === undefined ? {} : { schemaVersion: active.version }),
    ...(active === undefined ? {} : { schemaHash: active.schema_hash }),
    schemaFence,
  };
}

async function dataFenceFor(
  rows: readonly AnalysisRow[],
  scope: string,
): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      scope,
      rows: rows.map((row) => ({
        kind: row.kind,
        id: row.id,
        props: canonicalValue(parseProps(row.props)),
        validFrom: row.valid_from,
        validTo: row.valid_to,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
      })),
    }),
    16,
  );
}

function populationForKind(
  entity: KindEntity,
  kind: string,
  schema: z.ZodType,
  rows: readonly AnalysisRow[],
): KindPopulationStatistics {
  const kindRows = rows.filter((row) => row.kind === kind);
  const paths = declaredPropertyPaths(serializeSchemaProperties(schema));
  return {
    entity,
    kind,
    count: kindRows.length,
    properties: paths.map((path) => {
      const nonNullCount = kindRows.filter((row) => {
        const value = valueAtPath(parseProps(row.props), path);
        return value !== undefined && value !== null;
      }).length;
      return {
        path: pathToPointer(path),
        nonNullCount,
        coverage: kindRows.length === 0 ? 0 : nonNullCount / kindRows.length,
      };
    }),
  };
}

function zodFailures(
  entity: KindEntity,
  kind: string,
  schema: z.ZodType,
  rows: readonly AnalysisRow[],
): readonly StoreValidationFailure[] {
  const failures: StoreValidationFailure[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(parseProps(row.props));
    if (parsed.success) continue;
    for (const issue of parsed.error.issues) {
      // Undeclared fields are healthy semi-structured state even when a
      // consumer authored a strict Zod object. Every other Zod issue is a
      // rule the declared schema actually owns.
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

function requireSnapshotBackend<G extends GraphDef>(
  ctx: AnalysisContext<G>,
): void {
  if (ctx.backend.capabilities.execution.interactiveTransactions) return;
  throw new TypeGraphError(
    "Store analysis requires a backend that can hold a repeatable-read snapshot.",
    "STORE_ANALYSIS_SNAPSHOT_UNSUPPORTED",
    {
      category: "system",
      details: { dialect: ctx.backend.dialect },
      suggestion:
        "Use a transactional SQLite or PostgreSQL backend for describe() and validateStore().",
    },
  );
}

export async function describeStore<G extends GraphDef>(
  ctx: AnalysisContext<G>,
): Promise<StoreDescription> {
  requireSnapshotBackend(ctx);
  return ctx.backend.transaction(
    async (backend) => {
      const validTime = nowIso();
      const [schemaCoordinate, nodeRows, edgeRows] = await Promise.all([
        schemaFenceFor(ctx, backend),
        readRows(backend, ctx.schema, ctx.graphId, "node", validTime),
        readRows(backend, ctx.schema, ctx.graphId, "edge", validTime),
      ]);
      const dataFence = await sha256Hex(
        JSON.stringify({
          nodes: await dataFenceFor(nodeRows, "node"),
          edges: await dataFenceFor(edgeRows, "edge"),
        }),
        16,
      );
      const nodes = Object.entries(ctx.graph.nodes).map(
        ([kind, registration]) =>
          populationForKind("node", kind, registration.type.schema, nodeRows),
      );
      const edges = Object.entries(ctx.graph.edges).map(
        ([kind, registration]) =>
          populationForKind("edge", kind, registration.type.schema, edgeRows),
      );
      return {
        schema: ctx.introspect(),
        statistics: {
          snapshot: { ...schemaCoordinate, dataFence, validTime },
          nodes,
          edges,
        },
      };
    },
    { isolationLevel: "repeatable_read", accessMode: "read_only" },
  );
}

export async function validateStore<G extends GraphDef>(
  ctx: AnalysisContext<G>,
  options: ValidateStoreOptions,
): Promise<StoreValidationPage> {
  requireSnapshotBackend(ctx);
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
  const validTime = cursor?.validTime ?? nowIso();
  return ctx.backend.transaction(
    async (backend) => {
      const [schemaCoordinate, rows] = await Promise.all([
        schemaFenceFor(ctx, backend),
        readRows(
          backend,
          ctx.schema,
          ctx.graphId,
          options.entity,
          validTime,
          options.kind,
        ),
      ]);
      const dataFence = await dataFenceFor(rows, options.entity);
      if (
        cursor !== undefined &&
        (cursor.schemaFence !== schemaCoordinate.schemaFence ||
          cursor.dataFence !== dataFence)
      ) {
        throw new StoreAnalysisCursorStaleError({
          entity: options.entity,
          kind: options.kind,
          expectedSchemaFence: cursor.schemaFence,
          actualSchemaFence: schemaCoordinate.schemaFence,
          expectedDataFence: cursor.dataFence,
          actualDataFence: dataFence,
        });
      }
      const failures = zodFailures(
        options.entity,
        options.kind,
        registration.type.schema,
        rows,
      );
      const offset = cursor?.offset ?? 0;
      const violations = failures.slice(offset, offset + pageSize);
      const nextOffset = offset + violations.length;
      const snapshot = { ...schemaCoordinate, dataFence, validTime };
      return {
        snapshot,
        violations,
        ...(nextOffset >= failures.length ?
          {}
        : {
            nextCursor: encodeValidationCursor({
              entity: options.entity,
              kind: options.kind,
              schemaFence: schemaCoordinate.schemaFence,
              dataFence,
              validTime,
              offset: nextOffset,
            }),
          }),
      };
    },
    { isolationLevel: "repeatable_read", accessMode: "read_only" },
  );
}
