import { type GraphDef } from "../core/define-graph";
import {
  type AnyEdgeType,
  type EdgeRegistration,
  type NodeRegistration,
  type NodeType,
} from "../core/types";
import { ConfigurationError, KindNotFoundError } from "../errors";
import {
  autoDeriveVectorIndexes,
  mergeVectorIndexes,
} from "../indexes/auto-derive";
import { defineEdgeIndex, defineNodeIndex } from "../indexes/define-index";
import {
  type EdgeIndexConfig,
  type IndexDeclaration,
  type NodeIndexConfig,
  type VectorIndexDeclaration,
} from "../indexes/types";
import { type OntologyRelation } from "../ontology/types";
import { canonicalEqual } from "../schema/canonical";
import { unwrap } from "../utils/result";
import { compileGraphExtension } from "./compiler";
import {
  GraphExtensionUnresolvedEndpointError,
  KindCollisionError,
} from "./errors";
import {
  type ExtensionIndex,
  type ExtensionOntologyRelation,
  type GraphExtension,
} from "./extension-types";
import {
  buildRuntimeOntologyKeySet,
  compileTimeOntologyKey,
} from "./ontology-keys";
import { validateGraphExtension } from "./validation";

/**
 * Compiles a graph extension and merges the result into a host
 * `GraphDef`. The merge is **additive over the canonical extension**:
 *
 * - New kinds, new edges referencing existing kinds (compile-time or
 *   extension), and new ontology relations are allowed.
 * - Re-declaring an existing extension kind with the **same shape** is a
 *   no-op (idempotent re-evolve, the agent-loop hot path).
 * - Re-declaring an existing extension kind with a **narrowing change**
 *   that existing rows can't satisfy is classified at the call site
 *   (`Store.evolve` / `Store.removeKinds`) and surfaces as
 *   `IncompatibleChangeError`. v1 supports a curated allowed set of
 *   additive modifications; everything else gets rejected.
 * - Collisions with **compile-time** kinds (any name reuse) throw
 *   `KindCollisionError` (code `KIND_COLLISION`).
 * - Edge endpoints that don't resolve against either the extension
 *   or the host graph throw `GraphExtensionUnresolvedEndpointError`
 *   (code `GRAPH_EXTENSION_UNRESOLVED_ENDPOINT`) — the startup-conflict
 *   case for stale persisted extensions.
 *
 * The returned graph carries the union of the host's existing
 * `extension` and the new extension, so re-serialization is
 * stable across restarts. When the union is structurally equal to the
 * existing document, the host graph is returned unchanged so no-op
 * evolves skip the compile + filter + merge work entirely.
 *
 * Validates the document structurally before compiling — every load
 * path goes through here, so persisted documents that drift from the
 * v1 subset surface as `GraphExtensionValidationError` rather than
 * raw compiler crashes.
 */
