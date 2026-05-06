import { type GraphDef } from "../core/define-graph";
import {
  type EdgeRegistration,
  type NodeRegistration,
  type NodeType,
} from "../core/types";
import { ConfigurationError } from "../errors";
import { getTypeName, type OntologyRelation } from "../ontology/types";
import { canonicalEqual } from "../schema/canonical";
import { unwrap } from "../utils/result";
import { compileRuntimeExtension } from "./compiler";
import {
  type RuntimeGraphDocument,
  type RuntimeOntologyRelation,
} from "./document-types";
import { validateRuntimeExtension } from "./validation";

/**
 * Compiles a runtime extension document and merges the result into a
 * host `GraphDef`. The merge is **additive over the canonical document**:
 *
 * - New kinds, new edges referencing existing kinds (compile-time or
 *   runtime), and new ontology relations are allowed.
 * - Re-declaring an existing runtime kind with the **same shape** is a
 *   no-op (idempotent re-evolve, the agent-loop hot path).
 * - Re-declaring an existing runtime kind with a **different shape**
 *   throws `ConfigurationError` with code `RUNTIME_KIND_REDEFINITION`.
 *   v1 doesn't support modifying a prior declaration; use a new kind
 *   name to evolve a kind.
 * - Collisions with **compile-time** kinds (any name reuse) throw
 *   `RUNTIME_KIND_NAME_COLLISION`.
 * - Edge endpoints that don't resolve against either the runtime
 *   extension or the host graph throw `RUNTIME_EXTENSION_UNRESOLVED_ENDPOINT`
 *   — the startup-conflict case for stale persisted documents.
 *
 * The returned graph carries the union of the host's existing
 * `runtimeDocument` and the new extension, so re-serialization is
 * stable across restarts. When the union is structurally equal to the
 * existing document, the host graph is returned unchanged so no-op
 * evolves skip the compile + filter + merge work entirely.
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
  const existingDocument: RuntimeGraphDocument =
    graph.runtimeDocument ?? Object.freeze({});

  // Reject runtime-runtime redefinitions BEFORE building the union, so
  // the union spread (`{ ...existing, ...next }`) can't silently
  // overwrite a prior declaration. Same-shape re-evolves still pass
  // through — the spread overwrites with an equal value, and the
  // canonicalEqual short-circuit below collapses the whole call to a
  // no-op.
  assertNoRedefinitions(existingDocument, validated, graph.id);

  const unionDocument = unionDocuments(existingDocument, validated);

  // Fast path: when the new extension is structurally a subset of the
  // existing runtime document (the agent-loop "I evolved with the same
  // extension again" case), the union equals existing and there's no
  // work to do. Skip the compile + filter + merge pipeline entirely.
  if (
    graph.runtimeDocument !== undefined &&
    canonicalEqual(unionDocument, existingDocument)
  ) {
    return graph;
  }

  const compiled = compileRuntimeExtension(unionDocument);

  // Existing runtime-origin kind names — these aren't compile-time
  // collisions when re-applied, so we skip the collision check for them
  // and let the union document overwrite the previous compiled form.
  const runtimeNodeNames = new Set(Object.keys(existingDocument.nodes ?? {}));
  const runtimeEdgeNames = new Set(Object.keys(existingDocument.edges ?? {}));

  const nodeKinds = new Map<string, NodeType>();
  for (const registration of Object.values(graph.nodes)) {
    if (runtimeNodeNames.has(registration.type.kind)) continue;
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

  const mergedNodes: Record<string, NodeRegistration> = {};
  for (const [name, registration] of Object.entries(graph.nodes)) {
    if (runtimeNodeNames.has(name)) continue;
    mergedNodes[name] = registration;
  }
  for (const node of compiled.nodes) {
    mergedNodes[node.type.kind] = {
      type: node.type,
      ...(node.unique.length === 0 ? {} : { unique: [...node.unique] }),
    };
  }

  const mergedEdges: Record<string, EdgeRegistration> = {};
  for (const [name, registration] of Object.entries(graph.edges)) {
    if (runtimeEdgeNames.has(name)) continue;
    mergedEdges[name] = registration;
  }
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

  // Drop ontology relations that came from the previous runtime
  // document — `compiled.ontology` reproduces them from the union, so
  // keeping the originals would double-stack. Pre-build a Set of
  // canonical keys for O(1) lookup; the naive per-relation `.some`
  // scan was O(N×M).
  const runtimeOntologyKeys = new Set(
    (existingDocument.ontology ?? []).map(
      (entry) => `${entry.metaEdge}|${entry.from}|${entry.to}`,
    ),
  );
  const compileTimeOntology = graph.ontology.filter(
    (relation) =>
      !runtimeOntologyKeys.has(
        `${relation.metaEdge.name}|${getTypeName(relation.from)}|${getTypeName(relation.to)}`,
      ),
  );
  const mergedOntology: readonly OntologyRelation[] = [
    ...compileTimeOntology,
    ...compiled.ontology.map((relation) =>
      resolveOntologyEndpoints(relation, nodeKinds),
    ),
  ];

  // Returned as `G` even though runtime kinds aren't in the static
  // type — consumers reach them via the registry.
  return Object.freeze({
    ...graph,
    nodes: mergedNodes,
    edges: mergedEdges,
    ontology: mergedOntology,
    runtimeDocument: unionDocument,
  });
}

/**
 * Combines two runtime extension documents into one. Same-named nodes
 * and edges in `next` overwrite their `existing` counterpart (the
 * structural-equal redefinition case is caught upstream by
 * `assertNoRedefinitions`, so the overwrite is always with an equal
 * value here). Ontology relations are deduped by `(metaEdge, from, to)`
 * — re-applying the same relation twice would otherwise persist
 * duplicates that the next restart's validator rejects with
 * `DUPLICATE_ONTOLOGY_RELATION`.
 */
