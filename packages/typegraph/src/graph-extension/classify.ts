/**
 * Per-delta classification for `evolve()` modify-existing-kind support.
 *
 * Distinguishes additive / loosening changes (allowed without data
 * inspection) from tightening changes that require an empty-kind
 * probe, from genuinely incompatible changes that always reject.
 *
 * Pure function — no I/O. The caller (`store.evolve`) takes the
 * `requireEmpty` candidate list and runs the existence probes before
 * committing.
 */
import type { KindEntity } from "../core/types";
import { canonicalEqual } from "../schema/canonical";
import { type IncompatibleChange, IncompatibleChangeError } from "./errors";
import {
  type ExtensionArrayProperty,
  type ExtensionEdgeDef,
  type ExtensionEnumProperty,
  type ExtensionNodeDef,
  type ExtensionNumberProperty,
  type ExtensionObjectProperty,
  type ExtensionPropertyType,
  type ExtensionStringProperty,
  type ExtensionUniqueConstraint,
  type GraphExtension,
} from "./extension-types";

/**
 * Result of classifying every delta between two graph-extension documents.
 *
 * `incompatible` collects rejections that the caller throws as a
 * single `IncompatibleChangeError`. `requireEmpty`
 * collects the names of kinds where at least one delta is
 * allowed-only-on-empty — the caller probes each kind's row count
 * and promotes the `requireEmpty` entries to `incompatible` when
 * the kind has rows.
 *
 * `entity` is tracked per-key so the probe dispatches to the right
 * backend primitive: `countNodesByKind` for `node`, `countEdgesByKind`
 * for `edge`. Without this, an edge-keyed `TIGHTEN_EDGE_ENDPOINTS`
 * delta would silently slip past the empty-kind gate (the node-
 * keyed count would always be 0 for an edge name).
 */
type ModificationClassification = Readonly<{
  /** Deltas that always reject. */
  incompatible: readonly IncompatibleChange[];
  /**
   * Deltas allowed only when the kind has zero rows. One entry per
   * `(entity, kindName)`; each carries the per-delta detail to promote
   * to `incompatible` if the empty-probe shows rows. Caller looks up
   * by entry identity (frozen reference) — no string-key encoding.
   */
  requireEmpty: readonly RequireEmptyEntry[];
}>;

export type RequireEmptyEntry = Readonly<{
  entity: KindEntity;
  kindName: string;
  changes: readonly IncompatibleChange[];
}>;

/**
 * Classifies every delta between an existing and proposed graph-extension
 * document. Same-shape kinds produce no entries; new-kind additions
 * produce no entries (handled by the union spread upstream).
 *
 * The classification covers nodes and edges in scope; ontology and
 * indexes pass through unchanged because v1 evolve doesn't modify
 * them in-place (consumers add new ontology relations, runtime
 * indexes follow auto-derive on the underlying nodes).
 */
export function classifyModifications(
  existing: GraphExtension,
  next: GraphExtension,
): ModificationClassification {
  const incompatible: IncompatibleChange[] = [];
  // Aggregate by (entity, kindName) using a temporary string-keyed Map
  // — the encoding is private to this function. The Map's values are
  // returned as a plain array; the caller never sees the key.
  const requireEmptyMutable = new Map<
    string,
    { entity: KindEntity; kindName: string; changes: IncompatibleChange[] }
  >();

  const recordIncompatible = (entry: IncompatibleChange): void => {
    incompatible.push(entry);
  };
  const recordRequireEmpty = (
    entity: KindEntity,
    entry: IncompatibleChange,
  ): void => {
    const key = `${entity}:${entry.kind}`;
    const existingEntry = requireEmptyMutable.get(key);
    if (existingEntry === undefined) {
      requireEmptyMutable.set(key, {
        entity,
        kindName: entry.kind,
        changes: [entry],
      });
    } else {
      existingEntry.changes.push(entry);
    }
  };

  for (const [name, nextNode] of Object.entries(next.nodes ?? {})) {
    const existingNode = existing.nodes?.[name];
    if (existingNode === undefined) continue;
    classifyNode(name, existingNode, nextNode, {
      recordIncompatible,
      recordRequireEmpty: (entry) => {
        recordRequireEmpty("node", entry);
      },
    });
  }
  for (const [name, nextEdge] of Object.entries(next.edges ?? {})) {
    const existingEdge = existing.edges?.[name];
    if (existingEdge === undefined) continue;
    classifyEdge(name, existingEdge, nextEdge, {
      recordIncompatible,
      recordRequireEmpty: (entry) => {
        recordRequireEmpty("edge", entry);
      },
    });
  }

  const requireEmpty: RequireEmptyEntry[] = [];
  for (const value of requireEmptyMutable.values()) {
    requireEmpty.push(
      Object.freeze({
        entity: value.entity,
        kindName: value.kindName,
        changes: Object.freeze([...value.changes]),
      }),
    );
  }

  return { incompatible, requireEmpty };
}

