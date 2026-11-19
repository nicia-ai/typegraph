import { ConfigurationError, ValidationError } from "../../errors";
import { validateCanonicalIsoDate } from "../../utils/date";
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
  /**
   * The snake_case name the previous release's `orderBy` accepted for this
   * field, now removed. Absent for a field that was not orderable by a
   * system name before (`meta.version`) or kept its name (`id`, `kind`).
   */
  removedName?: string;
  /**
   * Present on the timestamp metadata fields. A selected row carries them as
   * ISO-8601 strings, but a predicate compares them as instants, so it
   * accepts a `Date` operand.
   */
  timestamp?: true;
  /**
   * Present on `version`, a 32-bit integer column on PostgreSQL. A predicate
   * refuses any other operand, which PostgreSQL would reject while SQLite
   * compared it numerically.
   */
  integer?: true;
}>;

/**
 * The one table of system fields: each one's order name, its location in a
 * selected row, and its physical column. Every consumer — the alias-form
 * `orderBy`, cursor extraction from mapped and selective rows, the native
 * tuple-comparison check, and the `$meta` namespace of predicate accessors
 * and expression contexts — reads it, so none can name a field differently.
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
    removedName: "from_id",
    nullable: false,
    owner: "edge",
    valueType: "string",
  },
  {
    selectedPath: ["toId"],
    column: "to_id",
    removedName: "to_id",
    nullable: false,
    owner: "edge",
    valueType: "string",
  },
  {
    selectedPath: ["meta", "version"],
    column: "version",
    integer: true,
    nullable: false,
    owner: "node",
    valueType: "number",
  },
  {
    selectedPath: ["meta", "validFrom"],
    column: "valid_from",
    removedName: "valid_from",
    timestamp: true,
    nullable: true,
    owner: "both",
    valueType: "string",
  },
  {
    selectedPath: ["meta", "validTo"],
    column: "valid_to",
    removedName: "valid_to",
    timestamp: true,
    nullable: true,
    owner: "both",
    valueType: "string",
  },
  {
    selectedPath: ["meta", "createdAt"],
    column: "created_at",
    removedName: "created_at",
    timestamp: true,
    nullable: false,
    owner: "both",
    valueType: "string",
  },
  {
    selectedPath: ["meta", "updatedAt"],
    column: "updated_at",
    removedName: "updated_at",
    timestamp: true,
    nullable: false,
    owner: "both",
    valueType: "string",
  },
  {
    selectedPath: ["meta", "deletedAt"],
    column: "deleted_at",
    removedName: "deleted_at",
    timestamp: true,
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

const SYSTEM_ORDER_FIELDS_BY_REMOVED_NAME: ReadonlyMap<
  string,
  SystemOrderField
> = new Map(
  SYSTEM_ORDER_FIELDS.flatMap((field) =>
    field.removedName === undefined ?
      []
    : [[field.removedName, field] as const],
  ),
);

const SYSTEM_ORDER_FIELDS_BY_COLUMN: ReadonlyMap<string, SystemOrderField> =
  new Map(SYSTEM_ORDER_FIELDS.map((field) => [field.column, field]));

function ownedBy(field: SystemOrderField, isEdge: boolean): boolean {
  return field.owner === "both" || field.owner === (isEdge ? "edge" : "node");
}

/**
 * A metadata field an alias stores, named by its key under `meta` in a
 * selected row (`createdAt`), which is also its key under `$meta` in
 * predicate accessors and expression contexts.
 */
export type SystemMetadataField = Readonly<{
  name: string;
  column: string;
  nullable: boolean;
  valueType: NonNullable<FieldRef["valueType"]>;
  timestamp: boolean;
  integer: boolean;
}>;