function unionDocuments(
  existing: RuntimeGraphDocument,
  next: RuntimeGraphDocument,
): RuntimeGraphDocument {
  // First-evolve fast path: when there's no existing document, the
  // already-frozen `next` IS the union. Skips three object spreads and
  // a freeze on the cold path.
  if (
    existing.nodes === undefined &&
    existing.edges === undefined &&
    existing.ontology === undefined
  ) {
    return next;
  }

  const nodes =
    existing.nodes === undefined && next.nodes === undefined ?
      undefined
    : { ...existing.nodes, ...next.nodes };
  const edges =
    existing.edges === undefined && next.edges === undefined ?
      undefined
    : { ...existing.edges, ...next.edges };
  const ontology =
    existing.ontology === undefined && next.ontology === undefined ?
      undefined
    : dedupRelations([...(existing.ontology ?? []), ...(next.ontology ?? [])]);

  return Object.freeze({
    ...(nodes === undefined ? {} : { nodes }),
    ...(edges === undefined ? {} : { edges }),
    ...(ontology === undefined ? {} : { ontology }),
  });
}

function dedupRelations(
  relations: readonly RuntimeOntologyRelation[],
): readonly RuntimeOntologyRelation[] {
  const seen = new Set<string>();
  const out: RuntimeOntologyRelation[] = [];
  for (const relation of relations) {
    const key = `${relation.metaEdge}|${relation.from}|${relation.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(relation);
  }
  return out;
}

function assertNoRedefinitions(
  existing: RuntimeGraphDocument,
  next: RuntimeGraphDocument,
  graphId: string,
): void {
  for (const [name, nextNode] of Object.entries(next.nodes ?? {})) {
    const existingNode = existing.nodes?.[name];
    if (existingNode !== undefined && !canonicalEqual(existingNode, nextNode)) {
      throw new ConfigurationError(
        `Runtime extension redefines node kind "${name}" on graph "${graphId}" with a different shape than the existing runtime declaration. v1 extensions are additive only — modifying a prior declaration is not supported. Use a new kind name to evolve the schema.`,
        { code: "RUNTIME_KIND_REDEFINITION" },
      );
    }
  }
  for (const [name, nextEdge] of Object.entries(next.edges ?? {})) {
    const existingEdge = existing.edges?.[name];
    if (existingEdge !== undefined && !canonicalEqual(existingEdge, nextEdge)) {
      throw new ConfigurationError(
        `Runtime extension redefines edge kind "${name}" on graph "${graphId}" with a different shape than the existing runtime declaration. v1 extensions are additive only — modifying a prior declaration is not supported. Use a new kind name to evolve the schema.`,
        { code: "RUNTIME_KIND_REDEFINITION" },
      );
    }
  }
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
