import { type z } from "zod";

import {
  IDENTIFIER_COMPONENT_MAX_LENGTH,
  MAX_PG_IDENTIFIER_LENGTH,
  TRUNCATED_IDENTIFIER_MAX_LENGTH,
} from "../constants";
import {
  type AnyEdgeType,
  type KindEntity,
  type NodeType,
} from "../core/types";
import { type ValueType } from "../query/ast";
import { resolveFieldTypeInfoAtJsonPointer } from "../query/field-type-info";
import {
  type JsonPointer,
  jsonPointer,
  type JsonPointerInput,
  type JsonPointerSegment,
  normalizeJsonPointer,
  parseJsonPointer,
} from "../query/json-pointer";
import {
  createSchemaIntrospector,
  type FieldTypeInfo,
} from "../query/schema-introspector";
import { EDGE_META_KEYS, NODE_META_KEYS } from "../system-fields";
import { fnv1aBase36 } from "../utils/hash";
import { getNodeScopeColumns } from "./compiler";
import {
  type EdgeIndexConfig,
  type EdgeIndexDeclaration,
  type EdgeIndexDirection,
  type EdgeIndexWhereBuilder,
  type IndexFieldInput,
  type IndexScope,
  type IndexWhereExpression,
  type IndexWhereFieldBuilder,
  type IndexWhereLiteral,
  type IndexWhereOp,
  type IndexWhereOperand,
  type NodeIndexConfig,
  type NodeIndexDeclaration,
  type NodeIndexWhereBuilder,
  type RelationalIndexMethod,
  type SystemColumnName,
} from "./types";

const NODE_KEY_SYSTEM_COLUMNS: ReadonlySet<SystemColumnName> = new Set([
  "graph_id",
  "kind",
  "id",
  "deleted_at",
  "valid_from",
  "valid_to",
  "created_at",
  "updated_at",
  "version",
]);

// ============================================================
// Public API
// ============================================================

export function defineNodeIndex<N extends NodeType>(
  node: N,
  config: NodeIndexConfig<N>,
): NodeIndexDeclaration {
  const scope = config.scope ?? "graphAndKind";
  const unique = config.unique ?? false;
  const keySystemColumns = normalizeKeySystemColumnsOrThrow(
    config.keySystemColumns ?? [],
    scope,
  );

  const schemaIntrospector = createSchemaIntrospector(
    new Map([[node.kind, { schema: node.schema }]]),
  );

  const { pointers: fields, valueTypes: fieldValueTypes } =
    normalizeNodeIndexFieldsOrThrow(
      node,
      config.fields ?? [],
      schemaIntrospector,
      "fields",
      // GIN containment indexes exist precisely for array/object fields,
      // which the btree guard otherwise rejects.
      { allowEmpty: true, allowJsonFields: config.method === "gin" },
    );

  const { pointers: coveringFields, valueTypes: coveringFieldValueTypes } =
    normalizeNodeIndexFieldsOrThrow(
      node,
      config.coveringFields ?? [],
      schemaIntrospector,
      "coveringFields",
      { allowEmpty: true },
    );
  assertNoOverlap(fields, coveringFields, "fields", "coveringFields");

  if (
    fields.length === 0 &&
    coveringFields.length === 0 &&
    keySystemColumns.length === 0
  ) {
    throw new Error(
      "Index must declare at least one of fields, coveringFields, or keySystemColumns",
    );
  }

  const where = normalizeWhereInput(config.where, () =>
    createNodeWhereBuilder(node, schemaIntrospector),
  );

  const method = resolveAdvancedIndexMethod(config.method, {
    fieldCount: fields.length,
    fieldValueType: fieldValueTypes[0],
    coveringFieldCount: coveringFields.length,
    keySystemColumnCount: keySystemColumns.length,
    unique,
    hasWhere: where !== undefined,
  });

  const defaultName = generateDefaultIndexName({
    kind: "node",
    kindName: node.kind,
    unique,
    scope,
    direction: "none",
    fields,
    coveringFields,
    keySystemColumns,
  });
  const name =
    config.name ??
    (method === undefined ? defaultName : `${defaultName}_${method}`);

  // `origin` is intentionally omitted: `"compile-time"` is the default
  // and is canonicalized by absence so the serialized form stays
  // byte-identical for legacy graphs. `method` and `keySystemColumns`
  // follow the same rule (absence == "btree" / no system key columns).
  return {
    entity: "node",
    kind: node.kind,
    name,
    fields,
    fieldValueTypes,
    coveringFields,
    coveringFieldValueTypes,
    unique,
    scope,
    where,
    ...(method === undefined ? {} : { method }),
    ...(keySystemColumns.length === 0 ? {} : { keySystemColumns }),
  };
}

