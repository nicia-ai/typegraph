/**
 * Schema migration utilities.
 *
 * Provides diff detection between schema versions to identify
 * what has changed and what migrations might be needed.
 */
import { type IndexEntity } from "../core/types";
import { type IndexDeclaration } from "../indexes/types";
import { compareStrings } from "../utils/compare";
import { requireDefined } from "../utils/presence";
import { canonicalEqual, sortedReplacer } from "./canonical";
import {
  type JsonSchema,
  type SerializedEdgeDef,
  type SerializedNodeDef,
  type SerializedOntology,
  type SerializedSchema,
} from "./types";

// ============================================================
// Change Types
// ============================================================

/**
 * Types of changes that can occur in a schema.
 */
export type ChangeType = "added" | "removed" | "modified" | "renamed";

/**
 * Severity of a change for migration purposes.
 */
export type ChangeSeverity =
  | "safe" // No data migration needed
  | "warning" // Might need attention
  | "breaking"; // Requires data migration

// ============================================================
// Node Changes
// ============================================================

/**
 * A change to a node definition.
 */
export type NodeChange = Readonly<{
  type: ChangeType;
  kind: string;
  severity: ChangeSeverity;
  details: string;
  before?: SerializedNodeDef | undefined;
  after?: SerializedNodeDef | undefined;
}>;

// ============================================================
// Edge Changes
// ============================================================

/**
 * A change to an edge definition.
 */
export type EdgeChange = Readonly<{
  type: ChangeType;
  kind: string;
  severity: ChangeSeverity;
  details: string;
  before?: SerializedEdgeDef | undefined;
  after?: SerializedEdgeDef | undefined;
}>;

// ============================================================
// Ontology Changes
// ============================================================

/**
 * A change to the ontology.
 */
export type OntologyChange = Readonly<{
  type: ChangeType;
  entity: "metaEdge" | "relation";
  name: string;
  severity: ChangeSeverity;
  details: string;
}>;

// ============================================================
// Index Changes
// ============================================================

/**
 * A change to an index declaration.
 *
 * Index changes are always `safe`-severity: index DDL is materialized
 * separately and never blocks schema-version commits or migrations.
 * Adding, removing, or modifying an index never invalidates existing
 * data — it only changes which physical indexes the deployment will
 * materialize on its next pass.
 */
export type IndexChange = Readonly<{
  type: ChangeType;
  /** Index name (the diffing identity key). */
  name: string;
  /**
   * Whether this index is on a node, edge, or vector field. Vector
   * index changes flow through the same diff classification as
   * relational ones.
   */
  entity: IndexEntity;
  severity: ChangeSeverity;
  details: string;
  before?: IndexDeclaration | undefined;
  after?: IndexDeclaration | undefined;
}>;

// ============================================================
// Graph Extension Document Changes
// ============================================================

/**
 * A change to the persisted graph-extension document.
 *
 * Graph-extension document changes are committed only through the
 * graph-extension lifecycle verbs (`evolve` and `removeKinds`), so the
 * extension-slice change itself is `safe`-severity. The detailed
 * per-kind effect is captured in the corresponding node/edge/ontology
 * changes the merged document produced.
 */
export type ExtensionChange = Readonly<{
  type: ChangeType;
  severity: ChangeSeverity;
  details: string;
}>;

// ============================================================
// Deprecated Kinds Changes
// ============================================================

/**
 * Change to the soft-deprecated kind set. `safe`-severity by
 * construction — deprecation is a metadata signal that doesn't gate
 * reads, writes, or queries. The `added` and `removed` arrays carry
 * the per-name deltas so consumers can render granular diffs.
 */
export type DeprecatedKindsChange = Readonly<{
  added: readonly string[];
  removed: readonly string[];
  severity: ChangeSeverity;
  details: string;
}>;

// ============================================================
// Schema Diff
// ============================================================

/**
 * A complete diff between two schema versions.
 */
export type SchemaDiff = Readonly<{
  fromVersion: number;
  toVersion: number;

  /** Changes to node definitions */
  nodes: readonly NodeChange[];

  /** Changes to edge definitions */
  edges: readonly EdgeChange[];

  /** Changes to ontology */
  ontology: readonly OntologyChange[];

  /** Changes to index declarations */
  indexes: readonly IndexChange[];

  /**
   * Change to the graph-extension document, if any. `undefined` when
   * the slice is unchanged on both sides (the common case).
   */
  extension?: ExtensionChange;

  /**
   * Change to the soft-deprecated kind set, if any. `undefined` when
   * the set is unchanged on both sides.
   */
  deprecatedKinds?: DeprecatedKindsChange;

  /** Whether any breaking changes exist */
  hasBreakingChanges: boolean;

  /** Whether the change is backwards compatible (no breaking changes) */
  isBackwardsCompatible: boolean;

  /** Whether any changes exist at all */
  hasChanges: boolean;

  /** Summary of changes */
  summary: string;
}>;

