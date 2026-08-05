import {
  type AllNodeTypes,
  type GraphDef,
  type NodeKinds,
} from "../core/define-graph";
import { ValidationError } from "../errors";
import {
  type GraphNodeReference,
  type Node,
  type NodeRef,
} from "../store/types";

/**
 * The loose *input* form every identity facade method accepts: a whole node, a
 * bare id, or a `{ kind, id }` pair, for any node kind in the graph. Its kind
 * and id are independent, so a caller can pass what it already has without
 * re-correlating them.
 *
 * Identity *results* use the strict {@link GraphNodeReference} instead, whose
 * `kind` and branded `id` stay correlated.
 */
export type IdentityNodeRefInput<G extends GraphDef> = NodeRef<AllNodeTypes<G>>;

/** A hydrated identity member, discriminated by its registered node kind. */
export type IdentityNode<G extends GraphDef> = {
  [K in NodeKinds<G>]: Node<G["nodes"][K]["type"]>;
}[NodeKinds<G>];

declare const __identityAssertionId: unique symbol;

export type IdentityAssertionId = string &
  Readonly<{ [__identityAssertionId]: true }>;

/**
 * Brands a non-empty string as an {@link IdentityAssertionId}.
 *
 * Use this when a persisted identity assertion id has round-tripped through
 * untyped storage or an external boundary and must be passed back to a
 * retraction surface such as `retractAssertion` or `bulkRetractAssertions`.
 * Mirrors the `asNodeId` / `asEdgeId` precedent.
 *
 * @throws {ValidationError} when `value` is empty.
 */
export function asIdentityAssertionId(value: string): IdentityAssertionId {
  if (value.length === 0) {
    throw new ValidationError(
      "asIdentityAssertionId must be a non-empty string.",
      {
        issues: [
          {
            path: "asIdentityAssertionId",
            message: "Expected a non-empty string.",
          },
        ],
      },
      {
        suggestion: "Use a persisted identity assertion id value.",
      },
    );
  }
  return value as IdentityAssertionId;
}

/**
 * What one assertion claims about a pair of nodes: `"same"` merges them into
 * one equivalence set, `"different"` records a disjointness that a later
 * `"same"` claim must not contradict.
 */
export type IdentityRelation = "same" | "different";

/**
 * One persisted identity claim about an ordered pair of nodes. Returned by the
 * assertion writers and by `identity.assertionsOf(...)`; `validTo` is set when
 * the assertion has been retracted, so a historical read can still see it.
 */
export type IdentityAssertion<G extends GraphDef> = Readonly<{
  id: IdentityAssertionId;
  relation: IdentityRelation;
  a: GraphNodeReference<G>;
  b: GraphNodeReference<G>;
  validFrom: string;
  validTo?: string;
}>;

/** Result of an idempotent assertion write. */
export type IdentityAssertionResult<G extends GraphDef> = Readonly<{
  assertion: IdentityAssertion<G>;
  action: "created" | "existing";
}>;

/** One ordered node pair handed to `bulkAssertSame` / `bulkAssertDifferent`. */
export type IdentityPair<G extends GraphDef> = Readonly<{
  a: IdentityNodeRefInput<G>;
  b: IdentityNodeRefInput<G>;
}>;

/**
 * The read half of the identity surface: equivalence-set membership,
 * representative selection, and the assertions behind them.
 *
 * Obtained from a read-only lens — `store.asOf(...).identity`,
 * `store.snapshot().identity` — where it answers at that view's coordinate.
 * The full read+write surface is {@link IdentityFacade}.
 */
export type IdentityReadFacade<G extends GraphDef> = Readonly<{
  representativeOf: (
    ref: IdentityNodeRefInput<G>,
  ) => Promise<GraphNodeReference<G> | undefined>;
  membersOf: (
    ref: IdentityNodeRefInput<G>,
  ) => Promise<readonly GraphNodeReference<G>[]>;
  nodesOf: (
    ref: IdentityNodeRefInput<G>,
  ) => Promise<readonly IdentityNode<G>[]>;
  areSame: (
    a: IdentityNodeRefInput<G>,
    b: IdentityNodeRefInput<G>,
  ) => Promise<boolean>;
  areDifferent: (
    a: IdentityNodeRefInput<G>,
    b: IdentityNodeRefInput<G>,
  ) => Promise<boolean>;
  assertionsOf: (
    ref: IdentityNodeRefInput<G>,
  ) => Promise<readonly IdentityAssertion<G>[]>;
}>;

/**
 * The full TypeGraph Identity Profile surface: {@link IdentityReadFacade} plus
 * the assertion writers and retractions.
 *
 * Obtained from `store.identity` or `tx.identity`, and present only on graphs
 * that declared `identity: { ... }` in `defineGraph`. Every writer is
 * idempotent — re-asserting an existing claim returns it with
 * `action: "existing"` rather than duplicating it.
 */
export type IdentityFacade<G extends GraphDef> = IdentityReadFacade<G> &
  Readonly<{
    assertSame: (
      a: IdentityNodeRefInput<G>,
      b: IdentityNodeRefInput<G>,
    ) => Promise<IdentityAssertionResult<G>>;
    assertDifferent: (
      a: IdentityNodeRefInput<G>,
      b: IdentityNodeRefInput<G>,
    ) => Promise<IdentityAssertionResult<G>>;
    bulkAssertSame: (
      pairs: readonly IdentityPair<G>[],
    ) => Promise<readonly IdentityAssertionResult<G>[]>;
    bulkAssertDifferent: (
      pairs: readonly IdentityPair<G>[],
    ) => Promise<readonly IdentityAssertionResult<G>[]>;
    retractAssertion: (
      id: IdentityAssertionId,
    ) => Promise<IdentityAssertion<G> | undefined>;
    retractSameAssertion: (
      a: IdentityNodeRefInput<G>,
      b: IdentityNodeRefInput<G>,
    ) => Promise<IdentityAssertion<G> | undefined>;
    retractDifferentAssertion: (
      a: IdentityNodeRefInput<G>,
      b: IdentityNodeRefInput<G>,
    ) => Promise<IdentityAssertion<G> | undefined>;
    bulkRetractAssertions: (
      ids: readonly IdentityAssertionId[],
    ) => Promise<readonly IdentityAssertion<G>[]>;
  }>;

/**
 * Per-transaction identity write counts carried by a transaction receipt.
 * `total` is the sum of the three preceding counters.
 */
export type IdentityWriteSummary = Readonly<{
  sameAssertions: number;
  differentAssertions: number;
  retractions: number;
  total: number;
}>;
