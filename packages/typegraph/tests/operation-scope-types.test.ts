import { describe, expectTypeOf, it } from "vitest";

import type { GraphBackend, TransactionBackend } from "../src/backend/types";
import {
  enterOperation,
  type OperationBackend,
  type StatementBackend,
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
