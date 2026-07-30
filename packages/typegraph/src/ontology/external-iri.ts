/**
 * Returns whether a string is an absolute external HTTP(S) IRI.
 *
 * Ontology relations deliberately keep these references inert when the
 * referenced kind is not registered locally. Bare names are local kind
 * references and must resolve at the graph-extension merge boundary.
 */
export function isExternalIri(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}