export function mergeGraphExtension<G extends GraphDef>(
  graph: G,
  document: GraphExtension,
): G {
  const validated = unwrap(validateGraphExtension(document));
  const existingDocument: GraphExtension = graph.extension ?? Object.freeze({});

  // Modification compatibility (REMOVE_PROPERTY, TYPE_CHANGE,
  // ADD_REQUIRED_PROPERTY on populated kinds, etc.) is classified
  // and rejected at the call site (`Store.evolve` / `Store.removeKinds`)
  // because the empty-kind probes that promote allowed-on-empty
  // deltas to allowed need backend access. The merge itself just
  // unions the documents — same-shape re-evolves collapse via the
  // canonicalEqual short-circuit below; truly incompatible deltas
  // would never reach the merge in production code paths.

  const unionDocument = unionDocuments(existingDocument, validated);
  const validatedUnion = unwrap(validateGraphExtension(unionDocument));

  // Fast path: when the new extension is structurally a subset of the
  // existing runtime document (the agent-loop "I evolved with the same
  // extension again" case), the union equals existing and there's no
  // work to do. Skip the compile + filter + merge pipeline entirely.
  if (
    graph.extension !== undefined &&
    canonicalEqual(validatedUnion, existingDocument)
  ) {
    return graph;
  }

  const compiled = compileGraphExtension(validatedUnion);

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
  const runtimeOntologyKeys = buildRuntimeOntologyKeySet(existingDocument);
  const compileTimeOntology = graph.ontology.filter(
    (relation) => !runtimeOntologyKeys.has(compileTimeOntologyKey(relation)),
  );
  const mergedOntology: readonly OntologyRelation[] = [
    ...compileTimeOntology,
    ...compiled.ontology.map((relation) =>
      resolveOntologyEndpoints(relation, nodeKinds),
    ),
  ];

  // Auto-derive vector indexes from `embedding()` brands on the
  // runtime kinds in the union document. Compile-time vector indexes
  // already live on `graph.indexes` from `defineGraph`; we drop any
  // prior runtime-origin entries (the union document is the source of
  // truth) and re-derive against the current runtime nodes so the
  // result is correct after add / replace cycles. Explicit compile-
  // time indexes win on (kind, fieldPath) collisions per the
  // `mergeVectorIndexes` contract.
  const runtimeVectorIndexes: readonly VectorIndexDeclaration[] =
    deriveRuntimeVectorIndexes(compiled.nodes);
  // Document-declared relational indexes (analogue of compile-time
  // `defineNodeIndex` / `defineEdgeIndex` passed to defineGraph).
  // Resolved here because schema introspection requires the merged
  // NodeType / EdgeType — runtime-declared kinds AND compile-time
  // host kinds are both reachable as targets.
  const runtimeRelationalIndexes = compileRuntimeRelationalIndexes(
    compiled.indexes,
    nodeKinds,
    mergedEdges,
    graph.id,
  );
  const mergedIndexes = mergeIndexesWithRuntime(
    graph.indexes,
    [...runtimeVectorIndexes, ...runtimeRelationalIndexes],
    graph.id,
  );

  // Returned as `G` even though runtime kinds aren't in the static
  // type — consumers reach them via the registry.
  return Object.freeze({
    ...graph,
    nodes: mergedNodes,
    edges: mergedEdges,
    ontology: mergedOntology,
    indexes: mergedIndexes,
    extension: validatedUnion,
  });
}

function deriveRuntimeVectorIndexes(
  compiledNodes: ReturnType<typeof compileGraphExtension>["nodes"],
): readonly VectorIndexDeclaration[] {
  if (compiledNodes.length === 0) return [];
  const registrations: Record<string, NodeRegistration> = {};
  for (const compiled of compiledNodes) {
    registrations[compiled.type.kind] = {
      type: compiled.type,
      ...(compiled.unique.length === 0 ? {} : { unique: [...compiled.unique] }),
    };
  }
  return autoDeriveVectorIndexes(registrations).map((index) =>
    Object.freeze({ ...index, origin: "runtime" as const }),
  );
}

function mergeIndexesWithRuntime(
  existing: readonly IndexDeclaration[] | undefined,
  runtimeIndexes: readonly IndexDeclaration[],
  graphId: string,
): readonly IndexDeclaration[] | undefined {
  // Preserve "no indexes anywhere" as `undefined` so legacy graphs
  // that never declared indexes keep the same canonical-form hash.
  if (existing === undefined && runtimeIndexes.length === 0) {
    return undefined;
  }
  const compileTimeIndexes = (existing ?? []).filter(
    (index) => index.origin !== "runtime",
  );
  if (runtimeIndexes.length === 0) return compileTimeIndexes;

  // Vector entries dedup by (kind, fieldPath); explicit declarations
  // win over auto-derived. Run that pass first against vector inputs
  // only, then concatenate the (already-validated) relational
  // entries — they pass through `defineNodeIndex` /
  // `defineEdgeIndex` which enforces name uniqueness, so collisions
  // are caught earlier.
  const runtimeVectors = runtimeIndexes.filter(
    (index): index is VectorIndexDeclaration => index.entity === "vector",
  );
  const runtimeRelational = runtimeIndexes.filter(
    (index) => index.entity !== "vector",
  );
  const vectorMerged = mergeVectorIndexes(compileTimeIndexes, runtimeVectors);
  const merged = [...vectorMerged, ...runtimeRelational];
  assertUniqueIndexNames(merged, graphId);
  return merged;
}

