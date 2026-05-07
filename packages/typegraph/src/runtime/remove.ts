/**
 * Runtime-extension removal: mutate a `GraphExtension` to drop a
 * set of runtime kinds with cascading edge / ontology cleanup.
 *
 * Pure function — no I/O, no compilation. The caller (`store.removeKinds`)
 * handles persistence (CAS commit of the resulting document) and the
 * deferred data-cleanup phase via `materializeRemovals`. This module
 * answers two questions:
 *
 *   1. Is it valid to remove these names? Compile-time kinds are
 *      rejected (compile-time kinds are removed by recompiling and
 *      redeploying — persisting "removed-compile-time-kind" state in
 *      `schema_doc` is incoherent). Runtime kinds referenced by a
 *      compile-time edge or ontology relation are also rejected
 *      (removing them would orphan compile-time references at the
 *      next deploy).
 *
 *   2. What does the new document look like? Edges whose endpoint
 *      list becomes empty after removal are cascading-removed; edges
 *      with surviving endpoints are retained with the removed name
 *      dropped from `from`/`to`. Ontology relations referencing any
 *      removed kind are also cascading-removed.
 */
import { type GraphDef } from "../core/define-graph";
import { getTypeName } from "../ontology/types";
import {
  KindHasReferentsError,
  type KindReferent,
  RemoveCompileTimeKindError,
} from "./errors";
import {
  type ExtensionEdgeDef,
  type ExtensionIndex,
  type ExtensionNodeDef,
  type ExtensionOntologyRelation,
  type GraphExtension,
} from "./extension-types";
import {
  buildRuntimeOntologyKeySet,
  compileTimeOntologyKey,
} from "./ontology-keys";

type RemovalPlan = Readonly<{
  /**
   * The new extension after applying the removals. When the input
   * list contained only absent names, the document is structurally
   * equal to the existing extension and the caller short-circuits
   * the schema commit.
   */
  document: GraphExtension | undefined;
  /** Kinds actually removed (extension kinds present in the document). */
  removedNodeKinds: readonly string[];
  /** Edge kinds dropped because every endpoint they connected was removed. */
  removedEdgeKinds: readonly string[];
}>;

/**
 * Plans the removal of a set of names from a host graph's
 * extension, validating against the host graph's compile-time
 * kinds and runtime kinds. Throws on the rejection cases:
 *
 *   - `RemoveCompileTimeKindError` if any name is a compile-time kind.
 *   - `KindHasReferentsError` if a runtime kind is referenced
 *     by a compile-time edge endpoint or ontology relation.
 *
 * Returns a plan describing the new document and which kinds will be
 * cascading-removed alongside the explicitly named ones.
 */
export function planRemovals<G extends GraphDef>(
  graph: G,
  names: readonly string[],
): RemovalPlan {
  const document = graph.extension;
  const namesSet = new Set(names);
  if (namesSet.size === 0) {
    return { document, removedNodeKinds: [], removedEdgeKinds: [] };
  }

  const runtimeNodeNames = new Set(Object.keys(document?.nodes ?? {}));
  const runtimeEdgeNames = new Set(Object.keys(document?.edges ?? {}));
  const compileTimeNodeNames = new Set(
    Object.keys(graph.nodes).filter((name) => !runtimeNodeNames.has(name)),
  );
  const compileTimeEdgeNames = new Set(
    Object.keys(graph.edges).filter((name) => !runtimeEdgeNames.has(name)),
  );

  // Reject compile-time names first — same shape across the API
  // surface even when the call also references absent runtime names.
  for (const name of namesSet) {
    if (compileTimeNodeNames.has(name)) {
      throw new RemoveCompileTimeKindError(name, "node", graph.id);
    }
    if (compileTimeEdgeNames.has(name)) {
      throw new RemoveCompileTimeKindError(name, "edge", graph.id);
    }
  }

  const removedNodeKinds = [...namesSet].filter((name) =>
    runtimeNodeNames.has(name),
  );
  const explicitlyRemovedEdgeKinds = [...namesSet].filter((name) =>
    runtimeEdgeNames.has(name),
  );

  // Compile-time-edge referent check: a runtime kind being removed
  // cannot remain a target of any compile-time edge or ontology
  // relation, because the compile-time declaration would resurrect
  // the reference on the next deploy.
  for (const kindName of removedNodeKinds) {
    const referents = findCompileTimeReferents(
      graph,
      kindName,
      runtimeEdgeNames,
    );
    if (referents.length > 0) {
      throw new KindHasReferentsError(kindName, referents, graph.id);
    }
  }

  if (document === undefined) {
    return {
      document: undefined,
      removedNodeKinds: [],
      removedEdgeKinds: [],
    };
  }

  // Build the cascading-edges set: any runtime edge whose `from` or
  // `to` becomes empty after removal is also removed; edges with
  // surviving endpoints are retained with the removed name pruned.
  const removedNodeKindsSet = new Set(removedNodeKinds);
  const explicitlyRemovedEdgeKindsSet = new Set(explicitlyRemovedEdgeKinds);
  const cascadeEdges = new Set<string>();
  const updatedEdges: Record<string, ExtensionEdgeDef> = {};

  for (const [edgeName, edgeDocument] of Object.entries(document.edges ?? {})) {
    if (explicitlyRemovedEdgeKindsSet.has(edgeName)) {
      cascadeEdges.add(edgeName);
      continue;
    }
    const newFrom = edgeDocument.from.filter(
      (kind) => !removedNodeKindsSet.has(kind),
    );
    const newTo = edgeDocument.to.filter(
      (kind) => !removedNodeKindsSet.has(kind),
    );
    if (newFrom.length === 0 || newTo.length === 0) {
      cascadeEdges.add(edgeName);
      continue;
    }
    updatedEdges[edgeName] = {
      ...edgeDocument,
      from: newFrom,
      to: newTo,
    };
  }

  // Filter nodes — explicit removals are dropped.
  const updatedNodes: Record<string, ExtensionNodeDef> = {};
  for (const [nodeName, nodeDocument] of Object.entries(document.nodes ?? {})) {
    if (removedNodeKindsSet.has(nodeName)) continue;
    updatedNodes[nodeName] = nodeDocument;
  }

  // Drop ontology relations referencing any removed kind. The compile-
  // time-referent check above already rejects compile-time-side
  // ontology referencing the removed kind, so any remaining ontology
  // is safe to filter.
  const survivingOntology: ExtensionOntologyRelation[] = (
    document.ontology ?? []
  ).filter(
    (relation) =>
      !removedNodeKindsSet.has(relation.from) &&
      !removedNodeKindsSet.has(relation.to),
  );

  // Drop runtime indexes referencing removed kinds (relational + edge
  // entries; the auto-derived vector indexes follow the runtime nodes
  // they were derived from, so dropping the runtime node implicitly
  // drops the index when `mergeRuntimeExtension` re-runs auto-derive
  // against the smaller node set).
  const allRemovedKinds = new Set([
    ...removedNodeKindsSet,
    ...cascadeEdges,
    ...explicitlyRemovedEdgeKindsSet,
  ]);
  const survivingIndexes: ExtensionIndex[] = (document.indexes ?? []).filter(
    (index) => !allRemovedKinds.has(index.kind),
  );

  const newDocument: GraphExtension = Object.freeze({
    ...(document.version === undefined ? {} : { version: document.version }),
    ...(Object.keys(updatedNodes).length === 0 ? {} : { nodes: updatedNodes }),
    ...(Object.keys(updatedEdges).length === 0 ? {} : { edges: updatedEdges }),
    ...(survivingOntology.length === 0 ? {} : { ontology: survivingOntology }),
    ...(survivingIndexes.length === 0 ? {} : { indexes: survivingIndexes }),
  });

  return {
    document: newDocument,
    removedNodeKinds,
    removedEdgeKinds: [
      ...explicitlyRemovedEdgeKinds,
      ...[...cascadeEdges].filter(
        (name) => !explicitlyRemovedEdgeKindsSet.has(name),
      ),
    ],
  };
}

