/**
 * `decorateOperation`: where an operation's own work decorates its handle
 * (recorded capture's overlay over a schema-commit preflight's transaction),
 * the result is an operation of the SAME session whose statements go through
 * the decoration. A replacement handle that is not a derivation of the
 * operation's handle would be a different transaction attributed to this
 * session, so it is refused.
 */
import { describe, expect, it } from "vitest";

import { deriveBackend } from "../src/backend/derive-backend";
import type { TransactionBackend } from "../src/backend/types";
import {
  decorateOperation,
  enterOperation,
  openTransactionSession,
  operationEntrySession,
} from "../src/store/operation-scope";
import { createTestBackend } from "./test-utils";

async function withOperation(
  fn: (
    operation: ReturnType<typeof enterOperation<TransactionBackend>>,
  ) => void,
): Promise<void> {
  const backend = createTestBackend();
  await backend.transaction((transaction: TransactionBackend) => {
    fn(enterOperation(openTransactionSession(transaction)));
    return Promise.resolve();
  });
}

describe("decorateOperation", () => {
  it("keeps the operation's session and sends statements through the decoration", async () => {
    await withOperation((operation) => {
      const decorated = deriveBackend(operation.backend, {});
      const result = decorateOperation(operation, decorated);
      expect(result.backend).toBe(decorated);
      expect(operationEntrySession(result)).toBe(
        operationEntrySession(operation),
      );
    });
  });

  it("refuses a handle that is not derived from the operation's own", async () => {
    await withOperation((operation) => {
      const unrelated = enterOperation(
        openTransactionSession({} as TransactionBackend),
      ).backend;
      expect(() => decorateOperation(operation, unrelated)).toThrow(
        new TypeError(
          "An operation's handle can only be replaced by a derivation of it.",
        ),
      );
      expect(() => decorateOperation(operation, operation.backend)).toThrow(
        TypeError,
      );
    });
  });
});
