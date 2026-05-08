/**
 * Public entry for declaring a graph extension.
 *
 * Pure value: validates the input, deeply freezes the result, and returns
 * a `GraphExtension`. Invalid documents throw
 * `GraphExtensionValidationError` carrying every issue with a
 * JSON-pointer `path` to the offending field.
 */
import { unwrap } from "../utils/result";
import { type GraphExtension } from "./extension-types";
import { validateGraphExtension } from "./validation";

/**
 * Validates and freezes a graph-extension document.
 *
 * Authoring entry point — runs validation in **strict** mode: unknown
 * top-level keys (e.g. `node` instead of `nodes`) and unsupported
 * string formats (e.g. `"date-time"` with a hyphen instead of
 * `"datetime"`) fail loudly with `UNKNOWN_DOCUMENT_KEY` /
 * `UNSUPPORTED_STRING_FORMAT`. The persistence-load path leaves both
 * checks off so a document committed by a future v1.x writer with
 * additive fields still parses on an older v1 reader. Callers
 * accepting raw JSON from an untyped source (e.g. an LLM proposal)
 * should validate first via `validateGraphExtension` and surface
 * the structured issues, then pass the validated document here.
 *
 * @param input - Document describing additional node kinds, edge
 *   kinds, and ontology relations. Must satisfy the v1 property-type
 *   subset documented in `ExtensionPropertyType`.
 *
 * @returns The same document, deeply frozen and shape-checked.
 *
 * @throws {GraphExtensionValidationError} when the document violates
 *   the v1 property-type subset, references undeclared kinds, contains
 *   ontology cycles, etc. The thrown error's `details.issues` array
 *   carries every failure with a JSON-pointer path.
 * @throws {GraphExtensionVersionUnsupportedError} when the document
 *   declares a future major version this library cannot safely decode.
 *
 * @example
 * ```typescript
 * const extension = defineGraphExtension({
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
 * const evolved = await store.evolve(extension);
 * const papers = evolved.getNodeCollectionOrThrow("Paper");
 * ```
 */
export function defineGraphExtension(input: GraphExtension): GraphExtension {
  return unwrap(validateGraphExtension(input, { strict: true }));
}