/**
 * Validates `keySystemColumns`: must be node system columns (not
 * edge-only `from_kind`/`from_id`/`to_kind`/`to_id`), must not repeat
 * each other, and must not repeat a column `scope` already prefixes the
 * key with.
 */
function normalizeKeySystemColumnsOrThrow(
  columns: readonly SystemColumnName[],
  scope: IndexScope,
): readonly SystemColumnName[] {
  if (columns.length === 0) return [];

  for (const column of columns) {
    if (!NODE_KEY_SYSTEM_COLUMNS.has(column)) {
      throw new Error(
        `Node index keySystemColumns does not support "${column}" (edge-only system column)`,
      );
    }
  }
  assertUnique(columns, "keySystemColumns");

  const scopeColumns = new Set(getNodeScopeColumns(scope));
  for (const column of columns) {
    if (scopeColumns.has(column)) {
      throw new Error(
        `Node index keySystemColumns must not repeat a column already implied by scope "${scope}": "${column}"`,
      );
    }
  }

  return columns;
}

export function defineEdgeIndex<E extends AnyEdgeType>(
  edge: E,
  config: EdgeIndexConfig<E>,
): EdgeIndexDeclaration {
  const scope = config.scope ?? "graphAndKind";
  const unique = config.unique ?? false;
  const direction = config.direction ?? "none";

  const schemaIntrospector = createSchemaIntrospector(
    new Map(),
    new Map([[edge.kind, { schema: edge.schema }]]),
  );

  const { pointers: fields, valueTypes: fieldValueTypes } =
    normalizeEdgeIndexFieldsOrThrow(
      edge,
      config.fields,
      schemaIntrospector,
      "fields",
      { allowEmpty: false, allowJsonFields: config.method === "gin" },
    );

  const { pointers: coveringFields, valueTypes: coveringFieldValueTypes } =
    normalizeEdgeIndexFieldsOrThrow(
      edge,
      config.coveringFields ?? [],
      schemaIntrospector,
      "coveringFields",
      { allowEmpty: true },
    );
  assertNoOverlap(fields, coveringFields, "fields", "coveringFields");

  const where = normalizeWhereInput(config.where, () =>
    createEdgeWhereBuilder(edge, schemaIntrospector),
  );

  const method = resolveAdvancedIndexMethod(config.method, {
    fieldCount: fields.length,
    fieldValueType: fieldValueTypes[0],
    coveringFieldCount: coveringFields.length,
    keySystemColumnCount: 0,
    unique,
    hasWhere: where !== undefined,
  });

  const defaultName = generateDefaultIndexName({
    kind: "edge",
    kindName: edge.kind,
    unique,
    scope,
    direction,
    fields,
    coveringFields,
  });
  const name =
    config.name ??
    (method === undefined ? defaultName : `${defaultName}_${method}`);

  return {
    entity: "edge",
    kind: edge.kind,
    name,
    fields,
    fieldValueTypes,
    coveringFields,
    coveringFieldValueTypes,
    unique,
    scope,
    direction,
    where,
    ...(method === undefined ? {} : { method }),
  };
}

