/**
 * Edge claims — what an edge write reserves on a declared cardinality axis.
 *
 * A declared cardinality is a predicate over `(kind, from)` or
 * `(kind, from, to)`, and the edges relation's only uniqueness is its
 * `(graph_id, id)` primary key, so nothing in the schema re-decides at write
 * time what the probe decided at read time. This module is the reservation that
 * does: one row per `(graph_id, axis, key)` in `typegraph_edge_claims`, whose
 * primary key refuses a second concurrent claimant.
 *
 * The claim needs no release path. A claim whose holder is no longer live (or,
 * for `oneActive`, no longer active) fails the liveness predicate the takeover
 * statement carries and is taken over in place, so the fence never depends on
 * any delete path having run. `purgeEdgeClaims` exists to bound table growth,
 * not to make the fence correct.
 */
import type { CLAIMS } from "../../backend/capabilities/bundle-registry";
import { type BundleVerdictOf } from "../../backend/capabilities/resolve";
import {
  type ClaimEdgeCardinalityParams,
  type GraphBackend,
  type InsertEdgeParams,
} from "../../backend/types";
import { type Cardinality, type TargetCardinality } from "../../core/types";
import { CardinalityError, ConfigurationError } from "../../errors";
import { isMissingTableError } from "../../utils/sql-errors";
import { encodeTupleKey } from "../../utils/tuple-key";
import {
  type ClaimTarget,
  compareClaimTargets,
  edgeCardinalityAxis,
} from "./axis";
import { claimSupport } from "./backing";

/** A cardinality that declares something — `many` declares nothing. */
export type ConstrainedCardinality = Exclude<Cardinality, "many">;

/** A target-side cardinality that declares something. */
export type ConstrainedTargetCardinality = Exclude<TargetCardinality, "many">;

/** Which endpoint's population a declared cardinality bounds. */
export type EdgeCardinalityDirection = "source" | "target";

/**
 * ONE declared population: which endpoint it bounds and how.
 *
 * A discriminated pair rather than two independent fields, because
 * `{direction: "target", cardinality: "unique"}` is not a population this
 * library has — `unique` is a property of the endpoint PAIR, declared once
 * from the source side. Making it unspellable here is what keeps every
 * downstream `switch` total without a defensive arm for a state that cannot
 * exist.
 */
export type EdgeCardinalityAxisRef =
  | Readonly<{ direction: "source"; cardinality: ConstrainedCardinality }>
  | Readonly<{
      direction: "target";
      cardinality: ConstrainedTargetCardinality;
    }>;

/** The composite key of the spec table. */
export type EdgeCardinalityAxisName =
  `source:${ConstrainedCardinality}` | `target:${ConstrainedTargetCardinality}`;

export function edgeCardinalityAxisName(
  ref: EdgeCardinalityAxisRef,
): EdgeCardinalityAxisName {
  // A switch on the discriminant, not a bare template literal over
  // `ref.cardinality`: read off the union, that field's type is the union of
  // BOTH branches' cardinality (`unique` included), which would let the
  // template literal type widen to a `"target:unique"` string this module
  // must never produce.
  switch (ref.direction) {
    case "source": {
      return `source:${ref.cardinality}`;
    }
    case "target": {
      return `target:${ref.cardinality}`;
    }
  }
}

/**
 * What one declared cardinality means to every layer that has to agree about
 * it: which endpoints its axis key covers, whether an edge born already ended
 * claims at all, and what a holder must still BE for its claim to stand.
 */
export type EdgeCardinalitySpec = Readonly<{
  /** Which endpoint columns the axis key and the liveness predicate read. */
  keyShape: "from" | "to" | "fromAndTo";
  /** Whether a new edge that is born ENDED makes a claim at all. */
  claimsWhenBornEnded: boolean;
  /** What a holder must still be for its claim to stand. */
  holderLiveness: "live" | "liveAndActive";
}>;

