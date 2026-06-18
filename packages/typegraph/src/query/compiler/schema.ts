/**
 * SQL Schema Configuration for Query Compilation
 *
 * Provides table and column identifiers that the query compiler uses.
 * This allows the compiler to work with custom table names instead of
 * hard-coded defaults.
 */
import { type SQL, sql } from "drizzle-orm";

import { type VectorIndexType, type VectorMetric } from "../../backend/types";
import { MAX_PG_IDENTIFIER_LENGTH } from "../../constants";
import { ConfigurationError } from "../../errors";

/**
 * Table names for TypeGraph SQL schema.
 *
 * Carries every customizable physical-table name the backend exposes,
 * including the secondary tables (`uniques`) that the query compiler
 * itself doesn't reference but `materializeRemovals` and other
 * cleanup paths need to address by name. Backends without a
 * `uniques` table (custom embeddings-only stores) leave it as the
 * default — the cleanup path is a no-op for kinds with no unique
 * rows.
 */
export type SqlTableNames = Readonly<{
  /** Nodes table name (default: "typegraph_nodes") */
  nodes: string;
  /** Edges table name (default: "typegraph_edges") */
  edges: string;
  /** Recorded node relation table name (default: "typegraph_recorded_nodes") */
  recordedNodes?: string | undefined;
  /** Recorded edge relation table name (default: "typegraph_recorded_edges") */
  recordedEdges?: string | undefined;
  /** Recorded-time commit clock table name (default: "typegraph_recorded_clock") */
  recordedClock?: string | undefined;
  /** Node fulltext table name (default: "typegraph_node_fulltext") */
  fulltext: string;
  /** Node uniques table name (default: "typegraph_node_uniques") */
  uniques: string;
}>;

export type ResolvedSqlTableNames = Readonly<{
  /** Nodes table name */
  nodes: string;
  /** Edges table name */
  edges: string;
  /** Recorded node relation table name */
  recordedNodes: string;
  /** Recorded edge relation table name */
  recordedEdges: string;
  /** Recorded-time commit clock table name */
  recordedClock: string;
  /** Node fulltext table name */
  fulltext: string;
  /** Node uniques table name */
  uniques: string;
}>;

type SqlSchemaFields = Readonly<{
  /** Table names */
  tables: ResolvedSqlTableNames;
  /** Get a SQL reference to the nodes table */
  nodesTable: SQL;
  /** Get a SQL reference to the edges table */
  edgesTable: SQL;
  /** Get a SQL reference to the recorded node relation */
  recordedNodesTable: SQL;
  /** Get a SQL reference to the recorded edge relation */
  recordedEdgesTable: SQL;
  /** Get a SQL reference to the recorded-time commit clock */
  recordedClockTable: SQL;
  /** Get a SQL reference to the fulltext table */
  fulltextTable: SQL;
}>;

/**
 * SQL schema configuration for query compilation.
 * Contains table identifiers and utility methods for generating SQL references.
 *
 * Branded and frozen by {@link createSqlSchema}; callers should not construct
 * schema-shaped objects by hand.
 */
export type SqlSchema = SqlSchemaDescriptor;

class SqlSchemaDescriptor implements SqlSchemaFields {
  // Private field gives SqlSchema nominal identity; runtime checks use instanceof.
  readonly #brand = true;
  readonly tables: ResolvedSqlTableNames;
  readonly nodesTable: SQL;
  readonly edgesTable: SQL;
  readonly recordedNodesTable: SQL;
  readonly recordedEdgesTable: SQL;
  readonly recordedClockTable: SQL;
  readonly fulltextTable: SQL;

  constructor(fields: SqlSchemaFields) {
    this.tables = fields.tables;
    this.nodesTable = fields.nodesTable;
    this.edgesTable = fields.edgesTable;
    this.recordedNodesTable = fields.recordedNodesTable;
    this.recordedEdgesTable = fields.recordedEdgesTable;
    this.recordedClockTable = fields.recordedClockTable;
    this.fulltextTable = fields.fulltextTable;
    void this.#brand;
    Object.freeze(this);
  }
}

/**
 * Default table names matching the standard TypeGraph schema.
 */
const DEFAULT_TABLE_NAMES: ResolvedSqlTableNames = {
  nodes: "typegraph_nodes",
  edges: "typegraph_edges",
  recordedNodes: "typegraph_recorded_nodes",
  recordedEdges: "typegraph_recorded_edges",
  recordedClock: "typegraph_recorded_clock",
  fulltext: "typegraph_node_fulltext",
  uniques: "typegraph_node_uniques",
};

