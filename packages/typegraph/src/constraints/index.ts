/**
 * Constraint validation module.
 *
 * Provides validation functions for enforcing graph constraints:
 * - Uniqueness constraints on node properties
 * - Cardinality constraints on edges
 * - Endpoint type constraints on edges
 * - Disjointness constraints between node kinds
 */

/**
 * Separator used between field values in composite unique keys.
 * Uses ASCII Record Separator (0x1E) — valid UTF-8 and safe for PostgreSQL
 * TEXT columns (unlike \0 which PostgreSQL rejects).
 */
const UNIQUE_KEY_SEPARATOR = "\u001E";

/** Marker for undefined/null field values in unique keys. */
const UNIQUE_KEY_NULL_MARKER = "\u001F"; // ASCII Unit Separator
import {
  type Cardinality,
  type Collation,
  type EdgeRegistration,
  type NullCheckOp,
  type UniqueConstraint,
  type UniquenessScope,
} from "../core/types";
import {
  CardinalityError,
  DisjointError,
  EndpointError,
  UniquenessError,
} from "../errors";
import { type KindRegistry } from "../registry/kind-registry";
import { readOwnProperty } from "../utils/object";
import { isPresent } from "../utils/presence";

// ============================================================
// Uniqueness Validation
// ============================================================

/**
 * Computes the unique key for a node's uniqueness constraint.
 *
 * The key is built by concatenating the specified field values,
 * optionally normalized for case-insensitive comparison.
 *
 * Field values are read by declared OWN key ({@link readOwnProperty}): a
 * constraint may name a field that a props bag does not carry (an absent
 * optional field), and a plain `props[field]` read would answer such a field
 * with the inherited `Object.prototype` member when the field is named after
 * one. A constraint over a field named `toString` then keyed on the inherited
 * function — `""` under `binary` (the function stringified and dropped by
 * `JSON.stringify`) and a `TypeError` under `caseInsensitive` — instead of the
 * null marker every other absent value gets.
 */
export function computeUniqueKey(
  props: Record<string, unknown>,
  fields: readonly string[],
  collation: Collation,
): string {
  const values = fields.map((field) => {
    const value = readOwnProperty(props, field);
    if (value === undefined || value === null) {
      return UNIQUE_KEY_NULL_MARKER;
    }
    // Convert to string, handling primitives safely
    const stringValue =
      typeof value === "string" ? value
      : typeof value === "number" || typeof value === "boolean" ?
        value.toString()
      : JSON.stringify(value);
    return collation === "caseInsensitive" ?
        stringValue.toLowerCase()
      : stringValue;
  });
  return values.join(UNIQUE_KEY_SEPARATOR);
}

/**
 * Checks if a uniqueness constraint's where predicate passes.
 */
export function checkWherePredicate(
  constraint: UniqueConstraint,
  props: Record<string, unknown>,
): boolean {
  if (!constraint.where) {
    return true; // No where clause, always applies
  }

  // Build predicate context
  const predicateBuilder = buildPredicateContext();
  const predicate = constraint.where(predicateBuilder);

  // Evaluate predicate
  return evaluatePredicate(predicate, props);
}

type UniquePredicate = Readonly<{
  __type: "unique_predicate";
  field: string;
  op: NullCheckOp;
}>;

type PredicateContext = Readonly<
  Record<
    string,
    Readonly<{
      isNull: () => UniquePredicate;
      isNotNull: () => UniquePredicate;
    }>
  >
>;

