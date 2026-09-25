/** Pure JSON-Schema introspection for a graph-extension document. */
import type { KindAnnotations, NodeType } from "../core/types";
import { serializeSchemaProperties } from "../schema/serializer";
import type { JsonSchema } from "../schema/types";
import { compileGraphExtension } from "./compiler";
import { defineGraphExtension } from "./define-graph-extension";
import type { GraphExtension } from "./extension-types";

export type GraphExtensionKindIntrospection = Readonly<{
  name: string;
  description: string | undefined;
  annotations: KindAnnotations | undefined;
  properties: JsonSchema;
  unique: readonly Readonly<{
    name: string;
    fields: readonly string[];
    scope: "kind" | "kindWithSubClasses";
    collation: "binary" | "caseInsensitive";
  }>[];
}>;

export type GraphExtensionEdgeIntrospection = Readonly<{
  name: string;
  description: string | undefined;
  from: readonly string[];
  to: readonly string[];
  properties: JsonSchema;
  annotations: KindAnnotations | undefined;
}>;

function endpointName(endpoint: NodeType | string): string {
  return typeof endpoint === "string" ? endpoint : endpoint.kind;
}

function isEndpointList(
  value:
    | readonly (NodeType | string)[]
    | Readonly<Record<string, readonly (NodeType | string)[]>>,
): value is readonly (NodeType | string)[] {
  return Array.isArray(value);
}

/**
 * Introspects a graph-extension without a Store or backend. The result only
 * describes declarations present in the document; it carries no graph ID,
 * committed version, or schema hash.
 */
export function introspectGraphExtension(extension: GraphExtension): Readonly<{
  kinds: readonly GraphExtensionKindIntrospection[];
  edges: readonly GraphExtensionEdgeIntrospection[];
}> {
  const validatedExtension = defineGraphExtension(extension);
  const compiled = compileGraphExtension(validatedExtension);
  const kinds = compiled.nodes.map(({ type, unique }) => {
    return {
      name: type.kind,
      description: type.description,
      annotations: type.annotations,
      properties: serializeSchemaProperties(type.schema),
      unique: unique.map((constraint) => ({
        name: constraint.name,
        fields: [...constraint.fields],
        scope: constraint.scope,
        collation: constraint.collation,
      })),
    };
  });
  const edges = compiled.edges.map((edge) => ({
    name: edge.kindName,
    description: edge.description,
    from: edge.from.map((endpoint) => endpointName(endpoint)),
    to:
      isEndpointList(edge.to) ?
        edge.to.map((endpoint) => endpointName(endpoint))
      : [
          ...new Set(
            Object.values(edge.to).flatMap((targets) =>
              targets.map((endpoint: NodeType | string) =>
                endpointName(endpoint),
              ),
            ),
          ),
        ],
    properties: serializeSchemaProperties(edge.schema),
    annotations: edge.annotations,
  }));

  return Object.freeze({
    kinds: Object.freeze(kinds),
    edges: Object.freeze(edges),
  });
}
