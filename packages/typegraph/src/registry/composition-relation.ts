/**
 * The composition relation — THE authoritative record of every declared
 * `partOf` / `hasPart` pair on a graph, plus the orientation and whole-side
 * population each pair resolves to.
 *
 * `buildCompositionRelation` is deliberately both the builder AND the
 * validator, in one traversal: a separate `validateCompositionRelations`
 * would have to re-derive orientation, population, and exactness to decide
 * whether to throw, which is a second spelling of every decision this
 * function makes. It returns both the relation and the issues found while
 * building it; the caller (`src/registry/build-validated.ts`) throws.
 *
 * Every other consumer of composition — write validation, the claim writer,
 * the acyclicity check, navigation, cascade, interchange, merge — reads the
 * resulting `CompositionRelation` only through `KindRegistry`'s derived
 * readers, never `pairs` directly. That is what keeps "is this edge kind a
 * composition edge" and "which side is the part" answered once.
 */
import { META_EDGE_HAS_PART, META_EDGE_PART_OF } from "../ontology/constants";
import { type NamedOntologyRelation } from "../ontology/validation";
import { compareStrings } from "../utils/compare";
import { requireDefined } from "../utils/presence";
import { encodeTupleKey } from "../utils/tuple-key";
import { type EdgeKindFacts } from "./edge-kind-facts";
import { type KindRegistry } from "./kind-registry";

// ============================================================
// Types
// ============================================================

/** Which endpoint of the realizing edge carries the PART. R5's orientation. */
export type CompositionPartSide = "from" | "to";

/** One declared composition pair and the edge that realizes it. */
export type CompositionPair = Readonly<{
  partKind: string;
  wholeKind: string;
  viaEdgeKind: string;
  /** R5: inferred from the pair against the edge's endpoints, or declared. */
  partSide: CompositionPartSide;
  /**
   * The WHOLE-side cardinality of the realizing edge: `cardinality` when
   * `partSide === "from"`, `targetCardinality` when it is `"to"`. This
   * single value is the temporal population every composition claim reads.
   */
  population: "one" | "oneActive";
}>;

/** THE composition relation of one graph. Everything else is derived. */
export type CompositionRelation = Readonly<{
  /** Code-point ordered by (partKind, wholeKind, viaEdgeKind). */
  pairs: readonly CompositionPair[];
  /** Every realizing edge kind, flat, code-point ordered. */
  edgeKinds: ReadonlySet<string>;
  /** Orientation per realizing edge kind. */
  partSideByEdgeKind: ReadonlyMap<string, CompositionPartSide>;
}>;

export const EMPTY_COMPOSITION_RELATION: CompositionRelation = {
  pairs: [],
  edgeKinds: new Set(),
  partSideByEdgeKind: new Map(),
};

export type CompositionIssueCode =
  | "ONTOLOGY_COMPOSITION_VIA_UNKNOWN"
  | "ONTOLOGY_COMPOSITION_VIA_ENDPOINTS"
  | "ONTOLOGY_COMPOSITION_PART_SIDE_REQUIRED"
  | "ONTOLOGY_COMPOSITION_PART_SIDE_INVALID"
  | "ONTOLOGY_COMPOSITION_CARDINALITY"
  | "ONTOLOGY_COMPOSITION_VIA_MIXED"
  | "ONTOLOGY_COMPOSITION_POPULATION_MIXED";

export type CompositionIssue = Readonly<{
  code: CompositionIssueCode;
  message: string;
  relation: NamedOntologyRelation;
}>;

// ============================================================
// Orientation inference
// ============================================================

/**
 * Whether the realizing edge admits an instance whose `from` endpoint is
 * (assignable to) `fromCandidate` and whose `to` endpoint is (assignable to)
 * `toCandidate`, against `EdgeKindFacts.pairs` — the edge's admitted
 * `(from, to)` pairs, already resolved (source-dependent target map or plain
 * Cartesian product) by the one site that builds it. `pairs` is typed
 * optional only because `EdgeKindFacts` is shared with older, pre-pairs
 * consumers; composition's two construction sites
 * (`buildGraphEdgeKindFacts`, the deserializer's) always populate it, so
 * a missing one here is a builder defect, not a shape this function should
 * quietly re-derive a Cartesian product for (a second, driftable spelling of
 * the same value).
 */
function edgeAdmitsPair(
  fromCandidate: string,
  toCandidate: string,
  facts: EdgeKindFacts,
  registry: KindRegistry,
): boolean {
  return requireDefined(
    facts.pairs,
    "EdgeKindFacts.pairs must be populated for composition validation",
  ).some(
    (pair) =>
      registry.isAssignableTo(fromCandidate, pair.from) &&
      registry.isAssignableTo(toCandidate, pair.to),
  );
}