// ============================================================
// Diff Computation
// ============================================================

/**
 * Computes the diff between two schema versions.
 *
 * @param before - The previous schema version
 * @param after - The new schema version
 * @returns A diff describing all changes
 */
export function computeSchemaDiff(
  before: SerializedSchema,
  after: SerializedSchema,
): SchemaDiff {
  const nodeChanges = diffNodes(before.nodes, after.nodes);
  const edgeChanges = diffEdges(before.edges, after.edges);
  const ontologyChanges = diffOntology(before.ontology, after.ontology);
  const indexChanges = diffIndexes(before.indexes, after.indexes);
  const extensionChange = diffExtension(before.extension, after.extension);
  const deprecatedKindsChange = diffDeprecatedKinds(
    before.deprecatedKinds,
    after.deprecatedKinds,
  );

  const allChanges = [
    ...nodeChanges,
    ...edgeChanges,
    ...ontologyChanges,
    ...indexChanges,
  ];
  const hasBreakingChanges = allChanges.some(
    (change) => change.severity === "breaking",
  );
  const hasChanges =
    allChanges.length > 0 ||
    extensionChange !== undefined ||
    deprecatedKindsChange !== undefined;

  const summary = generateSummary(
    nodeChanges,
    edgeChanges,
    ontologyChanges,
    indexChanges,
    extensionChange,
    deprecatedKindsChange,
  );

  return {
    fromVersion: before.version,
    toVersion: after.version,
    nodes: nodeChanges,
    edges: edgeChanges,
    ontology: ontologyChanges,
    indexes: indexChanges,
    ...(extensionChange === undefined ? {} : { extension: extensionChange }),
    ...(deprecatedKindsChange === undefined ?
      {}
    : { deprecatedKinds: deprecatedKindsChange }),
    hasBreakingChanges,
    isBackwardsCompatible: !hasBreakingChanges,
    hasChanges,
    summary,
  };
}

// ============================================================
// Node Diff
// ============================================================

/**
 * Computes changes between node definitions.
 */
function diffNodes(
  before: Record<string, SerializedNodeDef>,
  after: Record<string, SerializedNodeDef>,
): readonly NodeChange[] {
  const changes: NodeChange[] = [];
  const beforeNames = new Set(Object.keys(before));
  const afterNames = new Set(Object.keys(after));

  // Find removed nodes
  for (const name of beforeNames) {
    if (!afterNames.has(name)) {
      changes.push({
        type: "removed",
        kind: name,
        severity: "breaking",
        details: `Node kind "${name}" was removed`,
        before: before[name],
      });
    }
  }

  // Find added nodes
  for (const name of afterNames) {
    if (!beforeNames.has(name)) {
      changes.push({
        type: "added",
        kind: name,
        severity: "safe",
        details: `Node kind "${name}" was added`,
        after: after[name],
      });
    }
  }

  // Find modified nodes
  for (const name of beforeNames) {
    if (afterNames.has(name)) {
      const nodeBefore = requireDefined(before[name]);
      const nodeAfter = requireDefined(after[name]);
      const nodeChanges = diffNodeDef(name, nodeBefore, nodeAfter);
      changes.push(...nodeChanges);
    }
  }

  return changes;
}

/**
 * JSON-Schema keywords whose array value is semantically a *set*: `required`
 * lists which properties must be present, `enum` lists which values are
 * allowed. Reordering either changes nothing a validator — or a stored row —
 * can observe, so a reordering must not read as a schema change.
 *
 * Other arrays are deliberately left in order: `prefixItems` is positional,
 * and composition members (`allOf` / `anyOf` / `oneOf`) can carry
 * order-dependent evaluation semantics.
 */
const SET_VALUED_KEYWORDS: ReadonlySet<string> = new Set(["required", "enum"]);

/**
 * Keywords whose value is a subschema, or an array of subschemas. Recursion is
 * an **allowlist**: anything not named here is preserved verbatim.
 *
 * That direction matters. Recursing by default would apply schema semantics to
 * values that are not schemas — instance data (`default`, `const`, `examples`)
 * and arbitrary extension keys, which Zod's `.meta()` merges straight into the
 * generated JSON Schema. A key merely *named* `required` inside one of those
 * would then be sorted, silently normalizing away a real change. Failing the
 * other way is safe: an unrecognized schema-valued keyword is left unsorted, so
 * a reordering inside it reads as a change rather than being hidden.
 */
