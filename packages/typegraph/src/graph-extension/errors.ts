/**
 * Errors raised across the graph-extension surface.
 *
 * Two flavours:
 *
 * - **Validation issues** (`GraphExtensionValidationError` +
 *   `GraphExtensionIssue` / `GraphExtensionIssueCode`) — produced by
 *   `validateGraphExtension`. The issue list batches every failure
 *   with a JSON-pointer `path` so a UI can highlight every offending
 *   field at once.
 * - **Operation errors** (every other class in this file, all extending
 *   `GraphExtensionError`) — thrown one at a time from `evolve`,
 *   `removeKinds`, `materializeIndexes`, search, etc. Each carries a
 *   stable string `code` for logging / serialization PLUS a typed
 *   shape so consumers can `instanceof` for control flow.
 */
import type { KindEntity } from "../core/types";
import { type ErrorCategory, TypeGraphError } from "../errors";

// ============================================================
// Validation issues (multi-issue batch)
// ============================================================

/**
 * One specific issue raised during graph-extension validation.
 */
export type GraphExtensionIssue = Readonly<{
  /**
   * JSON-pointer path to the offending value, rooted at the document
   * (e.g. `/nodes/Paper/properties/title/pattern`). The empty string
   * `""` means "the document itself".
   */
  path: string;
  /** Human-readable explanation of the failure. */
  message: string;
  /**
   * Stable machine-readable code so callers (and tests) can branch on
   * specific failure modes without parsing messages. New codes are
   * additive.
   */
  code: GraphExtensionIssueCode;
}>;

/**
 * Stable machine codes for every validation failure produced by the
 * document validator. New codes are additive — existing codes never
 * change meaning.
 *
 * Note: codes here describe per-field validation problems. Operation-
 * level errors (kind not found, version mismatch on persisted doc,
 * compile-time-kind removal, etc.) surface as typed Error subclasses
 * exported below — not as issue codes.
 */
/**
 * Every issue code emitted by `validateGraphExtension`. Const-array form
 * so tests, codegen, and runtime introspection can iterate the full set
 * without restating it.
 */
export const GRAPH_EXTENSION_ISSUE_CODES = [
  "UNSUPPORTED_PROPERTY_TYPE",
  "INVALID_PROPERTY_REFINEMENT",
  "NESTED_ARRAY",
  "NESTED_OBJECT_TOO_DEEP",
  "INVALID_MODIFIER_TARGET",
  "INVALID_ENUM_VALUES",
  "INVALID_NUMBER_BOUNDS",
  "INVALID_LENGTH_BOUNDS",
  "INVALID_PATTERN",
  "INVALID_EMBEDDING_DIMENSIONS",
  "INVALID_SEARCHABLE_LANGUAGE",
  "RESERVED_PROPERTY_NAME",
  "INVALID_KIND_NAME",
  "DUPLICATE_KIND_NAME",
  "EMPTY_PROPERTIES",
  "EMPTY_FROM_OR_TO",
  "DUPLICATE_UNIQUE_CONSTRAINT",
  "EMPTY_UNIQUE_FIELDS",
  "DUPLICATE_UNIQUE_FIELD",
  "UNKNOWN_UNIQUE_FIELD",
  "INVALID_UNIQUE_WHERE_OP",
  "UNKNOWN_UNIQUE_WHERE_FIELD",
  "INVALID_ANNOTATION",
  "UNKNOWN_META_EDGE",
  "ONTOLOGY_CYCLE",
  "ONTOLOGY_SELF_LOOP",
  "ONTOLOGY_DISJOINT_CONFLICT",
  "ONTOLOGY_INVERSE_MULTIPLE_PARTNERS",
  "DUPLICATE_ONTOLOGY_RELATION",
  "INVALID_DOCUMENT_SHAPE",
  "UNKNOWN_DOCUMENT_KEY",
  "UNSUPPORTED_STRING_FORMAT",
  "INVALID_INDEX_DECLARATION",
  "DUPLICATE_INDEX_NAME",
  "EMPTY_INDEX_FIELDS",
  "UNKNOWN_PROPERTY_KEY",
] as const;

export type GraphExtensionIssueCode =
  (typeof GRAPH_EXTENSION_ISSUE_CODES)[number];

// ============================================================
// Operation errors (typed, single-error throws)
// ============================================================