/**
 * Builds the context a constraint's `where` callback names fields on.
 *
 * EVERY field name gets a member, because the builder type declares every
 * schema field as required (`-?` in `UniqueConstraintPredicateBuilder`) —
 * precisely so a partial constraint can ask whether an OPTIONAL field is
 * present. Populating the context from the props bag's own keys instead left a
 * declared-but-absent field with no member, and the callback's access then hit
 * whatever the context's prototype offered: `Object.prototype.toString` for a
 * field named `toString` (so naming it threw "isNull is not a function"), and
 * `undefined` for an ordinary field (so the everyday partial constraint over
 * `externalId` threw — "Cannot read properties of undefined", or "Expected a
 * defined value" through `requireDefined` — for every node written without it).
 *
 * Answering every name is safe because a name comes from the predicate author
 * (the code), never from data, and the field's VALUE is still read from the
 * props bag by own key when the predicate is evaluated — so an absent field
 * evaluates as null, which is what a partial constraint means by absent. This
 * is also the shape `serializeWherePredicate` (src/schema/serializer.ts) has
 * always captured constraints with, so a persisted `where` and an evaluated
 * `where` now see the same builder.
 *
 * The guard against a TYPO'D field name is the type system, not this Proxy:
 * `UniqueConstraintPredicateBuilder` declares exactly the schema's fields, so a
 * typed caller cannot name an undeclared one. An UNTYPED caller naming an
 * undeclared field gets absent-⇒-null semantics (the predicate quietly never
 * applies) rather than a runtime refusal — this function has no schema shape
 * to validate against. Runtime refusal parity with `validateMatchOnFields`
 * would need the shape threaded to every checkWherePredicate call site.
 */
function buildPredicateContext(): PredicateContext {
  return new Proxy<PredicateContext>(
    {},
    {
      get(_target, property) {
        if (typeof property === "symbol") return;
        return {
          isNull: () => ({
            __type: "unique_predicate" as const,
            field: property,
            op: "isNull" as const,
          }),
          isNotNull: () => ({
            __type: "unique_predicate" as const,
            field: property,
            op: "isNotNull" as const,
          }),
        };
      },
    },
  );
}

/**
 * Evaluates a uniqueness predicate.
 */
function evaluatePredicate(
  predicate: unknown,
  props: Record<string, unknown>,
): boolean {
  if (
    typeof predicate !== "object" ||
    predicate === null ||
    !("__type" in predicate)
  ) {
    return true;
  }

  const pred = predicate as {
    __type: string;
    field: string;
    op: NullCheckOp;
  };

  if (pred.__type !== "unique_predicate") {
    return true;
  }

  // Own-key read: `pred.field` is a schema field name, and a props bag that
  // does not carry it must read as absent rather than as the inherited
  // `Object.prototype` member a field named after one would otherwise find
  // (which reads as present, inverting both `isNull` and `isNotNull`).
  const value = readOwnProperty(props, pred.field);
  if (pred.op === "isNull") {
    return value === null || value === undefined;
  }
  return isPresent(value);
}

/**
 * Gets all kinds that should be checked for a uniqueness constraint.
 *
 * For "kindWithSubClasses" scope, includes the entire subclass hierarchy:
 * - The kind itself
 * - All ancestors (parent classes)
 * - All descendants of those ancestors (sibling classes)
 *
 * For "kind" scope, only the specific kind.
 */
export function getKindsForUniquenessCheck(
  baseKind: string,
  scope: UniquenessScope,
  registry: KindRegistry,
): readonly string[] {
  if (scope === "kind") {
    return [baseKind];
  }

  // Get the entire connected subclass hierarchy by finding the root ancestor
  const root = findRootAncestor(baseKind, registry);

  // Return the root and all its descendants (which includes baseKind and siblings)
  return registry.expandSubClasses(root);
}

/**
 * Finds the topmost ancestor of a kind, or the kind itself if it has no ancestors.
 */
function findRootAncestor(kind: string, registry: KindRegistry): string {
  const ancestors = registry.getAncestors(kind);

  if (ancestors.size === 0) {
    return kind;
  }

  // Find an ancestor with no ancestors (the root)
  for (const ancestor of ancestors) {
    if (registry.getAncestors(ancestor).size === 0) {
      return ancestor;
    }
  }

  // If all ancestors have ancestors, recurse up
  const firstAncestor = [...ancestors][0];
  return firstAncestor ? findRootAncestor(firstAncestor, registry) : kind;
}

/**
 * Creates a uniqueness error.
 */
export function createUniquenessError(
  constraintName: string,
  kind: string,
  existingId: string,
  newId: string,
  fields: readonly string[],
): UniquenessError {
  return new UniquenessError({
    constraintName,
    kind,
    existingId,
    newId,
    fields: [...fields],
  });
}