/**
 * Validates and canonicalizes a declaration's index method. `"btree"` (or
 * absent) canonicalizes to `undefined` so serialized declarations and
 * materialization signatures from before `method` existed stay
 * byte-identical. GIN-family methods index one expression and have no
 * ordered key columns, so multi-field, covering, unique, and partial
 * variants are rejected at declaration time rather than failing as
 * confusing DDL errors at materialization time.
 */
function resolveAdvancedIndexMethod(
  method: RelationalIndexMethod | undefined,
  details: Readonly<{
    fieldCount: number;
    fieldValueType: ValueType | undefined;
    coveringFieldCount: number;
    keySystemColumnCount: number;
    unique: boolean;
    hasWhere: boolean;
  }>,
): Exclude<RelationalIndexMethod, "btree"> | undefined {
  const resolved = method ?? "btree";
  if (resolved === "btree") return undefined;
  if (details.fieldCount !== 1) {
    throw new Error(
      `Index method "${resolved}" requires exactly one field (a GIN indexes one expression), got ${details.fieldCount}`,
    );
  }
  // Enforce the field-type contract the methods advertise: gin serves the
  // array containment predicates, trigram serves the string substring /
  // case-insensitive predicates. Anything else (including unresolvable
  // field types) would materialize an index no documented predicate can
  // ever use, so it is rejected here rather than silently costing write
  // amplification for nothing.
  if (resolved === "gin" && details.fieldValueType !== "array") {
    throw new Error(
      details.fieldValueType === "string" ?
        'Index method "gin" serves array containment; for substring or case-insensitive matching on a string field use method: "trigram"'
      : `Index method "gin" requires an array field (it serves the array containment predicates), got field type "${details.fieldValueType ?? "unresolved"}"`,
    );
  }
  if (resolved === "trigram" && details.fieldValueType !== "string") {
    throw new Error(
      details.fieldValueType === "array" ?
        'Index method "trigram" serves substring matching on string fields; for array containment use method: "gin"'
      : `Index method "trigram" requires a string field (it serves substring and case-insensitive matches), got field type "${details.fieldValueType ?? "unresolved"}"`,
    );
  }
  if (details.coveringFieldCount > 0) {
    throw new Error(
      `Index method "${resolved}" does not support coveringFields (GIN indexes cannot serve index-only scans over extra columns)`,
    );
  }
  if (details.keySystemColumnCount > 0) {
    throw new Error(
      `Index method "${resolved}" does not support keySystemColumns (GIN indexes cannot serve index-only scans over extra columns)`,
    );
  }
  if (details.unique) {
    throw new Error(
      `Index method "${resolved}" does not support unique (GIN indexes cannot enforce uniqueness)`,
    );
  }
  if (details.hasWhere) {
    throw new Error(
      `Index method "${resolved}" does not support a partial where clause`,
    );
  }
  return resolved;
}

// ============================================================
// WHERE Builder
// ============================================================

/**
 * The WHERE builder currently only supports top-level fields.
 * Nested field access (e.g., `where.metadata.priority.gt(5)`) is not supported.
 * Use top-level field predicates like `where.status.eq("active")`.
 *
 * For complex nested predicates, use `andWhere()`, `orWhere()`, and `notWhere()`
 * to compose multiple top-level conditions.
 */

function normalizeWhereInput<Builder>(
  input:
    | ((where: Builder) => IndexWhereExpression)
    | IndexWhereExpression
    | undefined,
  createBuilder: () => Builder,
): IndexWhereExpression | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (typeof input === "function") {
    return input(createBuilder());
  }

  return input;
}

type NodeShape = Readonly<Record<string, z.ZodType>>;
type EdgeShape = Readonly<Record<string, z.ZodType>>;