/**
 * Promotes the `requireEmpty` entries whose probe came back non-empty
 * to incompatible, returning a single `IncompatibleChangeError`
 * covering both the always-incompatible deltas and the promoted ones.
 * Returns `undefined` when nothing rejects (probe came back empty for
 * every entry and `incompatible` is empty).
 */
export function buildIncompatibleChangeError(
  classification: ModificationClassification,
  nonEmpty: ReadonlySet<RequireEmptyEntry>,
  graphId: string,
): IncompatibleChangeError | undefined {
  const promoted: IncompatibleChange[] = [];
  for (const entry of nonEmpty) {
    promoted.push(...entry.changes);
  }
  const all = [...classification.incompatible, ...promoted];
  if (all.length === 0) return undefined;
  return new IncompatibleChangeError(all, graphId);
}

// ============================================================
// Node classification
// ============================================================

type Recorders = Readonly<{
  recordIncompatible: (entry: IncompatibleChange) => void;
  recordRequireEmpty: (entry: IncompatibleChange) => void;
}>;

function classifyNode(
  kind: string,
  existing: ExtensionNodeDef,
  next: ExtensionNodeDef,
  recorders: Recorders,
): void {
  classifyProperties(kind, existing.properties, next.properties, recorders);
  classifyUnique(kind, existing.unique ?? [], next.unique ?? [], recorders);
  // description / annotations — always allowed (no semantic effect).
}

function classifyEdge(
  kind: string,
  existing: ExtensionEdgeDef,
  next: ExtensionEdgeDef,
  recorders: Recorders,
): void {
  classifyProperties(
    kind,
    existing.properties ?? {},
    next.properties ?? {},
    recorders,
  );
  classifyEdgeEndpoints(kind, existing, next, recorders);
}

function classifyEdgeEndpoints(
  kind: string,
  existing: ExtensionEdgeDef,
  next: ExtensionEdgeDef,
  recorders: Recorders,
): void {
  // Adding kinds to from/to is broadening — always allowed.
  // Removing kinds with no existing edges of that endpoint would be
  // allowed in the spec, but TypeGraph doesn't have a per-(edge,
  // endpoint-kind) row probe today; v1 stays conservative by treating
  // endpoint-kind removal as allowed-on-empty for the whole edge kind.
  const fromExisting = new Set(existing.from);
  const toExisting = new Set(existing.to);
  const fromNext = new Set(next.from);
  const toNext = new Set(next.to);

  for (const removed of [...fromExisting].filter(
    (entry) => !fromNext.has(entry),
  )) {
    recorders.recordRequireEmpty({
      kind,
      type: "TIGHTEN_EDGE_ENDPOINTS",
      detail: `removed "${removed}" from \`from\``,
    });
  }
  for (const removed of [...toExisting].filter((entry) => !toNext.has(entry))) {
    recorders.recordRequireEmpty({
      kind,
      type: "TIGHTEN_EDGE_ENDPOINTS",
      detail: `removed "${removed}" from \`to\``,
    });
  }
}

// ============================================================
// Properties
// ============================================================

function classifyProperties(
  kind: string,
  existing: Readonly<Record<string, ExtensionPropertyType>>,
  next: Readonly<Record<string, ExtensionPropertyType>>,
  recorders: Recorders,
): void {
  const existingNames = new Set(Object.keys(existing));
  const nextNames = new Set(Object.keys(next));

  // Removed properties — REMOVE_PROPERTY (always reject).
  for (const name of existingNames) {
    if (!nextNames.has(name)) {
      recorders.recordIncompatible({
        kind,
        field: name,
        type: "REMOVE_PROPERTY",
      });
    }
  }

  // Added properties — ADD_OPTIONAL (allowed) or ADD_REQUIRED
  // (allowed-on-empty).
  for (const name of nextNames) {
    if (!existingNames.has(name)) {
      const property = next[name]!;
      if (property.optional === true) continue;
      recorders.recordRequireEmpty({
        kind,
        field: name,
        type: "ADD_REQUIRED_PROPERTY",
      });
    }
  }

  // Modified properties — per-property classification.
  for (const name of existingNames) {
    if (!nextNames.has(name)) continue;
    classifyProperty(kind, name, existing[name]!, next[name]!, recorders);
  }
}

