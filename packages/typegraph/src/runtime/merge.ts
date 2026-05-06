import { type GraphDef } from "../core/define-graph";
import {
  type EdgeRegistration,
  type NodeRegistration,
  type NodeType,
} from "../core/types";
import { ConfigurationError } from "../errors";
import { type OntologyRelation } from "../ontology/types";
import { unwrap } from "../utils/result";
import { compileRuntimeExtension } from "./compiler";
import { type RuntimeGraphDocument } from "./document-types";
import { validateRuntimeExtension } from "./validation";

/**
 * Compiles a runtime extension document and merges the result into a
 * host compile-time `GraphDef`. Throws `ConfigurationError` on
 * kind-name collisions or on edge endpoints that don't resolve against
 * either the runtime extension or the host graph (the startup-conflict
 * case for stale persisted documents). The returned graph carries
 * `runtimeDocument` so re-serialization is stable across restarts.
 *
 * Validates the document structurally before compiling — every load
 * path goes through here, so persisted documents that drift from the
 * v1 subset surface as `RuntimeExtensionValidationError` rather than
 * raw compiler crashes.
 */
export function mergeRuntimeExtension<G extends GraphDef>(
  graph: G,
  document: RuntimeGraphDocument,
): G {
  const validated = unwrap(validateRuntimeExtension(document));
  const compiled = compileRuntimeExtension(validated);

  const nodeKinds = new Map<string, NodeType>();
  for (const registration of Object.values(graph.nodes)) {
    nodeKinds.set(registration.type.kind, registration.type);
  }
  for (const node of compiled.nodes) {
    assertNoCollision(
      node.type.kind,
      "node",
      nodeKinds.has(node.type.kind),
      graph.id,
    );
    nodeKinds.set(node.type.kind, node.type);
  }

  const mergedNodes: Record<string, NodeRegistration> = { ...graph.nodes };
  for (const node of compiled.nodes) {
    mergedNodes[node.type.kind] = {
      type: node.type,
      ...(node.unique.length === 0 ? {} : { unique: [...node.unique] }),
    };
  }

  const mergedEdges: Record<string, EdgeRegistration> = { ...graph.edges };
  for (const edge of compiled.edges) {
    assertNoCollision(
      edge.type.kind,
      "edge",
      mergedEdges[edge.type.kind] !== undefined,
      graph.id,
    );
    const from = resolveEndpoints(edge.from, nodeKinds, {
      graphId: graph.id,
      edgeKind: edge.type.kind,
      side: "from",
    });
    const to = resolveEndpoints(edge.to, nodeKinds, {
      graphId: graph.id,
      edgeKind: edge.type.kind,
      side: "to",
    });
    // Rebuild the EdgeType with the cross-graph-resolved endpoints —
    // the compiler only saw the runtime document, so its
    // `edge.type.from/to` covers in-document kinds only. Registry
    // introspection (`registry.getEdgeType(name).to`) reads off the
    // EdgeType, not the registration's parallel arrays, so the two
    // must agree.
    const resolvedType = Object.freeze({
      ...edge.type,
      from,
      to,
    }) as unknown as typeof edge.type;
    mergedEdges[edge.type.kind] = { type: resolvedType, from, to };
  }

  const mergedOntology: readonly OntologyRelation[] = [
    ...graph.ontology,
    ...compiled.ontology.map((relation) =>
      resolveOntologyEndpoints(relation, nodeKinds),
    ),
  ];

  // The cast widens the merged graph back to `G`. Additional runtime
  // kinds aren't visible to the type system; consumers that need them
  // reach through the runtime registry. The lie is consolidated here so
  // call sites don't repeat it.
  return Object.freeze({
    ...graph,
    nodes: mergedNodes,
    edges: mergedEdges,
    ontology: mergedOntology,
    runtimeDocument: validated,
  });
}

function assertNoCollision(
  kindName: string,
  entity: "node" | "edge",
  collides: boolean,
  graphId: string,
): void {
  if (!collides) return;
  throw new ConfigurationError(
    `Runtime extension declares ${entity} kind "${kindName}" which already exists as a compile-time kind in graph "${graphId}". Kind-name collisions are not allowed; rename the runtime ${entity}.`,
    { code: "RUNTIME_KIND_NAME_COLLISION" },
  );
}

function resolveEndpoints(
  entries: readonly (NodeType | string)[],
  nodeKinds: ReadonlyMap<string, NodeType>,
  context: Readonly<{ graphId: string; edgeKind: string; side: "from" | "to" }>,
): readonly NodeType[] {
  return entries.map((entry) => {
    if (typeof entry !== "string") return entry;
    const resolved = nodeKinds.get(entry);
    if (resolved === undefined) {
      throw new ConfigurationError(
        `Runtime extension on graph "${context.graphId}" references undeclared node kind "${entry}" as the ${context.side} endpoint of edge "${context.edgeKind}". The kind may have been removed from the application's compile-time graph; revert the removal or evolve the runtime extension to drop the reference.`,
        { code: "RUNTIME_EXTENSION_UNRESOLVED_ENDPOINT" },
      );
    }
    return resolved;
  });
}

function resolveOntologyEndpoints(
  relation: OntologyRelation,
  nodeKinds: ReadonlyMap<string, NodeType>,
): OntologyRelation {
  // Ontology endpoints are intentionally permissive — unresolved strings
  // pass through as external IRIs (matching the existing runtime
  // compiler behavior). Cross-graph kind validation only fires for edge
  // endpoints, which require a NodeType reference.
  const from =
    typeof relation.from === "string" ?
      (nodeKinds.get(relation.from) ?? relation.from)
    : relation.from;
  const to =
    typeof relation.to === "string" ?
      (nodeKinds.get(relation.to) ?? relation.to)
    : relation.to;
  return { ...relation, from, to };
}