/**
 * THE table every renderer of the cardinality predicate reads: the TypeScript
 * probe ({@link file://../constraints.ts checkEdgeCardinalityConstraints}),
 * the SQL takeover statement
 * ({@link file://../../backend/drizzle/operations/edge-claims.ts}), and the
 * fence audit
 * ({@link file://../../backend/drizzle/operations/constraint-fence-audit.ts}).
 *
 * Three renderers, one table, exhaustive by type: a new cardinality (on
 * either side) cannot be added without stating all three facts, and no
 * renderer can disagree about any of them — a disagreement is exactly the
 * shape where the probe accepts a write the fence then refuses forever (or
 * the reverse).
 */
export const EDGE_CARDINALITY_SPECS = {
  "source:one": {
    keyShape: "from",
    claimsWhenBornEnded: true,
    holderLiveness: "live",
  },
  "source:unique": {
    keyShape: "fromAndTo",
    claimsWhenBornEnded: true,
    holderLiveness: "live",
  },
  "source:oneActive": {
    keyShape: "from",
    claimsWhenBornEnded: false,
    holderLiveness: "liveAndActive",
  },
  "target:one": {
    keyShape: "to",
    claimsWhenBornEnded: true,
    holderLiveness: "live",
  },
  "target:oneActive": {
    keyShape: "to",
    claimsWhenBornEnded: false,
    holderLiveness: "liveAndActive",
  },
} as const satisfies Record<EdgeCardinalityAxisName, EdgeCardinalitySpec>;

export function edgeCardinalitySpec(
  ref: EdgeCardinalityAxisRef,
): EdgeCardinalitySpec {
  return EDGE_CARDINALITY_SPECS[edgeCardinalityAxisName(ref)];
}

/** Every axis an edge kind's claims can sit on, for housekeeping reaps. */
/** Parses one spec-table key back into the ref it names. */
function edgeCardinalityAxisRefFromName(
  axisName: EdgeCardinalityAxisName,
): EdgeCardinalityAxisRef {
  const [direction, cardinality] = axisName.split(":");
  if (direction === "source") {
    return { direction, cardinality: cardinality as ConstrainedCardinality };
  }
  return {
    direction: "target",
    cardinality: cardinality as ConstrainedTargetCardinality,
  };
}

export function edgeCardinalityAxesForKind(
  edgeKind: string,
): readonly string[] {
  return (
    Object.keys(EDGE_CARDINALITY_SPECS) as readonly EdgeCardinalityAxisName[]
  ).map((axisName) =>
    edgeCardinalityAxis(edgeCardinalityAxisRefFromName(axisName), edgeKind),
  );
}

/**
 * THE claim row one edge write reserves: its axis, and the endpoint identity
 * the axis is keyed by.
 *
 * The key is {@link encodeTupleKey}, not a delimiter join: node ids are
 * arbitrary caller data (only kind names pass `assertClaimAxisSafe`), and a
 * delimiter that a value may contain makes two different endpoint tuples
 * collapse onto one key — which would refuse a write no constraint forbids.
 *
 * **Reservation scope, as the issue specifies it**: `axis` carries the edge
 * kind and the direction, `key` carries the constrained endpoint's identity
 * only. A target claim's key never mentions the source, so two permitted
 * source kinds contend for one target allowance by construction, and a target
 * claim's axis never mentions the opposite endpoint's kind, so an edge kind's
 * source and target populations cannot collide even when a node id repeats
 * under different kinds.
 */
export function edgeCardinalityClaimTarget(
  params: ClaimEdgeCardinalityParams,
): ClaimTarget {
  const spec = edgeCardinalitySpec(params);
  return {
    relation: "edgeClaims",
    graphId: params.graphId,
    axis: edgeCardinalityAxis(params, params.edgeKind),
    key:
      spec.keyShape === "from" ?
        encodeTupleKey([params.fromKind, params.fromId])
      : spec.keyShape === "to" ? encodeTupleKey([params.toKind, params.toId])
      : encodeTupleKey([
          params.fromKind,
          params.fromId,
          params.toKind,
          params.toId,
        ]),
  };
}

/**
 * The fields a claim is decided from: the row's identity and the upper bound
 * that decides whether it joins an active-only population. Narrower than
 * {@link InsertEdgeParams} on purpose — a resurrect has no insert params to
 * hand over, and passing an invented `props` to satisfy a type would be a
 * fabricated value a reader has to check is unread.
 */