/**
 * Base class for every graph-extension error. Consumers can catch
 * the family with one `instanceof GraphExtensionError` check and
 * branch on the concrete subclass beneath. Carries the same
 * `code` / `category` / `details` slots as `TypeGraphError` so existing
 * `isTypeGraphError` / `isUserRecoverable` helpers continue to apply.
 */
export abstract class GraphExtensionError extends TypeGraphError {
  // The concrete `code` is set as a literal-typed property on each
  // subclass so consumers can branch on it with full type narrowing.
  declare readonly code: string;

  protected constructor(spec: {
    message: string;
    code: string;
    details: Readonly<Record<string, unknown>>;
    suggestion: string;
    category?: ErrorCategory;
    cause?: unknown;
  }) {
    super(spec.message, spec.code, {
      details: spec.details,
      category: spec.category ?? "user",
      suggestion: spec.suggestion,
      ...(spec.cause === undefined ? {} : { cause: spec.cause }),
    });
    // `new.target.name` resolves to the concrete subclass at construction
    // time, eliminating per-subclass `this.name = "ClassName"` repetition.
    this.name = new.target.name;
  }
}

/**
 * Thrown when `validateGraphExtension` (or `defineGraphExtension`)
 * rejects an input document for one or more shape/content reasons.
 *
 * The `issues` array carries every failure with a JSON-pointer
 * `path`, so callers presenting the document to a human reviewer can
 * highlight every offending field at once.
 */
export class GraphExtensionValidationError extends GraphExtensionError {
  override readonly code = "GRAPH_EXTENSION_INVALID" as const;
  readonly issues: readonly GraphExtensionIssue[];
  declare readonly details: Readonly<{
    issues: readonly GraphExtensionIssue[];
  }>;

  constructor(issues: readonly GraphExtensionIssue[], cause?: unknown) {
    const frozenIssues = Object.freeze([...issues]);
    super({
      message: `Graph extension document is invalid (${issues.length} issue${
        issues.length === 1 ? "" : "s"
      }): ${summarizeIssues(issues)}`,
      code: "GRAPH_EXTENSION_INVALID",
      details: { issues: frozenIssues },
      suggestion: `Inspect error.issues for per-field paths and codes; each issue's "path" is a JSON pointer into the source document.`,
      cause,
    });
    this.issues = frozenIssues;
  }
}

/**
 * Generic "first N items + overflow tail" summary for inclusion in an
 * Error message. Shared by `summarizeIssues` and `summarizeChanges`
 * because the overflow shape is identical; only the per-item
 * formatting differs.
 */
function summarizeWithOverflow<T>(
  items: readonly T[],
  formatItem: (item: T) => string,
  emptyMessage: string,
): string {
  if (items.length === 0) return emptyMessage;
  const head = items
    .slice(0, 3)
    .map((item) => formatItem(item))
    .join("; ");
  const overflow = items.length > 3 ? ` (+${items.length - 3} more)` : "";
  return `${head}${overflow}`;
}

function summarizeIssues(issues: readonly GraphExtensionIssue[]): string {
  return summarizeWithOverflow(
    issues,
    (issue) => `${issue.path || "(root)"} — ${issue.message}`,
    "no specific issues recorded",
  );
}

/**
 * Thrown when an extension declares a kind whose name collides with an
 * existing compile-time kind. The graph-extension contract is
 * additive: graph-extension-declared kinds cannot shadow compile-time kinds.
 */
export class KindCollisionError extends GraphExtensionError {
  override readonly code = "KIND_COLLISION" as const;
  readonly kindName: string;
  readonly entity: KindEntity;

  constructor(kindName: string, entity: KindEntity, graphId: string) {
    super({
      message: `Graph extension declares ${entity} kind "${kindName}" which already exists as a compile-time kind on graph "${graphId}". Graph-extension-declared kinds cannot collide with compile-time kinds.`,
      code: "KIND_COLLISION",
      details: { kindName, entity, graphId },
      suggestion:
        "Pick a different graph-extension-declared kind name, or remove the compile-time declaration.",
    });
    this.kindName = kindName;
    this.entity = entity;
  }
}

/**
 * One classified delta in a `IncompatibleChangeError`.
 *
 * `field` is `undefined` for kind-level changes (e.g. tightening edge
 * endpoints, adding a unique constraint to a populated kind). `detail`
 * is human-readable and intended for surfaces showing the change to a
 * reviewer (e.g. `"minLength: 5 → 10"`).
 */