function classifyProperty(
  kind: string,
  field: string,
  existing: ExtensionPropertyType,
  next: ExtensionPropertyType,
  recorders: Recorders,
): void {
  // Type change — always reject.
  if (existing.type !== next.type) {
    recorders.recordIncompatible({
      kind,
      field,
      type: "TYPE_CHANGE",
      detail: `${existing.type} → ${next.type}`,
    });
    return;
  }

  // Optionality.
  const wasOptional = existing.optional === true;
  const isOptional = next.optional === true;
  if (!wasOptional && isOptional) {
    // LOOSEN_OPTIONALITY — allowed.
  } else if (wasOptional && !isOptional) {
    recorders.recordRequireEmpty({
      kind,
      field,
      type: "TIGHTEN_OPTIONALITY",
      detail: "optional: true → false",
    });
  }

  // Searchable / embedding modifiers — always allowed (the materializer
  // backfills indexes via materializeIndexes; vector regen is on the
  // consumer per the design doc).

  // Per-type constraint deltas.
  switch (existing.type) {
    case "string": {
      classifyString(
        kind,
        field,
        existing,
        next as ExtensionStringProperty,
        recorders,
      );
      break;
    }
    case "number": {
      classifyNumber(
        kind,
        field,
        existing,
        next as ExtensionNumberProperty,
        recorders,
      );
      break;
    }
    case "enum": {
      classifyEnum(
        kind,
        field,
        existing,
        next as ExtensionEnumProperty,
        recorders,
      );
      break;
    }
    case "array": {
      classifyArray(
        kind,
        field,
        existing,
        next as ExtensionArrayProperty,
        recorders,
      );
      break;
    }
    case "object": {
      classifyObject(
        kind,
        field,
        existing,
        next as ExtensionObjectProperty,
        recorders,
      );
      break;
    }
    case "boolean": {
      // No classifiable deltas beyond optionality, already handled.
      break;
    }
  }
}

function classifyString(
  kind: string,
  field: string,
  existing: ExtensionStringProperty,
  next: ExtensionStringProperty,
  recorders: Recorders,
): void {
  // Length bounds: tighten requires empty, loosen allowed.
  if (
    existing.minLength !== next.minLength &&
    next.minLength !== undefined &&
    (existing.minLength === undefined || next.minLength > existing.minLength)
  ) {
    recorders.recordRequireEmpty({
      kind,
      field,
      type: "TIGHTEN_CONSTRAINT",
      detail: `minLength: ${existing.minLength ?? "(none)"} → ${next.minLength}`,
    });
  }
  if (
    existing.maxLength !== next.maxLength &&
    next.maxLength !== undefined &&
    (existing.maxLength === undefined || next.maxLength < existing.maxLength)
  ) {
    recorders.recordRequireEmpty({
      kind,
      field,
      type: "TIGHTEN_CONSTRAINT",
      detail: `maxLength: ${existing.maxLength ?? "(none)"} → ${next.maxLength}`,
    });
  }
  // Pattern.
  if (existing.pattern !== next.pattern) {
    if (existing.pattern === undefined && next.pattern !== undefined) {
      recorders.recordRequireEmpty({
        kind,
        field,
        type: "ADD_PATTERN",
        detail: next.pattern,
      });
    } else if (existing.pattern !== undefined && next.pattern === undefined) {
      // DROP_PATTERN — allowed.
    } else if (
      existing.pattern !== undefined &&
      next.pattern !== undefined &&
      existing.pattern !== next.pattern
    ) {
      recorders.recordRequireEmpty({
        kind,
        field,
        type: "CHANGE_PATTERN",
        detail: `${existing.pattern} → ${next.pattern}`,
      });
    }
  }
  // Format.
  if (existing.format !== next.format) {
    if (existing.format === undefined && next.format !== undefined) {
      recorders.recordRequireEmpty({
        kind,
        field,
        type: "ADD_FORMAT",
        detail: next.format,
      });
    } else if (existing.format !== undefined && next.format === undefined) {
      // DROP_FORMAT — allowed.
    } else {
      recorders.recordRequireEmpty({
        kind,
        field,
        type: "CHANGE_FORMAT",
        detail: `${existing.format} → ${next.format}`,
      });
    }
  }
}