function resolveTableNames(
  names: Partial<SqlTableNames>,
): ResolvedSqlTableNames {
  return {
    nodes: names.nodes ?? DEFAULT_TABLE_NAMES.nodes,
    edges: names.edges ?? DEFAULT_TABLE_NAMES.edges,
    recordedNodes: names.recordedNodes ?? DEFAULT_TABLE_NAMES.recordedNodes,
    recordedEdges: names.recordedEdges ?? DEFAULT_TABLE_NAMES.recordedEdges,
    recordedClock: names.recordedClock ?? DEFAULT_TABLE_NAMES.recordedClock,
    fulltext: names.fulltext ?? DEFAULT_TABLE_NAMES.fulltext,
    uniques: names.uniques ?? DEFAULT_TABLE_NAMES.uniques,
  };
}

/**
 * Regex for valid SQL identifiers.
 * Must start with a letter or underscore.
 * Can contain letters, digits, underscores, and dollar signs.
 * Dollar signs are a PostgreSQL extension but commonly supported.
 */
const VALID_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_$]*$/i;

/**
 * Validates that a table name is a valid SQL identifier.
 *
 * @throws Error if the table name is invalid
 */
function validateTableName(name: string, label: string): void {
  if (!name || name.length === 0) {
    throw new ConfigurationError(`${label} table name cannot be empty`);
  }
  if (name.length > MAX_PG_IDENTIFIER_LENGTH) {
    throw new ConfigurationError(
      `${label} table name exceeds maximum length of ${MAX_PG_IDENTIFIER_LENGTH} characters`,
    );
  }
  if (!VALID_IDENTIFIER_PATTERN.test(name)) {
    throw new ConfigurationError(
      `${label} table name "${name}" is not a valid SQL identifier. ` +
        `Table names must start with a letter or underscore and contain only letters, digits, underscores, or dollar signs.`,
    );
  }
}

/**
 * Quotes a SQL identifier using ANSI SQL standard double quotes.
 * Escapes any embedded double quotes by doubling them.
 *
 * This works for both SQLite and PostgreSQL.
 */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function freezeSqlSchema(fields: SqlSchemaFields): SqlSchema {
  return new SqlSchemaDescriptor(fields);
}

function isSqlSchema(schema: unknown): schema is SqlSchema {
  return schema instanceof SqlSchemaDescriptor && Object.isFrozen(schema);
}

export function requireSqlSchema(
  schema: unknown,
  surface = "SqlSchema",
): SqlSchema {
  if (isSqlSchema(schema)) return schema;
  throw new ConfigurationError(
    `${surface} must be created with createSqlSchema(...).`,
    { code: "INVALID_SQL_SCHEMA", surface },
    {
      suggestion:
        "Pass the result of createSqlSchema(...) instead of a plain schema-shaped object.",
    },
  );
}

/**
 * Creates a SqlSchema configuration from table names.
 *
 * Table names are validated to ensure they are valid SQL identifiers.
 * This prevents SQL injection and ensures compatibility across databases.
 *
 * @param names - Optional custom table names (defaults to standard names)
 * @returns SqlSchema configuration for query compilation
 * @throws Error if any table name is invalid
 *
 * @example
 * ```typescript
 * // Use default table names
 * const schema = createSqlSchema();
 *
 * // Use custom table names
 * const schema = createSqlSchema({
 *   nodes: "myapp_nodes",
 *   edges: "myapp_edges",
 *   fulltext: "myapp_fulltext",
 * });
 * ```
 */
export function createSqlSchema(names: Partial<SqlTableNames> = {}): SqlSchema {
  const tables = resolveTableNames(names);

  // Validate all table names
  validateTableName(tables.nodes, "nodes");
  validateTableName(tables.edges, "edges");
  validateTableName(tables.recordedNodes, "recordedNodes");
  validateTableName(tables.recordedEdges, "recordedEdges");
  validateTableName(tables.recordedClock, "recordedClock");
  validateTableName(tables.fulltext, "fulltext");
  validateTableName(tables.uniques, "uniques");

  return freezeSqlSchema({
    tables: Object.freeze(tables),
    nodesTable: sql.raw(quoteIdentifier(tables.nodes)),
    edgesTable: sql.raw(quoteIdentifier(tables.edges)),
    recordedNodesTable: sql.raw(quoteIdentifier(tables.recordedNodes)),
    recordedEdgesTable: sql.raw(quoteIdentifier(tables.recordedEdges)),
    recordedClockTable: sql.raw(quoteIdentifier(tables.recordedClock)),
    fulltextTable: sql.raw(quoteIdentifier(tables.fulltext)),
  });
}