/**
 * Infers which side of the realizing edge carries the PART, for one declared
 * `(partKind, wholeKind)` pair.
 *
 * - Neither orientation is endpoint-compatible: `ONTOLOGY_COMPOSITION_VIA_ENDPOINTS`.
 * - Exactly one is: that side — a `declared` value contradicting it is
 *   `ONTOLOGY_COMPOSITION_PART_SIDE_INVALID` (a stated option is applied or
 *   refused, never ignored); a `declared` value agreeing with it is accepted
 *   as redundant.
 * - Both are (same-kind or otherwise ambiguous containment): `declared`
 *   decides; absent is `ONTOLOGY_COMPOSITION_PART_SIDE_REQUIRED`.
 */
export function inferCompositionPartSide(
  pair: Readonly<{
    partKind: string;
    wholeKind: string;
    declared?: CompositionPartSide;
  }>,
  facts: EdgeKindFacts,
  registry: KindRegistry,
):
  | Readonly<{ partSide: CompositionPartSide }>
  | Readonly<{ code: CompositionIssueCode }> {
  const forwardOk = edgeAdmitsPair(
    pair.partKind,
    pair.wholeKind,
    facts,
    registry,
  );
  const reverseOk = edgeAdmitsPair(
    pair.wholeKind,
    pair.partKind,
    facts,
    registry,
  );

  if (!forwardOk && !reverseOk) {
    return { code: "ONTOLOGY_COMPOSITION_VIA_ENDPOINTS" };
  }

  if (forwardOk && reverseOk) {
    if (pair.declared === undefined) {
      return { code: "ONTOLOGY_COMPOSITION_PART_SIDE_REQUIRED" };
    }
    return { partSide: pair.declared };
  }

  const inferred: CompositionPartSide = forwardOk ? "from" : "to";
  if (pair.declared !== undefined && pair.declared !== inferred) {
    return { code: "ONTOLOGY_COMPOSITION_PART_SIDE_INVALID" };
  }
  return { partSide: inferred };
}

// ============================================================
// The builder / validator
// ============================================================

/**
 * Whether `metaEdge` is one of the two composition meta-edges (`partOf` /
 * `hasPart`). Exported so every site that needs "is this relation a
 * composition relation" calls one predicate instead of re-spelling the
 * `=== META_EDGE_PART_OF || === META_EDGE_HAS_PART` pair (E-a-7).
 */
export function isCompositionMetaEdge(metaEdge: string): boolean {
  return metaEdge === META_EDGE_PART_OF || metaEdge === META_EDGE_HAS_PART;
}

/**
 * Normalizes a `partOf` or `hasPart` relation to `(partKind, wholeKind)`.
 * Exported so the registry's declaration-closure collector
 * (`kind-registry.ts`'s `partOf`/`hasPart` closure) shares this decision
 * instead of re-spelling the same from/to flip (E-a-7).
 */
export function normalizePartWhole(
  relation: NamedOntologyRelation,
): Readonly<{ partKind: string; wholeKind: string }> {
  return relation.metaEdge === META_EDGE_PART_OF ?
      { partKind: relation.from, wholeKind: relation.to }
    : { partKind: relation.to, wholeKind: relation.from };
}

/** The subset of {@link CompositionIssueCode} `inferCompositionPartSide` can return. */
type InferenceIssueCode = Extract<
  CompositionIssueCode,
  | "ONTOLOGY_COMPOSITION_VIA_ENDPOINTS"
  | "ONTOLOGY_COMPOSITION_PART_SIDE_REQUIRED"
  | "ONTOLOGY_COMPOSITION_PART_SIDE_INVALID"
>;

/**
 * Narrows `inferCompositionPartSide`'s widened public return type back to
 * the codes it can actually produce, so the message builder's switch stays
 * exhaustive without a defensive `default` for a state the function cannot
 * reach.
 */
function isInferenceIssueCode(
  code: CompositionIssueCode,
): code is InferenceIssueCode {
  return (
    code === "ONTOLOGY_COMPOSITION_VIA_ENDPOINTS" ||
    code === "ONTOLOGY_COMPOSITION_PART_SIDE_REQUIRED" ||
    code === "ONTOLOGY_COMPOSITION_PART_SIDE_INVALID"
  );
}