const SCHEMA_VALUED_KEYWORDS: ReadonlySet<string> = new Set([
  "additionalProperties",
  "allOf",
  "anyOf",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "oneOf",
  "prefixItems",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

/**
 * Keywords holding a *map of subschemas keyed by user-chosen names*. Their keys
 * are property names, not keywords, so a property called `default` or `enum`
 * must not be read as the keyword of the same name — its value is an ordinary
 * subschema and still needs normalizing.
 */
const SUBSCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
]);

/**
 * Maps a property name to the set of property names it requires. User-keyed
 * like {@link SUBSCHEMA_MAP_KEYWORDS}, but each value is a set of names rather
 * than a subschema.
 */
const DEPENDENT_REQUIRED_KEYWORD = "dependentRequired";

function canonicalKey(value: unknown): string {
  return JSON.stringify(value, sortedReplacer);
}

function sortedByCanonicalForm(items: readonly unknown[]): readonly unknown[] {
  // `compareStrings`, not `localeCompare`: the ordering has to be identical in
  // every process that diffs this schema, and locale-aware collation varies
  // with the host's ICU configuration.
  return items.toSorted((left, right) =>
    compareStrings(canonicalKey(left), canonicalKey(right)),
  );
}

/**
 * Recursively order-normalizes {@link SET_VALUED_KEYWORDS} arrays so that a
 * pure reordering compares equal.
 *
 * Deliberately *not* folded into `canonicalEqual` / `sortedReplacer`: that
 * canonical form also feeds `computeSchemaHash`, and normalizing arrays there
 * would change the hash of every schema already committed to a database.
 * This normalization is scoped to diff comparison only.
 */
function orderNormalizedSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => orderNormalizedSchema(item));
  }
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      normalized[key] = normalizedKeywordValue(key, entry);
    }
    return normalized;
  }
  return value;
}

/**
 * Normalizes one keyword's value according to what that keyword *holds*.
 *
 * The distinction matters: descending into a keyword blindly would apply
 * schema semantics to instance data, so a reordered array inside a `default`
 * (or inside an `enum` member) would be silently treated as unchanged.
 */
function normalizedKeywordValue(key: string, value: unknown): unknown {
  if (SET_VALUED_KEYWORDS.has(key) && Array.isArray(value)) {
    // Order-normalize the set itself, but leave each member alone: `enum`
    // members are instance values and `required` members are plain names.
    return sortedByCanonicalForm(value);
  }
  if (SUBSCHEMA_MAP_KEYWORDS.has(key)) return normalizedSubschemaMap(value);
  if (key === DEPENDENT_REQUIRED_KEYWORD) {
    return normalizedDependentRequired(value);
  }
  if (SCHEMA_VALUED_KEYWORDS.has(key)) return orderNormalizedSchema(value);
  // Everything else is preserved verbatim: annotations (`title`), instance
  // data (`default`, `const`, `examples`), and unknown extension keys. See
  // {@link SCHEMA_VALUED_KEYWORDS} for why recursion is an allowlist.
  return value;
}

/** Order-normalizes each name set in a `dependentRequired` map. */
function normalizedDependentRequired(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const normalized: Record<string, unknown> = {};
  for (const [name, required] of Object.entries(value)) {
    normalized[name] =
      Array.isArray(required) ? sortedByCanonicalForm(required) : required;
  }
  return normalized;
}

/**
 * Normalizes a map of subschemas without treating its user-chosen keys as
 * keywords — so a property named `default` is still normalized as the
 * subschema it is.
 */
function normalizedSubschemaMap(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return orderNormalizedSchema(value);
  }
  const normalized: Record<string, unknown> = {};
  for (const [name, subschema] of Object.entries(value)) {
    normalized[name] = orderNormalizedSchema(subschema);
  }
  return normalized;
}

/**
 * Whether two property JSON-Schemas are the same schema. Insensitive to the
 * order of set-valued keywords, so restating a kind with its fields declared
 * in a different order is correctly a no-op rather than a "modified" kind that
 * forces a migration.
 */
function propertySchemasEqual(before: unknown, after: unknown): boolean {
  return canonicalEqual(
    orderNormalizedSchema(before),
    orderNormalizedSchema(after),
  );
}

/**
 * Endpoint kind lists are sets — the order edge endpoints are declared in
 * carries no meaning.
 */
