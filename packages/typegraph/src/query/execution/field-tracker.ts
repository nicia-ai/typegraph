/**
 * Field Tracking for Smart Select Optimization.
 *
 * Provides infrastructure for tracking which fields are accessed during
 * a select callback, enabling the query compiler to selectively project
 * only those fields instead of fetching the full props blob.
 */

import { EDGE_META_KEYS, NODE_META_KEYS } from "../../system-fields";
import { type SelectiveField, type ValueType } from "../ast";
import { type QueryBuilderState } from "../builder/types";
import {
  type FieldTypeInfo,
  type SchemaIntrospector,
} from "../schema-introspector";

// ============================================================
// Types
// ============================================================

type TrackingValueMode = "falsy" | "truthy" | "max";

type AccessedField = Readonly<{
  alias: string;
  field: string;
  isSystemField: boolean;
}>;

export type TrackingContextOptions = Readonly<{
  schemaIntrospector: SchemaIntrospector;
  mode: TrackingValueMode;
  /**
   * When "absent", optional traversal aliases are set to undefined to
   * encourage exploring fallback branches (e.g., `ctx.friend ? ... : ...`).
   */
  optionalTraversalAliases: "present" | "absent";
}>;

// ============================================================
// Constants
// ============================================================

const OBJECT_PROTOTYPE_PROPERTIES = new Set<string>([
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
]);

// ============================================================
// FieldAccessTracker
// ============================================================

export class FieldAccessTracker {
  readonly #fields = new Map<string, AccessedField>();

  record(alias: string, field: string, isSystemField: boolean): void {
    const key = `${alias}\u0000${field}`;
    this.#fields.set(key, { alias, field, isSystemField });
  }