function inferenceIssueMessage(
  code: InferenceIssueCode,
  relation: NamedOntologyRelation,
  partKind: string,
  wholeKind: string,
  viaEdgeKind: string,
): string {
  const relationLabel = `${relation.metaEdge}(${relation.from}, ${relation.to})`;
  switch (code) {
    case "ONTOLOGY_COMPOSITION_VIA_ENDPOINTS": {
      return (
        `Composition relation ${relationLabel} is endpoint-incompatible with its \`via\` edge "${viaEdgeKind}": ` +
        `neither ("${partKind}" -> "${wholeKind}") nor ("${wholeKind}" -> "${partKind}") is an endpoint pair "${viaEdgeKind}" admits.`
      );
    }
    case "ONTOLOGY_COMPOSITION_PART_SIDE_REQUIRED": {
      return (
        `Composition relation ${relationLabel} is ambiguous: edge "${viaEdgeKind}" admits both orientations ` +
        `between "${partKind}" and "${wholeKind}", so \`partSide: "from" | "to"\` is required.`
      );
    }
    case "ONTOLOGY_COMPOSITION_PART_SIDE_INVALID": {
      return `Composition relation ${relationLabel} declares a \`partSide\` that contradicts edge "${viaEdgeKind}"'s endpoints.`;
    }
  }
}

/**
 * Builds and validates the composition relation from the ontology's
 * `partOf` / `hasPart` relations.
 *
 * Assumes the shape checks in `validateOntologyRelations`
 * (`ONTOLOGY_COMPOSITION_VIA_REQUIRED` / `..._FORBIDDEN`) already ran and
 * passed: every `partOf` / `hasPart` relation reaching this function has a
 * `via`. A relation missing `via` is skipped rather than re-reported, since
 * `build-validated.ts` never calls this function until that pass is clean.
 */
