import { describe, expectTypeOf, it } from "vitest";

import type {
  GraphBackend,
  SchemaWriteTransactionBackend,
  TransactionBackend,
} from "../src/backend/types";
import {
  enterOperation,
  legacyTransactionOperation,
  type OperationBackend,
  type OperationScoped,
  type StatementBackend,
  type StoreTransactionBackend,
} from "../src/store/operation-scope";
import type { executeEdgeCreate } from "../src/store/operations/edge-operations";

type EdgeCreateBackend = Parameters<typeof executeEdgeCreate>[2];

describe("operation-scoped statement targets", () => {
  it("refuses a raw transaction backend on the edge-create path", () => {
    expectTypeOf<TransactionBackend>().not.toExtend<EdgeCreateBackend>();
    expectTypeOf<OperationBackend>().toExtend<EdgeCreateBackend>();
    expectTypeOf<GraphBackend>().toExtend<EdgeCreateBackend>();
  });

  it("mints an operation handle from a raw transaction backend", () => {
    expectTypeOf(enterOperation).returns.toEqualTypeOf<StatementBackend>();
    expectTypeOf(enterOperation)
      .parameter(0)
      .toEqualTypeOf<GraphBackend | TransactionBackend>();
  });
});

describe("the Store-facing transaction", () => {
  it("carries identity and SQL compilation, and no statement member", () => {
    expectTypeOf<
      Exclude<keyof StoreTransactionBackend, symbol>
    >().toEqualTypeOf<
      | "dialect"
      | "capabilities"
      | "tableNames"
      | "fulltextStrategy"
      | "vectorStrategy"
      | "fenceSql"
      | "compileSql"
    >();
    expectTypeOf<StoreTransactionBackend>().not.toExtend<
      Pick<TransactionBackend, "execute">
    >();
    expectTypeOf<StoreTransactionBackend>().not.toExtend<EdgeCreateBackend>();
  });

  it("is what every engine transaction narrows to without a conversion", () => {
    expectTypeOf<TransactionBackend>().toExtend<StoreTransactionBackend>();
    expectTypeOf<SchemaWriteTransactionBackend>().toExtend<
      StoreTransactionBackend<SchemaWriteTransactionBackend>
    >();
    expectTypeOf<
      StoreTransactionBackend<SchemaWriteTransactionBackend>
    >().toExtend<StoreTransactionBackend>();
  });

  it("becomes a handle to its engine type only through the shim", () => {
    expectTypeOf(
      legacyTransactionOperation<StoreTransactionBackend>,
    ).returns.toEqualTypeOf<OperationBackend>();
    expectTypeOf(
      legacyTransactionOperation<
        StoreTransactionBackend<SchemaWriteTransactionBackend>
      >,
    ).returns.toEqualTypeOf<OperationScoped<SchemaWriteTransactionBackend>>();
    expectTypeOf(
      legacyTransactionOperation<GraphBackend | StoreTransactionBackend>,
    ).returns.toEqualTypeOf<StatementBackend>();
    expectTypeOf(
      legacyTransactionOperation<GraphBackend>,
    ).returns.toEqualTypeOf<GraphBackend>();
  });
});
