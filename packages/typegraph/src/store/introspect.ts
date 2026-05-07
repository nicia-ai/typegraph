/**
 * `store.introspect()` — unified read of the merged schema.
 *
 * Returns a coherent snapshot of "what does my schema look like right
 * now" suitable for schema-management UIs, codegen, and IDE plugins.
 * The previous surface was fragmented across `registry.hasNodeType`,
 * `store.deprecatedKinds`, and direct graph poking; `introspect()`
 * unifies them with explicit `origin` markers distinguishing
 * compile-time from runtime declarations.
 *
 * Pure read — no I/O. Built from the in-memory `GraphDef` and the
 * persisted-but-already-merged `extension`. `schemaVersion` /
 * `schemaHash` are populated when the loader cached them at
 * construction time and `undefined` otherwise; consumers needing a
 * fresh read should call `backend.getActiveSchema(graphId)` directly.
 */
import {
  type AllEdgeTypes,
  type AllNodeTypes,
  type GraphDef,
} from "../core/define-graph";
import {
  type Cardinality,
  type Collation,
  type EdgeType,
  type EndpointExistence,
  type KindAnnotations,
  type NodeRegistration,
  type NodeType,
  type UniquenessScope,
} from "../core/types";
import { type GraphExtension } from "../graph-extension/extension-types";
import {
  buildRuntimeOntologyKeySet,
  compileTimeOntologyKey,
} from "../graph-extension/ontology-keys";
import { getTypeName } from "../ontology/types";
import { serializeSchemaProperties } from "../schema/serializer";
import { type JsonSchema } from "../schema/types";

export type SchemaIntrospection = Readonly<{
  graphId: string;
  /** Active schema version on the backend, when known to the caller. */
  schemaVersion: number | undefined;
  /** Hash of the active schema document, when known to the caller. */
  schemaHash: string | undefined;
  kinds: readonly KindIntrospection[];
  edges: readonly EdgeIntrospection[];
  ontology: readonly OntologyIntrospection[];
  deprecatedKinds: ReadonlySet<string>;
  /**
   * The persisted graph extension, or `undefined` when the store has
   * no extensions. Round-trips: passing this value to
   * `defineGraphExtension` and `evolve` against an empty graph yields
   * a graph with the same extension kinds.
   */
  extension: GraphExtension | undefined;
}>;

export type KindIntrospection = Readonly<{
  name: string;
  origin: "compile-time" | "runtime";
  description: string | undefined;
  annotations: KindAnnotations | undefined;
  deprecated: boolean;
  /**
   * JSON-Schema view of the kind's properties. For extension kinds the
   * lower-level `ExtensionPropertyType` shape (with first-class
   * `searchable` / `embedding` modifiers) is reachable via
   * `introspection.extension.nodes[name].properties`.
   */
  properties: JsonSchema;
  unique: readonly UniqueIntrospection[];
}>;

export type EdgeIntrospection = Readonly<{
  name: string;
  origin: "compile-time" | "runtime";
  description: string | undefined;
  from: readonly string[];
  to: readonly string[];
  cardinality: Cardinality;
  endpointExistence: EndpointExistence;
  properties: JsonSchema;
  annotations: KindAnnotations | undefined;
  deprecated: boolean;
}>;

export type OntologyIntrospection = Readonly<{
  metaEdge: string;
  from: string;
  to: string;
  origin: "compile-time" | "runtime";
}>;

export type UniqueIntrospection = Readonly<{
  name: string;
  fields: readonly string[];
  scope: UniquenessScope;
  collation: Collation;
}>;

type IntrospectContext = Readonly<{
  graphId: string;
  schemaVersion: number | undefined;
  schemaHash: string | undefined;
}>;

export function introspectSchema<G extends GraphDef>(
  graph: G,
  context: IntrospectContext,
): SchemaIntrospection {
  const extension = graph.extension;
  const runtimeNodeNames = new Set(
    extension === undefined ? [] : Object.keys(extension.nodes ?? {}),
  );
  const runtimeEdgeNames = new Set(
    extension === undefined ? [] : Object.keys(extension.edges ?? {}),
  );
  const deprecated = graph.deprecatedKinds;

  const kinds: KindIntrospection[] = [];
  for (const [name, registration] of Object.entries(graph.nodes)) {
    const reg = registration as NodeRegistration<NodeType>;
    kinds.push({
      name,
      origin: runtimeNodeNames.has(name) ? "runtime" : "compile-time",
      description: reg.type.description,
      annotations: reg.type.annotations,
      deprecated: deprecated.has(name),
      properties: serializeSchemaProperties(reg.type.schema),
      unique: (reg.unique ?? []).map((constraint) => ({
        name: constraint.name,
        fields: [...constraint.fields],
        scope: constraint.scope,
        collation: constraint.collation,
      })),
    });
  }

  const edges: EdgeIntrospection[] = [];
  for (const [name, registration] of Object.entries(graph.edges)) {
    const reg = registration;
    const edgeType = reg.type as AllEdgeTypes<G> & EdgeType;
    edges.push({
      name,
      origin: runtimeEdgeNames.has(name) ? "runtime" : "compile-time",
      description: edgeType.description,
      from: reg.from.map((entry) => (entry as AllNodeTypes<G> & NodeType).kind),
      to: reg.to.map((entry) => (entry as AllNodeTypes<G> & NodeType).kind),
      cardinality: reg.cardinality ?? "many",
      endpointExistence: reg.endpointExistence ?? "notDeleted",
      properties: serializeSchemaProperties(edgeType.schema),
      annotations: edgeType.annotations,
      deprecated: deprecated.has(name),
    });
  }

  const runtimeOntologyKeys = buildRuntimeOntologyKeySet(extension);
  const ontology: OntologyIntrospection[] = graph.ontology.map((relation) => ({
    metaEdge: relation.metaEdge.name,
    from: getTypeName(relation.from),
    to: getTypeName(relation.to),
    origin:
      runtimeOntologyKeys.has(compileTimeOntologyKey(relation)) ? "runtime" : (
        "compile-time"
      ),
  }));

  return {
    graphId: context.graphId,
    schemaVersion: context.schemaVersion,
    schemaHash: context.schemaHash,
    kinds,
    edges,
    ontology,
    deprecatedKinds: new Set(deprecated),
    extension,
  };
}
