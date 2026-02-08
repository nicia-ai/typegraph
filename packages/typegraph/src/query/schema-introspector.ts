import { type z } from "zod";

import { getEmbeddingDimensions } from "../core/embedding";
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
}>;

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
    const infos = kindNames
      .map((kindName) => getFieldTypeInfo(kindName, fieldName))
      .filter((info): info is FieldTypeInfo => info !== undefined);

    if (infos.length !== kindNames.length || infos.length === 0) {
      return undefined;
    }

    return mergeFieldTypeInfos(infos);
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
    const infos = edgeKindNames
      .map((kindName) => getEdgeFieldTypeInfo(kindName, fieldName))
      .filter((info): info is FieldTypeInfo => info !== undefined);

    if (infos.length !== edgeKindNames.length || infos.length === 0) {
      return undefined;
    }

    return mergeFieldTypeInfos(infos);
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

  return {
    getFieldTypeInfo,
    getSharedFieldTypeInfo,
    getEdgeFieldTypeInfo,
    getSharedEdgeFieldTypeInfo,
  };
}

function resolveFieldTypeInfo(schema: z.ZodType): FieldTypeInfo {
  // Check for embedding type before unwrapping
  // (embedding metadata is attached to the outer schema)
  const embeddingDimensions = getEmbeddingDimensions(schema);
  if (embeddingDimensions !== undefined) {
    return { valueType: "embedding", dimensions: embeddingDimensions };
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