/**
 * The recorded/system-time relation a read coordinate may reconstruct from.
 *
 * TypeGraph's built-in capture relation is bound by `createStore(..., {
 * history: true })`. Hosts can also bind externally populated row-compatible
 * recorded relations through `recordedRelation({ schema })`. Keeping both as
 * explicit values separates the read contract from the write-capture mechanism
 * so future external/TMS-owned recorded relations can feed the same query
 * machinery without changing StoreView or ReadCoordinate.
 */
const EXTERNAL_RECORDED_READ_SOURCE: unique symbol = Symbol(
  "ExternalRecordedReadSource",
);

export type ExternalRecordedReadSource = Readonly<{
  source: "external";
  schema: SqlSchema;
  [EXTERNAL_RECORDED_READ_SOURCE]: true;
}>;

type ExternalRecordedReadSourceCandidate = Readonly<{
  source?: unknown;
  schema?: unknown;
  [EXTERNAL_RECORDED_READ_SOURCE]?: unknown;
}>;

const TYPEGRAPH_RECORDED_READ_SOURCE: unique symbol = Symbol(
  "TypeGraphRecordedReadSource",
);

export type TypeGraphRecordedReadSource = Readonly<{
  source: "typegraph-capture";
  schema: SqlSchema;
  [TYPEGRAPH_RECORDED_READ_SOURCE]: true;
}>;

type RecordedReadSource =
  | ExternalRecordedReadSource
  | TypeGraphRecordedReadSource;

export type RecordedReadBinding = RecordedReadSource;

export type RecordedRelationOptions = Readonly<{
  schema: SqlSchema;
}>;

export function recordedRelation(
  options: RecordedRelationOptions,
): ExternalRecordedReadSource {
  const schema = requireSqlSchema(options.schema, "recordedRelation schema");
  return Object.freeze({
    source: "external",
    schema,
    [EXTERNAL_RECORDED_READ_SOURCE]: true as const,
  });
}

export function requireExternalRecordedReadSource(
  source: unknown,
): ExternalRecordedReadSource | undefined {
  if (source === undefined) return undefined;
  if (isExternalRecordedReadSource(source)) return source;
  throw new ConfigurationError(
    "recordedRead must be created with recordedRelation({ schema }).",
    { code: "INVALID_RECORDED_READ_SOURCE" },
    {
      suggestion:
        "Pass { recordedRead: recordedRelation({ schema }) } for an externally populated recorded relation. Use { history: true } when TypeGraph should capture writes.",
    },
  );
}

function isExternalRecordedReadSource(
  source: unknown,
): source is ExternalRecordedReadSource {
  if (typeof source !== "object" || source === null) return false;
  const candidate = source as ExternalRecordedReadSourceCandidate;
  return (
    candidate.source === "external" &&
    candidate[EXTERNAL_RECORDED_READ_SOURCE] === true &&
    isSqlSchema(candidate.schema) &&
    Object.isFrozen(candidate)
  );
}

export function createRecordedReadBinding(
  schema: SqlSchema,
): TypeGraphRecordedReadSource {
  const readSchema = requireSqlSchema(schema, "recorded read binding schema");
  return Object.freeze({
    source: "typegraph-capture",
    schema: readSchema,
    [TYPEGRAPH_RECORDED_READ_SOURCE]: true as const,
  });
}

export function requireRecordedReadBinding(
  binding: unknown,
  surface: string,
): RecordedReadBinding {
  if (isRecordedReadBinding(binding)) return binding;
  if (binding !== undefined) {
    throw new ConfigurationError(
      "Recorded-time reads require a recorded read relation created by TypeGraph.",
      { code: "INVALID_RECORDED_READ_BINDING", surface },
      {
        suggestion:
          "Use createStore(graph, backend, { history: true }) or { recordedRead: recordedRelation({ schema }) } instead of passing a plain object.",
      },
    );
  }
  throw new ConfigurationError(
    "Recorded-time reads require a recorded read relation.",
    { code: "RECORDED_READ_REQUIRES_BINDING", surface },
    {
      suggestion:
        "Create the store with createStore(graph, backend, { history: true }) to bind TypeGraph's built-in captured relation, or pass { recordedRead: recordedRelation({ schema }) } for an externally populated recorded relation.",
    },
  );
}

