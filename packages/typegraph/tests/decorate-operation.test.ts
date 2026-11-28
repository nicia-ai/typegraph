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
  narrowSessionSurface,
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

/**
 * `narrowSessionSurface`: a layer that opened a transaction with its session
 * narrows what the session's later operations hand out to a guard it built
 * over the current surface. Anything not derived from that surface would drop
 * the layers beneath it, so it is refused and the session is left as it was.
 */
describe("narrowSessionSurface", () => {
  it("hands the narrowed surface to later operations of the same session, keeping earlier operations and the undecorated holding", async () => {
    const backend = createTestBackend();
    await backend.transaction((transaction: TransactionBackend) => {
      const session = openTransactionSession(transaction);
      const earlier = enterOperation(session);
      const guarded = deriveBackend(earlier.backend, {});
      expect(narrowSessionSurface(session, guarded)).toBe(session);
      const later = enterOperation(session);
      expect(later.backend).toBe(guarded);
      expect(later.control).toBe(transaction);
      expect(earlier.backend).toBe(transaction);
      expect(operationEntrySession(later)).toBe(session);
      return Promise.resolve();
    });
  });

  it("refuses a surface that is not derived from the current one", async () => {
    const backend = createTestBackend();
    await backend.transaction((transaction: TransactionBackend) => {
      const session = openTransactionSession(transaction);
      const unrelated = enterOperation(
        openTransactionSession({} as TransactionBackend),
      ).backend;
      expect(() => narrowSessionSurface(session, unrelated)).toThrow(
        new TypeError(
          "A session's statement surface can only be narrowed to a derivation of it.",
        ),
      );
      expect(enterOperation(session).backend).toBe(transaction);
      return Promise.resolve();
    });
  });
});