function metadataFields(
  isEdge: boolean,
): ReadonlyMap<string, SystemMetadataField> {
  return new Map(
    SYSTEM_ORDER_FIELDS.flatMap((field) => {
      const [namespace, name] = field.selectedPath;
      if (namespace !== "meta" || name === undefined || !ownedBy(field, isEdge))
        return [];
      const metadata: SystemMetadataField = {
        name,
        column: field.column,
        nullable: field.nullable,
        valueType: field.valueType,
        timestamp: field.timestamp === true,
        integer: field.integer === true,
      };
      return [[name, metadata] as const];
    }),
  );
}

const NODE_METADATA_FIELDS = metadataFields(false);
const EDGE_METADATA_FIELDS = metadataFields(true);

/**
 * The metadata fields by physical column. Node and edge fields share their
 * columns, so one map resolves either alias's field reference.
 */
const METADATA_FIELDS_BY_COLUMN: ReadonlyMap<string, SystemMetadataField> =
  new Map(
    [...NODE_METADATA_FIELDS.values(), ...EDGE_METADATA_FIELDS.values()].map(
      (field) => [field.column, field],
    ),
  );

/** The smallest and largest values PostgreSQL's `integer` column stores. */
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

/**
 * The metadata field a predicate's field reference compares, or `undefined`
 * for any other reference (a property, `id`, `kind`, an edge endpoint).
 */
function metadataFieldOfReference(
  reference: FieldRef,
): SystemMetadataField | undefined {
  if (reference.jsonPointer !== undefined || reference.path.length !== 1)
    return undefined;
  const [column] = reference.path;
  return column === undefined ? undefined : (
      METADATA_FIELDS_BY_COLUMN.get(column)
    );
}

/**
 * Refuses one operand a metadata predicate compares against a metadata
 * column unless every backend compares it the same way. It is the single
 * check for a literal (the `$meta` accessor calls it before building the
 * predicate) and for a `param()` binding (prepared-query validation calls it
 * for every value bound against a metadata field), so both refuse before any
 * SQL runs:
 *
 * - `version` takes a 32-bit integer. PostgreSQL rejects `1.5` or `2 ** 31`
 *   against its `integer` column, while SQLite compared them numerically.
 * - A timestamp takes a `Date` or a canonical UTC ISO-8601 string
 *   (`YYYY-MM-DDTHH:mm:ss.sssZ`, via `validateCanonicalIsoDate`). SQLite
 *   compares the stored text and PostgreSQL the parsed instant, so
 *   `"2021-01-01T00:00:00Z"` — the instant of a stored
 *   `"2021-01-01T00:00:00.000Z"` but text that sorts after it — matched
 *   `lt` on SQLite and not on PostgreSQL.
 *
 * A reference to anything other than a metadata column is not checked here.
 */
export function assertMetadataOperand(
  reference: FieldRef,
  operand: unknown,
): void {
  const field = metadataFieldOfReference(reference);
  if (field === undefined) return;
  const path = `${reference.alias}.$meta.${field.name}`;
  if (field.timestamp) {
    if (operand instanceof Date && !Number.isNaN(operand.getTime())) return;
    if (typeof operand === "string") {
      validateCanonicalIsoDate(operand, path);
      return;
    }
    refuseMetadataOperand(
      path,
      operand,
      "a Date or a canonical UTC ISO-8601 string (YYYY-MM-DDTHH:mm:ss.sssZ)",
    );
  }
  if (
    field.integer &&
    !(
      typeof operand === "number" &&
      Number.isInteger(operand) &&
      operand >= INT32_MIN &&
      operand <= INT32_MAX
    )
  ) {
    refuseMetadataOperand(
      path,
      operand,
      `an integer from ${INT32_MIN} to ${INT32_MAX}`,
    );
  }
}

function refuseMetadataOperand(
  path: string,
  operand: unknown,
  expected: string,
): never {
  const received =
    operand instanceof Date ? "an invalid Date" : (
      `${typeof operand} ${String(operand)}`
    );
  throw new ValidationError(
    `Invalid operand for "${path}": expected ${expected}, got ${received}.`,
    { issues: [{ path, message: `Expected ${expected}, got ${received}` }] },
  );
}

