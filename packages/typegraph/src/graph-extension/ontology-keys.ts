/**
 * Canonical-key encoding for ontology relations across the runtime
 * extension layer.
 *
 * The runtime side stores `(metaEdge, from, to)` triples on the
 * pure-value `ExtensionOntologyRelation`; the compile-time side stores
 * `OntologyRelation` with a `MetaEdge` value, a `NodeType | string`
 * `from`, and a `NodeType | string` `to`. Three distinct call sites
 * (`runtime/merge.ts`, `runtime/remove.ts`, `store/introspect.ts`)
 * need a single canonical-string key that compares the two sides for
 * "is this compile-time relation also in the runtime document?". One
 * encoding here keeps the four sites from drifting apart.
 */
import { getTypeName, type OntologyRelation } from "../ontology/types";
import {
  type ExtensionOntologyRelation,
  type GraphExtension,
} from "./extension-types";

function runtimeOntologyKey(entry: ExtensionOntologyRelation): string {
  return `${entry.metaEdge}|${entry.from}|${entry.to}`;
}

export function compileTimeOntologyKey(relation: OntologyRelation): string {
  return `${relation.metaEdge.name}|${getTypeName(relation.from)}|${getTypeName(relation.to)}`;
}

/**
 * Builds the set of `runtimeOntologyKey(...)` values for a runtime
 * document's ontology relations. Used to filter compile-time relations
 * away from runtime ones in merge / introspect / remove flows.
 */
export function buildRuntimeOntologyKeySet(
  document: GraphExtension | undefined,
): ReadonlySet<string> {
  return new Set(
    (document?.ontology ?? []).map((entry) => runtimeOntologyKey(entry)),
  );
}
