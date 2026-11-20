/**
 * The per-allocation lock of the PostgreSQL working-copy manager, and the one
 * place that decides whether a session may rely on it.
 *
 * `operate`, `markDelivered` and destroy each open a transaction and take this
 * lock first. Its release at COMMIT is what makes the evidence `sequence` equal
 * commit order and makes the destroy fence binding. It only does that when every
 * statement after the lock wait takes a fresh snapshot, that is under READ
 * COMMITTED. A transaction option asking for it is a request, not evidence: a
 * wrapper can drop the option and a role or server default can then supply
 * REPEATABLE READ. So the lock statement also reports the isolation level of
 * the session it ran on, in the same statement, and this module refuses any
 * other level before the caller reads or writes anything.
 */
import { ConfigurationError } from "../../errors";
import { WORKING_COPY_ALLOCATION_ADVISORY_LOCK_NAMESPACE } from "../advisory-lock-namespaces";
import { resolveFenceStatements } from "../capabilities/write-fence";
import { normalizeGraphCommandIsolation } from "../command-contract";
import type { TransactionOptions } from "../types";
import { postgresFenceSql } from "./postgres-fence-sql";
import { type QuerySession, rows } from "./postgres-working-copy-sql";

export const WORKING_COPY_ISOLATION_UNSUPPORTED =
  "WORKING_COPY_ISOLATION_UNSUPPORTED";

/**
 * Options for every transaction that takes the allocation lock. Requested, never
 * assumed: {@link lockAllocation} observes what the session actually runs at.
 */
export const ALLOCATION_LOCK_TRANSACTION_OPTIONS = {
  isolationLevel: "read_committed",
} as const satisfies TransactionOptions;

const allocationLockStatements = resolveFenceStatements(postgresFenceSql);

type LockRow = Readonly<{ transaction_isolation: unknown }>;

/**
 * Takes `allocationId`'s lock for the rest of `session`'s transaction and
 * refuses unless that transaction runs under READ COMMITTED. `session` MUST be
 * the transaction session that goes on to read or write under the lock.
 *
 * The caller's attestation read (ledger row, ownership token) is a separate
 * statement AFTER this one. It cannot be folded in: a statement's snapshot is
 * taken before its lock wait, so a read folded into the lock statement could
 * observe the ledger as it was before the holder we waited on committed.
 *
 * @throws {ConfigurationError} with `details.code`
 *   {@link WORKING_COPY_ISOLATION_UNSUPPORTED} when the session's isolation is
 *   not READ COMMITTED. The lock is released with the transaction's rollback.
 */
export async function lockAllocation(
  session: QuerySession,
  allocationId: string,
): Promise<void> {
  const observed = await rows<LockRow>(
    session,
    allocationLockStatements.acquireKeyedWithIsolation(
      WORKING_COPY_ALLOCATION_ADVISORY_LOCK_NAMESPACE,
      allocationId,
    ),
  );
  const isolation = normalizeGraphCommandIsolation(
    observed[0]?.transaction_isolation,
  );
  if (isolation === "read_committed") return;
  throw new ConfigurationError(
    `Working-copy allocation lock ran under ${isolation} isolation; its ordering and destroy fence hold only under read_committed.`,
    { code: WORKING_COPY_ISOLATION_UNSUPPORTED, observedIsolation: isolation },
    {
      suggestion:
        "Forward the transaction `isolationLevel` option in every `control` and `connect` backend wrapper, and do not override it with a role or server default of repeatable read or serializable.",
    },
  );
}
