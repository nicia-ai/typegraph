import { type z } from "zod";

import { type AnyEdgeType, type NodeType } from "../core/types";
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
import {
  type EdgeIndex,
  type EdgeIndexConfig,
  type EdgeIndexDirection,
  type EdgeIndexWhereBuilder,
  type IndexFieldInput,
  type IndexScope,
  type IndexWhereExpression,
  type IndexWhereFieldBuilder,
  type IndexWhereLiteral,
  type IndexWhereOp,
  type IndexWhereOperand,
  type NodeIndex,
  type NodeIndexConfig,
  type NodeIndexWhereBuilder,
  type SystemColumnName,
} from "./types";

// ============================================================
// Public API
// ============================================================

export function defineNodeIndex<N extends NodeType>(
  node: N,
  config: NodeIndexConfig<N>,
): NodeIndex<N> {
  const scope = config.scope ?? "graphAndKind";
  const unique = config.unique ?? false;

  const schemaIntrospector = createSchemaIntrospector(
    new Map([[node.kind, { schema: node.schema }]]),
  );

  const { pointers: fields, valueTypes: fieldValueTypes } =
    normalizeNodeIndexFieldsOrThrow(
      node,
      config.fields,
      schemaIntrospector,
      "fields",
      { allowEmpty: false },
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

  const where = normalizeWhereInput(config.where, () =>
    createNodeWhereBuilder(node, schemaIntrospector),
  );

  const name =
    config.name ??
    generateDefaultIndexName({
      kind: "node",
      kindName: node.kind,
      unique,
      scope,
      direction: "none",
      fields,
      coveringFields,
    });

  return {
    __type: "typegraph_node_index",
    node,
    nodeKind: node.kind,
    fields,
    fieldValueTypes,
    coveringFields,
    coveringFieldValueTypes,
    unique,
    scope,
    where,
    name,
  };
}

export function defineEdgeIndex<E extends AnyEdgeType>(
  edge: E,
  config: EdgeIndexConfig<E>,
): EdgeIndex<E> {
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
      { allowEmpty: false },
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

  const name =
    config.name ??
    generateDefaultIndexName({
      kind: "edge",
      kindName: edge.kind,
      unique,
      scope,
      direction,
      fields,
      coveringFields,
    });

  return {
    __type: "typegraph_edge_index",
    edge,
    edgeKind: edge.kind,
    fields,
    fieldValueTypes,
    coveringFields,
    coveringFieldValueTypes,
    unique,
    scope,
    direction,
    where,
    name,
  };
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

function assertIndexableValueType(valueType: ValueType, context: string): void {
  if (valueType === "embedding") {
    throw new Error(
      `Cannot create props index for embedding field (${context}); use vector indexes on the embeddings table instead`,
    );
  }

  if (valueType === "array" || valueType === "object") {
    throw new Error(
      `Cannot create btree props index for ${valueType} field (${context}); use a GIN/JSON index strategy instead`,
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
  options: Readonly<{ allowEmpty: boolean }>,
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
    assertIndexableValueType(info.valueType, `node "${node.kind}" ${pointer}`);
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
  options: Readonly<{ allowEmpty: boolean }>,
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
    assertIndexableValueType(info.valueType, `edge "${edge.kind}" ${pointer}`);
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
  kind: "node" | "edge";
  kindName: string;
  unique: boolean;
  scope: IndexScope;
  direction: EdgeIndexDirection;
  fields: readonly string[];
  coveringFields: readonly string[];
}>;

function generateDefaultIndexName(parts: DefaultNameParts): string {
  const hash = fnv1aBase36Hash(
    JSON.stringify({
      kind: parts.kind,
      kindName: parts.kindName,
      unique: parts.unique,
      scope: parts.scope,
      direction: parts.direction,
      fields: parts.fields,
      covering: parts.coveringFields,
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
    parts.direction === "none" ? undefined : parts.direction,
    parts.unique ? "uniq" : undefined,
    parts.scope === "graphAndKind" ?
      undefined
    : sanitizeIdentifierComponent(parts.scope),
    hash,
  ].filter((part) => part !== undefined);

  const joined = nameParts.join("_");
  return joined.length <= 63 ? joined : `${joined.slice(0, 54)}_${hash}`;
}

function sanitizeIdentifierComponent(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .slice(0, 20);
}

function fnv1aBase36Hash(input: string): string {
  let hash = 0x81_1c_9d_c5;
  for (const character of input) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    hash ^= codePoint;
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  // Convert to an unsigned 32-bit integer and encode compactly.
  return (hash >>> 0).toString(36);
}