export function buildCompositionRelation(
  ontology: readonly NamedOntologyRelation[],
  edgeFacts: ReadonlyMap<string, EdgeKindFacts>,
  registry: KindRegistry,
): Readonly<{
  relation: CompositionRelation;
  issues: readonly CompositionIssue[];
}> {
  const issues: CompositionIssue[] = [];
  const pairs: CompositionPair[] = [];
  const seenPairKeys = new Set<string>();
  const partSideByEdgeKind = new Map<string, CompositionPartSide>();
  const representativeByEdgeKind = new Map<string, NamedOntologyRelation>();

  for (const relation of ontology) {
    if (!isCompositionMetaEdge(relation.metaEdge)) {
      continue;
    }
    const viaEdgeKind = relation.via;
    if (viaEdgeKind === undefined) continue;

    const facts = edgeFacts.get(viaEdgeKind);
    if (facts === undefined) {
      issues.push({
        code: "ONTOLOGY_COMPOSITION_VIA_UNKNOWN",
        message: `Composition relation ${relation.metaEdge}(${relation.from}, ${relation.to}) names unregistered edge kind "${viaEdgeKind}" as its \`via\`.`,
        relation,
      });
      continue;
    }

    const { partKind, wholeKind } = normalizePartWhole(relation);
    const inference = inferCompositionPartSide(
      {
        partKind,
        wholeKind,
        ...(relation.partSide === undefined ?
          {}
        : { declared: relation.partSide }),
      },
      facts,
      registry,
    );
    if ("code" in inference) {
      issues.push({
        code: inference.code,
        message:
          isInferenceIssueCode(inference.code) ?
            inferenceIssueMessage(
              inference.code,
              relation,
              partKind,
              wholeKind,
              viaEdgeKind,
            )
          : `Composition relation ${relation.metaEdge}(${relation.from}, ${relation.to}) is invalid ("${inference.code}").`,
        relation,
      });
      continue;
    }

    const { partSide } = inference;
    const population =
      partSide === "from" ? facts.cardinality : facts.targetCardinality;
    if (population !== "one" && population !== "oneActive") {
      const optionName =
        partSide === "from" ? "cardinality" : "targetCardinality";
      issues.push({
        code: "ONTOLOGY_COMPOSITION_CARDINALITY",
        message:
          `Composition edge "${viaEdgeKind}" must declare \`${optionName}: "one"\` or \`"oneActive"\` ` +
          `(found "${population}") because it realizes ${relation.metaEdge}(${relation.from}, ${relation.to}).`,
        relation,
      });
      continue;
    }

    // A second declaration disagreeing with an already-recorded orientation
    // for this edge kind is refused directly, rather than relying on
    // composition-exactness (below) to notice a coverage gap: exactness
    // only catches the conflict when the corrupted pair also fails to
    // reproduce the edge's admitted pairs, which is not guaranteed for
    // every endpoint shape and makes the verdict declaration-order
    // dependent. Recording one side per edge kind and refusing a
    // contradicting second side keeps the map's invariant true by
    // construction instead of by coincidence.
    const existingPartSide = partSideByEdgeKind.get(viaEdgeKind);
    if (existingPartSide !== undefined && existingPartSide !== partSide) {
      issues.push({
        code: "ONTOLOGY_COMPOSITION_VIA_MIXED",
        message:
          `Edge kind "${viaEdgeKind}" realizes composition in two different orientations ` +
          `("${existingPartSide}" and "${partSide}"); one edge kind must have one part side.`,
        relation,
      });
      continue;
    }
    partSideByEdgeKind.set(viaEdgeKind, partSide);
    representativeByEdgeKind.set(viaEdgeKind, relation);

    // The documented `partOf(part, whole, ...)` + mirrored
    // `hasPart(whole, part, ...)` idiom (both realized by the same edge)
    // normalizes to the identical (partKind, wholeKind, viaEdgeKind) tuple.
    // Keep one `CompositionPair` per tuple so every `pairs` consumer
    // (exactness, population, cascade, navigation) processes it once.
    const pairKey = encodeTupleKey([partKind, wholeKind, viaEdgeKind]);
    if (seenPairKeys.has(pairKey)) continue;
    seenPairKeys.add(pairKey);

    pairs.push({
      partKind,
      wholeKind,
      viaEdgeKind,
      partSide,
      population,
    });
  }

  // Composition-exactness: every allowed (from, to) pair the realizing edge
  // admits must be a declared composition pair in the inferred orientation.
  // This is what makes "is a composition edge" a whole-kind property, so
  // cascade and navigation can use a flat edge-kind set with no per-pair
  // filter.
  for (const edgeKind of partSideByEdgeKind.keys()) {
    const facts = edgeFacts.get(edgeKind);
    if (facts === undefined) continue;
    const declaredTuples = new Set(
      pairs
        .filter((pair) => pair.viaEdgeKind === edgeKind)
        .map((pair) =>
          pair.partSide === "from" ?
            encodeTupleKey([pair.partKind, pair.wholeKind])
          : encodeTupleKey([pair.wholeKind, pair.partKind]),
        ),
    );
    const representative = requireDefined(
      representativeByEdgeKind.get(edgeKind),
      `Composition edge "${edgeKind}" has an orientation with no declaring relation.`,
    );
    for (const { from, to } of requireDefined(
      facts.pairs,
      "EdgeKindFacts.pairs must be populated for composition validation",
    )) {
      if (!declaredTuples.has(encodeTupleKey([from, to]))) {
        issues.push({
          code: "ONTOLOGY_COMPOSITION_VIA_MIXED",
          message:
            `Edge kind "${edgeKind}" admits (${from} -> ${to}), which is not a declared composition pair. ` +
            `Every pair "${edgeKind}" admits must be declared as a partOf/hasPart pair, or the edge must be split so it is exclusively a composition edge.`,
          relation: representative,
        });
      }
    }
  }

  // Uniform population: every composition edge that can hold a given node
  // kind as its part must agree on the whole-side cardinality, because R4's
  // claim axis is relation-wide, not per-edge.
  const candidateKinds = new Set<string>();
  for (const pair of pairs) {
    candidateKinds.add(pair.partKind);
    for (const descendant of registry.subClassDescendants.get(pair.partKind) ??
      []) {
      candidateKinds.add(descendant);
    }
  }
  for (const kind of candidateKinds) {
    const applicable = pairs.filter(
      (pair) =>
        kind === pair.partKind || registry.isAssignableTo(kind, pair.partKind),
    );
    const populations = new Set(applicable.map((pair) => pair.population));
    if (populations.size > 1) {
      const representative = requireDefined(applicable[0]);
      issues.push({
        code: "ONTOLOGY_COMPOSITION_POPULATION_MIXED",
        message:
          `Node kind "${kind}" is a composition part under edges declaring different populations ` +
          `(${[...populations].toSorted((left, right) => compareStrings(left, right)).join(", ")}); ` +
          `every composition edge that can hold "${kind}" as a part must declare the same cardinality.`,
        relation: {
          metaEdge: META_EDGE_PART_OF,
          from: representative.partKind,
          to: representative.wholeKind,
          via: representative.viaEdgeKind,
          partSide: representative.partSide,
        },
      });
    }
  }

  const sortedPairs = pairs.toSorted(
    (left, right) =>
      compareStrings(left.partKind, right.partKind) ||
      compareStrings(left.wholeKind, right.wholeKind) ||
      compareStrings(left.viaEdgeKind, right.viaEdgeKind),
  );
  const edgeKinds = new Set(
    [...partSideByEdgeKind.keys()].toSorted((left, right) =>
      compareStrings(left, right),
    ),
  );

  return {
    relation: { pairs: sortedPairs, edgeKinds, partSideByEdgeKind },
    issues,
  };
}
