/**
 * `createEngineOperationBackend`'s assembly must not disturb two dialect
 * asymmetries: which atomic mutation programs a transaction-scoped
 * operation backend registers, and whether that dialect's transaction-scope
 * factory tears its connection down with a `drainAndClose` step. Both are
 * exercised here on real engines (better-sqlite3 and PGlite) rather than
 * fakes, since the fact under test is what the dialect's own
 * `createTransactionBackend` does at its call sites — code that lives in
 * each dialect's own `createTransactionBackend`, not in the shared
 * assembly.
 *
 * PostgreSQL registers three session-scoped mutation-program families
 * (`replaceNodes`, `mutateNodes`, `mutateEdges`) and its `transaction()`
 * awaits `drainAndClose()` before resolving, closing the pinned
 * connection's serialized statement queue (`../src/backend/drizzle/
 * execution/statement-queue.ts`) — a handle that escapes the callback then
 * rejects every later statement with `TransactionClosedError`. SQLite's
 * transaction-scoped operation backend excludes the atomic SQL program
 * executor entirely (`fusion.atomicProgramsAtTransactionScope: false`), so
 * it registers no mutation programs at all, and it has no comparable close
 * step — the transaction IS the connection's own framing, so a handle that
 * escapes the callback keeps working exactly as an ordinary read would.
 */
import { describe, expect, it } from "vitest";

import { resolveAtomicMutationPrograms } from "../src/backend/capabilities/atomic-mutation-program";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { TransactionBackend } from "../src/backend/types";
import { TransactionClosedError } from "../src/errors";
import { requireDefined } from "../src/utils/presence";

describe("engine operation-layer transaction-scope parity", () => {
  it("registers PostgreSQL's session mutation-program families on a real PGlite transaction", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    try {
      await backend.transaction(async (tx) => {
        await tx.getNode("engine-tx-scope", "Person", "does-not-exist");
        const profile = resolveAtomicMutationPrograms(tx);
        // Registration order is incidental; only the registered set matters.
        expect(Object.keys(requireDefined(profile)).toSorted()).toEqual([
          "mutateEdges",
          "mutateNodes",
          "replaceNodes",
        ]);
      });
    } finally {
      await backend.close();
    }
  });

  it("registers no atomic mutation programs on a real better-sqlite3 transaction", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      await backend.transaction(async (tx) => {
        await tx.getNode("engine-tx-scope", "Person", "does-not-exist");
        expect(resolveAtomicMutationPrograms(tx)).toBeUndefined();
      });
    } finally {
      await backend.close();
    }
  });

  it("closes PostgreSQL's pinned transaction queue on exit: an escaped handle rejects with TransactionClosedError", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    try {
      let escaped: TransactionBackend | undefined;
      await backend.transaction((tx) => {
        escaped = tx;
        return Promise.resolve();
      });
      await expect(
        requireDefined(escaped).getNode(
          "engine-tx-scope",
          "Person",
          "does-not-exist",
        ),
      ).rejects.toThrow(TransactionClosedError);
    } finally {
      await backend.close();
    }
  });

  it("has no comparable close step on SQLite: an escaped handle keeps working", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      let escaped: TransactionBackend | undefined;
      await backend.transaction((tx) => {
        escaped = tx;
        return Promise.resolve();
      });
      await expect(
        requireDefined(escaped).getNode(
          "engine-tx-scope",
          "Person",
          "does-not-exist",
        ),
      ).resolves.toBeUndefined();
    } finally {
      await backend.close();
    }
  });
});