function endpointKindsEqual(
  before: readonly string[] | undefined,
  after: readonly string[] | undefined,
): boolean {
  return canonicalEqual(before?.toSorted(), after?.toSorted());
}

/**
 * Computes changes to a single node definition.
 */
function diffNodeDef(
  name: string,
  before: SerializedNodeDef,
  after: SerializedNodeDef,
): readonly NodeChange[] {
  const changes: NodeChange[] = [];

  // Check property schema changes
  if (!propertySchemasEqual(before.properties, after.properties)) {
    const { severity, details } = classifyPropertyChanges(
      name,
      before.properties,
      after.properties,
    );

    changes.push({
      type: "modified",
      kind: name,
      severity,
      details,
      before,
      after,
    });
  }

  // Check onDelete behavior
  if (before.onDelete !== after.onDelete) {
    changes.push({
      type: "modified",
      kind: name,
      severity: "warning",
      details: `onDelete changed from "${before.onDelete}" to "${after.onDelete}" for "${name}"`,
      before,
      after,
    });
  }

  // Check unique constraints
  if (!canonicalEqual(before.uniqueConstraints, after.uniqueConstraints)) {
    changes.push({
      type: "modified",
      kind: name,
      severity: "warning",
      details: `Unique constraints changed for "${name}"`,
      before,
      after,
    });
  }

  if (annotationsChanged(before.annotations, after.annotations)) {
    changes.push({
      type: "modified",
      kind: name,
      severity: "safe",
      details: `Annotations changed for "${name}"`,
      before,
      after,
    });
  }

  return changes;
}

/**
 * A comparable token for a property's JSON-Schema type. A change here
 * (`string` → `number`, or scalar → union / enum / const) means existing
 * JSON-encoded props no longer satisfy the declared type, which no data-free
 * migration can reconcile.
 */
function propertyTypeSignature(schema: JsonSchema): string {
  if (schema.type !== undefined) return JSON.stringify(schema.type);
  if (schema.const !== undefined) return "const";
  if (schema.enum !== undefined) return "enum";
  if (schema.anyOf !== undefined) return "anyOf";
  if (schema.oneOf !== undefined) return "oneOf";
  if (schema.allOf !== undefined) return "allOf";
  return "unknown";
}

/**
 * Non-constraining JSON-Schema keywords: changing them cannot invalidate an
 * existing stored value, so a diff limited to these is safe.
 */
const NON_CONSTRAINING_KEYWORDS = new Set([
  "description",
  "title",
  "default",
  "$schema",
]);

/** A copy of `schema` with the non-constraining keywords removed. */
function stripSchemaMetadata(schema: JsonSchema): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!NON_CONSTRAINING_KEYWORDS.has(key)) stripped[key] = value;
  }
  return stripped;
}

function isObjectSchema(schema: JsonSchema): boolean {
  return schema.type === "object" || schema.properties !== undefined;
}

/**
 * Whether replacing property schema `before` with `after` can invalidate an
 * existing stored value — i.e. whether the change is breaking. Deliberately
 * conservative: it returns `false` (safe) only for changes it can prove are
 * non-breaking, and `true` for everything else.
 *
 * Provably safe: a metadata-only change; an object whose nested change is itself
 * safe (recursively) with no removed or newly-required nested property (so
 * adding an optional nested field stays safe). Everything else — a changed type
 * token, an array whose items changed, an enum/const change, a composition
 * change, or any constraint change on a scalar — is treated as breaking. This
 * mirrors how the top-level property diff classifies node/edge properties, so a
 * change nested inside an object, array, or enum is caught the same way a
 * top-level one is (rather than passing as a non-blocking warning and
 * auto-migrating over rows that no longer satisfy the schema).
 */
function isBreakingPropertyChange(
  before: JsonSchema,
  after: JsonSchema,
): boolean {
  if (
    propertySchemasEqual(
      stripSchemaMetadata(before),
      stripSchemaMetadata(after),
    )
  ) {
    return false;
  }
  if (propertyTypeSignature(before) !== propertyTypeSignature(after)) {
    return true;
  }
  if (isObjectSchema(before) && isObjectSchema(after)) {
    return isBreakingObjectSchemaChange(before, after);
  }
  // Same top-level token, but a constraining change the recursion above does not
  // model (array items, enum/const values, composition members, scalar bounds).
  // Cannot prove it is a loosening, so treat it as breaking.
  return true;
}

