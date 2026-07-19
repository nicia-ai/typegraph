import {
  type AllNodeTypes,
  type GraphDef,
  type GraphIdentityConfig,
  type NodeKinds,
} from "../core/define-graph";
import { type NodeId } from "../core/types";
import { ValidationError } from "../errors";
import { type Node, type NodeRef } from "../store/types";

export type GraphNodeRef<G extends GraphDef> = NodeRef<AllNodeTypes<G>>;

/** A graph-bounded identity result reference with a kind-specific branded id. */
export type IdentityNodeRef<G extends GraphDef> = {
  [K in NodeKinds<G>]: Readonly<{
    kind: K;
    id: NodeId<G["nodes"][K]["type"]>;
  }>;
}[NodeKinds<G>];

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

export type IdentityRelation = "same" | "different";

export type IdentityAssertion<G extends GraphDef> = Readonly<{
  id: IdentityAssertionId;
  relation: IdentityRelation;
  a: IdentityNodeRef<G>;
  b: IdentityNodeRef<G>;
  validFrom: string;
  validTo?: string;
}>;

/** Result of an idempotent assertion write. */
export type IdentityAssertionResult<G extends GraphDef> = IdentityAssertion<G> &
  Readonly<{
    assertion: IdentityAssertion<G>;
    action: "created" | "existing";
  }>;

export type IdentityPair<G extends GraphDef> = Readonly<{
  a: GraphNodeRef<G>;
  b: GraphNodeRef<G>;
}>;

export type IdentityReadFacade<G extends GraphDef> = Readonly<{
  representativeOf: (
    ref: GraphNodeRef<G>,
  ) => Promise<IdentityNodeRef<G> | undefined>;
  membersOf: (ref: GraphNodeRef<G>) => Promise<readonly IdentityNodeRef<G>[]>;
  nodesOf: (ref: GraphNodeRef<G>) => Promise<readonly IdentityNode<G>[]>;
  areSame: (a: GraphNodeRef<G>, b: GraphNodeRef<G>) => Promise<boolean>;
  areDifferent: (a: GraphNodeRef<G>, b: GraphNodeRef<G>) => Promise<boolean>;
  assertionsOf: (
    ref: GraphNodeRef<G>,
  ) => Promise<readonly IdentityAssertion<G>[]>;
}>;

export type IdentityFacade<G extends GraphDef> = IdentityReadFacade<G> &
  Readonly<{
    assertSame: (
      a: GraphNodeRef<G>,
      b: GraphNodeRef<G>,
    ) => Promise<IdentityAssertionResult<G>>;
    assertDifferent: (
      a: GraphNodeRef<G>,
      b: GraphNodeRef<G>,
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
      a: GraphNodeRef<G>,
      b: GraphNodeRef<G>,
    ) => Promise<IdentityAssertion<G> | undefined>;
    retractDifferentAssertion: (
      a: GraphNodeRef<G>,
      b: GraphNodeRef<G>,
    ) => Promise<IdentityAssertion<G> | undefined>;
    bulkRetractAssertions: (
      ids: readonly IdentityAssertionId[],
    ) => Promise<readonly IdentityAssertion<G>[]>;
  }>;

export type IdentityFacadeFor<G extends GraphDef> =
  G["identity"] extends GraphIdentityConfig ? IdentityFacade<G> : never;

export type IdentityReadFacadeFor<G extends GraphDef> =
  G["identity"] extends GraphIdentityConfig ? IdentityReadFacade<G> : never;

export type IdentityWriteSummary = Readonly<{
  sameAssertions: number;
  differentAssertions: number;
  retractions: number;
  total: number;
}>;
