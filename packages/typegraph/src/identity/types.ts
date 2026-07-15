import {
  type AllNodeTypes,
  type GraphDef,
  type GraphIdentityConfig,
} from "../core/define-graph";
import { type NodeRef } from "../store/types";

export type GraphNodeRef<G extends GraphDef> = NodeRef<AllNodeTypes<G>>;

declare const __identityAssertionId: unique symbol;

export type IdentityAssertionId = string &
  Readonly<{ [__identityAssertionId]: true }>;

export type IdentityRelation = "same" | "different";

export type IdentityAssertion<G extends GraphDef> = Readonly<{
  id: IdentityAssertionId;
  relation: IdentityRelation;
  a: GraphNodeRef<G>;
  b: GraphNodeRef<G>;
  validFrom: string;
  validTo?: string;
}>;

export type IdentityPair<G extends GraphDef> = Readonly<{
  a: GraphNodeRef<G>;
  b: GraphNodeRef<G>;
}>;

export type IdentityReadFacade<G extends GraphDef> = Readonly<{
  representativeOf: (
    ref: GraphNodeRef<G>,
  ) => Promise<GraphNodeRef<G> | undefined>;
  membersOf: (ref: GraphNodeRef<G>) => Promise<readonly GraphNodeRef<G>[]>;
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
    ) => Promise<IdentityAssertion<G>>;
    assertDifferent: (
      a: GraphNodeRef<G>,
      b: GraphNodeRef<G>,
    ) => Promise<IdentityAssertion<G>>;
    bulkAssertSame: (
      pairs: readonly IdentityPair<G>[],
    ) => Promise<readonly IdentityAssertion<G>[]>;
    bulkAssertDifferent: (
      pairs: readonly IdentityPair<G>[],
    ) => Promise<readonly IdentityAssertion<G>[]>;
    retractAssertion: (id: IdentityAssertionId) => Promise<void>;
    retractSameAssertion: (
      a: GraphNodeRef<G>,
      b: GraphNodeRef<G>,
    ) => Promise<void>;
    retractDifferentAssertion: (
      a: GraphNodeRef<G>,
      b: GraphNodeRef<G>,
    ) => Promise<void>;
    bulkRetractAssertions: (
      ids: readonly IdentityAssertionId[],
    ) => Promise<void>;
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