/**
 * Returns a graph with the runtime slice stripped: nodes and edges
 * registered by `mergeRuntimeExtension` are dropped along with the
 * `extension` itself, leaving the compile-time-only graph.
 *
 * Used by `removeKinds` as the base for re-merging the post-removal
 * runtime document — the alternative (mutating `graph.nodes` /
 * `graph.edges` in-place) would skip the merge step's validation
 * (collision checks, endpoint resolution).
 */
export function stripRuntime<G extends GraphDef>(graph: G): G {
  const document = graph.extension;
  if (document === undefined) return graph;
  const runtimeNodeNames = new Set(Object.keys(document.nodes ?? {}));
  const runtimeEdgeNames = new Set(Object.keys(document.edges ?? {}));
  const runtimeOntologyKeys = buildRuntimeOntologyKeySet(document);

  const compileNodes: Record<string, (typeof graph.nodes)[string]> = {};
  for (const [name, registration] of Object.entries(graph.nodes)) {
    if (runtimeNodeNames.has(name)) continue;
    compileNodes[name] = registration;
  }
  const compileEdges: Record<string, (typeof graph.edges)[string]> = {};
  for (const [name, registration] of Object.entries(graph.edges)) {
    if (runtimeEdgeNames.has(name)) continue;
    compileEdges[name] = registration;
  }
  const compileOntology = graph.ontology.filter(
    (relation) => !runtimeOntologyKeys.has(compileTimeOntologyKey(relation)),
  );
  // Drop runtime-origin indexes too — `mergeRuntimeExtension` re-runs
  // auto-derivation against the new (smaller) runtime kind set.
  const compileIndexes = (graph.indexes ?? []).filter(
    (index) => index.origin !== "runtime",
  );

  return Object.freeze({
    ...graph,
    nodes: compileNodes,
    edges: compileEdges,
    ontology: compileOntology,
    indexes: compileIndexes.length === 0 ? undefined : compileIndexes,
    extension: undefined,
  });
}

function findCompileTimeReferents<G extends GraphDef>(
  graph: G,
  kindName: string,
  runtimeEdgeNames: ReadonlySet<string>,
): readonly KindReferent[] {
  const referents: KindReferent[] = [];

  for (const [edgeName, registration] of Object.entries(graph.edges)) {
    if (runtimeEdgeNames.has(edgeName)) continue;
    const reg = registration as {
      from?: readonly { kind: string }[];
      to?: readonly { kind: string }[];
    };
    const fromHas =
      reg.from?.some((endpoint) => endpoint.kind === kindName) ?? false;
    const toHas =
      reg.to?.some((endpoint) => endpoint.kind === kindName) ?? false;
    if (fromHas || toHas) {
      referents.push({ type: "compile-time-edge", name: edgeName });
    }
  }

  const runtimeOntologyKeys = buildRuntimeOntologyKeySet(graph.extension);
  for (const relation of graph.ontology) {
    if (runtimeOntologyKeys.has(compileTimeOntologyKey(relation))) continue;
    const fromName = getTypeName(relation.from);
    const toName = getTypeName(relation.to);
    if (fromName === kindName || toName === kindName) {
      referents.push({
        type: "compile-time-ontology",
        name: `${relation.metaEdge.name}(${fromName}, ${toName})`,
      });
    }
  }

  return referents;
}
