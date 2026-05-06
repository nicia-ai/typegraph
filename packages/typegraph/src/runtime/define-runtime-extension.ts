/**
 * Public entry for declaring a runtime graph extension.
 *
 * Pure value: validates the input, deeply freezes the result, and returns
 * a `RuntimeGraphDocument`. Invalid documents throw
 * `RuntimeExtensionValidationError` carrying every issue with a
 * JSON-pointer `path` to the offending field.
 */
import { unwrap } from "../utils/result";
import { type RuntimeGraphDocument } from "./document-types";
import { validateRuntimeExtension } from "./validation";

/**
 * Validates and freezes a runtime extension document.
 *
 * @param input - Plain object describing additional node kinds, edge
 *   kinds, and ontology relations. Must satisfy the v1 property-type
 *   subset documented in `RuntimePropertyType`.
 *
 * @returns The same document, deeply frozen and shape-checked.
 *
 * @throws {RuntimeExtensionValidationError} when the document violates
 *   the v1 property-type subset, references undeclared kinds, contains
 *   ontology cycles, etc. The thrown error's `details.issues` array
 *   carries every failure with a JSON-pointer path.
 *
 * @example
 * ```typescript
 * const extension = defineRuntimeExtension({
 *   nodes: {
 *     Paper: {
 *       properties: {
 *         doi:   { type: "string" },
 *         title: { type: "string", searchable: { language: "english" } },
 *       },
 *       unique: [{ name: "paper_doi", fields: ["doi"] }],
 *     },
 *   },
 * });
 *
 * const compiled = compileRuntimeExtension(extension);
 * // compiled.nodes[0].type is a NodeType ready to merge into a GraphDef.
 * ```
 */
export function defineRuntimeExtension(input: unknown): RuntimeGraphDocument {
  return unwrap(validateRuntimeExtension(input));
}