/** The metadata fields a node or edge alias stores, in table order. */
export function systemMetadataFields(
  isEdge: boolean,
): readonly SystemMetadataField[] {
  return [...(isEdge ? EDGE_METADATA_FIELDS : NODE_METADATA_FIELDS).values()];
}

/**
 * Resolves a metadata field by its key under `meta` / `$meta`, or
 * `undefined` when this alias stores no such field (`version` on an edge).
 */
export function resolveSystemMetadataField(
  name: string,
  isEdge: boolean,
): SystemMetadataField | undefined {
  return (isEdge ? EDGE_METADATA_FIELDS : NODE_METADATA_FIELDS).get(name);
}

/**
 * Refuses `$meta.<name>` for a name this alias stores no metadata field for,
 * listing the ones it does. The typed accessors make the same name a compile
 * error; this is the refusal an untyped caller reaches.
 */
export function refuseUnknownMetadataField(
  alias: string,
  name: string,
  isEdge: boolean,
): never {
  const available = systemMetadataFields(isEdge).map((field) => field.name);
  throw new ConfigurationError(
    `"${alias}.$meta.${name}" is not a metadata field of this ${isEdge ? "edge" : "node"} alias.`,
    { code: "METADATA_FIELD_UNKNOWN", alias, field: name, available },
    { suggestion: `Use one of: ${available.join(", ")}.` },
  );
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
 * Refuses a snake_case system name the previous release accepted
 * (`created_at`, `from_id`, …) that the alias does not declare as a
 * property, naming its replacement. Refused on every schema, open ones
 * included: the previous release read the name as the system column, so
 * reading a property of that name instead would silently change what
 * existing queries sort by.
 */
function refuseRemovedSystemName(
  alias: string,
  field: string,
  isEdge: boolean,
): void {
  const removed = SYSTEM_ORDER_FIELDS_BY_REMOVED_NAME.get(field);
  if (removed === undefined || !ownedBy(removed, isEdge)) return;
  const replacement = orderName(removed);
  throw new ConfigurationError(
    `orderBy("${alias}", "${field}"): "${field}" is no longer an order field name; use "${replacement}".`,
    { code: "ORDER_FIELD_RENAMED", alias, field, replacement },
    {
      suggestion: `System fields are ordered by their path in a selected row: orderBy("${alias}", "${replacement}"). Declare "${field}" in the schema to order by a property of that name.`,
    },
  );
}

/**
 * Refuses an order field that names neither a system field nor a property
 * the alias's closed schema declares. A name equal to a system column
 * (`version`) is pointed at that field's order name.
 */
function refuseUnknownOrderField(
  alias: string,
  field: string,
  isEdge: boolean,
): never {
  const column = SYSTEM_ORDER_FIELDS_BY_COLUMN.get(field);
  const nearest =
    column !== undefined && ownedBy(column, isEdge) ?
      `Did you mean "${orderName(column)}"? `
    : "";
  throw new ConfigurationError(
    `orderBy("${alias}", "${field}"): "${field}" is not a property declared by this ${isEdge ? "edge" : "node"} alias or an orderable system field.`,
    { code: "ORDER_FIELD_UNKNOWN", alias, field },
    {
      suggestion: `${nearest}Order by a declared property or one of: ${systemOrderNames(isEdge).join(", ")}.`,
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
  if (!declared) {
    // A removed snake_case system name is refused on any schema: the previous
    // release read it as the system column, so silently reading a property of
    // the same name instead would change what existing queries sort by.
    refuseRemovedSystemName(alias, field, kinds.isEdge);
    const closed =
      kinds.isEdge ?
        introspector.hasClosedEdgePropertySet(kinds.edgeKindNames)
      : introspector.hasClosedPropertySet(kinds.nodeKindNames);
    // Only a closed property set proves the name cannot be stored: an open
    // schema, or one whose shape cannot be read, may hold any key.
    if (closed) refuseUnknownOrderField(alias, field, kinds.isEdge);
  }

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
