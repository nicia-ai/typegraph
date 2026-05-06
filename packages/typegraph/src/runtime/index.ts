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
export type {
  RuntimeArrayItemType,
  RuntimeArrayProperty,
  RuntimeBooleanProperty,
  RuntimeEdgeDocument,
  RuntimeEmbeddingModifier,
  RuntimeEnumProperty,
  RuntimeGraphDocument,
  RuntimeNodeDocument,
  RuntimeNumberProperty,
  RuntimeObjectFieldProperty,
  RuntimeObjectProperty,
  RuntimeOntologyRelation,
  RuntimePropertyType,
  RuntimeSearchableModifier,
  RuntimeStringProperty,
  RuntimeUniqueConstraint,
  RuntimeUniqueWhere,
} from "./document-types";

// Errors
export {
  type RuntimeExtensionIssue,
  type RuntimeExtensionIssueCode,
  RuntimeExtensionValidationError,
} from "./errors";

// Result-returning validator (for callers that prefer Result-style)
export { validateRuntimeExtension } from "./validation";