function createNodeWhereBuilder<N extends NodeType>(
  node: N,
  schemaIntrospector: ReturnType<typeof createSchemaIntrospector>,
): NodeIndexWhereBuilder<N> {
  const shape = getSchemaShape(node.schema);
  const system = createSystemColumnMapForNode();

  function getOperand(key: string): IndexWhereOperand {
    const systemColumn = system.get(key);
    if (systemColumn) {
      return {
        __type: "index_operand_system",
        column: systemColumn.column,
        valueType: systemColumn.valueType,
      };
    }

    if (!(key in shape)) {
      throw new Error(
        `Unknown field "${key}" in node index WHERE clause for "${node.kind}"`,
      );
    }

    const info = schemaIntrospector.getFieldTypeInfo(node.kind, key);
    const valueType = info?.valueType;

    return {
      __type: "index_operand_prop",
      field: key,
      valueType,
    };
  }

  return createWhereProxy<NodeIndexWhereBuilder<N>>((key) => getOperand(key));
}

function createEdgeWhereBuilder<E extends AnyEdgeType>(
  edge: E,
  schemaIntrospector: ReturnType<typeof createSchemaIntrospector>,
): EdgeIndexWhereBuilder<E> {
  const shape = getSchemaShape(edge.schema);
  const system = createSystemColumnMapForEdge();

  function getOperand(key: string): IndexWhereOperand {
    const systemColumn = system.get(key);
    if (systemColumn) {
      return {
        __type: "index_operand_system",
        column: systemColumn.column,
        valueType: systemColumn.valueType,
      };
    }

    if (!(key in shape)) {
      throw new Error(
        `Unknown field "${key}" in edge index WHERE clause for "${edge.kind}"`,
      );
    }

    const info = schemaIntrospector.getEdgeFieldTypeInfo(edge.kind, key);
    const valueType = info?.valueType;

    return {
      __type: "index_operand_prop",
      field: key,
      valueType,
    };
  }

  return createWhereProxy<EdgeIndexWhereBuilder<E>>((key) => getOperand(key));
}

function createWhereProxy<TBuilder extends object>(
  getOperand: (key: string) => IndexWhereOperand,
): TBuilder {
  return new Proxy(Object.create(null) as TBuilder, {
    get: (_target, property: string | symbol) => {
      if (typeof property !== "string") return;
      if (property === "then") return;
      if (property === "toJSON") return;

      const operand = getOperand(property);
      return createIndexWhereFieldBuilder(operand);
    },
  });
}

function createIndexWhereFieldBuilder<T>(
  operand: IndexWhereOperand,
): IndexWhereFieldBuilder<T> {
  function isNull(): IndexWhereExpression {
    return { __type: "index_where_null_check", operand, op: "isNull" };
  }

  function isNotNull(): IndexWhereExpression {
    return { __type: "index_where_null_check", operand, op: "isNotNull" };
  }

  function comparison(op: IndexWhereOp, value: unknown): IndexWhereExpression {
    return {
      __type: "index_where_comparison",
      left: operand,
      op,
      right: toLiteralOrThrow(value, operand.valueType),
    };
  }

  function listComparison(
    op: IndexWhereOp,
    values: readonly unknown[],
  ): IndexWhereExpression {
    const literals = values.map((value) =>
      toLiteralOrThrow(value, operand.valueType),
    );
    return {
      __type: "index_where_comparison",
      left: operand,
      op,
      right: literals,
    };
  }

  return {
    eq: (value) => comparison("eq", value),
    neq: (value) => comparison("neq", value),
    gt: (value) => comparison("gt", value),
    gte: (value) => comparison("gte", value),
    lt: (value) => comparison("lt", value),
    lte: (value) => comparison("lte", value),
    in: (values) => listComparison("in", values),
    notIn: (values) => listComparison("notIn", values),
    isNull,
    isNotNull,
  };
}

function toLiteralOrThrow(
  value: unknown,
  preferredType: ValueType | undefined,
): IndexWhereLiteral {
  if (value instanceof Date) {
    return {
      __type: "index_where_literal",
      value: value.toISOString(),
      valueType: "date",
    };
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const valueType = inferValueType(value, preferredType);
    return { __type: "index_where_literal", value, valueType };
  }

  throw new Error(
    `Unsupported literal value type in index WHERE clause: ${String(value)}`,
  );
}

