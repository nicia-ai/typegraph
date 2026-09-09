/**
 * Composition claims (item E) — what a `partOf`/`hasPart` realizing edge
 * write reserves, on top of whatever ordinary cardinality axis it already
 * reserves.
 *
 * R4 is one invariant, relation-wide: a part holds exactly one whole across
 * EVERY declared composition pair, not one whole per realizing edge kind. It
 * therefore cannot be an ordinary per-edge-kind cardinality claim — two
 * different edge kinds attaching the same part must collide on one row. This
 * module is the ONE owner of that extra reservation: `compositionClaim`
 * decides whether one edge kind owes it, {@link edgeInsertClaims} folds it
 * into the claim SET every edge insert (or re-entry) issues, and
 * `compositionClaimRefusal` (`./edge-claims`, its physical home — see that
 * file's docblock) is the one typed error a lost claim raises.
 */
import {
  type ClaimEdgeCardinalityParams,
  type CompositionClaimScope,
  type EdgeCardinalityDeclaration,
} from "../../backend/types";
import { type CompositionPartSide } from "../../registry/composition-relation";
import { type KindRegistry } from "../../registry/kind-registry";
import { requireDefined } from "../../utils/presence";
import { compareClaimTargets } from "./axis";
import {
  type EdgeCardinalityAxisRef,
  edgeCardinalityAxisReferences,
  edgeCardinalityClaims,
  edgeCardinalityClaimTarget,
  type EdgeCardinalityDeclarations,
  edgeCardinalitySpec,
  type EdgeClaimSubject,
} from "./edge-claims";

/**
 * THE oriented holder list every composition claim on this graph carries as
 * its `scope.holders` — one entry per realizing edge kind, tagged with which
 * endpoint of that kind is the part. Computed once per call rather than
 * cached: it folds a `KindRegistry`'s own already-built map
 * (`compositionEdgeKinds`/`compositionPartSide`), so recomputing it is a
 * flat map over data the registry already holds, not a second traversal of
 * the ontology.
 */
function compositionHolders(
  registry: KindRegistry,
): readonly Readonly<{ edgeKind: string; partSide: CompositionPartSide }>[] {
  return registry.compositionEdgeKinds().map((edgeKind) => ({
    edgeKind,
    partSide: requireDefined(
      registry.compositionPartSide(edgeKind),
      `"${edgeKind}" is in compositionEdgeKinds() but has no recorded partSide`,
    ),
  }));
}

/**
 * R5's orientation, translated into the vocabulary an ordinary edge
 * cardinality claim already understands: the part's side is the DIRECTION
 * (`"source"` when the part is `from`, `"target"` when it is `to`), and the
 * whole-side population (§2.6) is the CARDINALITY. This is what lets a
 * composition claim reuse {@link edgeCardinalitySpec}'s `keyShape` and
 * `holderLiveness` with no new table: `edgeCardinalitySpec` already answers
 * both for every `(direction, cardinality)` pair, composition or not.
 */
function compositionAxisRef(
  partSide: CompositionPartSide,
  population: "one" | "oneActive",
): EdgeCardinalityAxisRef {
  return partSide === "from" ?
      { direction: "source", cardinality: population }
    : { direction: "target", cardinality: population };
}

/**
 * THE composition claim an edge insert owes, or `undefined` when it owes
 * none (an ordinary, non-composition edge kind).
 *
 * Not exported beyond this module: {@link edgeInsertClaims} and
 * {@link compositionReentryClaim} are the only two callers, both here.
 */
function compositionClaim(
  registry: KindRegistry,
  subject: EdgeClaimSubject,
): ClaimEdgeCardinalityParams | undefined {
  const partSide = registry.compositionPartSide(subject.kind);
  if (partSide === undefined) return undefined;
  const partConcreteKind =
    partSide === "from" ? subject.fromKind : subject.toKind;
  const population = requireDefined(
    registry.compositionPopulation(partConcreteKind),
    `"${subject.kind}" is a composition edge kind but "${partConcreteKind}" has no recorded composition population`,
  );
  return {
    ...compositionAxisRef(partSide, population),
    graphId: subject.graphId,
    edgeKind: subject.kind,
    edgeId: subject.id,
    fromKind: subject.fromKind,
    fromId: subject.fromId,
    toKind: subject.toKind,
    toId: subject.toId,
    scope: { kind: "composition", holders: compositionHolders(registry) },
  };
}

