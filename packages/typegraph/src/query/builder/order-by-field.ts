import { ConfigurationError } from "../../errors";
import { type FieldRef, type OrderSpec, type SortDirection } from "../ast";
import { jsonPointer } from "../json-pointer";
import { fieldRef } from "../predicates";
import {
  type FieldTypeInfo,
  type SchemaIntrospector,
} from "../schema-introspector";

type SystemOrderOwner = "both" | "edge" | "node";

type SystemOrderField = Readonly<{
  /**
   * Where a selected node or edge holds the value. Joined with `.`, it is
   * also the name `orderBy(alias, name)` accepts.
   */
  selectedPath: readonly [string] | readonly ["meta", string];
  /** The physical column the value is stored in. */
  column: string;
  nullable: boolean;
  owner: SystemOrderOwner;
  valueType: NonNullable<FieldRef["valueType"]>;
}>;

/**
 * The one table of orderable system fields: each one's order name, its
 * location in a selected row, and its physical column. Every consumer — the
 * alias-form `orderBy`, cursor extraction from mapped and selective rows,
 * and the native tuple-comparison check — reads it, so the three cannot name
 * a field differently.
 */
const SYSTEM_ORDER_FIELDS: readonly SystemOrderField[] = [
  {
    selectedPath: ["id"],
    column: "id",
    nullable: false,
    owner: "both",
    valueType: "string",
  },
  {
    selectedPath: ["kind"],
    column: "kind",
    nullable: false,
    owner: "both",
    valueType: "string",
  },
  {
    selectedPath: ["fromId"],
    column: "from_id",
    nullable: false,
    owner: "edge",
    valueType: "string",
  },
  {
    selectedPath: ["toId"],
    column: "to_id",
    nullable: false,
    owner: "edge",
    valueType: "string",
  },
  {
    selectedPath: ["meta", "version"],
    column: "version",
    nullable: false,
    owner: "node",
    valueType: "number",
  },
  {
    selectedPath: ["meta", "validFrom"],
    column: "valid_from",
    nullable: true,
    owner: "both",
    valueType: "string",
  },
  {
    selectedPath: ["meta", "validTo"],
    column: "valid_to",
    nullable: true,
    owner: "both",
    valueType: "string",
  },
  {
    selectedPath: ["meta", "createdAt"],
    column: "created_at",
    nullable: false,
    owner: "both",
    valueType: "string",
  },
  {
    selectedPath: ["meta", "updatedAt"],
    column: "updated_at",
    nullable: false,
    owner: "both",
    valueType: "string",
  },
  {
    selectedPath: ["meta", "deletedAt"],
    column: "deleted_at",
    nullable: true,
    owner: "both",
    valueType: "string",
  },
];

function orderName(field: SystemOrderField): string {
  return field.selectedPath.join(".");
}

const SYSTEM_ORDER_FIELDS_BY_NAME: ReadonlyMap<string, SystemOrderField> =
  new Map(SYSTEM_ORDER_FIELDS.map((field) => [orderName(field), field]));

const SYSTEM_ORDER_FIELDS_BY_COLUMN: ReadonlyMap<string, SystemOrderField> =
  new Map(SYSTEM_ORDER_FIELDS.map((field) => [field.column, field]));

function ownedBy(field: SystemOrderField, isEdge: boolean): boolean {
  return field.owner === "both" || field.owner === (isEdge ? "edge" : "node");
}

/** Identifies physical system columns whose row-value comparisons are unsafe. */
export function isNullableSystemOrderField(column: string): boolean {
  return SYSTEM_ORDER_FIELDS_BY_COLUMN.get(column)?.nullable === true;
}

/**
 * The location of system column `column` on a selected node or edge, or
 * `undefined` when `column` is not an orderable system column. Cursor
 * extraction reads an ordered system column here, for full and projected
 * selections alike: `created_at` is `meta.createdAt` there, not a top-level
 * key.
 */
export function systemColumnSelectedPath(
  column: string,
): readonly string[] | undefined {
  return SYSTEM_ORDER_FIELDS_BY_COLUMN.get(column)?.selectedPath;
}

/**
 * Resolves an orderable system field by its order name (`id`, `kind`,
 * `meta.createdAt`, …, and `fromId` / `toId` on an edge), or `undefined`
 * when `field` names no system field of this alias.
 */