/** Recursive breaking-change check for two object JSON-Schemas. */
function isBreakingObjectSchemaChange(
  before: JsonSchema,
  after: JsonSchema,
): boolean {
  const beforeProps = before.properties ?? {};
  const afterProps = after.properties ?? {};
  const beforeRequired = new Set(before.required);
  const afterRequired = new Set(after.required);

  for (const key of Object.keys(beforeProps)) {
    if (!(key in afterProps)) return true; // nested property removed
  }
  for (const key of afterRequired) {
    if (!beforeRequired.has(key)) return true; // nested property newly required
  }
  for (const [key, beforeChild] of Object.entries(beforeProps)) {
    const afterChild = afterProps[key];
    if (afterChild === undefined) continue; // removal already handled above
    if (isBreakingPropertyChange(beforeChild, afterChild)) return true;
  }
  return false; // only additive optional / provably-safe nested changes
}

/**
 * Classifies a change to a node/edge's property JSON-Schema. Props are stored
 * as a single JSON column with no per-field DDL, so the schema is enforced only
 * at the application layer — a diff-based migration cannot rewrite existing
 * rows. A change is therefore only ever **breaking** or **safe**:
 *
 *  - **breaking** when existing rows can no longer be proven to satisfy the new
 *    schema and no data-free migration fixes it: a removed property, a newly
 *    required property, or a shared property whose schema changed in a way that
 *    is not provably a loosening (a changed type token, a changed array item
 *    schema, an enum/const/composition change, a scalar constraint change, or a
 *    breaking change nested inside an object). `ensureSchema` refuses to
 *    auto-migrate these (throws `MigrationError` with the data actions).
 *  - **safe** when the only changes are new optional properties, metadata-only
 *    edits, or additive optional fields nested inside an object.
 *
 * Deliberately conservative: a change is called safe only when
 * {@link isBreakingPropertyChange} can prove it non-breaking, so an ambiguous
 * change (e.g. a scalar → union *widening*, or a same-type constraint change)
 * is reported breaking — a false positive the operator acknowledges — rather
 * than risk auto-migrating over rows that no longer satisfy the schema. There
 * is no "warning" bucket: an unproven change blocks rather than silently
 * migrating.
 */
function classifyPropertyChanges(
  kind: string,
  before: JsonSchema,
  after: JsonSchema,
): { severity: ChangeSeverity; details: string } {
  const beforeProps = before.properties ?? {};
  const afterProps = after.properties ?? {};
  const beforeRequired = new Set(before.required);
  const afterRequired = new Set(after.required);

  const removed = Object.keys(beforeProps).filter((p) => !(p in afterProps));
  const added = Object.keys(afterProps).filter((p) => !(p in beforeProps));
  const newRequired = [...afterRequired].filter((p) => !beforeRequired.has(p));

  // A shared property whose schema changed in a way that can invalidate existing
  // rows (type/shape change, a breaking nested/array/enum/constraint change).
  const breakingProps: string[] = [];
  for (const [property, beforeProperty] of Object.entries(beforeProps)) {
    const afterProperty = afterProps[property];
    if (afterProperty === undefined) continue; // removed — handled below
    if (canonicalEqual(beforeProperty, afterProperty)) continue; // unchanged
    if (isBreakingPropertyChange(beforeProperty, afterProperty)) {
      breakingProps.push(property);
    }
  }

  if (removed.length > 0) {
    return {
      severity: "breaking",
      details: `Properties removed from "${kind}": ${removed.join(", ")}`,
    };
  }
  if (breakingProps.length > 0) {
    return {
      severity: "breaking",
      details: `Property schemas changed incompatibly in "${kind}": ${breakingProps.join(", ")}`,
    };
  }
  if (newRequired.length > 0) {
    return {
      severity: "breaking",
      details: `New required properties in "${kind}": ${newRequired.join(", ")}`,
    };
  }
  if (added.length > 0) {
    return {
      severity: "safe",
      details: `Properties added to "${kind}": ${added.join(", ")}`,
    };
  }
  // Only provably non-breaking property changes remain (metadata, additive
  // optional nested fields, a widened/loosened shape the checks above cleared).
  return { severity: "safe", details: `Properties changed in "${kind}"` };
}

// ============================================================
// Edge Diff
// ============================================================

/**
 * Computes changes between edge definitions.
 */
