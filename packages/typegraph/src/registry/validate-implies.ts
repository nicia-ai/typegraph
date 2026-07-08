/**
 * Endpoint-compatibility validation for `implies()` ontology relations.
 *
 * Every place that builds a query-capable `KindRegistry` — `buildKindRegistry`
 * for a live `GraphDef`, and the schema deserializer for a persisted schema —
 * calls this so an endpoint-incompatible implication can never reach
 * `KindRegistry.expandImplyingEdges()`. Without this gate, an implying edge
 * would be folded into any `expand: "implying"` traversal for the edge it
 * implies even when it connects entirely different node kinds — the query
 * compiler filters by expanded edge kind plus the *queried* node aliases, not
 * by the implied edge's own domain/range, so a mismatched edge would silently
 * satisfy whatever kinds the traversal alias happens to ask for.
 */
import { ConfigurationError } from "../errors/index";
import { META_EDGE_IMPLIES } from "../ontology/constants";
import { type KindRegistry } from "./kind-registry";

/** An edge kind's declared domain (`from`) and range (`to`) kind names. */
export type EdgeEndpointKinds = Readonly<{
  from: readonly string[];
  to: readonly string[];
}>;

/**
 * Rejects implications whose implying edge can never be endpoint-compatible
 * with the edge it implies.
 *
 * The check runs over the *effective transitive closure*, not the authored
 * direct relations: for every registered edge `C`, every edge `A` that
 * `registry.expandImplyingEdges(C)` reports as (transitively) implying `C` is
 * validated directly against `C`. This is what keeps the gate sound through an
 * unregistered intermediate — given `A implies B implies C` with `B` absent
 * from `edgeEndpoints`, neither direct hop is individually checkable, yet the
 * precomputed closure still folds `A` into a traversal of `C`, so `A` must be
 * validated against `C` regardless of `B`.
 *
 * A relation is compatible when every kind the implying edge allows on a side
 * is assignable — via `registry.isAssignableToAny` (equal, or a `subClassOf`
 * descendant) — to at least one kind the implied edge allows on that same
 * side. An implying edge kind absent from `edgeEndpoints` is skipped: it is
 * unregistered on this graph, has no stored rows, and so can never fold
 * anything into a traversal.
 */
export function validateImpliesEndpointCompatibility(
  edgeEndpoints: ReadonlyMap<string, EdgeEndpointKinds>,
  registry: KindRegistry,
): void {
  for (const [impliedEdgeKind, impliedEndpoints] of edgeEndpoints) {
    for (const implyingEdgeKind of registry.expandImplyingEdges(
      impliedEdgeKind,
    )) {
      if (implyingEdgeKind === impliedEdgeKind) continue;
      const implyingEndpoints = edgeEndpoints.get(implyingEdgeKind);
      if (!implyingEndpoints) continue;

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
