import { ConfigurationError } from "../errors";
import { META_EDGE_INVERSE_OF } from "../ontology/constants";
import { type NamedOntologyRelation } from "../ontology/validation";
import { type KindRegistry } from "./kind-registry";
import { type EdgeEndpointKinds } from "./validate-implies";

/** Validates the endpoint reversal required by every registered inverse pair. */
export function validateInverseEndpointCompatibility(
  ontology: readonly NamedOntologyRelation[],
  edgeEndpoints: ReadonlyMap<string, EdgeEndpointKinds>,
  registry: KindRegistry,
): void {
  for (const relation of ontology) {
    if (relation.metaEdge !== META_EDGE_INVERSE_OF) continue;
    const left = edgeEndpoints.get(relation.from);
    const right = edgeEndpoints.get(relation.to);
    if (left === undefined || right === undefined) continue;

    assertInverseSideCompatible(
      relation.from,
      "from",
      left.from,
      relation.to,
      "to",
      right.to,
      registry,
    );
    assertInverseSideCompatible(
      relation.from,
      "to",
      left.to,
      relation.to,
      "from",
      right.from,
      registry,
    );
    if (relation.from === relation.to) continue;
    assertInverseSideCompatible(
      relation.to,
      "from",
      right.from,
      relation.from,
      "to",
      left.to,
      registry,
    );
    assertInverseSideCompatible(
      relation.to,
      "to",
      right.to,
      relation.from,
      "from",
      left.from,
      registry,
    );
  }
}

function assertInverseSideCompatible(
  sourceEdge: string,
  sourceSide: "from" | "to",
  sourceKinds: readonly string[],
  inverseEdge: string,
  inverseSide: "from" | "to",
  inverseKinds: readonly string[],
  registry: KindRegistry,
): void {
  const incompatibleKinds = sourceKinds.filter(
    (kind) => !registry.isAssignableToAny(kind, inverseKinds),
  );
  if (incompatibleKinds.length === 0) return;

  throw new ConfigurationError(
    `inverseOf("${sourceEdge}", "${inverseEdge}") is endpoint-incompatible: ` +
      `${sourceSide} kind(s) [${incompatibleKinds.join(", ")}] declared on "${sourceEdge}" ` +
      `cannot be assigned to any of "${inverseEdge}"'s ${inverseSide} kind(s) [${inverseKinds.join(", ")}].`,
    {
      metaEdge: META_EDGE_INVERSE_OF,
      sourceEdge,
      inverseEdge,
      sourceEndpoint: sourceSide,
      inverseEndpoint: inverseSide,
      incompatibleKinds,
      allowedKinds: inverseKinds,
    },
    {
      suggestion:
        "Make the inverse edge declarations exact reversals (allowing subClassOf assignability), or remove the inverseOf relation.",
    },
  );
}