function diffEdges(
  before: Record<string, SerializedEdgeDef>,
  after: Record<string, SerializedEdgeDef>,
): readonly EdgeChange[] {
  const changes: EdgeChange[] = [];
  const beforeNames = new Set(Object.keys(before));
  const afterNames = new Set(Object.keys(after));

  // Find removed edges
  for (const name of beforeNames) {
    if (!afterNames.has(name)) {
      changes.push({
        type: "removed",
        kind: name,
        severity: "breaking",
        details: `Edge kind "${name}" was removed`,
        before: before[name],
      });
    }
  }

  // Find added edges
  for (const name of afterNames) {
    if (!beforeNames.has(name)) {
      changes.push({
        type: "added",
        kind: name,
        severity: "safe",
        details: `Edge kind "${name}" was added`,
        after: after[name],
      });
    }
  }

  // Find modified edges
  for (const name of beforeNames) {
    if (afterNames.has(name)) {
      const edgeBefore = requireDefined(before[name]);
      const edgeAfter = requireDefined(after[name]);
      const edgeChanges = diffEdgeDef(name, edgeBefore, edgeAfter);
      changes.push(...edgeChanges);
    }
  }

  return changes;
}

/**
 * Computes changes to a single edge definition.
 */
function diffEdgeDef(
  name: string,
  before: SerializedEdgeDef,
  after: SerializedEdgeDef,
): readonly EdgeChange[] {
  const changes: EdgeChange[] = [];

  // Check endpoint kinds
  if (!endpointKindsEqual(before.fromKinds, after.fromKinds)) {
    changes.push({
      type: "modified",
      kind: name,
      severity: "warning",
      details: `fromKinds changed for "${name}"`,
      before,
      after,
    });
  }

  if (!endpointKindsEqual(before.toKinds, after.toKinds)) {
    changes.push({
      type: "modified",
      kind: name,
      severity: "warning",
      details: `toKinds changed for "${name}"`,
      before,
      after,
    });
  }

  // Check cardinality
  if (before.cardinality !== after.cardinality) {
    changes.push({
      type: "modified",
      kind: name,
      severity: "warning",
      details: `Cardinality changed from "${before.cardinality}" to "${after.cardinality}" for "${name}"`,
      before,
      after,
    });
  }

  // Check properties
  if (!propertySchemasEqual(before.properties, after.properties)) {
    const { severity, details } = classifyPropertyChanges(
      name,
      before.properties,
      after.properties,
    );
    changes.push({
      type: "modified",
      kind: name,
      severity,
      details,
      before,
      after,
    });
  }

  if (annotationsChanged(before.annotations, after.annotations)) {
    changes.push({
      type: "modified",
      kind: name,
      severity: "safe",
      details: `Annotations changed for "${name}"`,
      before,
      after,
    });
  }

  return changes;
}

function annotationsChanged(before: unknown, after: unknown): boolean {
  if (before === undefined && after === undefined) return false;
  if (before === undefined || after === undefined) return true;
  return !canonicalEqual(before, after);
}

// ============================================================
// Ontology Diff
// ============================================================

/**
 * Computes changes to the ontology.
 */
function diffOntology(
  before: SerializedOntology,
  after: SerializedOntology,
): readonly OntologyChange[] {
  const changes: OntologyChange[] = [];

  // Diff meta-edges
  const metaEdgesBefore = new Set(Object.keys(before.metaEdges));
  const metaEdgesAfter = new Set(Object.keys(after.metaEdges));

  for (const name of metaEdgesBefore) {
    if (!metaEdgesAfter.has(name)) {
      changes.push({
        type: "removed",
        entity: "metaEdge",
        name,
        severity: "breaking",
        details: `Meta-edge "${name}" was removed`,
      });
    }
  }

  for (const name of metaEdgesAfter) {
    if (!metaEdgesBefore.has(name)) {
      changes.push({
        type: "added",
        entity: "metaEdge",
        name,
        severity: "safe",
        details: `Meta-edge "${name}" was added`,
      });
    }
  }

  // Diff relations (simplified - just detect additions/removals)
  const relationsBefore = new Set(
    before.relations.map((r) => `${r.metaEdge}:${r.from}:${r.to}`),
  );
  const relationsAfter = new Set(
    after.relations.map((r) => `${r.metaEdge}:${r.from}:${r.to}`),
  );

  for (const relationKey of relationsBefore) {
    if (!relationsAfter.has(relationKey)) {
      const [metaEdge, from, to] = relationKey.split(":");
      changes.push({
        type: "removed",
        entity: "relation",
        name: relationKey,
        severity: "warning",
        details: `Relation ${metaEdge}(${from}, ${to}) was removed`,
      });
    }
  }

  for (const relationKey of relationsAfter) {
    if (!relationsBefore.has(relationKey)) {
      const [metaEdge, from, to] = relationKey.split(":");
      changes.push({
        type: "added",
        entity: "relation",
        name: relationKey,
        severity: "safe",
        details: `Relation ${metaEdge}(${from}, ${to}) was added`,
      });
    }
  }

  return changes;
}