type TypeGraphRecordedReadSourceCandidate = Readonly<{
  source?: unknown;
  schema?: unknown;
  [TYPEGRAPH_RECORDED_READ_SOURCE]?: unknown;
}>;

function isTypeGraphRecordedReadSource(
  source: unknown,
): source is TypeGraphRecordedReadSource {
  if (typeof source !== "object" || source === null) return false;
  const candidate = source as TypeGraphRecordedReadSourceCandidate;
  return (
    candidate.source === "typegraph-capture" &&
    candidate[TYPEGRAPH_RECORDED_READ_SOURCE] === true &&
    isSqlSchema(candidate.schema) &&
    Object.isFrozen(candidate)
  );
}

function isRecordedReadBinding(
  binding: unknown,
): binding is RecordedReadBinding {
  return (
    isExternalRecordedReadSource(binding) ||
    isTypeGraphRecordedReadSource(binding)
  );
}

/**
 * Returns a schema view whose primary node/edge sources are the recorded-time
 * relations. The recorded relations are row-compatible with the live tables
 * for every column the query compiler, subgraph extractor, and algorithms
 * already read; the temporal filter adds the `recorded_from/to` predicate.
 */
export function recordedReadSqlSchema(binding: RecordedReadBinding): SqlSchema {
  const { schema } = requireRecordedReadBinding(
    binding,
    "recorded-read-schema",
  );
  return freezeSqlSchema({
    tables: schema.tables,
    nodesTable: schema.recordedNodesTable,
    edgesTable: schema.recordedEdgesTable,
    recordedNodesTable: schema.recordedNodesTable,
    recordedEdgesTable: schema.recordedEdgesTable,
    recordedClockTable: schema.recordedClockTable,
    fulltextTable: schema.fulltextTable,
  });
}

/**
 * Resolves the read schema for a coordinate: the live schema when no recorded
 * pin is set, or the recorded-relation view when `recordedAsOf` is present. The
 * single place every read path decides whether to source the recorded tables.
 */
export function recordedReadSchemaFor(
  schema: SqlSchema,
  recordedAsOf: string | undefined,
  binding: RecordedReadBinding | undefined,
  surface: string,
): SqlSchema {
  const baseSchema = requireSqlSchema(schema, `${surface} schema`);
  if (recordedAsOf === undefined) return baseSchema;
  return recordedReadSqlSchema(requireRecordedReadBinding(binding, surface));
}

/**
 * Default SqlSchema using standard TypeGraph table names.
 */
export const DEFAULT_SQL_SCHEMA: SqlSchema = createSqlSchema();

/**
 * The compiler's resolved view of one declared embedding field — the
 * `(dimensions, metric, indexType)` a {@link VectorStrategy} needs to
 * name and scan the field's typed per-`(kind, field)` storage. Sourced
 * from the registered node schema's `embedding()` declaration when the
 * store builds its compile options.
 */
export type VectorSlotDescriptor = Readonly<{
  dimensions: number;
  metric: VectorMetric;
  indexType: VectorIndexType;
}>;

/**
 * Map of declared embedding slots keyed by {@link vectorSlotKey} -
 * `"<nodeKind>\0<fieldPath>"` (NUL-separated). Carries every `(concrete kind,
 * fieldPath)` that declares an embedding field, so the compiler's
 * `field.similarTo(...)` CTE can UNION ALL the per-field tables for the
 * kinds in an alias that actually declare the field (only
 * `includeSubClasses` yields more than one).
 */
export type VectorSlotMap = ReadonlyMap<string, VectorSlotDescriptor>;

/** NUL-delimited composite key for {@link VectorSlotMap}. */
export function vectorSlotKey(nodeKind: string, fieldPath: string): string {
  return `${nodeKind}\u0000${fieldPath}`;
}

/**
 * CTE aliases used by the standard query emitter. Joining on these names
 * across multiple builder files is fragile when typed as raw strings —
 * import these constants instead.
 */
export const ALIAS_CTE_PREFIX = "cte_" as const;
export const EMBEDDINGS_CTE_ALIAS = "cte_embeddings" as const;
export const FULLTEXT_CTE_ALIAS = "cte_fulltext" as const;
export const HYBRID_CANDIDATES_CTE_ALIAS = "cte_relevance_candidates" as const;