export type EdgeClaimSubject = Pick<
  InsertEdgeParams,
  "graphId" | "id" | "kind" | "fromKind" | "fromId" | "toKind" | "toId"
> &
  Readonly<{ validTo?: string }>;

/** The two options a registration may declare, narrowed to what decides. */
export type EdgeCardinalityDeclarations = Readonly<{
  cardinality?: Cardinality;
  targetCardinality?: TargetCardinality;
}>;

/**
 * THE axes one edge kind's declaration constrains, in probe order.
 *
 * Every layer that asks "is this write constrained, and by what?" folds
 * through here: the write-time probe, the claim set, the pending-batch
 * accounting, the write-fence predicate, the fast-path eligibility gates, the
 * fence-audit declarations and the schema-tightening probe. A layer that
 * re-derived the answer from `cardinality !== "many"` would be blind to a
 * target-only declaration — which is the exact silent bypass this fold exists
 * to make impossible.
 *
 * Source before target: when a write violates both, the refusal a caller sees
 * names the source axis, which is the refusal it sees today.
 */
export function edgeCardinalityAxisReferences(
  declarations: EdgeCardinalityDeclarations,
): readonly EdgeCardinalityAxisRef[] {
  const references: EdgeCardinalityAxisRef[] = [];
  const cardinality = declarations.cardinality ?? "many";
  if (cardinality !== "many") {
    references.push({ direction: "source", cardinality });
  }
  const targetCardinality = declarations.targetCardinality ?? "many";
  if (targetCardinality !== "many") {
    references.push({ direction: "target", cardinality: targetCardinality });
  }
  return references;
}

/**
 * THE claims an edge write owes, in CLAIM order.
 *
 * Claim order is {@link compareClaimTargets}, not probe order: two writers
 * that take the same two axis rows must take them in the same order or they
 * deadlock against each other, and the source and target axes of one edge
 * kind are two rows in one relation. Probe order (source first) is a
 * diagnostic choice and lives in {@link edgeCardinalityAxisReferences}; lock order
 * is a correctness one and lives here. The two are deliberately different and
 * that difference is the reason both are named.
 *
 * `many` declares no constraint, and an `oneActive` edge born already ended
 * joins no active population — `claimsWhenBornEnded` is the one place that
 * second exemption is written down, per AXIS, and the probe reads the same
 * field, so the two cannot drift into "probed but unclaimed" (a silent hole)
 * or "claimed but unprobed" (a refusal with no matching error).
 */
export function edgeCardinalityClaims(
  declarations: EdgeCardinalityDeclarations,
  subject: EdgeClaimSubject,
): readonly ClaimEdgeCardinalityParams[] {
  const claims = edgeCardinalityAxisReferences(declarations)
    .filter(
      (ref) =>
        edgeCardinalitySpec(ref).claimsWhenBornEnded ||
        subject.validTo === undefined,
    )
    .map((ref): ClaimEdgeCardinalityParams => ({
      ...ref,
      graphId: subject.graphId,
      edgeKind: subject.kind,
      edgeId: subject.id,
      fromKind: subject.fromKind,
      fromId: subject.fromId,
      toKind: subject.toKind,
      toId: subject.toId,
    }));
  return claims
    .map((claim) => ({ claim, target: edgeCardinalityClaimTarget(claim) }))
    .toSorted((left, right) => compareClaimTargets(left.target, right.target))
    .map((entry) => entry.claim);
}

/**
 * THE cardinality refusal. Every probe and every fence refusal is this
 * function, so the fence's error is `instanceof` the same class and carries
 * the same payload as the probe's for the same violation.
 *
 * `existingCount` is already the population the axis counts (the from-count,
 * the to-count, or the 0/1 pair-existence read) — every constrained
 * cardinality refuses on exactly "the population is non-empty", so one
 * comparison serves `one`, `oneActive` and `unique` alike; the difference
 * between them lives entirely in how the caller computed `existingCount`.
 */
export function edgeCardinalityViolation(
  ref: EdgeCardinalityAxisRef,
  subject: EdgeCardinalityViolationSubject,
  existingCount: number,
): CardinalityError | undefined {
  if (existingCount <= 0) return undefined;
  return new CardinalityError({
    edgeKind: subject.edgeKind,
    direction: ref.direction,
    fromKind: subject.fromKind,
    fromId: subject.fromId,
    toKind: subject.toKind,
    toId: subject.toId,
    cardinality: ref.cardinality,
    existingCount,
  });
}

