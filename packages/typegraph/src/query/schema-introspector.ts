import { type z } from "zod";

import { getEmbeddingDimensions } from "../core/embedding";
import {
  getSearchableMetadata,
  type SearchableMetadata,
} from "../core/searchable";
import { type ValueType } from "./ast";

const SUPPORTED_SCHEMA_TYPES = [
  "string",
  "number",
  "nan",
  "boolean",
  "date",
  "literal",
  "enum",
  "nativeEnum",
  "array",
  "tuple",
  "object",
  "record",
  "union",
  "discriminatedUnion",
  "intersection",
] as const;

type SupportedSchemaType = (typeof SUPPORTED_SCHEMA_TYPES)[number];

// Use Set<string> to allow checking arbitrary strings while maintaining type safety
const SUPPORTED_SCHEMA_TYPE_SET: ReadonlySet<string> = new Set(
  SUPPORTED_SCHEMA_TYPES,
);

function isSupportedSchemaType(type: string): type is SupportedSchemaType {
  return SUPPORTED_SCHEMA_TYPE_SET.has(type);
}

export type FieldTypeInfo = Readonly<{
  valueType: ValueType;
  elementType?: ValueType | undefined;
  elementTypeInfo?: FieldTypeInfo | undefined;
  shape?: Readonly<Record<string, FieldTypeInfo>> | undefined;
  recordValueType?: FieldTypeInfo | undefined;
  /** For embedding types: the number of dimensions */
  dimensions?: number | undefined;
  /** For fulltext-searchable string types: field-level metadata */
  searchable?: SearchableMetadata | undefined;
}>;

export type SchemaIntrospector = Readonly<{
  getFieldTypeInfo: (
    kindName: string,
    fieldName: string,
  ) => FieldTypeInfo | undefined;
  getSharedFieldTypeInfo: (
    kindNames: readonly string[],
    fieldName: string,
  ) => FieldTypeInfo | undefined;
  getEdgeFieldTypeInfo: (
    edgeKindName: string,
    fieldName: string,
  ) => FieldTypeInfo | undefined;
  getSharedEdgeFieldTypeInfo: (
    edgeKindNames: readonly string[],
    fieldName: string,
  ) => FieldTypeInfo | undefined;
  /**
   * True iff every kind in `kindNames` has at least one `searchable()`
   * field. For polymorphic aliases, `$fulltext` is available only when
   * every resolved kind has searchable content — otherwise `.matches()`
   * would silently miss some kinds.
   */
  hasSearchableField: (kindNames: readonly string[]) => boolean;
}>;

function sharedCacheKey(
  kindNames: readonly string[],
  fieldName: string,
): string {
  return `${[...kindNames].toSorted().join("|")}|${fieldName}`;
}

