/**
 * Whether a savepoint unit rolled back inside a leasing scope takes the
 * schema-fence leases it added back with it.
 *
 * PostgreSQL releases a lock taken after a savepoint when the transaction
 * rolls back to it, so a lease added inside a unit that rolls back no longer
 * stands for a held fence. The reusable write session of a `store.transaction`
 * attempt registers a savepoint checkpoint for its leases, and the unit
 * restores them. The lease an adopted history callback holds
 * (`withPreAcquiredTransactionSchemaFenceLease`) registers none: a lease added
 * inside a unit there survives the unit's rollback. That is pinned below as a
 * known defect rather than fixed, because fixing it changes which writes after
 * such a rollback take the fence again.
 *
 * The lease the adopted scope seeds itself was acquired before the callback,
 * so no unit inside the callback can release it; what a unit can add is a
 * lease under another key (another graph id or expected version) on the same
 * session. The unit here is the savepoint-state seam every Store savepoint
 * goes through (`withSavepointState`), restoring as a rolled-back unit does.
 */
import { describe, it } from "vitest";

import { createSqlSchema } from "../src/query/compiler/schema";
import {
  enterOperation,
  openTransactionSession,
  type Operation,
  type TransactionSession,
} from "../src/store/operation-scope";
import {
  hasLeasedSchemaFence,
  memoizeLeasedSchemaFence,
  withPreAcquiredTransactionSchemaFenceLease,
  withWriteTransactionSession,
} from "../src/store/operations/write-transaction";
import { withSavepointState } from "../src/store/savepoint-state";
import { expectObservation } from "./helpers/known-defect";
import { createTestBackend } from "./test-utils";

const SEEDED = { graphId: "lease_checkpoint", schemaVersion: 1 } as const;
// A lease under another key on the same session, added inside the unit.
const ADDED = { graphId: "lease_checkpoint", schemaVersion: 2 } as const;

type LeaseScope = "managed write session" | "adopted history callback";

/** Runs `body` inside the leasing scope `scope` opens on `session`. */
function withLeaseScope(
  scope: LeaseScope,
  session: TransactionSession,
  operation: Operation,
  body: () => Promise<void>,
): Promise<void> {
  if (scope === "adopted history callback") {
    return withPreAcquiredTransactionSchemaFenceLease(SEEDED, session, body);
  }
  return withWriteTransactionSession(
    session,
    operation.backend,
    operation.backend,
    {
      ...SEEDED,
      historyEnabled: false,
      revisionTrackingEnabled: false,
      revisionSchema: createSqlSchema(createTestBackend().tableNames),
    },
    "reusable",
    body,
  );
}

describe("schema-fence lease savepoint checkpoint", () => {
  for (const scope of [
    "managed write session",
    "adopted history callback",
  ] as const) {
    it(`a unit that rolls back takes back the lease it added (${scope})`, async () => {
      const backend = createTestBackend();
      const observed = await backend.transaction(async (transaction) => {
        const session = openTransactionSession(transaction);
        const operation = enterOperation(session);
        let leasedInsideUnit = false;
        let leasedAfterRollback = false;
        await withLeaseScope(scope, session, operation, async () => {
          // The managed session leases lazily: its first write acquires.
          memoizeLeasedSchemaFence(SEEDED, operation);
          await withSavepointState(operation.backend, (restore) => {
            memoizeLeasedSchemaFence(ADDED, operation);
            leasedInsideUnit = hasLeasedSchemaFence(ADDED, operation);
            restore(new Error("the unit rolled back"));
            return Promise.resolve();
          });
          leasedAfterRollback = hasLeasedSchemaFence(ADDED, operation);
        });
        return { leasedInsideUnit, leasedAfterRollback };
      });
      expectObservation({
        lane: { scope },
        observed,
        correct: { leasedInsideUnit: true, leasedAfterRollback: false },
        defects: [
          {
            label: "adopted-lease-not-checkpointed",
            on: { scope: ["adopted history callback"] },
            today: { leasedInsideUnit: true, leasedAfterRollback: true },
          },
        ],
      });
    });
  }
});
