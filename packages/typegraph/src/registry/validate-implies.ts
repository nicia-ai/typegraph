/**
 * Endpoint-compatibility validation for `implies()` ontology relations.
 *
 * Every place that builds a query-capable `KindRegistry` — `buildKindRegistry`
 * for a live `GraphDef`, and the schema deserializer for a persisted schema —
 * calls this so an endpoint-incompatible `implies(edgeA, edgeB)` can never
 * reach `KindRegistry.expandImplyingEdges()`. Without this gate, `edgeA`
 * would be folded into any `expand: "implying"` traversal for `edgeB` even
 * when `edgeA` connects entirely different node kinds — the query compiler
 * filters by expanded edge kind plus the *queried* node aliases, not by
 * `edgeB`'s own domain/range, so a mismatched edge would silently satisfy
 * whatever kinds the traversal alias happens to ask for.
 */
import { ConfigurationError } from "../errors/index";
import { META_EDGE_IMPLIES } from "../ontology/constants";
import { getTypeName, type OntologyRelation } from "../ontology/types";
import { type KindRegistry } from "./kind-registry";

/**
 * The minimal shape both a live `OntologyRelation` (`metaEdge` is a
 * `MetaEdge` object, `from`/`to` may be `EdgeType` objects) and a
 * `SerializedOntologyRelation` (`metaEdge`/`from`/`to` are all plain
 * strings) can be adapted to — this validator only needs the meta-edge
 * name and each endpoint's kind name. `from`/`to` reuse `OntologyRelation`'s
 * own field type so this can never drift from what `getTypeName()` accepts.
 */
export type ImpliesRelationLike = Readonly<{
  metaEdgeName: string;
  from: OntologyRelation["from"];
  to: OntologyRelation["to"];
}>;

/** An edge kind's declared domain (`from`) and range (`to`) kind names. */
export type EdgeEndpointKinds = Readonly<{
  from: readonly string[];
  to: readonly string[];
}>;

/**
 * Rejects `implies(edgeA, edgeB)` relations whose declared endpoints can
 * never be compatible with the edge they imply.
 *
 * A relation is compatible when every kind the implying edge allows on a
 * side is assignable — via `registry.isAssignableToAny` (equal, or a
 * `subClassOf` descendant) — to at least one kind the implied edge allows
 * on that same side. Relations naming an edge kind absent from
 * `edgeEndpoints` are skipped — they cannot affect this graph's traversals.
 *
 * Soundness holds transitively: validating each direct relation certifies
 * the whole `edgeImplyingClosure`, since subclass assignability composes
 * (if A implies B and B implies C, A→B and B→C compatibility together
 * guarantee A→C compatibility) — no separate check of the expanded closure
 * is needed.
 */
export function validateImpliesEndpointCompatibility(
  relations: readonly ImpliesRelationLike[],
  edgeEndpoints: ReadonlyMap<string, EdgeEndpointKinds>,
  registry: KindRegistry,
): void {
  for (const relation of relations) {
    if (relation.metaEdgeName !== META_EDGE_IMPLIES) continue;

    const implyingEdgeKind = getTypeName(relation.from);
    const impliedEdgeKind = getTypeName(relation.to);
    const implyingEndpoints = edgeEndpoints.get(implyingEdgeKind);
    const impliedEndpoints = edgeEndpoints.get(impliedEdgeKind);
    if (!implyingEndpoints || !impliedEndpoints) continue;

    assertEndpointCompatible(
      "from",
      implyingEdgeKind,
      implyingEndpoints.from,
      impliedEdgeKind,
      impliedEndpoints.from,
      registry,
    );
    assertEndpointCompatible(
      "to",
      implyingEdgeKind,
      implyingEndpoints.to,
      impliedEdgeKind,
      impliedEndpoints.to,
      registry,
    );
  }
}

function assertEndpointCompatible(
  side: "from" | "to",
  implyingEdgeKind: string,
  implyingKinds: readonly string[],
  impliedEdgeKind: string,
  impliedKinds: readonly string[],
  registry: KindRegistry,
): void {
  const incompatibleKinds = implyingKinds.filter(
    (kind) => !registry.isAssignableToAny(kind, impliedKinds),
  );
  if (incompatibleKinds.length === 0) return;

  throw new ConfigurationError(
    `implies("${implyingEdgeKind}", "${impliedEdgeKind}") is endpoint-incompatible: ` +
      `${side} kind(s) [${incompatibleKinds.join(", ")}] declared on "${implyingEdgeKind}" ` +
      `cannot be assigned to any of "${impliedEdgeKind}"'s ${side} kind(s) [${impliedKinds.join(", ")}].`,
    {
      metaEdge: META_EDGE_IMPLIES,
      implyingEdge: implyingEdgeKind,
      impliedEdge: impliedEdgeKind,
      endpoint: side,
      incompatibleKinds,
      allowedKinds: impliedKinds,
    },
    {
      suggestion:
        `Add a subClassOf relation from each of [${incompatibleKinds.join(", ")}] to one of ` +
        `"${impliedEdgeKind}"'s ${side} kind(s) [${impliedKinds.join(", ")}], narrow "${implyingEdgeKind}"'s ` +
        `${side} declaration to exclude [${incompatibleKinds.join(", ")}], or remove ` +
        `implies("${implyingEdgeKind}", "${impliedEdgeKind}").`,
    },
  );
}
