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
  type TransactionBackend,
} from "../../backend/types";
import { checkCardinality, checkUniqueEdge } from "../../constraints";
import { type Cardinality } from "../../core/types";
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

/**
 * What one declared cardinality means to every layer that has to agree about
 * it: which endpoints its axis key covers, whether an edge born already ended
 * claims at all, and what a holder must still BE for its claim to stand.
 */
export type EdgeCardinalitySpec = Readonly<{
  /** Which endpoints the axis key covers. */
  keyShape: "from" | "fromAndTo";
  /** Whether a new edge that is born ENDED makes a claim at all. */
  claimsWhenBornEnded: boolean;
  /** What a holder must still be for its claim to stand. */
  holderLiveness: "live" | "liveAndActive";
}>;

/**
 * THE table both renderers of the cardinality predicate read: the TypeScript
 * probe ({@link file://../constraints.ts checkCardinalityConstraint}) and the
 * SQL takeover statement
 * ({@link file://../../backend/drizzle/operations/edge-claims.ts}).
 *
 * Two renderers, one table, exhaustive by type: a new cardinality cannot be
 * added without stating all three facts, and the probe and the fence cannot
 * disagree about any of them — a disagreement is exactly the shape where the
 * probe accepts a write the fence then refuses forever (or the reverse).
 */
export const EDGE_CARDINALITY_SPECS = {
  one: { keyShape: "from", claimsWhenBornEnded: true, holderLiveness: "live" },
  unique: {
    keyShape: "fromAndTo",
    claimsWhenBornEnded: true,
    holderLiveness: "live",
  },
  oneActive: {
    keyShape: "from",
    claimsWhenBornEnded: false,
    holderLiveness: "liveAndActive",
  },
} as const satisfies Record<ConstrainedCardinality, EdgeCardinalitySpec>;

/** Every axis an edge kind's claims can sit on, for housekeeping reaps. */
export function edgeCardinalityAxesForKind(
  edgeKind: string,
): readonly string[] {
  return Object.keys(EDGE_CARDINALITY_SPECS).map((cardinality) =>
    edgeCardinalityAxis(cardinality, edgeKind),
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
 */
export function edgeCardinalityClaimTarget(
  params: ClaimEdgeCardinalityParams,
): ClaimTarget {
  const spec = EDGE_CARDINALITY_SPECS[params.cardinality];
  return {
    relation: "edgeClaims",
    graphId: params.graphId,
    axis: edgeCardinalityAxis(params.cardinality, params.edgeKind),
    key:
      spec.keyShape === "from" ?
        encodeTupleKey([params.fromKind, params.fromId])
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

/**
 * THE claim an edge insert owes, or `undefined` when it owes none.
 *
 * `many` declares no constraint, and an `oneActive` edge born already ended
 * joins no active population — `claimsWhenBornEnded` is the one place that
 * second exemption is written down, and the probe reads the same field, so the
 * two cannot drift into "probed but unclaimed" (a silent hole) or "claimed but
 * unprobed" (a refusal with no matching error).
 */
export function edgeCardinalityClaim(
  cardinality: Cardinality,
  subject: EdgeClaimSubject,
): ClaimEdgeCardinalityParams | undefined {
  if (cardinality === "many") return undefined;
  if (
    !EDGE_CARDINALITY_SPECS[cardinality].claimsWhenBornEnded &&
    subject.validTo !== undefined
  ) {
    return undefined;
  }
  return {
    graphId: subject.graphId,
    cardinality,
    edgeKind: subject.kind,
    edgeId: subject.id,
    fromKind: subject.fromKind,
    fromId: subject.fromId,
    toKind: subject.toKind,
    toId: subject.toId,
  };
}

/**
 * The refusal a lost claim raises — built by the SAME owners the probe calls,
 * so the fence's error is `instanceof` the same class and carries the same
 * payload as the probe's for the same violation (I3).
 */
/**
 * Builds the public cardinality refusal for a claim decision.
 *
 * Both the ordinary claim path and the fused claim-plus-edge path call this
 * owner. Keeping the translation here prevents a backend result discriminator
 * from growing a second spelling of the same typed error.
 */
function edgeClaimRefusal(
  params: ClaimEdgeCardinalityParams,
): CardinalityError {
  const error =
    params.cardinality === "unique" ?
      checkUniqueEdge(
        params.edgeKind,
        params.fromKind,
        params.fromId,
        params.toKind,
        params.toId,
        1,
      )
    : checkCardinality(
        params.edgeKind,
        params.fromKind,
        params.fromId,
        params.cardinality,
        1,
        true,
      );
  // Both owners refuse for an incumbent count of one on every constrained
  // cardinality; the fallback keeps the return type honest without inventing a
  // second spelling of the message.
  return (
    error ??
    new CardinalityError({
      edgeKind: params.edgeKind,
      fromKind: params.fromKind,
      fromId: params.fromId,
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
export async function withEdgeClaimRelationPrecondition<T>(
  graphId: string,
  issue: () => Promise<T>,
): Promise<T> {
  try {
    return await issue();
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    throw new ConfigurationError(
      "Enforcing a declared edge cardinality needs the edge claim relation " +
        "(typegraph_edge_claims), and this database does not have it. " +
        "Databases initialized before this relation existed were never sent " +
        "its CREATE TABLE, because the bootstrap DDL runs only on first boot.",
      { code: "EDGE_CLAIM_RELATION_MISSING", graphId },
      {
        cause: error,
        suggestion:
          "Run the generated migration SQL (generatePostgresMigrationSQL / " +
          "generateSqliteMigrationSQL) against this database, or declare the " +
          'edge kind `cardinality: "many"` and enforce the limit in ' +
          "application code.",
      },
    );
  }
}

/** The backend an edge claim is written to — the object inside the transaction. */
type ClaimTargetBackend = GraphBackend | TransactionBackend;
type ClaimModeTarget = Readonly<
  Partial<
    Pick<
      GraphBackend,
      (typeof CLAIMS)["core"][number] | "claimEdgeCardinalityGuarded"
    >
  >
>;

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
  backend: ClaimTargetBackend,
  verdict: BundleVerdictOf<typeof CLAIMS>,
  claim: ClaimEdgeCardinalityParams,
): Promise<void> {
  const mode = edgeCardinalityClaimMode(backend, verdict);
  if (mode.kind === "guarded") {
    const outcome = await withEdgeClaimRelationPrecondition(claim.graphId, () =>
      mode.claim(claim),
    );
    if (outcome.status === "refused") throw edgeClaimRefusal(claim);
    return;
  }
  const support = mode.support;
  if (!support.supported) return;
  const outcome = await withEdgeClaimRelationPrecondition(claim.graphId, () =>
    support.claims.claimEdgeCardinality(claim),
  );
  if (outcome.status === "refused") throw edgeClaimRefusal(claim);
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
  backend: ClaimTargetBackend,
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
      throw edgeClaimRefusal(entry.claim);
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
  backend: ClaimTargetBackend,
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