export function resolveSystemOrderField(
  alias: string,
  field: string,
  isEdge: boolean,
): FieldRef | undefined {
  const system = SYSTEM_ORDER_FIELDS_BY_NAME.get(field);
  if (system === undefined || !ownedBy(system, isEdge)) return undefined;
  return fieldRef(alias, [system.column], {
    nullable: system.nullable,
    valueType: system.valueType,
  });
}

/** The order names this alias accepts besides its declared properties. */
function systemOrderNames(isEdge: boolean): readonly string[] {
  return SYSTEM_ORDER_FIELDS.filter((field) => ownedBy(field, isEdge)).map(
    (field) => orderName(field),
  );
}

/**
 * Refuses an order field that names neither a system field nor a declared
 * property. A removed snake_case column name is told its replacement.
 */
function refuseUnknownOrderField(
  alias: string,
  field: string,
  isEdge: boolean,
): never {
  const renamed = SYSTEM_ORDER_FIELDS_BY_COLUMN.get(field);
  if (
    renamed !== undefined &&
    ownedBy(renamed, isEdge) &&
    orderName(renamed) !== field
  ) {
    const replacement = orderName(renamed);
    throw new ConfigurationError(
      `orderBy("${alias}", "${field}"): "${field}" is no longer an order field name; use "${replacement}".`,
      { code: "ORDER_FIELD_RENAMED", alias, field, replacement },
      {
        suggestion: `System fields are ordered by their path in a selected row: orderBy("${alias}", "${replacement}").`,
      },
    );
  }
  throw new ConfigurationError(
    `orderBy("${alias}", "${field}"): "${field}" is not a property declared by this ${isEdge ? "edge" : "node"} alias or an orderable system field.`,
    { code: "ORDER_FIELD_UNKNOWN", alias, field },
    {
      suggestion: `Order by a declared property or one of: ${systemOrderNames(isEdge).join(", ")}.`,
    },
  );
}

/** The kinds an `orderBy` alias resolves to. */
export type OrderAliasKinds = Readonly<
  | { isEdge: true; edgeKindNames: readonly string[] }
  | { isEdge: false; nodeKindNames: readonly string[] }
>;

/**
 * Builds the ORDER BY entry for `orderBy(alias, field, direction)`: a system
 * field by its order name, else a property the alias declares. Both fluent
 * builder stages call this, so they accept and refuse the same names.
 */
export function resolveAliasOrderSpec(
  introspector: SchemaIntrospector,
  alias: string,
  kinds: OrderAliasKinds | undefined,
  field: string,
  direction: SortDirection,
): OrderSpec {
  if (kinds === undefined) {
    throw new ConfigurationError(
      `orderBy("${alias}", "${field}"): "${alias}" is not an alias of this query.`,
      { code: "ORDER_ALIAS_UNKNOWN", alias, field },
    );
  }
  const systemField = resolveSystemOrderField(alias, field, kinds.isEdge);
  if (systemField !== undefined) return { field: systemField, direction };

  const declared =
    kinds.isEdge ?
      introspector.hasDeclaredEdgeField(kinds.edgeKindNames, field)
    : introspector.hasDeclaredField(kinds.nodeKindNames, field);
  if (!declared) refuseUnknownOrderField(alias, field, kinds.isEdge);

  const typeInfo =
    kinds.isEdge ?
      introspector.getSharedEdgeFieldTypeInfo(kinds.edgeKindNames, field)
    : introspector.getSharedFieldTypeInfo(kinds.nodeKindNames, field);
  if (!kinds.isEdge)
    assertSharedNodeField(kinds.nodeKindNames, field, typeInfo);

  return {
    field: fieldRef(alias, ["props"], {
      jsonPointer: jsonPointer([field]),
      valueType: typeInfo?.valueType,
      elementType: typeInfo?.elementType,
      ...(typeInfo === undefined ?
        {}
      : { nullable: typeInfo.nullable === true }),
    }),
    direction,
  };
}

/** Refuses property operations that lack schema agreement across node kinds. */
export function assertSharedNodeField(
  kindNames: readonly string[] | undefined,
  field: string,
  typeInfo: FieldTypeInfo | undefined,
): void {
  if (
    kindNames !== undefined &&
    kindNames.length > 1 &&
    typeInfo === undefined
  ) {
    throw new ConfigurationError(
      `Unknown or incompatible shared node field "${field}".`,
    );
  }
}