/**
 * Every incompatible-change classification produced by `evolve`'s
 * delta classifier. Const-array form so tests and reviewer UIs can
 * enumerate the set without restating it.
 */
export const INCOMPATIBLE_CHANGE_TYPES = [
  "REMOVE_PROPERTY",
  "ADD_REQUIRED_PROPERTY",
  "TIGHTEN_OPTIONALITY",
  "TIGHTEN_CONSTRAINT",
  "ADD_PATTERN",
  "CHANGE_PATTERN",
  "ADD_FORMAT",
  "CHANGE_FORMAT",
  "TIGHTEN_INT",
  "TIGHTEN_ENUM",
  "TYPE_CHANGE",
  "ADD_UNIQUE_ON_POPULATED",
  "TIGHTEN_EDGE_ENDPOINTS",
] as const;

export type IncompatibleChangeType = (typeof INCOMPATIBLE_CHANGE_TYPES)[number];

export type IncompatibleChange = Readonly<{
  kind: string;
  field?: string;
  type: IncompatibleChangeType;
  detail?: string;
}>;

/**
 * Thrown when `evolve` rejects one or more deltas against an existing
 * extension kind. Carries a structured `changes` list so a reviewer
 * UI can show the incompatible deltas across every affected kind in
 * one shot.
 */
export class IncompatibleChangeError extends GraphExtensionError {
  override readonly code = "INCOMPATIBLE_CHANGE" as const;
  readonly changes: readonly IncompatibleChange[];

  constructor(changes: readonly IncompatibleChange[], graphId: string) {
    const frozenChanges = Object.freeze([...changes]);
    super({
      message: `Graph extension contains ${changes.length} incompatible change${
        changes.length === 1 ? "" : "s"
      } against existing graph-extension kinds on graph "${graphId}": ${summarizeChanges(changes)}`,
      code: "INCOMPATIBLE_CHANGE",
      details: { graphId, changes: frozenChanges },
      suggestion:
        "Inspect error.changes for the per-field rejections. Compatible options: change the modification to an additive one (e.g. `optional: true`), or apply the change against an empty kind.",
    });
    this.changes = frozenChanges;
  }
}

function summarizeChanges(changes: readonly IncompatibleChange[]): string {
  return summarizeWithOverflow(
    changes,
    (change) => {
      const field = change.field === undefined ? "" : `.${change.field}`;
      const detail = change.detail === undefined ? "" : ` (${change.detail})`;
      return `${change.kind}${field}: ${change.type}${detail}`;
    },
    "(no specific changes recorded)",
  );
}

/**
 * Thrown when an extension's edge or ontology endpoint references a
 * kind that exists in neither the extension nor the host graph.
 * Distinct from `KindNotFoundError` because the cause is a
 * stale persisted extension (a compile-time kind was removed from
 * source after the extension was committed) rather than a
 * call-site typo.
 */
export class GraphExtensionUnresolvedEndpointError extends GraphExtensionError {
  override readonly code = "GRAPH_EXTENSION_UNRESOLVED_ENDPOINT" as const;
  readonly edgeKind: string;
  readonly side: "from" | "to";
  readonly endpoint: string;

  constructor(
    edgeKind: string,
    side: "from" | "to",
    endpoint: string,
    graphId: string,
  ) {
    super({
      message: `Graph-extension edge "${edgeKind}" ${side}-endpoint "${endpoint}" does not resolve to any kind on graph "${graphId}". The compile-time kind may have been removed since the extension was committed.`,
      code: "GRAPH_EXTENSION_UNRESOLVED_ENDPOINT",
      details: { edgeKind, side, endpoint, graphId },
      suggestion:
        "Restore the compile-time kind, or remove the graph-extension-declared kind via store.removeKinds before redeploying without it.",
    });
    this.edgeKind = edgeKind;
    this.side = side;
    this.endpoint = endpoint;
  }
}

/**
 * Thrown when `inverseOf` or `implies` uses an unresolved bare edge-kind
 * name. Absolute HTTP(S) IRIs remain deliberate inert external references.
 */
