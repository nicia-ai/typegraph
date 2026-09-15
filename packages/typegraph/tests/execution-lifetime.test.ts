import { describe, expect, it } from "vitest";

import {
  backendDerivationRoot,
  isBackendDerivedFrom,
} from "../src/backend/derive-backend";
import { TransactionClosedError } from "../src/errors";
import { scopeBackendExecution } from "../src/store/execution-lifetime";
import { createTestBackend } from "./test-utils";

describe("callback backend execution lifetime", () => {
  it("refuses escaped deferred reads after a successful callback", async () => {
    const sourceBackend = createTestBackend();
    const scope = scopeBackendExecution(sourceBackend);
    const deferredRead = () =>
      scope.backend.getNode("graph", "Person", "missing");

    expect(await deferredRead()).toBeUndefined();
    expect(isBackendDerivedFrom(scope.backend, sourceBackend)).toBe(true);
    expect(backendDerivationRoot(scope.backend)).toBe(
      backendDerivationRoot(sourceBackend),
    );

    scope.seal();
    expect(deferredRead).toThrow(TransactionClosedError);
  });

  it("refuses escaped operations after a failed callback", () => {
    const sourceBackend = createTestBackend();
    const scope = scopeBackendExecution(sourceBackend);
    const deferredWrite = () =>
      scope.backend.insertNode({
        graphId: "graph",
        id: "late",
        kind: "Person",
        props: { name: "Late" },
        validFrom: new Date().toISOString(),
      });

    try {
      throw new Error("callback failed");
    } catch {
      scope.seal();
    }

    expect(deferredWrite).toThrow(TransactionClosedError);
  });
});
