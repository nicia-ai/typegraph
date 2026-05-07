/**
 * Errors raised while parsing and validating a `RuntimeGraphDocument`.
 *
 * Every issue carries a JSON-pointer-style `path` (e.g.
 * `/nodes/Paper/properties/title/format`) so the caller can drop the
 * pointer straight into the offending document and see the exact field
 * that failed.
 */
import { TypeGraphError } from "../errors";

/**
 * One specific issue raised during runtime extension validation.
 */
export type RuntimeExtensionIssue = Readonly<{
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
  code: RuntimeExtensionIssueCode;
}>;

/**
 * Stable machine codes for every validation failure produced by the
 * document validator. New codes are additive — existing codes never
 * change meaning.
 */
export type RuntimeExtensionIssueCode =
  | "UNSUPPORTED_PROPERTY_TYPE"
  | "INVALID_PROPERTY_REFINEMENT"
  | "NESTED_ARRAY"
  | "NESTED_OBJECT_TOO_DEEP"
  | "INVALID_MODIFIER_TARGET"
  | "INVALID_ENUM_VALUES"
  | "INVALID_NUMBER_BOUNDS"
  | "INVALID_LENGTH_BOUNDS"
  | "INVALID_PATTERN"
  | "INVALID_EMBEDDING_DIMENSIONS"
  | "INVALID_SEARCHABLE_LANGUAGE"
  | "RESERVED_PROPERTY_NAME"
  | "INVALID_KIND_NAME"
  | "DUPLICATE_KIND_NAME"
  | "EMPTY_PROPERTIES"
  | "EMPTY_FROM_OR_TO"
  | "DUPLICATE_UNIQUE_CONSTRAINT"
  | "EMPTY_UNIQUE_FIELDS"
  | "DUPLICATE_UNIQUE_FIELD"
  | "UNKNOWN_UNIQUE_FIELD"
  | "INVALID_UNIQUE_WHERE_OP"
  | "UNKNOWN_UNIQUE_WHERE_FIELD"
  | "INVALID_ANNOTATION"
  | "UNKNOWN_META_EDGE"
  | "ONTOLOGY_CYCLE"
  | "ONTOLOGY_SELF_LOOP"
  | "DUPLICATE_ONTOLOGY_RELATION"
  | "INVALID_DOCUMENT_SHAPE"
  | "RUNTIME_EXTENSION_VERSION_UNSUPPORTED";

/**
 * Thrown when `defineRuntimeExtension(...)` rejects an input document.
 *
 * The `details.issues` array carries every failure with a JSON-pointer
 * `path`, so callers presenting the document to a human reviewer can
 * highlight the exact offending field.
 */
export class RuntimeExtensionValidationError extends TypeGraphError {
  declare readonly details: Readonly<{
    issues: readonly RuntimeExtensionIssue[];
  }>;

  constructor(issues: readonly RuntimeExtensionIssue[], cause?: unknown) {
    const summary = summarizeIssues(issues);
    super(
      `Runtime extension document is invalid (${issues.length} issue${
        issues.length === 1 ? "" : "s"
      }): ${summary}`,
      "RUNTIME_EXTENSION_INVALID",
      {
        details: { issues: Object.freeze([...issues]) },
        category: "user",
        suggestion: `Inspect error.details.issues for per-field paths and codes; each issue's "path" is a JSON pointer into the source document.`,
        cause,
      },
    );
    this.name = "RuntimeExtensionValidationError";
  }
}

/**
 * Builds the one-line summary the base `Error.message` shows. Keeps the
 * full structured list available on `details.issues` for programmatic
 * use.
 */
function summarizeIssues(issues: readonly RuntimeExtensionIssue[]): string {
  if (issues.length === 0) return "no specific issues recorded";
  const head = issues
    .slice(0, 3)
    .map((issue) => `${issue.path || "(root)"} — ${issue.message}`)
    .join("; ");
  const overflow = issues.length > 3 ? ` (+${issues.length - 3} more)` : "";
  return `${head}${overflow}`;
}