function assertUniqueIndexNames(
  indexes: readonly IndexDeclaration[],
  graphId: string,
): void {
  const seen = new Set<string>();
  for (const index of indexes) {
    if (!seen.has(index.name)) {
      seen.add(index.name);
      continue;
    }
    throw new ConfigurationError(
      `Duplicate index name "${index.name}" after merging graph extension into graph "${graphId}". Index names must be unique within a graph.`,
      { graphId, indexName: index.name, code: "DUPLICATE_INDEX_NAME" },
      {
        suggestion:
          "Give the runtime index a unique `name`, or remove the duplicate declaration.",
      },
    );
  }
}

function compileRuntimeRelationalIndexes(
  documents: readonly ExtensionIndex[],
  nodeKinds: ReadonlyMap<string, NodeType>,
  mergedEdges: Readonly<Record<string, EdgeRegistration>>,
  graphId: string,
): readonly IndexDeclaration[] {
  if (documents.length === 0) return [];
  const result: IndexDeclaration[] = [];
  for (const document of documents) {
    if (document.entity === "node") {
      const node = nodeKinds.get(document.kind);
      if (node === undefined) {
        throw new KindNotFoundError(document.kind, "node", {
          graphId,
          suggestion:
            "Declare the kind under `nodes` in this graph extension, or remove the index from `indexes`.",
        });
      }
      const declaration = defineNodeIndex(
        node,
        toNodeIndexConfig(document) as NodeIndexConfig<NodeType>,
      );
      result.push(Object.freeze({ ...declaration, origin: "runtime" }));
      continue;
    }

    const edgeRegistration = mergedEdges[document.kind];
    if (edgeRegistration === undefined) {
      throw new KindNotFoundError(document.kind, "edge", {
        graphId,
        suggestion:
          "Declare the edge under `edges` in this graph extension, or remove the index from `indexes`.",
      });
    }
    const declaration = defineEdgeIndex(
      edgeRegistration.type,
      toEdgeIndexConfig(document) as EdgeIndexConfig<AnyEdgeType>,
    );
    result.push(Object.freeze({ ...declaration, origin: "runtime" }));
  }
  return result;
}

// Document-side `where` carries the persistence-round-trippable
// `{ field, op: "isNull" | "isNotNull" }` shape. The compile-time
// API takes a builder callback that returns `IndexWhereExpression`;
// translate one into the other so `defineNodeIndex` / `defineEdgeIndex`
// can produce the canonical declaration.
function buildWhereCallback(where: NonNullable<ExtensionIndex["where"]>) {
  return (
    props: Record<string, { isNull: () => unknown; isNotNull: () => unknown }>,
  ) => {
    const builder = props[where.field];
    if (builder === undefined) {
      throw new ConfigurationError(
        `Runtime index \`where\` references unknown field "${where.field}".`,
        { field: where.field, code: "EXTENSION_INDEX_WHERE_UNKNOWN_FIELD" },
      );
    }
    return where.op === "isNull" ? builder.isNull() : builder.isNotNull();
  };
}

function toNodeIndexConfig(
  document: Extract<ExtensionIndex, { entity: "node" }>,
): Readonly<Record<string, unknown>> {
  return compactConfig({
    fields: document.fields,
    coveringFields: document.coveringFields,
    unique: document.unique,
    name: document.name,
    scope: document.scope,
    where:
      document.where === undefined ?
        undefined
      : buildWhereCallback(document.where),
  });
}