function inferValueType(
  value: string | number | boolean,
  preferredType: ValueType | undefined,
): ValueType {
  if (preferredType === "date" && typeof value === "string") {
    return "date";
  }
  if (preferredType === "number" && typeof value === "string") {
    return "number";
  }
  if (preferredType === "boolean" && typeof value === "string") {
    return "boolean";
  }

  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

function toSystemColumnName(metaKey: string): SystemColumnName {
  const snake = metaKey.replaceAll(/([A-Z])/g, "_$1").toLowerCase();

  switch (snake) {
    case "deleted_at":
    case "valid_from":
    case "valid_to":
    case "created_at":
    case "updated_at": {
      return snake;
    }
    default: {
      throw new Error(`Unsupported system meta key: ${metaKey}`);
    }
  }
}

function createSystemColumnMapForNode(): Map<
  string,
  Readonly<{ column: SystemColumnName; valueType: ValueType | undefined }>
> {
  const entries: (readonly [
    string,
    Readonly<{ column: SystemColumnName; valueType: ValueType | undefined }>,
  ])[] = [
    ["graphId", { column: "graph_id", valueType: "string" }],
    ["kind", { column: "kind", valueType: "string" }],
    ["id", { column: "id", valueType: "string" }],
  ];

  for (const key of NODE_META_KEYS) {
    if (key === "version") {
      entries.push([key, { column: "version", valueType: "number" }]);
      continue;
    }
    entries.push([key, { column: toSystemColumnName(key), valueType: "date" }]);
  }

  return new Map(entries);
}

function createSystemColumnMapForEdge(): Map<
  string,
  Readonly<{ column: SystemColumnName; valueType: ValueType | undefined }>
> {
  const entries: (readonly [
    string,
    Readonly<{ column: SystemColumnName; valueType: ValueType | undefined }>,
  ])[] = [
    ["graphId", { column: "graph_id", valueType: "string" }],
    ["kind", { column: "kind", valueType: "string" }],
    ["id", { column: "id", valueType: "string" }],
    ["fromKind", { column: "from_kind", valueType: "string" }],
    ["fromId", { column: "from_id", valueType: "string" }],
    ["toKind", { column: "to_kind", valueType: "string" }],
    ["toId", { column: "to_id", valueType: "string" }],
  ];

  for (const key of EDGE_META_KEYS) {
    entries.push([key, { column: toSystemColumnName(key), valueType: "date" }]);
  }

  return new Map(entries);
}

function getSchemaShape(schema: z.ZodType): NodeShape | EdgeShape {
  if (schema.type !== "object") {
    throw new Error("Index definitions require an object schema");
  }

  const def = schema.def as { shape?: Record<string, z.ZodType> };
  const shape = def.shape;
  if (!shape) {
    throw new Error("Index definitions require a resolvable object shape");
  }

  return shape;
}

// ============================================================
// Validation
// ============================================================

function assertNonEmpty(values: readonly unknown[], label: string): void {
  if (values.length === 0) {
    throw new Error(`Index ${label} must not be empty`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  const set = new Set<string>();
  for (const value of values) {
    if (set.has(value)) {
      throw new Error(`Index ${label} contains duplicate value: ${value}`);
    }
    set.add(value);
  }
}

function assertNoOverlap(
  a: readonly string[],
  b: readonly string[],
  aLabel: string,
  bLabel: string,
): void {
  const set = new Set(a);
  for (const value of b) {
    if (set.has(value)) {
      throw new Error(`Index ${bLabel} must not overlap ${aLabel}: ${value}`);
    }
  }
}

function assertIndexableValueType(
  valueType: ValueType,
  context: string,
  options: Readonly<{ allowJsonFields: boolean }>,
): void {
  if (valueType === "embedding") {
    throw new Error(
      `Cannot create props index for embedding field (${context}); embedding() fields are indexed automatically in the vector strategy's per-(kind, field) storage`,
    );
  }

  if (
    (valueType === "array" || valueType === "object") &&
    !options.allowJsonFields
  ) {
    throw new Error(
      `Cannot create btree props index for ${valueType} field (${context}); use method: "gin" instead`,
    );
  }
}

type NormalizedIndexFields = Readonly<{
  pointers: readonly JsonPointer[];
  valueTypes: readonly (ValueType | undefined)[];
}>;

function normalizeNodeIndexFieldsOrThrow<N extends NodeType>(
  node: N,
  inputs: readonly IndexFieldInput<z.infer<N["schema"]>>[],
  schemaIntrospector: ReturnType<typeof createSchemaIntrospector>,
  label: string,
  options: Readonly<{ allowEmpty: boolean; allowJsonFields?: boolean }>,
): NormalizedIndexFields {
  if (inputs.length === 0 && options.allowEmpty) {
    return { pointers: [], valueTypes: [] };
  }
  assertNonEmpty(inputs, label);

  const pointers: JsonPointer[] = [];
  const valueTypes: (ValueType | undefined)[] = [];

  for (const input of inputs) {
    const pointer = normalizeIndexFieldPointer(input);
    const info = resolveNodeFieldTypeInfoOrThrow(
      node.kind,
      pointer,
      schemaIntrospector,
    );
    assertIndexableValueType(info.valueType, `node "${node.kind}" ${pointer}`, {
      allowJsonFields: options.allowJsonFields ?? false,
    });
    pointers.push(pointer);
    valueTypes.push(info.valueType);
  }

  assertUnique(pointers, label);

  return { pointers, valueTypes };
}

function normalizeEdgeIndexFieldsOrThrow<E extends AnyEdgeType>(
  edge: E,
  inputs: readonly IndexFieldInput<z.infer<E["schema"]>>[],
  schemaIntrospector: ReturnType<typeof createSchemaIntrospector>,
  label: string,
  options: Readonly<{ allowEmpty: boolean; allowJsonFields?: boolean }>,
): NormalizedIndexFields {
  if (inputs.length === 0 && options.allowEmpty) {
    return { pointers: [], valueTypes: [] };
  }
  assertNonEmpty(inputs, label);

  const pointers: JsonPointer[] = [];
  const valueTypes: (ValueType | undefined)[] = [];

  for (const input of inputs) {
    const pointer = normalizeIndexFieldPointer(input);
    const info = resolveEdgeFieldTypeInfoOrThrow(
      edge.kind,
      pointer,
      schemaIntrospector,
    );
    assertIndexableValueType(info.valueType, `edge "${edge.kind}" ${pointer}`, {
      allowJsonFields: options.allowJsonFields ?? false,
    });
    pointers.push(pointer);
    valueTypes.push(info.valueType);
  }

  assertUnique(pointers, label);

  return { pointers, valueTypes };
}

function normalizeIndexFieldPointer<T>(input: IndexFieldInput<T>): JsonPointer {
  if (Array.isArray(input)) {
    if (input.length === 0) {
      throw new Error("Index field JSON pointer must not be empty");
    }
    return jsonPointer(input as readonly JsonPointerSegment[]);
  }

  if (typeof input === "string") {
    if (input.startsWith("/")) {
      const pointer = normalizeJsonPointer(
        input as JsonPointerInput<Record<string, unknown>>,
      );
      if (pointer === "") {
        throw new Error("Index field JSON pointer must not be empty");
      }
      return pointer;
    }
    return jsonPointer([input]);
  }

  throw new Error(`Unsupported index field input: ${String(input)}`);
}

function resolveNodeFieldTypeInfoOrThrow(
  nodeKind: string,
  pointer: JsonPointer,
  schemaIntrospector: ReturnType<typeof createSchemaIntrospector>,
): FieldTypeInfo {
  const segments = parseJsonPointer(pointer);
  const [first, ...rest] = segments;
  if (!first) {
    throw new Error("Index field JSON pointer must not be empty");
  }

  const rootInfo = schemaIntrospector.getFieldTypeInfo(nodeKind, first);
  if (!rootInfo) {
    throw new Error(
      `Unknown field "${first}" for node "${nodeKind}" in index definition`,
    );
  }

  if (rest.length === 0) {
    return rootInfo;
  }

  const resolved = resolveFieldTypeInfoAtJsonPointer(
    rootInfo,
    jsonPointer(rest),
  );
  if (!resolved) {
    throw new Error(
      `Unknown JSON pointer "${pointer}" for node "${nodeKind}" in index definition`,
    );
  }

  return resolved;
}

function resolveEdgeFieldTypeInfoOrThrow(
  edgeKind: string,
  pointer: JsonPointer,
  schemaIntrospector: ReturnType<typeof createSchemaIntrospector>,
): FieldTypeInfo {
  const segments = parseJsonPointer(pointer);
  const [first, ...rest] = segments;
  if (!first) {
    throw new Error("Index field JSON pointer must not be empty");
  }

  const rootInfo = schemaIntrospector.getEdgeFieldTypeInfo(edgeKind, first);
  if (!rootInfo) {
    throw new Error(
      `Unknown field "${first}" for edge "${edgeKind}" in index definition`,
    );
  }

  if (rest.length === 0) {
    return rootInfo;
  }

  const resolved = resolveFieldTypeInfoAtJsonPointer(
    rootInfo,
    jsonPointer(rest),
  );
  if (!resolved) {
    throw new Error(
      `Unknown JSON pointer "${pointer}" for edge "${edgeKind}" in index definition`,
    );
  }

  return resolved;
}

// ============================================================
// Default Name Generation
// ============================================================

type DefaultNameParts = Readonly<{
  kind: KindEntity;
  kindName: string;
  unique: boolean;
  scope: IndexScope;
  direction: EdgeIndexDirection;
  fields: readonly string[];
  coveringFields: readonly string[];
  /**
   * Node-only, defaults to `[]` for edges. Folded into the hash/name only
   * when non-empty so indexes that don't use it keep byte-identical
   * default names to before this field existed.
   */
  keySystemColumns?: readonly string[];
}>;

function generateDefaultIndexName(parts: DefaultNameParts): string {
  const keySystemColumns = parts.keySystemColumns ?? [];
  const hash = fnv1aBase36(
    JSON.stringify({
      kind: parts.kind,
      kindName: parts.kindName,
      unique: parts.unique,
      scope: parts.scope,
      direction: parts.direction,
      fields: parts.fields,
      covering: parts.coveringFields,
      ...(keySystemColumns.length > 0 ? { keySystemColumns } : {}),
    }),
  );

  const nameParts = [
    "idx",
    "tg",
    parts.kind,
    sanitizeIdentifierComponent(parts.kindName),
    sanitizeIdentifierComponent(parts.fields.join("_")),
    parts.coveringFields.length > 0 ?
      `cov_${sanitizeIdentifierComponent(parts.coveringFields.join("_"))}`
    : undefined,
    keySystemColumns.length > 0 ?
      `sys_${sanitizeIdentifierComponent(keySystemColumns.join("_"))}`
    : undefined,
    parts.direction === "none" ? undefined : parts.direction,
    parts.unique ? "uniq" : undefined,
    parts.scope === "graphAndKind" ?
      undefined
    : sanitizeIdentifierComponent(parts.scope),
    hash,
  ].filter((part) => part !== undefined);

  const joined = nameParts.join("_");
  return joined.length <= MAX_PG_IDENTIFIER_LENGTH ?
      joined
    : `${joined.slice(0, TRUNCATED_IDENTIFIER_MAX_LENGTH)}_${hash}`;
}

function sanitizeIdentifierComponent(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .slice(0, IDENTIFIER_COMPONENT_MAX_LENGTH);
}