/** The endpoint identity {@link edgeCardinalityViolation} names in its refusal. */
export type EdgeCardinalityViolationSubject = Readonly<{
  edgeKind: string;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
}>;

/**
 * Builds the public cardinality refusal for a lost claim.
 *
 * Both the ordinary claim path and the fused claim-plus-edge path call this
 * owner. Keeping the translation here prevents a backend result discriminator
 * from growing a second spelling of the same typed error.
 */
export function edgeCardinalityClaimRefusal(
  params: ClaimEdgeCardinalityParams,
): CardinalityError {
  // An incumbent count of one always violates every constrained cardinality;
  // the fallback keeps the return type honest without inventing a second
  // spelling of the message.
  return (
    edgeCardinalityViolation(params, params, 1) ??
    new CardinalityError({
      edgeKind: params.edgeKind,
      direction: params.direction,
      fromKind: params.fromKind,
      fromId: params.fromId,
      toKind: params.toKind,
      toId: params.toId,
      cardinality: params.cardinality,
      existingCount: 1,
    })
  );
}

/**
 * Converts the engine's "relation does not exist" into a typed precondition
 * error naming the relation and the way to create it.
 *
 * Checked at FIRST USE rather than at store construction: a graph with no
 * constrained edge kind never issues a claim and must not pay a catalog read
 * for a relation it will never touch. A database bootstrapped before this
 * relation existed reaches it here, on the first constrained edge write, with
 * an error that says what to run instead of an opaque driver failure.
 */
export function edgeClaimRelationMissing(
  graphId: string,
  cause: unknown,
): ConfigurationError {
  return new ConfigurationError(
    "Enforcing a declared edge cardinality needs the edge claim relation " +
      "(typegraph_edge_claims), and this database does not have it. " +
      "Databases initialized before this relation existed were never sent " +
      "its CREATE TABLE, because the bootstrap DDL runs only on first boot.",
    { code: "EDGE_CLAIM_RELATION_MISSING", graphId },
    {
      cause,
      suggestion:
        "Run the generated migration SQL (generatePostgresMigrationSQL / " +
        "generateSqliteMigrationSQL) against this database, or declare the " +
        'edge kind `cardinality: "many"` and enforce the limit in ' +
        "application code.",
    },
  );
}

async function withEdgeClaimRelationPrecondition<T>(
  graphId: string,
  issue: () => Promise<T>,
): Promise<T> {
  try {
    return await issue();
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    throw edgeClaimRelationMissing(graphId, error);
  }
}

type ClaimModeTarget = Readonly<
  Partial<
    Pick<
      GraphBackend,
      (typeof CLAIMS)["core"][number] | "claimEdgeCardinalityGuarded"
    >
  >
>;

/** The narrow backend facet an edge claim is written through. */
type ClaimTargetMembers = ClaimModeTarget;

/**
 * The one owner of whether a single write may replace its entity probe with a
 * guarded claim. Both claim-bundle support and the optional strong member are
 * required: the member is the backend's explicit opt-in contract, while the
 * bundle verdict proves the target can actually persist claims. Either absence
 * deliberately preserves the legacy probe-then-claim protocol.
 */
export function edgeCardinalityClaimMode(
  backend: ClaimModeTarget,
  verdict: BundleVerdictOf<typeof CLAIMS>,
):
  | Readonly<{
      kind: "guarded";
      claim: NonNullable<GraphBackend["claimEdgeCardinalityGuarded"]>;
    }>
  | Readonly<{
      kind: "probeThenClaim";
      support: ReturnType<typeof claimSupport>;
    }> {
  const support = claimSupport(backend, verdict);
  const guardedClaim = backend.claimEdgeCardinalityGuarded;
  return !support.supported || guardedClaim === undefined ?
      { kind: "probeThenClaim", support }
    : { kind: "guarded", claim: guardedClaim };
}

