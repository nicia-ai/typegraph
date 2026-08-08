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
  ConfigurationError,
  DisjointError,
  EndpointError,
  UniquenessError,
} from "../errors";
import { type KindRegistry } from "../registry/kind-registry";
import { hasOwnKey, readOwnProperty } from "../utils/object";
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
 *
 * A `where` callback that does not return a predicate is REFUSED here, not
 * treated as "the constraint always applies". The same malformed clause is a
 * hard `ConfigurationError` at definition time ({@link assertWhereFieldDeclared})
 * and at persistence time (`serializeWherePredicate`); a third reading that
 * silently widened a partial constraint to a total one would let the three
 * sites disagree about the same clause — the divergence
 * {@link captureWherePredicate} exists to prevent.
 *
 * The arm SHOULD be unreachable: `defineGraph` refuses a non-predicate callback
 * before any write can evaluate it, `validateGraphExtension` refuses the
 * document form, and a constraint reconstructed from a persisted schema carries
 * a callback this module built itself. It is reachable only by handing the
 * store a constraint object that never passed a definition gate — for which
 * failing loudly is the correct answer, since the alternative is enforcing
 * uniqueness over rows the author meant to exclude.
 */
export function checkWherePredicate(
  constraint: UniqueConstraint,
  props: Record<string, unknown>,
): boolean {
  if (!constraint.where) {
    return true; // No where clause, always applies
  }

  const predicate = captureWherePredicate(constraint.where);
  if (predicate === undefined) {
    throw new ConfigurationError(
      `Unique constraint "${constraint.name}" has a \`where\` callback that does not return a predicate.`,
      { constraintName: constraint.name, fields: [...constraint.fields] },
      {
        suggestion: `Return a field predicate, e.g. \`where: (fields) => fields.${constraint.fields[0] ?? "someField"}.isNotNull()\`. A constraint built outside \`defineGraph\` bypasses the definition-time check that normally reports this.`,
      },
    );
  }

  return evaluatePredicate(predicate, props);
}

type UniquePredicate = Readonly<{
  __type: "unique_predicate";
  field: string;
  op: NullCheckOp;
}>;

/**
 * The `where` callback as every caller of {@link captureWherePredicate} sees it:
 * a per-field builder in, whatever the author returned out.
 *
 * Deliberately looser than `UniqueConstraint["where"]`, whose builder type is
 * generic in the kind's schema — the capture is the same operation whether the
 * callback came from a typed `defineGraph` registration, a compiled
 * graph-extension document, or an untyped JavaScript caller.
 */
type UniqueWhereCallback = (
  builder: Readonly<
    Record<
      string,
      Readonly<{
        isNull: () => UniquePredicate;
        isNotNull: () => UniquePredicate;
      }>
    >
  >,
) => unknown;

/**
 * Runs a `where` callback against the shared builder and returns the predicate
 * it named, or `undefined` when the callback returned something that is not a
 * predicate.
 *
 * The single owner of "what does this `where` clause say": constraint
 * EVALUATION ({@link checkWherePredicate}), definition-time VALIDATION
 * ({@link assertWhereFieldDeclared}), and persistence-time CAPTURE
 * (`serializeWherePredicate` in src/schema/serializer.ts) all read the clause
 * through this one function, so a persisted `where`, a validated `where`, and
 * an evaluated `where` cannot disagree about which field the author named.
 */
export function captureWherePredicate(
  where: UniqueWhereCallback,
): UniquePredicate | undefined {
  const predicate = where(buildPredicateContext());
  if (
    typeof predicate !== "object" ||
    predicate === null ||
    !("__type" in predicate)
  ) {
    return undefined;
  }

  const candidate = predicate as {
    __type: unknown;
    field: unknown;
    op: unknown;
  };
  if (
    candidate.__type !== "unique_predicate" ||
    typeof candidate.field !== "string" ||
    (candidate.op !== "isNull" && candidate.op !== "isNotNull")
  ) {
    return undefined;
  }

  return {
    __type: "unique_predicate",
    field: candidate.field,
    op: candidate.op,
  };
}

/**
 * Refuses a uniqueness constraint whose `where` clause names a field the kind
 * does not declare.
 *
 * The runtime half of the builder's guard. {@link buildPredicateContext} is
 * total by design — it must answer for a DECLARED-but-absent field, which is
 * the whole point of a partial constraint — so a typo'd name cannot be caught
 * there, and the type system catches it only for typed callers
 * (`UniqueConstraintPredicateBuilder` declares exactly the schema's fields and
 * has no index signature). An untyped caller naming an undeclared field
 * otherwise gets a predicate that quietly never applies.
 *
 * Called once per constraint at graph-definition time — the single point every
 * constraint passes through before any write can evaluate it — rather than at
 * each of the write paths' `checkWherePredicate` call sites, so the refusal
 * covers every path uniformly and costs nothing per write. Mirrors
 * `validateGraphExtension`'s `UNKNOWN_UNIQUE_WHERE_FIELD` refusal, which
 * already holds the same invariant for kinds declared as JSON documents.
 */
export function assertWhereFieldDeclared(
  kind: string,
  constraint: UniqueConstraint,
  shape: Readonly<Record<string, unknown>>,
): void {
  if (!constraint.where) return;

  const predicate = captureWherePredicate(constraint.where);
  if (predicate === undefined) {
    throw new ConfigurationError(
      `Unique constraint "${constraint.name}" on node kind "${kind}" has a \`where\` callback that does not return a predicate.`,
      { kind, constraintName: constraint.name },
      {
        suggestion: `Return a field predicate, e.g. \`where: (fields) => fields.${Object.keys(shape)[0] ?? "someField"}.isNotNull()\`.`,
      },
    );
  }

  if (!hasOwnKey(shape, predicate.field)) {
    throw new ConfigurationError(
      `Unique constraint "${constraint.name}" on node kind "${kind}" has a \`where\` clause on field "${predicate.field}", which is not declared in the kind's schema.`,
      {
        kind,
        constraintName: constraint.name,
        field: predicate.field,
        declaredFields: Object.keys(shape),
      },
      {
        suggestion: `Name a declared field (${Object.keys(shape).join(", ")}) or add "${predicate.field}" to the schema.`,
      },
    );
  }
}

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
 * evaluates as null, which is what a partial constraint means by absent. Every
 * reader of a `where` clause goes through {@link captureWherePredicate}, which
 * builds this one context, so a persisted `where`, a validated `where`, and an
 * evaluated `where` cannot see different builders.
 *
 * The guard against a TYPO'D field name is NOT this Proxy — it must stay total
 * or a declared-but-absent field loses its member. It is
 * {@link assertWhereFieldDeclared}, which every constraint passes at
 * graph-definition time: an undeclared name is refused there with a typed
 * `ConfigurationError`, so no `where` clause naming one ever reaches
 * evaluation, from a typed or an untyped caller.
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
 *
 * Takes a CAPTURED predicate, not an `unknown`: the "is this really a
 * predicate?" question belongs to {@link captureWherePredicate}, which is its
 * single owner. The defensive `return true` arms this function used to carry
 * were a second, quieter answer to that question — and they answered it the
 * opposite way, widening a partial constraint into a total one where the owner
 * refuses.
 */
function evaluatePredicate(
  pred: UniquePredicate,
  props: Record<string, unknown>,
): boolean {
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
