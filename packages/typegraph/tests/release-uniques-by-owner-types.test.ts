/**
 * `releaseUniquesByOwner` is a REQUIRED member of the custom-backend contract
 * (#1011): a hand-written backend, transaction handle or SQL operation
 * strategy that does not implement it does not type-check. Each
 * `@ts-expect-error` below fails the typecheck if the member becomes optional
 * or disappears, and the signature pins are exact.
 */
import { type SQL } from "drizzle-orm";
import { describe, expectTypeOf, it } from "vitest";

import type { CommonOperationStrategy } from "../src/backend/drizzle/operations/strategy";
import type {
  GraphBackend,
  KeptUniqueClaim,
  OwnerClaimKeysParams,
  ReleaseUniquesByOwnerParams,
  TransactionBackend,
} from "../src/backend/index";

type WithoutRelease<T> = Omit<T, "releaseUniquesByOwner">;

/*
 * Each check is a function that is never called: the compiler judges the
 * assignment in its body, and nothing reads a value at run time.
 */
function backendWithoutReleaseIsRefused(
  candidate: WithoutRelease<GraphBackend>,
): GraphBackend {
  // @ts-expect-error -- `releaseUniquesByOwner` is required
  return candidate;
}

function transactionWithoutReleaseIsRefused(
  candidate: WithoutRelease<TransactionBackend>,
): TransactionBackend {
  // @ts-expect-error -- `releaseUniquesByOwner` is required
  return candidate;
}

function strategyWithoutBuilderIsRefused(
  candidate: Omit<CommonOperationStrategy, "buildReleaseUniquesByOwner">,
): CommonOperationStrategy {
  // @ts-expect-error -- `buildReleaseUniquesByOwner` is required
  return candidate;
}

function strategyWithoutKeyReadIsRefused(
  candidate: Omit<CommonOperationStrategy, "buildOwnerClaimKeys">,
): CommonOperationStrategy {
  // @ts-expect-error -- `buildOwnerClaimKeys` is required
  return candidate;
}

describe("releaseUniquesByOwner is required of a hand-written backend", () => {
  it("a backend without the member is not a GraphBackend", () => {
    expectTypeOf(
      backendWithoutReleaseIsRefused,
    ).returns.toEqualTypeOf<GraphBackend>();
  });

  it("a transaction handle without the member is not a TransactionBackend", () => {
    expectTypeOf(
      transactionWithoutReleaseIsRefused,
    ).returns.toEqualTypeOf<TransactionBackend>();
  });

  it("an operation strategy without the builder is not a CommonOperationStrategy", () => {
    expectTypeOf(
      strategyWithoutBuilderIsRefused,
    ).returns.toEqualTypeOf<CommonOperationStrategy>();
  });

  it("an operation strategy without the owner key read is not a CommonOperationStrategy", () => {
    expectTypeOf(
      strategyWithoutKeyReadIsRefused,
    ).returns.toEqualTypeOf<CommonOperationStrategy>();
  });

  it("pins the member's signature and params", () => {
    expectTypeOf<
      GraphBackend["releaseUniquesByOwner"]
    >().parameters.toEqualTypeOf<[params: ReleaseUniquesByOwnerParams]>();
    expectTypeOf<
      GraphBackend["releaseUniquesByOwner"]
    >().thisParameter.toBeVoid();
    expectTypeOf<GraphBackend["releaseUniquesByOwner"]>().returns.toEqualTypeOf<
      Promise<void>
    >();
    expectTypeOf<TransactionBackend["releaseUniquesByOwner"]>().toEqualTypeOf<
      GraphBackend["releaseUniquesByOwner"]
    >();
    expectTypeOf<ReleaseUniquesByOwnerParams>().toEqualTypeOf<
      Readonly<{
        graphId: string;
        concreteKind: string;
        nodeId: string;
        constraintNames: readonly string[];
        keep: readonly KeptUniqueClaim[];
      }>
    >();
    expectTypeOf<KeptUniqueClaim>().toEqualTypeOf<
      Readonly<{ constraintName: string; key: string }>
    >();
    expectTypeOf<
      ReturnType<CommonOperationStrategy["buildReleaseUniquesByOwner"]>
    >().toEqualTypeOf<SQL>();
    expectTypeOf<
      CommonOperationStrategy["buildOwnerClaimKeys"]
    >().parameters.toEqualTypeOf<[params: OwnerClaimKeysParams]>();
    expectTypeOf<OwnerClaimKeysParams>().toEqualTypeOf<
      Readonly<{
        graphId: string;
        concreteKind: string;
        nodeId: string;
        constraintName: string;
      }>
    >();
  });
});