// ============================================================
// Index Diff
// ============================================================

/**
 * Computes changes between index declarations.
 *
 * Indexes are identified by `name`. Add/remove/modify produce
 * `safe`-severity changes — index DDL is materialized separately and
 * never blocks schema-version commits.
 */
function diffIndexes(
  before: readonly IndexDeclaration[] | undefined,
  after: readonly IndexDeclaration[] | undefined,
): readonly IndexChange[] {
  const beforeIndexes = before ?? [];
  const afterIndexes = after ?? [];

  const beforeByName = new Map<string, IndexDeclaration>();
  for (const index of beforeIndexes) {
    beforeByName.set(index.name, index);
  }
  const afterByName = new Map<string, IndexDeclaration>();
  for (const index of afterIndexes) {
    afterByName.set(index.name, index);
  }

  const changes: IndexChange[] = [];

  for (const [name, index] of beforeByName) {
    if (!afterByName.has(name)) {
      changes.push({
        type: "removed",
        name,
        entity: index.entity,
        severity: "safe",
        details: `Index "${name}" was removed`,
        before: index,
      });
    }
  }

  for (const [name, index] of afterByName) {
    if (!beforeByName.has(name)) {
      changes.push({
        type: "added",
        name,
        entity: index.entity,
        severity: "safe",
        details: `Index "${name}" was added`,
        after: index,
      });
    }
  }

  for (const [name, beforeIndex] of beforeByName) {
    const afterIndex = afterByName.get(name);
    if (!afterIndex) continue;
    if (!canonicalEqual(beforeIndex, afterIndex)) {
      changes.push({
        type: "modified",
        name,
        entity: beforeIndex.entity,
        severity: "safe",
        details: `Index "${name}" was modified`,
        before: beforeIndex,
        after: afterIndex,
      });
    }
  }

  return changes;
}

// ============================================================
// Graph Extension Document Diff
// ============================================================

/**
 * Computes the change to the graph-extension document, if any. The
 * extension-slice change itself is always `safe` — the per-kind effects
 * of the merged document already surface as node/edge/ontology changes.
 */
function diffExtension(
  before: SerializedSchema["extension"],
  after: SerializedSchema["extension"],
): ExtensionChange | undefined {
  // Reference-equality short-circuit: when the loader threads the same
  // persisted document reference into the merged graph (the common
  // restart-with-no-evolve case), we avoid stringifying potentially
  // large agent-generated documents on every ensureSchema call.
  if (before === after) return undefined;
  if (before === undefined) {
    return {
      type: "added",
      severity: "safe",
      details: "Graph extension document was added",
    };
  }
  if (after === undefined) {
    return {
      type: "removed",
      severity: "safe",
      details: "Graph extension document was removed",
    };
  }
  if (canonicalEqual(before, after)) return undefined;
  return {
    type: "modified",
    severity: "safe",
    details: "Graph extension document was modified",
  };
}

// ============================================================
// Deprecated Kinds Diff
// ============================================================

/**
 * Computes the change to the soft-deprecated kind set, if any.
 * `safe`-severity by construction; the per-name `added` / `removed`
 * deltas let consumers render granular diffs without re-comparing the
 * whole set.
 */
function diffDeprecatedKinds(
  before: SerializedSchema["deprecatedKinds"],
  after: SerializedSchema["deprecatedKinds"],
): DeprecatedKindsChange | undefined {
  // Compare by value. The parse cache may share array identity between
  // repeated reads of the same row, but schema diffs still need to be
  // independent of object identity.
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added: string[] = [];
  const removed: string[] = [];
  for (const name of afterSet) {
    if (!beforeSet.has(name)) added.push(name);
  }
  for (const name of beforeSet) {
    if (!afterSet.has(name)) removed.push(name);
  }
  if (added.length === 0 && removed.length === 0) return undefined;
  added.sort();
  removed.sort();
  const parts: string[] = [];
  if (added.length > 0) parts.push(`added ${added.join(", ")}`);
  if (removed.length > 0) parts.push(`removed ${removed.join(", ")}`);
  return {
    added,
    removed,
    severity: "safe",
    details: `Deprecated kinds: ${parts.join("; ")}`,
  };
}

// ============================================================
// Summary Generation
// ============================================================

/**
 * Generates a human-readable summary of changes.
 */