/**
 * Issues ONE edge cardinality claim against the object the row write goes to,
 * refusing with the declared error when a live incumbent holds the axis.
 *
 * A backend that declares no claim support writes no claim and keeps exactly
 * the fence it has today (the per-graph write lock around the probe) — a
 * declared gap with a parity-matrix row, never a silent unfencing and never a
 * new refusal.
 */
export async function claimEdgeCardinality(
  backend: ClaimTargetMembers,
  verdict: BundleVerdictOf<typeof CLAIMS>,
  claim: ClaimEdgeCardinalityParams,
): Promise<void> {
  const mode = edgeCardinalityClaimMode(backend, verdict);
  if (mode.kind === "guarded") {
    const outcome = await withEdgeClaimRelationPrecondition(claim.graphId, () =>
      mode.claim(claim),
    );
    if (outcome.status === "refused") {
      throw edgeCardinalityClaimRefusal(claim);
    }
    return;
  }
  const support = mode.support;
  if (!support.supported) return;
  const outcome = await withEdgeClaimRelationPrecondition(claim.graphId, () =>
    support.claims.claimEdgeCardinality(claim),
  );
  if (outcome.status === "refused") throw edgeCardinalityClaimRefusal(claim);
}

/**
 * Issues every claim ONE edge write owes, in the order {@link
 * edgeCardinalityClaims} already sorted them (claim order, not probe order).
 *
 * Every single-write call site issues its claim set through here rather than
 * calling {@link claimEdgeCardinality} directly — the fold is what makes a
 * two-axis declaration (source AND target) reserve both rows instead of
 * whichever one a call site happened to spell.
 */
export async function claimEdgeCardinalities(
  backend: ClaimTargetMembers,
  verdict: BundleVerdictOf<typeof CLAIMS>,
  claims: readonly ClaimEdgeCardinalityParams[],
): Promise<void> {
  for (const claim of claims) {
    await claimEdgeCardinality(backend, verdict, claim);
  }
}

/**
 * Issues a batch's claims as ONE statement, entries sorted by
 * {@link compareClaimTargets}.
 *
 * One statement takes its row locks in a fixed order, so a batch cannot
 * deadlock against itself; sorting is what stops two writers of the same two
 * axes from taking them in opposite orders. In-batch duplicates are refused
 * before this by the batch validation wrapper's pending-cardinality state, so
 * the backend's duplicate-conflict-target guard stays a defensive invariant.
 */
export async function claimEdgeCardinalityBatch(
  backend: ClaimTargetMembers,
  verdict: BundleVerdictOf<typeof CLAIMS>,
  claims: readonly ClaimEdgeCardinalityParams[],
): Promise<void> {
  if (claims.length === 0) return;
  const support = claimSupport(backend, verdict);
  if (!support.supported) return;
  const ordered = claims
    .map((claim) => ({ claim, target: edgeCardinalityClaimTarget(claim) }))
    .toSorted((left, right) => compareClaimTargets(left.target, right.target));
  const graphId = ordered[0]?.claim.graphId ?? "";
  const outcomes = await withEdgeClaimRelationPrecondition(graphId, () =>
    support.claims.claimEdgeCardinalityBatch(
      ordered.map((entry) => entry.claim),
    ),
  );
  for (const [index, outcome] of outcomes.entries()) {
    const entry = ordered[index];
    if (entry !== undefined && outcome.status === "refused") {
      throw edgeCardinalityClaimRefusal(entry.claim);
    }
  }
}

/**
 * Housekeeping: drops the claim rows named edges held.
 *
 * Never a fence and never load-bearing — a claim whose holder is gone already
 * fails the takeover statement's liveness predicate, so the axis is reusable
 * whether or not this ran. It exists so a hard delete does not leave a row
 * behind forever. A backend without claim support has nothing to purge.
 */
export async function purgeEdgeClaims(
  backend: ClaimTargetMembers,
  verdict: BundleVerdictOf<typeof CLAIMS>,
  graphId: string,
  edgeIds: readonly string[],
): Promise<void> {
  if (edgeIds.length === 0) return;
  const support = claimSupport(backend, verdict);
  if (!support.supported) return;
  await withEdgeClaimRelationPrecondition(graphId, () =>
    support.claims.purgeEdgeClaims({ graphId, edgeIds }),
  );
}
