/**
 * A Store transaction's write session issues its own statements (the
 * end-of-callback revision advance) through the operation of the
 * transaction's opener it is handed, not through the statement surface its
 * mutations go through (the handle of the operation it is handed).
 */
import { describe, expect, it } from "vitest";

import { deriveBackend } from "../src/backend/derive-backend";
import type { TransactionBackend } from "../src/backend/types";
import { createSqlSchema } from "../src/query/compiler/schema";
import {
  decorateOperation,
  enterOperation,
  openTransactionSession,
  type OperationBackend,
} from "../src/store/operation-scope";
import {
  forceWriteTransactionRevision,
  withWriteTransactionSession,
} from "../src/store/operations/write-transaction";
import { createTestBackend } from "./test-utils";

const STATEMENT_MEMBERS = [
  "execute",
  "executeStatement",
  "executeRaw",
] as const;

/** A derivation of `base` that counts its statement member calls. */
function counting(
  base: OperationBackend,
  counts: Record<string, number>,
  label: string,
): OperationBackend {
  const overrides: Record<string, unknown> = {};
  for (const member of STATEMENT_MEMBERS) {
    const call: unknown = base[member];
    if (typeof call !== "function") continue;
    overrides[member] = (...args: unknown[]): unknown => {
      counts[label] = (counts[label] ?? 0) + 1;
      return Reflect.apply(call, base, args) as unknown;
    };
  }
  return deriveBackend(base, overrides as Partial<TransactionBackend>);
}

describe("write transaction session opener", () => {
  it("advances the revision clock through the opener, not the surface", async () => {
    const backend = createTestBackend();
    const counts: Record<string, number> = { surface: 0, opener: 0 };
    await backend.transaction(async (transaction) => {
      const openedSession = openTransactionSession(transaction);
      const operation = enterOperation(openedSession);
      const held = operation.backend;
      const surface = decorateOperation(
        operation,
        counting(held, counts, "surface"),
      );
      const opener = counting(held, counts, "opener");
      await withWriteTransactionSession(
        openedSession,
        surface.backend,
        opener,
        {
          graphId: "write_session_opener",
          schemaVersion: undefined,
          historyEnabled: false,
          revisionTrackingEnabled: true,
          revisionSchema: createSqlSchema(backend.tableNames),
        },
        "reusable",
        () => {
          expect(forceWriteTransactionRevision(surface)).toBe(true);
          return Promise.resolve();
        },
      );
    });
    expect(counts["surface"]).toBe(0);
    expect(counts["opener"]).toBeGreaterThan(0);
  });
});