// ============================================================
// Cardinality Validation
// ============================================================

/**
 * Checks if adding an edge would violate cardinality constraints.
 *
 * @param edgeKind - The edge kind being added
 * @param fromKind - The source node kind
 * @param fromId - The source node ID
 * @param cardinality - The cardinality constraint
 * @param existingEdgeCount - Number of existing edges of this kind from this source
 * @param hasActiveEdge - Whether there's an active (valid_to IS NULL) edge
 * @returns Error if violation, undefined if valid
 */
export function checkCardinality(
  edgeKind: string,
  fromKind: string,
  fromId: string,
  cardinality: Cardinality,
  existingEdgeCount: number,
  hasActiveEdge: boolean,
): CardinalityError | undefined {
  switch (cardinality) {
    case "many": {
      // No constraint
      return undefined;
    }
    case "one": {
      // At most one edge of this kind from any source node
      if (existingEdgeCount > 0) {
        return new CardinalityError({
          edgeKind,
          fromKind,
          fromId,
          cardinality: "one",
          existingCount: existingEdgeCount,
        });
      }
      return undefined;
    }
    case "unique": {
      // unique is checked separately per (source, target) pair
      return undefined;
    }
    case "oneActive": {
      // At most one edge with valid_to IS NULL from any source
      if (hasActiveEdge) {
        return new CardinalityError({
          edgeKind,
          fromKind,
          fromId,
          cardinality: "oneActive",
          existingCount: 1,
        });
      }
      return undefined;
    }
  }
}

/**
 * Checks unique edge constraint (at most one edge between any source-target pair).
 */
export function checkUniqueEdge(
  edgeKind: string,
  fromKind: string,
  fromId: string,
  _toKind: string,
  _toId: string,
  existingCount: number,
): CardinalityError | undefined {
  if (existingCount > 0) {
    return new CardinalityError({
      edgeKind,
      fromKind,
      fromId,
      cardinality: "unique",
      existingCount,
    });
  }
  return undefined;
}

// ============================================================
// Endpoint Validation
// ============================================================

/**
 * Validates that an edge's endpoints are valid node kinds.
 */
export function validateEdgeEndpoints(
  edgeKind: string,
  fromKind: string,
  toKind: string,
  registration: EdgeRegistration,
  registry: KindRegistry,
): EndpointError | undefined {
  // Check from kinds
  const validFromKinds = registration.from.map((node) => node.kind);
  if (!registry.isAssignableToAny(fromKind, validFromKinds)) {
    return new EndpointError({
      edgeKind,
      endpoint: "from",
      actualKind: fromKind,
      expectedKinds: validFromKinds,
    });
  }

  // Check to kinds
  const validToKinds = registration.to.map((node) => node.kind);
  if (!registry.isAssignableToAny(toKind, validToKinds)) {
    return new EndpointError({
      edgeKind,
      endpoint: "to",
      actualKind: toKind,
      expectedKinds: validToKinds,
    });
  }

  return undefined;
}

// ============================================================
// Disjointness Validation
// ============================================================

/**
 * Checks if creating a node would violate disjointness constraints.
 *
 * @param nodeId - The node ID being created
 * @param nodeKind - The kind of the new node
 * @param existingKinds - Kinds of existing nodes with the same ID
 * @param registry - The kind registry for disjointness checks
 * @returns Error if disjoint violation, undefined if valid
 */
export function checkDisjointness(
  nodeId: string,
  nodeKind: string,
  existingKinds: readonly string[],
  registry: KindRegistry,
): DisjointError | undefined {
  for (const existingKind of existingKinds) {
    if (registry.areDisjoint(nodeKind, existingKind)) {
      return new DisjointError({
        nodeId,
        attemptedKind: nodeKind,
        conflictingKind: existingKind,
      });
    }
  }
  return undefined;
}

/**
 * Gets all disjoint kinds for a given kind.
 */
export function getDisjointKinds(
  kind: string,
  registry: KindRegistry,
): readonly string[] {
  return registry.getDisjointKinds(kind);
}