export function createSchemaIntrospector(
  nodeKinds: ReadonlyMap<string, { schema: z.ZodType }>,
  edgeKinds?: ReadonlyMap<string, { schema: z.ZodType }>,
): SchemaIntrospector {
  const nodeShapeCache = new Map<
    string,
    Readonly<Record<string, FieldTypeInfo>>
  >();
  const edgeShapeCache = new Map<
    string,
    Readonly<Record<string, FieldTypeInfo>>
  >();
  // Proxy-based field accessors trigger a fresh merge on every property
  // read during a `whereNode(n => ...)` callback. For polymorphic
  // aliases with N kinds and M field accesses, that is O(N*M) per
  // compile; caching collapses it to O(1) after the first access.
  const sharedFieldTypeInfoCache = new Map<string, FieldTypeInfo | undefined>();
  const sharedEdgeFieldTypeInfoCache = new Map<
    string,
    FieldTypeInfo | undefined
  >();
  const searchableCache = new Map<string, boolean>();

  function getFieldTypeInfo(
    kindName: string,
    fieldName: string,
  ): FieldTypeInfo | undefined {
    const shape = getShapeForKind(kindName);
    return shape?.[fieldName];
  }

  function getSharedFieldTypeInfo(
    kindNames: readonly string[],
    fieldName: string,
  ): FieldTypeInfo | undefined {
    const cacheKey = sharedCacheKey(kindNames, fieldName);
    if (sharedFieldTypeInfoCache.has(cacheKey)) {
      return sharedFieldTypeInfoCache.get(cacheKey);
    }

    const infos = kindNames
      .map((kindName) => getFieldTypeInfo(kindName, fieldName))
      .filter((info): info is FieldTypeInfo => info !== undefined);

    const merged =
      infos.length !== kindNames.length || infos.length === 0 ?
        undefined
      : mergeFieldTypeInfos(infos);
    sharedFieldTypeInfoCache.set(cacheKey, merged);
    return merged;
  }

  function getEdgeFieldTypeInfo(
    edgeKindName: string,
    fieldName: string,
  ): FieldTypeInfo | undefined {
    const shape = getShapeForEdgeKind(edgeKindName);
    return shape?.[fieldName];
  }

  function getSharedEdgeFieldTypeInfo(
    edgeKindNames: readonly string[],
    fieldName: string,
  ): FieldTypeInfo | undefined {
    const cacheKey = sharedCacheKey(edgeKindNames, fieldName);
    if (sharedEdgeFieldTypeInfoCache.has(cacheKey)) {
      return sharedEdgeFieldTypeInfoCache.get(cacheKey);
    }

    const infos = edgeKindNames
      .map((kindName) => getEdgeFieldTypeInfo(kindName, fieldName))
      .filter((info): info is FieldTypeInfo => info !== undefined);

    const merged =
      infos.length !== edgeKindNames.length || infos.length === 0 ?
        undefined
      : mergeFieldTypeInfos(infos);
    sharedEdgeFieldTypeInfoCache.set(cacheKey, merged);
    return merged;
  }

  function getShapeForKind(
    kindName: string,
  ): Readonly<Record<string, FieldTypeInfo>> | undefined {
    const cached = nodeShapeCache.get(kindName);
    if (cached) {
      return cached;
    }

    const kind = nodeKinds.get(kindName);
    if (!kind) {
      return undefined;
    }

    const schema = kind.schema;
    if (schema.type !== "object") {
      return undefined;
    }

    const shape = (schema.def as { shape?: Record<string, z.ZodType> }).shape;
    if (!shape) {
      return undefined;
    }

    const entries = Object.entries(shape).map(
      ([key, value]) => [key, resolveFieldTypeInfo(value)] as const,
    );
    const resolved = Object.freeze(Object.fromEntries(entries));
    nodeShapeCache.set(kindName, resolved);
    return resolved;
  }

  function getShapeForEdgeKind(
    edgeKindName: string,
  ): Readonly<Record<string, FieldTypeInfo>> | undefined {
    if (!edgeKinds) {
      return undefined;
    }

    const cached = edgeShapeCache.get(edgeKindName);
    if (cached) {
      return cached;
    }

    const kind = edgeKinds.get(edgeKindName);
    if (!kind) {
      return undefined;
    }

    const schema = kind.schema;
    if (schema.type !== "object") {
      return undefined;
    }

    const shape = (schema.def as { shape?: Record<string, z.ZodType> }).shape;
    if (!shape) {
      return undefined;
    }

    const entries = Object.entries(shape).map(
      ([key, value]) => [key, resolveFieldTypeInfo(value)] as const,
    );
    const resolved = Object.freeze(Object.fromEntries(entries));
    edgeShapeCache.set(edgeKindName, resolved);
    return resolved;
  }

  function hasSearchableField(kindNames: readonly string[]): boolean {
    const cacheKey = [...kindNames].toSorted().join("|");
    const cached = searchableCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const result =
      kindNames.length > 0 &&
      kindNames.every((kindName) => {
        const shape = getShapeForKind(kindName);
        if (!shape) return false;
        return Object.values(shape).some(
          (info) => info.searchable !== undefined,
        );
      });
    searchableCache.set(cacheKey, result);
    return result;
  }

  return {
    getFieldTypeInfo,
    getSharedFieldTypeInfo,
    getEdgeFieldTypeInfo,
    getSharedEdgeFieldTypeInfo,
    hasSearchableField,
  };
}

