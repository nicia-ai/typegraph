/**
 * Runtime graph extension — pure-value document layer and Zod compiler.
 */

// Public entry
export { defineRuntimeExtension } from "./define-runtime-extension";

// Compiler
export {
  type CompiledEdge,
  type CompiledExtension,
  type CompiledNode,
  compileRuntimeExtension,
} from "./compiler";

// Document type surface
export {
  CURRENT_RUNTIME_DOCUMENT_VERSION,
  LEGACY_RUNTIME_DOCUMENT_VERSION,
  type RuntimeArrayItemType,
  type RuntimeArrayProperty,
  type RuntimeBooleanProperty,
  type RuntimeDocumentVersion,
  type RuntimeEdgeDocument,
  type RuntimeEmbeddingModifier,
  type RuntimeEnumProperty,
  type RuntimeGraphDocument,
  type RuntimeNodeDocument,
  type RuntimeNumberProperty,
  type RuntimeObjectFieldProperty,
  type RuntimeObjectProperty,
  type RuntimeOntologyRelation,
  type RuntimePropertyType,
  type RuntimeSearchableModifier,
  type RuntimeStringProperty,
  type RuntimeUniqueConstraint,
  type RuntimeUniqueWhere,
} from "./document-types";

// Errors
export {
  type RuntimeExtensionIssue,
  type RuntimeExtensionIssueCode,
  RuntimeExtensionValidationError,
} from "./errors";

// Result-returning validator (for callers that prefer Result-style)
export { validateRuntimeExtension } from "./validation";

// Merge: compile a runtime extension and fold it into a host GraphDef.
// Used by the schema-aware loader at startup and by `store.evolve()`.
export { mergeRuntimeExtension } from "./merge";