function generateSummary(
  nodeChanges: readonly NodeChange[],
  edgeChanges: readonly EdgeChange[],
  ontologyChanges: readonly OntologyChange[],
  indexChanges: readonly IndexChange[],
  extensionChange: ExtensionChange | undefined,
  deprecatedKindsChange: DeprecatedKindsChange | undefined,
): string {
  const parts: string[] = [];

  const nodeAdded = nodeChanges.filter((c) => c.type === "added").length;
  const nodeRemoved = nodeChanges.filter((c) => c.type === "removed").length;
  const nodeModified = nodeChanges.filter((c) => c.type === "modified").length;

  if (nodeAdded > 0 || nodeRemoved > 0 || nodeModified > 0) {
    parts.push(
      `Nodes: ${nodeAdded} added, ${nodeRemoved} removed, ${nodeModified} modified`,
    );
  }

  const edgeAdded = edgeChanges.filter((c) => c.type === "added").length;
  const edgeRemoved = edgeChanges.filter((c) => c.type === "removed").length;
  const edgeModified = edgeChanges.filter((c) => c.type === "modified").length;

  if (edgeAdded > 0 || edgeRemoved > 0 || edgeModified > 0) {
    parts.push(
      `Edges: ${edgeAdded} added, ${edgeRemoved} removed, ${edgeModified} modified`,
    );
  }

  const ontologyAdded = ontologyChanges.filter(
    (c) => c.type === "added",
  ).length;
  const ontologyRemoved = ontologyChanges.filter(
    (c) => c.type === "removed",
  ).length;

  if (ontologyAdded > 0 || ontologyRemoved > 0) {
    parts.push(`Ontology: ${ontologyAdded} added, ${ontologyRemoved} removed`);
  }

  const indexAdded = indexChanges.filter((c) => c.type === "added").length;
  const indexRemoved = indexChanges.filter((c) => c.type === "removed").length;
  const indexModified = indexChanges.filter(
    (c) => c.type === "modified",
  ).length;

  if (indexAdded > 0 || indexRemoved > 0 || indexModified > 0) {
    parts.push(
      `Indexes: ${indexAdded} added, ${indexRemoved} removed, ${indexModified} modified`,
    );
  }

  if (extensionChange !== undefined) {
    parts.push(`Graph extension document: ${extensionChange.type}`);
  }

  if (deprecatedKindsChange !== undefined) {
    const { added, removed } = deprecatedKindsChange;
    parts.push(
      `Deprecated kinds: ${added.length} added, ${removed.length} removed`,
    );
  }

  if (parts.length === 0) {
    return "No changes";
  }

  return parts.join("; ");
}

// ============================================================
// Migration Helpers
// ============================================================

/**
 * Checks if a schema change is backwards compatible.
 *
 * A change is backwards compatible if:
 * - No nodes or edges were removed
 * - No required properties were added
 * - No existing properties were removed
 */
export function isBackwardsCompatible(diff: SchemaDiff): boolean {
  return !diff.hasBreakingChanges;
}

/**
 * How a proposed graph relates to the committed schema.
 *
 * - `identical` — a semantic no-op; committing it changes nothing.
 * - `additive` — changes exist and are all backwards compatible.
 * - `incompatible` — at least one breaking change; needs a deliberate
 *   migration decision.
 */
export type SchemaChangeClassification =
  "identical" | "additive" | "incompatible";

/**
 * Classifies a schema diff into the three outcomes a caller actually branches
 * on. Pure — no I/O, no DDL. Pair with `getSchemaChanges(backend, graph)` (or
 * `store.schemaChanges()`) to pre-flight a proposal *before* touching a
 * privileged, migration-gated path.
 */
export function classifySchemaChanges(
  diff: SchemaDiff,
): SchemaChangeClassification {
  if (!diff.hasChanges) return "identical";
  return diff.hasBreakingChanges ? "incompatible" : "additive";
}

/**
 * Gets a list of actions needed for migration.
 */
export function getMigrationActions(diff: SchemaDiff): readonly string[] {
  const actions: string[] = [];

  for (const change of diff.nodes) {
    if (change.type === "removed") {
      actions.push(`DELETE data for removed node kind "${change.kind}"`);
    }
    if (change.severity === "breaking" && change.type === "modified") {
      actions.push(
        `MIGRATE data for node kind "${change.kind}": ${change.details}`,
      );
    }
  }

  for (const change of diff.edges) {
    if (change.type === "removed") {
      actions.push(`DELETE data for removed edge kind "${change.kind}"`);
    }
  }

  return actions;
}