export class GraphExtensionUnresolvedOntologyEndpointError extends GraphExtensionError {
  override readonly code =
    "GRAPH_EXTENSION_UNRESOLVED_ONTOLOGY_ENDPOINT" as const;
  readonly metaEdge: "inverseOf" | "implies";
  readonly endpoint: string;

  constructor(
    metaEdge: "inverseOf" | "implies",
    endpoint: string,
    graphId: string,
  ) {
    super({
      message: `Graph-extension ${metaEdge} endpoint "${endpoint}" does not resolve to a registered edge kind on graph "${graphId}".`,
      code: "GRAPH_EXTENSION_UNRESOLVED_ONTOLOGY_ENDPOINT",
      details: { metaEdge, endpoint, graphId },
      suggestion:
        "Correct the local edge-kind name, register that edge, or use an absolute http:// or https:// IRI for a deliberate inert external reference.",
    });
    this.metaEdge = metaEdge;
    this.endpoint = endpoint;
  }
}

/**
 * Thrown by `removeKinds` when the removal list contains a compile-
 * time kind. Compile-time kinds are removed by recompiling and
 * redeploying — persisting "removed-compile-time-kind" state in
 * `schema_doc` is incoherent because the kind would resurrect on the
 * next deploy.
 */
export class RemoveCompileTimeKindError extends GraphExtensionError {
  override readonly code = "REMOVE_COMPILE_TIME_KIND" as const;
  readonly kindName: string;
  readonly entity: KindEntity;

  constructor(kindName: string, entity: KindEntity, graphId: string) {
    super({
      message: `Cannot remove compile-time ${entity} kind "${kindName}" via store.removeKinds. Compile-time kinds are removed by recompiling and redeploying without them on graph "${graphId}".`,
      code: "REMOVE_COMPILE_TIME_KIND",
      details: { kindName, entity, graphId },
      suggestion:
        "Drop the kind from your defineGraph call and redeploy. Only graph-extension kinds (added via store.evolve) are removable through removeKinds.",
    });
    this.kindName = kindName;
    this.entity = entity;
  }
}

/**
 * Thrown by `removeKinds` when a compile-time edge or ontology
 * relation references the graph-extension kind being removed. Removing the
 * kind would orphan compile-time references — incoherent at the next
 * deploy.
 */
export class KindHasReferentsError extends GraphExtensionError {
  override readonly code = "KIND_HAS_REFERENTS" as const;
  readonly kindName: string;
  readonly referents: readonly KindReferent[];

  constructor(
    kindName: string,
    referents: readonly KindReferent[],
    graphId: string,
  ) {
    const summary = referents
      .map((referent) => `${referent.type}:${referent.name}`)
      .join(", ");
    const frozenReferents = Object.freeze([...referents]);
    super({
      message: `Cannot remove graph-extension kind "${kindName}" on graph "${graphId}" — it is referenced by compile-time declarations: ${summary}.`,
      code: "KIND_HAS_REFERENTS",
      details: { kindName, graphId, referents: frozenReferents },
      suggestion:
        "Remove the compile-time references first (drop the edge or ontology relation from defineGraph), or pick a different kind to remove.",
    });
    this.kindName = kindName;
    this.referents = frozenReferents;
  }
}

export type KindReferent = Readonly<{
  type: "compile-time-edge" | "compile-time-ontology";
  name: string;
}>;

/**
 * Thrown when a persisted graph extension was authored against a
 * higher major version of the graph-extension format than the
 * current library supports. The library refuses to load it rather
 * than risk silently misreading newer fields.
 */
export class GraphExtensionVersionUnsupportedError extends GraphExtensionError {
  override readonly code = "GRAPH_EXTENSION_VERSION_UNSUPPORTED" as const;
  readonly persistedVersion: number;
  readonly currentVersion: number;

  constructor(persistedVersion: number, currentVersion: number) {
    super({
      message: `Persisted extension was authored against graph-extension format v${persistedVersion}, but this library only supports up to v${currentVersion}. Upgrade @nicia-ai/typegraph.`,
      code: "GRAPH_EXTENSION_VERSION_UNSUPPORTED",
      details: { persistedVersion, currentVersion },
      category: "system",
      suggestion: `Upgrade @nicia-ai/typegraph to a version that supports graph-extension format v${persistedVersion}, or downgrade the writer.`,
    });
    this.persistedVersion = persistedVersion;
    this.currentVersion = currentVersion;
  }
}