function resolveFieldTypeInfo(schema: z.ZodType): FieldTypeInfo {
  // Check for embedding type before unwrapping
  // (embedding metadata is attached to the outer schema)
  const embeddingDimensions = getEmbeddingDimensions(schema);
  if (embeddingDimensions !== undefined) {
    return { valueType: "embedding", dimensions: embeddingDimensions };
  }

  const searchableMetadata = getSearchableMetadata(schema);
  const searchableStringSchema =
    searchableMetadata === undefined ? undefined : (
      unwrapSearchableStringSchema(schema)
    );
  if (
    searchableMetadata !== undefined &&
    searchableStringSchema !== undefined
  ) {
    return { valueType: "string", searchable: searchableMetadata };
  }

  const unwrapped = unwrapSchema(schema);

  // Check embedding on unwrapped schema too (for z.optional(embedding(...)))
  const unwrappedEmbeddingDimensions = getEmbeddingDimensions(unwrapped);
  if (unwrappedEmbeddingDimensions !== undefined) {
    return { valueType: "embedding", dimensions: unwrappedEmbeddingDimensions };
  }

  // Cast to string to detach from Zod's internal type union,
  // then let the type guard narrow to our SupportedSchemaType.
  const rawType = unwrapped.type as string;

  if (!isSupportedSchemaType(rawType)) {
    return { valueType: "unknown" };
  }

  // After the type guard, rawType is SupportedSchemaType.
  const schemaType = rawType;

  // Handle each schema type individually
  if (schemaType === "string") {
    return { valueType: "string" };
  }
  if (schemaType === "number" || schemaType === "nan") {
    return { valueType: "number" };
  }
  if (schemaType === "boolean") {
    return { valueType: "boolean" };
  }
  if (schemaType === "date") {
    return { valueType: "date" };
  }
  if (schemaType === "literal") {
    const literalValue = (unwrapped.def as { value?: unknown }).value;
    return resolveLiteralTypeInfo(literalValue);
  }
  if (schemaType === "enum") {
    return { valueType: "string" };
  }
  if (schemaType === "nativeEnum") {
    const values = Object.values(
      (unwrapped.def as { values?: Record<string, unknown> }).values ?? {},
    );
    const valueType = resolveEnumValueType(values);
    return { valueType };
  }
  if (schemaType === "array") {
    const elementSchema = (unwrapped.def as { element?: z.ZodType }).element;
    const elementInfo =
      elementSchema ? resolveFieldTypeInfo(elementSchema) : undefined;
    return {
      valueType: "array",
      elementType: elementInfo?.valueType,
      elementTypeInfo: elementInfo,
    };
  }
  if (schemaType === "tuple") {
    return {
      valueType: "array",
      elementType: "unknown",
    };
  }
  if (schemaType === "object") {
    const shape = (unwrapped.def as { shape?: Record<string, z.ZodType> })
      .shape;
    if (!shape) {
      return { valueType: "object" };
    }
    const entries = Object.entries(shape).map(
      ([key, value]) => [key, resolveFieldTypeInfo(value)] as const,
    );
    const resolved = Object.freeze(Object.fromEntries(entries));
    return {
      valueType: "object",
      shape: resolved,
    };
  }
  if (schemaType === "record") {
    const valueSchema = (unwrapped.def as { valueType?: z.ZodType }).valueType;
    const valueInfo =
      valueSchema ? resolveFieldTypeInfo(valueSchema) : undefined;
    return {
      valueType: "object",
      recordValueType: valueInfo,
    };
  }
  if (schemaType === "union" || schemaType === "discriminatedUnion") {
    const unionOptions = (unwrapped.def as { options?: readonly z.ZodType[] })
      .options;
    if (!unionOptions || unionOptions.length === 0) {
      return { valueType: "unknown" };
    }
    const optionInfos = unionOptions.map((option) =>
      resolveFieldTypeInfo(option),
    );
    return mergeFieldTypeInfos(optionInfos) ?? { valueType: "unknown" };
  }

  // Only "intersection" remains after all other cases
  const left = (unwrapped.def as { left?: z.ZodType }).left;
  const right = (unwrapped.def as { right?: z.ZodType }).right;
  if (!left || !right) {
    return { valueType: "unknown" };
  }
  const leftInfo = resolveFieldTypeInfo(left);
  const rightInfo = resolveFieldTypeInfo(right);
  return mergeFieldTypeInfos([leftInfo, rightInfo]) ?? { valueType: "unknown" };
}

function resolveLiteralTypeInfo(value: unknown): FieldTypeInfo {
  if (value instanceof Date) {
    return { valueType: "date" };
  }
  if (typeof value === "string") {
    return { valueType: "string" };
  }
  if (typeof value === "number") {
    return { valueType: "number" };
  }
  if (typeof value === "boolean") {
    return { valueType: "boolean" };
  }
  return { valueType: "unknown" };
}

function resolveEnumValueType(values: readonly unknown[]): ValueType {
  const uniqueTypes = new Set(values.map((value) => typeof value));
  if (uniqueTypes.size !== 1) {
    return "unknown";
  }

  const type = uniqueTypes.values().next().value;
  if (type === "string") {
    return "string";
  }
  if (type === "number") {
    return "number";
  }
  if (type === "boolean") {
    return "boolean";
  }
  return "unknown";
}

