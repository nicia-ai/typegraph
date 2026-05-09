import { type GraphDef } from "../core/define-graph";
import { defineEdge } from "../core/edge";
import {
  type AnyEdgeType,
  type EdgeRegistration,
  type EdgeType,
  type KindEntity,
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
import { compactUndefined } from "../utils/object";
import { unwrap } from "../utils/result";
import { compileGraphExtension } from "./compiler";
import {
  GraphExtensionUnresolvedEndpointError,
  KindCollisionError,
} from "./errors";
import { type ExtensionIndex, type GraphExtension } from "./extension-types";
import {
  buildGraphExtensionOntologyKeySet,
  compileTimeOntologyKey,
  extensionKindNames,
  graphExtensionOntologyKey,
} from "./ontology-keys";
import { validateGraphExtension } from "./validation";

/**
 * Compiles a graph extension and merges the result into a host
 * `GraphDef`. The merge is **additive over the canonical extension**:
 *
 * - New kinds, new edges referencing existing kinds (compile-time or
 *   extension), and new ontology relations are allowed.
 * - Re-declaring an existing extension kind with the **same shape** is a
 *   no-op (the idempotent re-evolve hot path).
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
 * Validates the merged union before compiling — every load path goes
 * through here, so persisted documents that drift from the v1 subset
 * surface as `GraphExtensionValidationError` rather than raw compiler
 * crashes. Callers that want input-only error precision (e.g. the
 * `defineGraphExtension` authoring path) call `validateGraphExtension`
 * themselves first; the merge runs the validator only against the
 * union so a single walk covers both cross-document invariants and the
 * input's own shape.
 */
export function mergeGraphExtension<G extends GraphDef>(
  graph: G,
  document: GraphExtension,
): G {
  const existingDocument: GraphExtension = graph.extension ?? Object.freeze({});

  // Modification compatibility (REMOVE_PROPERTY, TYPE_CHANGE,
  // ADD_REQUIRED_PROPERTY on populated kinds, etc.) is classified
  // and rejected at the call site (`Store.evolve` / `Store.removeKinds`)
  // because the empty-kind probes that promote allowed-on-empty
  // deltas to allowed need backend access. The merge itself just
  // unions the documents — same-shape re-evolves collapse via the
  // canonicalEqual short-circuit below; truly incompatible deltas
  // would never reach the merge in production code paths.

  const unionDocument = unionDocuments(existingDocument, document);

  // Fast path: when the union is structurally equal to the existing
  // graph-extension document (the "I evolved with the same extension
  // again" case, plus any subset-of-existing case), there's
  // no work to do. The existing document was already validated by the
  // upstream merge that installed it, so we skip the validation walk
  // (which would otherwise repeat the 2200-line validator over a
  // known-good document) AND the compile + filter pipeline.
  if (
    graph.extension !== undefined &&
    canonicalEqual(unionDocument, existingDocument)
  ) {
    return graph;
  }

  // Single validate covers both the input's shape and cross-document
  // invariants (ontology cycles, index-name uniqueness across docs,
  // etc.). The input doc's invariants are a subset of the union's, so
  // bad input still surfaces here — error paths just refer to union
  // pointers rather than input pointers. Callers wanting input-precise
  // errors call `validateGraphExtension(document)` themselves first.
  const validatedUnion = unwrap(validateGraphExtension(unionDocument));

  const compiled = compileGraphExtension(validatedUnion);

  // Existing runtime-origin kind names — these aren't compile-time
  // collisions when re-applied, so we skip the collision check for them
  // and let the union document overwrite the previous compiled form.
  const { nodes: runtimeNodeNames, edges: runtimeEdgeNames } =
    extensionKindNames(existingDocument);

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
      edge.kindName,
      "edge",
      mergedEdges[edge.kindName] !== undefined,
      graph.id,
    );
    const from = resolveEndpoints(edge.from, nodeKinds, {
      graphId: graph.id,
      edgeKind: edge.kindName,
      side: "from",
    });
    const to = resolveEndpoints(edge.to, nodeKinds, {
      graphId: graph.id,
      edgeKind: edge.kindName,
      side: "to",
    });
    // Build the EdgeType once with the cross-graph-resolved endpoints.
    // The compiler intentionally doesn't construct an EdgeType — its
    // view is graph-extension-only, so endpoint resolution against
    // compile-time host kinds isn't possible there.
    const type = defineEdge(
      edge.kindName,
      compactUndefined({
        schema: edge.schema,
        description: edge.description,
        annotations: edge.annotations,
        from,
        to,
      }),
    ) as unknown as EdgeType;
    mergedEdges[edge.kindName] = { type, from, to };
  }

  // Drop ontology relations that came from the previous graph-extension
  // document — `compiled.ontology` reproduces them from the union, so
  // keeping the originals would double-stack. Pre-build a Set of
  // canonical keys for O(1) lookup; the naive per-relation `.some`
  // scan was O(N×M).
  const runtimeOntologyKeys =
    buildGraphExtensionOntologyKeySet(existingDocument);
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
  // graph-extension kinds in the union document. Compile-time vector indexes
  // already live on `graph.indexes` from `defineGraph`; we drop any
  // prior runtime-origin entries (the union document is the source of
  // truth) and re-derive against the current graph-extension nodes so the
  // result is correct after add / replace cycles. Explicit compile-
  // time indexes win on (kind, fieldPath) collisions per the
  // `mergeVectorIndexes` contract.
  const runtimeVectorIndexes: readonly VectorIndexDeclaration[] =
    deriveGraphExtensionVectorIndexes(compiled.nodes);
  // Document-declared relational indexes (analogue of compile-time
  // `defineNodeIndex` / `defineEdgeIndex` passed to defineGraph).
  // Resolved here because schema introspection requires the merged
  // NodeType / EdgeType — graph-extension-declared kinds AND compile-time
  // host kinds are both reachable as targets.
  const runtimeRelationalIndexes = compileGraphExtensionRelationalIndexes(
    compiled.indexes,
    nodeKinds,
    mergedEdges,
    graph.id,
  );
  const mergedIndexes = mergeIndexesWithGraphExtension(
    graph.indexes,
    [...runtimeVectorIndexes, ...runtimeRelationalIndexes],
    graph.id,
  );

  // Returned as `G` even though graph-extension kinds aren't in the static
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