  getAccessedFields(): readonly AccessedField[] {
    return [...this.#fields.values()];
  }
}

// ============================================================
// Tracking Context Creation
// ============================================================

export function createTrackingContext(
  state: QueryBuilderState,
  tracker: FieldAccessTracker,
  options: TrackingContextOptions,
): Record<string, unknown> {
  const context: Record<string, unknown> = {
    [state.startAlias]: createNodeTrackingProxy(
      state.startAlias,
      state.startKinds,
      tracker,
      options,
    ),
  };

  for (const traversal of state.traversals) {
    const optionalAbsent =
      options.optionalTraversalAliases === "absent" && traversal.optional;

    context[traversal.nodeAlias] =
      optionalAbsent ? undefined : (
        createNodeTrackingProxy(
          traversal.nodeAlias,
          traversal.nodeKinds,
          tracker,
          options,
        )
      );

    context[traversal.edgeAlias] =
      optionalAbsent ? undefined : (
        createEdgeTrackingProxy(
          traversal.edgeAlias,
          traversal.edgeKinds,
          tracker,
          options,
        )
      );
  }

  return context;
}

function createNodeTrackingProxy(
  alias: string,
  kindNames: readonly string[],
  tracker: FieldAccessTracker,
  options: TrackingContextOptions,
): unknown {
  return new Proxy(
    {},
    {
      get: (_, property: string | symbol) => {
        if (typeof property === "symbol") return;
        if (property === "then") return;
        if (property === "toJSON") return;

        if (OBJECT_PROTOTYPE_PROPERTIES.has(property)) {
          if (property === "constructor") return Object;
          if (property === "__proto__") return Object.prototype;
          return Reflect.get(Object.prototype, property) as unknown;
        }

        if (property === "id" || property === "kind") {
          tracker.record(alias, property, true);
          return getPlaceholderForSystemField(property, options.mode);
        }

        if (property === "meta") {
          for (const key of NODE_META_KEYS) {
            tracker.record(alias, `meta.${key}`, true);
          }
          return buildNodeMetaPlaceholder(options.mode);
        }

        tracker.record(alias, property, false);
        const typeInfo = options.schemaIntrospector.getSharedFieldTypeInfo(
          kindNames,
          property,
        );
        return getPlaceholderForTypeInfo(typeInfo, options.mode);
      },
    },
  );
}

function createEdgeTrackingProxy(
  alias: string,
  edgeKindNames: readonly string[],
  tracker: FieldAccessTracker,
  options: TrackingContextOptions,
): unknown {
  return new Proxy(
    {},
    {
      get: (_, property: string | symbol) => {
        if (typeof property === "symbol") return;
        if (property === "then") return;
        if (property === "toJSON") return;

        if (OBJECT_PROTOTYPE_PROPERTIES.has(property)) {
          if (property === "constructor") return Object;
          if (property === "__proto__") return Object.prototype;
          return Reflect.get(Object.prototype, property) as unknown;
        }

        if (
          property === "id" ||
          property === "kind" ||
          property === "fromId" ||
          property === "toId"
        ) {
          tracker.record(alias, property, true);
          return getPlaceholderForSystemField(property, options.mode);
        }

        if (property === "meta") {
          for (const key of EDGE_META_KEYS) {
            tracker.record(alias, `meta.${key}`, true);
          }
          return buildEdgeMetaPlaceholder(options.mode);
        }

        tracker.record(alias, property, false);
        const typeInfo = options.schemaIntrospector.getSharedEdgeFieldTypeInfo(
          edgeKindNames,
          property,
        );
        return getPlaceholderForTypeInfo(typeInfo, options.mode);
      },
    },
  );
}

// ============================================================
// Selective Field Construction
// ============================================================

type BuildSelectiveFieldsOptions = Readonly<{
  state: QueryBuilderState;
  schemaIntrospector: SchemaIntrospector;
}>;

export function buildSelectiveFields(
  accessedFields: readonly AccessedField[],
  options?: BuildSelectiveFieldsOptions,
): readonly SelectiveField[] {
  const aliasInfo = options ? buildAliasKindMap(options.state) : undefined;

  return accessedFields
    .map((access) => {
      const base: SelectiveField = {
        alias: access.alias,
        field: access.field,
        outputName: `${access.alias}_${access.field}`,
        isSystemField: access.isSystemField,
      };

      if (!options || access.isSystemField) {
        return base;
      }

      const info = aliasInfo?.get(access.alias);
      if (!info) {
        return base;
      }

      const typeInfo =
        info.kind === "node" ?
          options.schemaIntrospector.getSharedFieldTypeInfo(
            info.kindNames,
            access.field,
          )
        : options.schemaIntrospector.getSharedEdgeFieldTypeInfo(
            info.kindNames,
            access.field,
          );

      return {
        ...base,
        valueType: typeInfo?.valueType,
      };
    })
    .toSorted((a, b) => {
      const aliasCompare = a.alias.localeCompare(b.alias);
      if (aliasCompare !== 0) return aliasCompare;
      return a.field.localeCompare(b.field);
    });
}

type AliasKind = "node" | "edge";

type AliasKindInfo = Readonly<{
  kind: AliasKind;
  kindNames: readonly string[];
}>;

function buildAliasKindMap(
  state: QueryBuilderState,
): ReadonlyMap<string, AliasKindInfo> {
  const map = new Map<string, AliasKindInfo>([
    [
      state.startAlias,
      {
        kind: "node",
        kindNames: state.startKinds,
      },
    ],
  ]);

  for (const traversal of state.traversals) {
    map.set(traversal.nodeAlias, {
      kind: "node",
      kindNames: traversal.nodeKinds,
    });
    map.set(traversal.edgeAlias, {
      kind: "edge",
      kindNames: traversal.edgeKinds,
    });
  }

  return map;
}

// ============================================================
// Placeholder Values
// ============================================================

function getPlaceholderForSystemField(
  field: string,
  mode: TrackingValueMode,
): unknown {
  if (
    field === "id" ||
    field === "kind" ||
    field === "fromId" ||
    field === "toId"
  ) {
    return mode === "falsy" ? "" : "x";
  }
  return undefined;
}

function buildNodeMetaPlaceholder(mode: TrackingValueMode): Readonly<{
  version: number;
  validFrom: string | undefined;
  validTo: string | undefined;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | undefined;
}> {
  const empty = mode === "falsy";
  return {
    version: empty ? 0 : 1,
    validFrom: empty ? undefined : "2020-01-01T00:00:00.000Z",
    validTo: undefined,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    deletedAt: undefined,
  };
}

function buildEdgeMetaPlaceholder(mode: TrackingValueMode): Readonly<{
  validFrom: string | undefined;
  validTo: string | undefined;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | undefined;
}> {
  const empty = mode === "falsy";
  return {
    validFrom: empty ? undefined : "2020-01-01T00:00:00.000Z",
    validTo: undefined,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    deletedAt: undefined,
  };
}

function getPlaceholderForTypeInfo(
  typeInfo: FieldTypeInfo | undefined,
  mode: TrackingValueMode,
): unknown {
  if (!typeInfo) {
    return undefined;
  }

  return getPlaceholderForValueType(typeInfo.valueType, mode);
}

function getPlaceholderForValueType(
  valueType: ValueType,
  mode: TrackingValueMode,
): unknown {
  switch (valueType) {
    case "string":
    case "date": {
      if (mode === "falsy") return "";
      if (mode === "max") return "active";
      return "x";
    }
    case "number": {
      if (mode === "falsy") return 0;
      if (mode === "max") return 100;
      return 1;
    }
    case "boolean": {
      return mode !== "falsy";
    }
    case "array":
    case "embedding": {
      return [];
    }
    case "object": {
      return {};
    }
    case "unknown": {
      return undefined;
    }
  }
}