function mergeFieldTypeInfos(
  infos: readonly FieldTypeInfo[],
): FieldTypeInfo | undefined {
  const [first, ...rest] = infos;
  if (!first) {
    return undefined;
  }

  const sameValueType = rest.every(
    (info) => info.valueType === first.valueType,
  );
  if (!sameValueType) {
    return undefined;
  }

  if (first.valueType === "array") {
    const elementType =
      rest.every((info) => info.elementType === first.elementType) ?
        first.elementType
      : "unknown";
    const elementTypeInfo =
      (
        rest.every(
          (info) =>
            info.elementTypeInfo?.valueType ===
            first.elementTypeInfo?.valueType,
        )
      ) ?
        first.elementTypeInfo
      : undefined;
    return {
      valueType: "array",
      elementType,
      elementTypeInfo,
    };
  }

  if (first.valueType === "object") {
    const shapes = infos
      .map((info) => info.shape)
      .filter(
        (shape): shape is Readonly<Record<string, FieldTypeInfo>> =>
          shape !== undefined,
      );

    const shape =
      shapes.length === infos.length ? intersectShapes(shapes) : undefined;

    const recordValueType =
      (
        rest.every(
          (info) =>
            info.recordValueType?.valueType ===
            first.recordValueType?.valueType,
        )
      ) ?
        first.recordValueType
      : undefined;

    return {
      valueType: "object",
      shape,
      recordValueType,
    };
  }

  // Strings: only mark the merged result as searchable if every kind
  // in the polymorphic alias declares the field as searchable. A field
  // that isn't uniformly searchable would silently search only some
  // kinds via `.matches()`.
  if (first.valueType === "string") {
    const allSearchable =
      first.searchable !== undefined &&
      rest.every((info) => info.searchable !== undefined);
    return allSearchable ?
        { valueType: "string", searchable: first.searchable }
      : { valueType: "string" };
  }

  return first;
}

function intersectShapes(
  shapes: readonly Readonly<Record<string, FieldTypeInfo>>[],
): Readonly<Record<string, FieldTypeInfo>> {
  const [first, ...rest] = shapes;
  if (!first) {
    return Object.freeze({});
  }

  const keys = Object.keys(first).filter((key) =>
    rest.every((shape) => key in shape),
  );

  const entries = keys
    .map((key) => {
      const infos = shapes.map((shape) => shape[key]!);
      const merged = mergeFieldTypeInfos(infos);
      if (!merged) {
        return;
      }
      return [key, merged] as const;
    })
    .filter(
      (entry): entry is readonly [string, FieldTypeInfo] => entry !== undefined,
    );

  return Object.freeze(Object.fromEntries(entries));
}

function unwrapSearchableStringSchema(
  schema: z.ZodType,
): z.ZodType | undefined {
  const type = schema.type;
  const def = schema.def as {
    innerType?: z.ZodType;
    in?: z.ZodType;
    out?: z.ZodType;
  };

  if (
    (type === "optional" ||
      type === "nullable" ||
      type === "default" ||
      type === "prefault" ||
      type === "catch" ||
      type === "readonly" ||
      type === "nonoptional" ||
      type === "success") &&
    def.innerType
  ) {
    return unwrapSearchableStringSchema(def.innerType);
  }

  if (type === "pipe") {
    return (
      (def.in === undefined ?
        undefined
      : unwrapSearchableStringSchema(def.in)) ??
      (def.out === undefined ?
        undefined
      : unwrapSearchableStringSchema(def.out))
    );
  }

  const unwrapped = unwrapSchema(schema);
  return unwrapped.type === "string" ? unwrapped : undefined;
}

function unwrapSchema(schema: z.ZodType): z.ZodType {
  const type = schema.type;
  const def = schema.def as {
    innerType?: z.ZodType;
    out?: z.ZodType;
  };

  if (
    (type === "optional" ||
      type === "nullable" ||
      type === "default" ||
      type === "prefault" ||
      type === "catch" ||
      type === "readonly" ||
      type === "nonoptional" ||
      type === "success") &&
    def.innerType
  ) {
    return unwrapSchema(def.innerType);
  }

  if (type === "pipe" && def.out) {
    return unwrapSchema(def.out);
  }

  return schema;
}