function deriveGraphExtensionVectorIndexes(
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

function mergeIndexesWithGraphExtension(
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
          "Give the graph-extension index a unique `name`, or remove the duplicate declaration.",
      },
    );
  }
}

function compileGraphExtensionRelationalIndexes(
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
        `Graph-extension index \`where\` references unknown field "${where.field}".`,
        { field: where.field, code: "EXTENSION_INDEX_WHERE_UNKNOWN_FIELD" },
      );
    }
    return where.op === "isNull" ? builder.isNull() : builder.isNotNull();
  };
}

function toNodeIndexConfig(
  document: Extract<ExtensionIndex, { entity: "node" }>,
): Readonly<Record<string, unknown>> {
  return compactUndefined<Record<string, unknown>>({
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
  return compactUndefined<Record<string, unknown>>({
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
  if (isEmptyExtension(existing)) {
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
    : dedupBy(
        [...(existing.ontology ?? []), ...(next.ontology ?? [])],
        graphExtensionOntologyKey,
      );
  const indexes =
    existing.indexes === undefined && next.indexes === undefined ?
      undefined
    : dedupBy(
        [...(existing.indexes ?? []), ...(next.indexes ?? [])],
        indexCompositeKey,
        "last",
      );

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
 * Dedupe `items` by `keyFn`, preserving first-seen order. `strategy`
 * controls which entry survives a key collision:
 *
 * - `"first"` (default): drop later duplicates. Used for ontology
 *   relations — re-applying the same relation in a later evolve is a
 *   no-op, not a redefinition.
 * - `"last"`: keep the most-recent value. Used for indexes — declared
 *   indexes don't carry independent identity beyond the composite key,
 *   so the most recent declaration wins. Idempotent re-evolve relies
 *   on `canonicalEqual(merged, existing)`, which is
 *   preserved as long as `next` carries an identical entry.
 */
function dedupBy<T>(
  items: readonly T[],
  keyFunction: (item: T) => string,
  strategy: "first" | "last" = "first",
): readonly T[] {
  const seen = new Map<string, T>();
  const order: string[] = [];
  for (const item of items) {
    const key = keyFunction(item);
    if (!seen.has(key)) {
      order.push(key);
      seen.set(key, item);
    } else if (strategy === "last") {
      seen.set(key, item);
    }
  }
  return order.map((key) => seen.get(key)!);
}

function indexCompositeKey(entry: ExtensionIndex): string {
  return `${entry.entity}|${entry.kind}|${entry.name ?? ""}|${entry.fields.join(",")}`;
}

/**
 * `true` when none of the v1 content slots carry data. Drives the
 * first-evolve fast path in `unionDocuments`, and any future caller
 * that needs to short-circuit on a "nothing to merge" document.
 */
function isEmptyExtension(extension: GraphExtension): boolean {
  return (
    extension.nodes === undefined &&
    extension.edges === undefined &&
    extension.ontology === undefined &&
    extension.indexes === undefined
  );
}

function assertNoCollision(
  kindName: string,
  entity: KindEntity,
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
