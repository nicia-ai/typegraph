/**
 * Graph extension — pure-value document layer + public errors.
 *
 * The Zod compiler (`compileGraphExtension`) and host-graph merge
 * (`mergeGraphExtension`) live in this directory but are NOT
 * re-exported from this barrel — they're internal plumbing reached
 * via file-path imports (`schema/manager.ts`, `store/store.ts`).
 * `Store.evolve` is the supported public path; consumers needing a
 * pre-merge inspection use `validateGraphExtension` (Result-style)
 * or `defineGraphExtension` (throwing) on the document, not the
 * compiler output.
 */

// Public entry
export { defineGraphExtension } from "./define-graph-extension";

// Document type surface
export {
  CURRENT_GRAPH_EXTENSION_VERSION,
  type ExtensionArrayItemType,
  type ExtensionArrayProperty,
  type ExtensionBooleanProperty,
  type ExtensionEdgeDef,
  type ExtensionEdgeIndex,
  type ExtensionEmbeddingModifier,
  type ExtensionEnumProperty,
  type ExtensionIndex,
  type ExtensionIndexWhere,
  type ExtensionNodeDef,
  type ExtensionNodeIndex,
  type ExtensionNumberProperty,
  type ExtensionObjectFieldProperty,
  type ExtensionObjectProperty,
  type ExtensionOntologyRelation,
  type ExtensionPropertyType,
  type ExtensionSearchableModifier,
  type ExtensionStringProperty,
  type ExtensionUniqueConstraint,
  type ExtensionUniqueWhere,
  GRAPH_EXTENSION_TOP_LEVEL_KEYS,
  type GraphExtension,
  type GraphExtensionTopLevelKey,
  type GraphExtensionVersion,
  LEGACY_GRAPH_EXTENSION_VERSION,
} from "./extension-types";

// Errors
export {
  GRAPH_EXTENSION_ISSUE_CODES,
  GraphExtensionError,
  type GraphExtensionIssue,
  type GraphExtensionIssueCode,
  GraphExtensionUnresolvedEndpointError,
  GraphExtensionValidationError,
  GraphExtensionVersionUnsupportedError,
  INCOMPATIBLE_CHANGE_TYPES,
  type IncompatibleChange,
  IncompatibleChangeError,
  type IncompatibleChangeType,
  KindCollisionError,
  KindHasReferentsError,
  type KindReferent,
  RemoveCompileTimeKindError,
} from "./errors";

// Result-returning validator (for callers that prefer Result-style)
export { validateGraphExtension } from "./validation";