/** Claim targets in {@link compareClaimTargets} order — the canonical claim order. */
function sortedByClaimTarget(
  claims: readonly ClaimEdgeCardinalityParams[],
): readonly ClaimEdgeCardinalityParams[] {
  return claims
    .map((claim) => ({ claim, target: edgeCardinalityClaimTarget(claim) }))
    .toSorted((left, right) => compareClaimTargets(left.target, right.target))
    .map((entry) => entry.claim);
}

/**
 * THE claims one edge insert owes: every declared cardinality axis, plus the
 * composition claim when the edge kind realizes one, in claim order
 * ({@link compareClaimTargets}) — not declaration order and not insertion
 * order, so a peer taking the same two rows can never take them in the
 * opposite order and deadlock.
 *
 * The ONE owner every insert path calls: the store's `edgeInsertWork`
 * (`src/store/operations/edge-operations.ts`) and import's
 * `importEdgeInsertWork` (`src/interchange/import.ts`), which before this
 * both called {@link edgeCardinalityClaims} directly for the same reason.
 */
export function edgeInsertClaims(
  registry: KindRegistry,
  declarations: EdgeCardinalityDeclarations,
  subject: EdgeClaimSubject,
): readonly ClaimEdgeCardinalityParams[] {
  const ordinary = edgeCardinalityClaims(
    edgeCardinalityAxisReferences(declarations),
    subject,
  );
  const composition = compositionClaim(registry, subject);
  // The same "does a row born already ended still claim?" exemption
  // {@link edgeCardinalityClaims} applies to every ordinary axis, applied to
  // composition's own axis: an edge born ended never joins a
  // `claimsWhenBornEnded: false` (`oneActive`) population, composition
  // included.
  const owesComposition =
    composition !== undefined &&
    (edgeCardinalitySpec(composition).claimsWhenBornEnded ||
      subject.validTo === undefined);
  return sortedByClaimTarget(
    owesComposition ? [...ordinary, composition] : ordinary,
  );
}

/**
 * THE composition claim a RE-ENTRY (a resurrect, or a bare active-only
 * window reopen) owes, mirroring the same gate the caller already applies to
 * its own ordinary axes (`reentryAxisReferences` in
 * `src/store/operations/edge-operations.ts`): a full resurrect re-takes
 * every reservation the soft delete vacated, composition included; a window
 * reopen with no delete transition never vacated a `claimsWhenBornEnded:
 * true` (`one`) axis in the first place and must not re-probe it, so it
 * re-takes composition only when composition's OWN population is
 * `oneActive`.
 */
export function compositionReentryClaim(
  registry: KindRegistry,
  subject: EdgeClaimSubject,
  reentersLivePopulation: boolean,
): ClaimEdgeCardinalityParams | undefined {
  const claim = compositionClaim(registry, subject);
  if (claim === undefined) return undefined;
  if (reentersLivePopulation) return claim;
  return edgeCardinalitySpec(claim).claimsWhenBornEnded ? undefined : claim;
}

/**
 * The per-edge-kind composition declaration the constraint-fence audit reads
 * (`src/store/claims/verify.ts`'s `fenceDeclarations`): one entry per
 * realizing edge kind, carrying the same oriented `scope` every write-path
 * claim for that kind carries, so the audit and the fence read the identical
 * axis and holder set.
 *
 * One entry per edge kind, not per declared pair: `CompositionPair.population`
 * is a property of the realizing edge kind's own declaration (its
 * `cardinality`/`targetCardinality`), so every pair sharing one `viaEdgeKind`
 * already agrees on it — `buildCompositionRelation` refuses the graph
 * otherwise (`ONTOLOGY_COMPOSITION_VIA_MIXED`).
 */
export function compositionEdgeCardinalityDeclarations(
  registry: KindRegistry,
): readonly EdgeCardinalityDeclaration[] {
  const holders = compositionHolders(registry);
  if (holders.length === 0) return [];
  const scope: CompositionClaimScope = { kind: "composition", holders };
  const seenEdgeKinds = new Set<string>();
  const declarations: EdgeCardinalityDeclaration[] = [];
  for (const pair of registry.compositionRelation().pairs) {
    if (seenEdgeKinds.has(pair.viaEdgeKind)) continue;
    seenEdgeKinds.add(pair.viaEdgeKind);
    declarations.push({
      ...compositionAxisRef(pair.partSide, pair.population),
      edgeKind: pair.viaEdgeKind,
      scope,
    });
  }
  return declarations;
}