function classifyNumber(
  kind: string,
  field: string,
  existing: ExtensionNumberProperty,
  next: ExtensionNumberProperty,
  recorders: Recorders,
): void {
  if (
    next.min !== undefined &&
    (existing.min === undefined || next.min > existing.min)
  ) {
    recorders.recordRequireEmpty({
      kind,
      field,
      type: "TIGHTEN_CONSTRAINT",
      detail: `min: ${existing.min ?? "(none)"} → ${next.min}`,
    });
  }
  if (
    next.max !== undefined &&
    (existing.max === undefined || next.max < existing.max)
  ) {
    recorders.recordRequireEmpty({
      kind,
      field,
      type: "TIGHTEN_CONSTRAINT",
      detail: `max: ${existing.max ?? "(none)"} → ${next.max}`,
    });
  }
  if (existing.int !== next.int && next.int === true && existing.int !== true) {
    recorders.recordRequireEmpty({
      kind,
      field,
      type: "TIGHTEN_INT",
      detail: "int: false → true",
    });
  }
  // LOOSEN_INT — allowed.
}

function classifyEnum(
  kind: string,
  field: string,
  existing: ExtensionEnumProperty,
  next: ExtensionEnumProperty,
  recorders: Recorders,
): void {
  const nextValues = new Set(next.values);
  const removed = existing.values.filter((value) => !nextValues.has(value));
  if (removed.length > 0) {
    recorders.recordRequireEmpty({
      kind,
      field,
      type: "TIGHTEN_ENUM",
      detail: `removed values: ${removed.join(", ")}`,
    });
  }
  // Adding values — LOOSEN_ENUM, allowed.
}

function classifyArray(
  kind: string,
  field: string,
  existing: ExtensionArrayProperty,
  next: ExtensionArrayProperty,
  recorders: Recorders,
): void {
  // v1: array.items deltas are nested-property deltas. Same-type
  // recurse; different-type → TYPE_CHANGE.
  if (existing.items.type !== next.items.type) {
    recorders.recordIncompatible({
      kind,
      field: `${field}.items`,
      type: "TYPE_CHANGE",
      detail: `${existing.items.type} → ${next.items.type}`,
    });
    return;
  }
  classifyProperty(
    kind,
    `${field}.items`,
    existing.items,
    next.items,
    recorders,
  );
}

function classifyObject(
  kind: string,
  field: string,
  existing: ExtensionObjectProperty,
  next: ExtensionObjectProperty,
  recorders: Recorders,
): void {
  // Recurse into the object's properties with field-prefixed names so
  // the issue carries a useful path for the reviewer.
  classifyProperties(kind, existing.properties, next.properties, {
    recordIncompatible: (entry) => {
      recorders.recordIncompatible({
        ...entry,
        field: `${field}.${entry.field ?? ""}`,
      });
    },
    recordRequireEmpty: (entry) => {
      recorders.recordRequireEmpty({
        ...entry,
        field: `${field}.${entry.field ?? ""}`,
      });
    },
  });
}

// ============================================================
// Unique constraints
// ============================================================

function classifyUnique(
  kind: string,
  existing: readonly ExtensionUniqueConstraint[],
  next: readonly ExtensionUniqueConstraint[],
  recorders: Recorders,
): void {
  const existingByName = new Map(
    existing.map((constraint) => [constraint.name, constraint]),
  );
  const nextByName = new Map(
    next.map((constraint) => [constraint.name, constraint]),
  );
  for (const [name, constraint] of nextByName) {
    if (!existingByName.has(name)) {
      // ADD_UNIQUE — allowed-on-empty (existing rule, kept).
      recorders.recordRequireEmpty({
        kind,
        type: "ADD_UNIQUE_ON_POPULATED",
        detail: `unique constraint "${name}" on [${constraint.fields.join(", ")}]`,
      });
    }
  }
  // Dropped unique constraints — DROP_UNIQUE, allowed.
  // Modified — DROP + ADD; the ADD is recorded above for any
  // structurally-different constraint with a same name.
  for (const [name, constraint] of existingByName) {
    const newOne = nextByName.get(name);
    if (newOne === undefined) continue;
    // Different shape with same name → treat as modify; ADD half is
    // allowed-on-empty. Use `canonicalEqual` so the comparison is
    // key-order-stable; plain `JSON.stringify` would flag two
    // structurally identical constraints with differently-ordered
    // keys as reshaped.
    const { name: _existingName, ...existingShape } = constraint;
    const { name: _nextName, ...nextShape } = newOne;
    if (!canonicalEqual(existingShape, nextShape)) {
      recorders.recordRequireEmpty({
        kind,
        type: "ADD_UNIQUE_ON_POPULATED",
        detail: `unique constraint "${name}" reshaped`,
      });
    }
  }
}