function toEdgeIndexConfig(
  document: Extract<ExtensionIndex, { entity: "edge" }>,
): Readonly<Record<string, unknown>> {
  return compactConfig({
    fields: document.fields,
    coveringFields: document.coveringFields,
    unique: document.unique,
    name: document.name,
    scope: document.scope,
    direction: document.direction,
    where:
      document.where === undefined ?
        undefined
      : buildWhereCallback(document.where),
  });
}

function compactConfig(
  raw: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Combines two graph-extension documents into one. Same-named nodes
 * and edges in `next` overwrite their `existing` counterpart (the
 * structural-equal redefinition case is caught upstream by
 * `assertNoRedefinitions`, so the overwrite is always with an equal
 * value here). Ontology relations are deduped by `(metaEdge, from, to)`
 * — re-applying the same relation twice would otherwise persist
 * duplicates that the next restart's validator rejects with
 * `DUPLICATE_ONTOLOGY_RELATION`.
 */
function unionDocuments(
  existing: GraphExtension,
  next: GraphExtension,
): GraphExtension {
  // First-evolve fast path: when there's no existing document, the
  // already-frozen `next` IS the union. Skips four object spreads and
  // a freeze on the cold path.
  if (
    existing.nodes === undefined &&
    existing.edges === undefined &&
    existing.ontology === undefined &&
    existing.indexes === undefined
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
  const indexes =
    existing.indexes === undefined && next.indexes === undefined ?
      undefined
    : dedupIndexes([...(existing.indexes ?? []), ...(next.indexes ?? [])]);

  // Both inputs come through the validator, so `version` is always
  // populated. Forward it on the merged document so the canonical-form
  // hash agrees between the first-evolve fast path (which returns
  // `next` directly) and this re-merge path.
  const version = next.version ?? existing.version;

  return Object.freeze({
    ...(version === undefined ? {} : { version }),
    ...(nodes === undefined ? {} : { nodes }),
    ...(edges === undefined ? {} : { edges }),
    ...(ontology === undefined ? {} : { ontology }),
    ...(indexes === undefined ? {} : { indexes }),
  });
}

/**
 * Dedupe `indexes` by composite key (entity, kind, generated/declared
 * name). Re-applying the same extension produces an identical entry
 * via the spread; without dedup, the merged document would carry two
 * copies and the next restart's validator would reject as
 * `DUPLICATE_INDEX_NAME`. Last-write-wins on collision: the agent-loop
 * idempotent re-evolve relies on `canonicalEqual` between merged and
 * existing being true, which is preserved when next mirrors existing.
 */
function dedupIndexes(
  indexes: readonly ExtensionIndex[],
): readonly ExtensionIndex[] {
  const seen = new Map<string, ExtensionIndex>();
  const order: string[] = [];
  for (const entry of indexes) {
    const key = `${entry.entity}|${entry.kind}|${entry.name ?? ""}|${entry.fields.join(",")}`;
    if (!seen.has(key)) order.push(key);
    seen.set(key, entry);
  }
  return order.map((key) => seen.get(key)!);
}

function dedupRelations(
  relations: readonly ExtensionOntologyRelation[],
): readonly ExtensionOntologyRelation[] {
  const seen = new Set<string>();
  const out: ExtensionOntologyRelation[] = [];
  for (const relation of relations) {
    const key = `${relation.metaEdge}|${relation.from}|${relation.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(relation);
  }
  return out;
}

function assertNoCollision(
  kindName: string,
  entity: "node" | "edge",
  collides: boolean,
  graphId: string,
): void {
  if (!collides) return;
  throw new KindCollisionError(kindName, entity, graphId);
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
      throw new GraphExtensionUnresolvedEndpointError(
        context.edgeKind,
        context.side,
        entry,
        context.graphId,
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
