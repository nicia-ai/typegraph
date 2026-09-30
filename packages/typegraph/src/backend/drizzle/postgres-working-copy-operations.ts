/**
 * Durable-branch operations for the PostgreSQL table-backed working copy.
 *
 * One evidence relation per durable allocation lives under the allocation's
 * ledger-reserved physical prefix, in the allocation's recorded schema. It is
 * provisioned with the allocation's other tables and removed with them, and
 * every statement that touches it names that schema ({@link
 * operationEvidenceRelation}) rather than trusting a connection's `search_path`.
 * `operate` applies the host's opaque mutation
 * and inserts its evidence in ONE transaction on the allocation's own session,
 * after taking the allocation's lock. TypeGraph never interprets the mutation;
 * the host's `apply` callback does, inside that transaction.
 *
 * SERIALIZATION AND COMMIT ORDER. Every `operate` (and `markDelivered`, and the
 * destroy fence) takes the allocation's transaction-scoped advisory lock
 * (`lockAllocation`) before touching the evidence relation, so
 * per-allocation writes never overlap. The evidence `sequence` is assigned
 * while that lock is held and the lock is released only at COMMIT, so a later
 * sequence cannot commit before an earlier one: sequence order IS commit
 * order, and a scan never observes a hole that fills in later. Only managers on
 * this version take the lock; a manager from an older release knows nothing of
 * it, so every process sharing a ledger must be upgraded before a durable
 * allocation is created or destroyed.
 *
 * ISOLATION. That argument, and the destroy fence's, hold only when each
 * statement after the lock wait takes a fresh snapshot. Every member that
 * relies on the lock requests READ COMMITTED
 * ({@link ALLOCATION_LOCK_TRANSACTION_OPTIONS}) and the lock statement then
 * OBSERVES the session's isolation and refuses any other level: the request is
 * only honored "if supported", and a role or server default could otherwise
 * supply REPEATABLE READ.
 *
 * BEFORE COORDINATE. `before` is read after the per-graph write lock, so a
 * store that takes that lock for its ordinary writes (history or revision
 * tracking) cannot commit a foreign write between `before` and `apply`. That
 * lock is graph-wide: it also blocks tracked writes to the source graph and to
 * every sibling working copy of it for the whole of `apply`. A store with
 * neither mode takes no such lock for ordinary writes; there `before` is not
 * fenced against writers other than `operate`.
 */
import type { GraphDef } from "../../core/define-graph";
import { assertJsonValue } from "../../core/json-value";
import type { JsonValue } from "../../core/types";
import { computeBaseVersionAtTarget } from "../../graph-merge/base-version";
import type { DurableBranchOrigin } from "../../graph-merge/durable-branch";
import type {
  DurableBranchCoordinates,
  DurableBranchOperation,
  DurableBranchOperationEvidence,
  DurableOperationCapability,
  DurableOperationOutcome,
  DurableOperationScan,
} from "../../graph-merge/durable-operation";
import {
  BranchError,
  DurableOperationConflictError,
  DurableOperationEvidenceError,
  DurableOperationRequestError,
} from "../../graph-merge/errors";
import {
  type EngineRevision,
  resolveLineage,
  transactionBackend,
} from "../../graph-merge/typegraph-internal";
import { asBaseVersion } from "../../graph-merge/types";
import { sql, type SqlFragment } from "../../query/sql-fragment";
import {
  lockRecordedGraphWrite,
  withTransactionPreCommitHook,
} from "../../store/recorded-capture";
import type { Store } from "../../store/store";
import type { TransactionContext } from "../../store/types";
import { isMissingTableError } from "../../utils/sql-errors";
import type { TransactionBackend, TransactionOptions } from "../types";
import { quoteDdlIdentifier } from "./ddl";
import { ALLOCATION_LOCK_TRANSACTION_OPTIONS } from "./postgres-working-copy-lock";
import { type QuerySession, rows, sqlName } from "./postgres-working-copy-sql";

const EVIDENCE_TABLE_SUFFIX = "op_evidence";
const UNDELIVERED_INDEX_SUFFIX = "_undelivered";
const CURSOR_PREFIX = "pgop1.";
const CURSOR_PATTERN = /^pgop1\.(0|[1-9]\d{0,18})$/u;
const INITIAL_SEQUENCE = "0";
const MAX_SEQUENCE = 9_223_372_036_854_775_807n;

const EVIDENCE_COLUMNS = sql.raw(
  "sequence::text AS sequence, idempotency_key, operation_digest, metadata, mutation, before_base, before_revision, after_base, after_revision, delivered",
);

/**
 * The host's opaque-mutation applier. TypeGraph never interprets `mutation`;
 * `apply` runs inside the evidence transaction on the allocation's
 * transaction-scoped context, and a throw rolls back the mutation and the
 * evidence together. `graph` is required because capability members receive
 * only the descriptor, so the manager cannot otherwise reopen the allocation.
 */
export type PostgresWorkingCopyOperations<G extends GraphDef> = Readonly<{
  graph: G;
  apply: (
    transaction: TransactionContext<G>,
    mutation: JsonValue,
  ) => Promise<void>;
}>;

/** What an operation member may use of one opened, attested allocation. */
export type OperationAllocation<G extends GraphDef> = Readonly<{
  store: Store<G>;
  /** Reads through the allocation's own connection. */
  session: QuerySession;
  /** Runs `use` in a transaction on the allocation's own session. */
  transaction: <T>(
    use: (transaction: TransactionBackend) => Promise<T>,
    options: TransactionOptions,
  ) => Promise<T>;
  evidenceRelation: OperationEvidenceRelation;
  /**
   * Takes the allocation lock on `session`, refuses unless `session` runs under
   * READ COMMITTED, and re-attests the sealed origin. `session` MUST be the
   * transaction session that goes on to read or write under the lock.
   */
  lockSealed: (
    session: QuerySession,
    expectedOrigin: DurableBranchOrigin,
  ) => Promise<void>;
}>;

/**
 * Attests the allocation a member names and hands it to the member that fits its
 * provisioning: `withEvidence` with an opened allocation, or `withoutEvidence`
 * for one provisioned before evidence existed, which needs no `connect` call.
 */
export type OperationAllocationAccess<G extends GraphDef> = <T>(
  descriptor: Readonly<{ allocationId: string }>,
  descriptorVersion: number,
  expectedOrigin: DurableBranchOrigin,
  members: Readonly<{
    withEvidence: (allocation: OperationAllocation<G>) => Promise<T>;
    withoutEvidence: () => T;
  }>,
) => Promise<T>;

type EvidenceRow = Readonly<{
  sequence: string;
  idempotency_key: string;
  operation_digest: string;
  metadata: string;
  mutation: string;
  before_base: string;
  before_revision: string | null;
  after_base: string;
  after_revision: string | null;
  delivered: boolean;
}>;

/** What one run of the operation transaction observed and decided. */
interface OperationAttempt {
  before: DurableBranchCoordinates | undefined;
  outcome: DurableOperationOutcome | undefined;
}

/** What a member answers for one evidence key of an allocation with no evidence relation. */
const NO_EVIDENCE: DurableBranchOperationEvidence | undefined = undefined;

const UNSUPPORTED_EVIDENCE_STORE = {
  outcome: "unsupported",
  dimensions: ["evidenceStore"],
} as const satisfies DurableOperationOutcome;

/**
 * What a member reports when the allocation it attested is gone by the time it
 * touches the allocation's relations. One owner, shared by the members that
 * hold the allocation lock (whose attestation read finds no row) and the ones
 * that do not (whose evidence read finds no relation).
 */
export function allocationRemovedError(cause?: unknown): BranchError {
  return new BranchError(
    "Working-copy allocation changed owner or was destroyed during the operation.",
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Runs one read of the allocation's own relations that holds no allocation
 * lock. A destroy can commit between the sealed-row read that chose the
 * allocation and the read itself; the read then fails with PostgreSQL's
 * missing-relation error, which is the contract's "removed allocation" and is
 * reported as such. `read` MUST reference only the allocation's own relations,
 * so a missing relation is one of them. The destroy fence holds the allocation
 * lock and does not use it.
 */
async function readUnlocked<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isMissingTableError(error)) throw allocationRemovedError(error);
    throw error;
  }
}

export function operationEvidenceTableName(physicalPrefix: string): string {
  return `${physicalPrefix}${EVIDENCE_TABLE_SUFFIX}`;
}

/**
 * The evidence relation as every read and write addresses it: qualified by the
 * allocation's recorded schema, so it resolves there whatever `search_path` the
 * connection runs with. It sits under the allocation's reserved prefix, which is
 * how allocation removal finds and drops it with the rest of the allocation.
 */
export type OperationEvidenceRelation = SqlFragment;

export function operationEvidenceRelation(
  schema: string,
  physicalPrefix: string,
): OperationEvidenceRelation {
  return sql`${sqlName(schema)}.${sqlName(operationEvidenceTableName(physicalPrefix))}`;
}

/**
 * Strict creation DDL for the evidence relation. JSON content is stored as
 * exact text (not jsonb) so a host value round-trips byte-for-byte, including
 * strings PostgreSQL's jsonb cannot represent. A revision column is null when
 * the working copy resolved no lineage.
 */
export function operationEvidenceCreateDdl(
  tableName: string,
): readonly string[] {
  const table = quoteDdlIdentifier(tableName);
  const index = quoteDdlIdentifier(`${tableName}${UNDELIVERED_INDEX_SUFFIX}`);
  return [
    `CREATE TABLE ${table} (
      sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      idempotency_key text NOT NULL UNIQUE,
      operation_digest text NOT NULL,
      metadata text NOT NULL,
      mutation text NOT NULL,
      before_base text NOT NULL,
      before_revision text,
      after_base text NOT NULL,
      after_revision text,
      delivered boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX ${index} ON ${table} (sequence) WHERE NOT delivered`,
  ];
}

/**
 * The destroy fence's predicate, shared with the capability's own query. It
 * classifies nothing: the capability's unlocked read wraps it in `readUnlocked`,
 * while the destroy fence holds the allocation lock over a relation it has just
 * discovered, so a missing relation there is not a removed allocation.
 */
export async function hasUndeliveredEvidence(
  session: QuerySession,
  evidenceRelation: OperationEvidenceRelation,
): Promise<boolean> {
  const found = await rows<Readonly<{ present: boolean }>>(
    session,
    sql`SELECT EXISTS (SELECT 1 FROM ${evidenceRelation} WHERE NOT delivered) AS present`,
  );
  return found[0]?.present === true;
}

/** A nullable text column: the coordinate's revision, absent without lineage. */
function nullableText(value: string | undefined): SqlFragment {
  return value === undefined ? sql`NULL` : sql`${value}`;
}

function encodeCursor(sequence: string): string {
  return `${CURSOR_PREFIX}${sequence}`;
}

function decodeCursor(cursor: string | undefined): string {
  if (cursor === undefined) return INITIAL_SEQUENCE;
  const match = CURSOR_PATTERN.exec(cursor);
  const sequence = match?.[1];
  if (sequence === undefined || BigInt(sequence) > MAX_SEQUENCE) {
    throw new DurableOperationRequestError(
      "Durable operation scan cursor is not a cursor issued by this strategy.",
    );
  }
  return sequence;
}

function parseStoredJson(text: string, column: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(text);
    assertJsonValue(parsed, column, "Durable operation evidence");
    return parsed as JsonValue;
  } catch (error) {
    throw new DurableOperationEvidenceError(
      `Stored durable operation evidence ${column} is not valid JSON.`,
      { cause: error },
    );
  }
}

/** A stored revision is text this manager persisted from a lineage's own token. */
function asEngineRevision(revision: string): EngineRevision {
  return revision as EngineRevision;
}

function toCoordinates(
  base: string,
  revision: string | null,
): DurableBranchCoordinates {
  return {
    base: asBaseVersion(base),
    ...(revision === null ? {} : { revision: asEngineRevision(revision) }),
  };
}

function toEvidence(row: EvidenceRow): DurableBranchOperationEvidence {
  return {
    idempotencyKey: row.idempotency_key,
    operationDigest: row.operation_digest,
    metadata: parseStoredJson(row.metadata, "metadata"),
    mutation: parseStoredJson(row.mutation, "mutation"),
    before: toCoordinates(row.before_base, row.before_revision),
    after: toCoordinates(row.after_base, row.after_revision),
    delivered: row.delivered,
  };
}

/**
 * THE one owner of an evidence coordinate: the merge-visible base version and,
 * when the working copy resolves lineage, the engine revision, both read on the
 * pinned `target` session so they describe the same state. `before` and `after`
 * are both minted here, so they cannot drift from each other.
 */
async function coordinatesAt<G extends GraphDef>(
  store: Store<G>,
  target: TransactionBackend,
): Promise<DurableBranchCoordinates> {
  const base = await computeBaseVersionAtTarget(store, target);
  const lineage = resolveLineage(store);
  return lineage === undefined ?
      { base }
    : { base, revision: await lineage.revision(target) };
}

async function readEvidence(
  session: QuerySession,
  evidenceRelation: OperationEvidenceRelation,
  idempotencyKey: string,
): Promise<EvidenceRow | undefined> {
  const found = await rows<EvidenceRow>(
    session,
    sql`SELECT ${EVIDENCE_COLUMNS} FROM ${evidenceRelation} WHERE idempotency_key = ${idempotencyKey}`,
  );
  return found[0];
}

async function insertEvidence(
  session: QuerySession,
  evidenceRelation: OperationEvidenceRelation,
  request: DurableBranchOperation,
  before: DurableBranchCoordinates,
  after: DurableBranchCoordinates,
): Promise<DurableBranchOperationEvidence> {
  const inserted = await rows<EvidenceRow>(
    session,
    sql`INSERT INTO ${evidenceRelation} (idempotency_key, operation_digest, metadata, mutation, before_base, before_revision, after_base, after_revision) VALUES (${request.idempotencyKey}, ${request.operationDigest}, ${JSON.stringify(request.metadata)}, ${JSON.stringify(request.mutation)}, ${before.base}, ${nullableText(before.revision)}, ${after.base}, ${nullableText(after.revision)}) RETURNING ${EVIDENCE_COLUMNS}`,
  );
  const row = inserted[0];
  if (row === undefined) {
    throw new BranchError(
      "Working-copy operation evidence insert returned no row.",
    );
  }
  return toEvidence(row);
}

function replayOrConflict(
  existing: EvidenceRow,
  request: DurableBranchOperation,
): DurableOperationOutcome {
  if (existing.operation_digest !== request.operationDigest) {
    throw new DurableOperationConflictError(
      `Idempotency key "${request.idempotencyKey}" was already committed with a different operation digest.`,
      { details: { idempotencyKey: request.idempotencyKey } },
    );
  }
  return { outcome: "replayed", evidence: toEvidence(existing) };
}

async function operateInAllocation<G extends GraphDef>(
  allocation: OperationAllocation<G>,
  operations: PostgresWorkingCopyOperations<G>,
  expectedOrigin: DurableBranchOrigin,
  request: DurableBranchOperation,
): Promise<DurableOperationOutcome> {
  const { store, evidenceRelation } = allocation;
  // The origin row is minted here, outside the transaction: a capture-scoped
  // transaction refuses raw row writes, and the in-transaction coordinate
  // reads then only ever read it. It holds no allocation lock yet, so a destroy
  // that already committed surfaces here as a missing relation.
  if (store.revisionTrackingEnabled) {
    await readUnlocked(() => store.revisionOriginNow());
  }

  // One entry per run of the transaction below, so a retried run can never
  // read the `before` or `outcome` a rolled-back run left behind.
  const attempts: OperationAttempt[] = [];

  const recordEvidence = async (target: TransactionBackend): Promise<void> => {
    const attempt = attempts.at(-1);
    if (attempt?.before === undefined) return;
    const after = await coordinatesAt(store, target);
    const evidence = await insertEvidence(
      target,
      evidenceRelation,
      request,
      attempt.before,
      after,
    );
    attempt.outcome = { outcome: "applied", evidence };
  };

  const run = async (transaction: TransactionContext<G>): Promise<void> => {
    const attempt: OperationAttempt = { before: undefined, outcome: undefined };
    attempts.push(attempt);
    const target = transactionBackend(transaction);
    await allocation.lockSealed(target, expectedOrigin);
    const existing = await readEvidence(
      target,
      evidenceRelation,
      request.idempotencyKey,
    );
    if (existing !== undefined) {
      attempt.outcome = replayOrConflict(existing, request);
      return;
    }
    // The write fence comes BEFORE the coordinate read: a writer that takes
    // this lock cannot commit between `before` and `apply` once we hold it.
    await lockRecordedGraphWrite(target, store.graphId);
    attempt.before = await coordinatesAt(store, target);
    await operations.apply(transaction, request.mutation);
  };

  // The revision clock advances (and recorded-time capture flushes) only after
  // `run` returns, so the `after` coordinate and the evidence row are written
  // by the pre-commit hook: on the same session, on the state COMMIT publishes.
  // The Store guarantees the hook runs exactly once before COMMIT.
  await store.transaction(
    run,
    withTransactionPreCommitHook(
      ALLOCATION_LOCK_TRANSACTION_OPTIONS,
      recordEvidence,
    ),
  );
  const outcome = attempts.at(-1)?.outcome;
  if (outcome === undefined) {
    throw new BranchError(
      "Working-copy operation committed without producing an outcome.",
    );
  }
  return outcome;
}

async function scanEvidence(
  session: QuerySession,
  evidenceRelation: OperationEvidenceRelation,
  after: string | undefined,
  afterSequence: string,
  limit: number,
): Promise<DurableOperationScan> {
  const found = await rows<EvidenceRow>(
    session,
    sql`SELECT ${EVIDENCE_COLUMNS} FROM ${evidenceRelation} WHERE sequence > ${afterSequence}::bigint ORDER BY sequence LIMIT ${limit + 1}`,
  );
  const page = found.slice(0, limit);
  const last = page.at(-1);
  return scanPage(
    page.map((row) => toEvidence(row)),
    last === undefined ? after : encodeCursor(last.sequence),
    found.length > limit,
  );
}

function scanPage(
  operations: readonly DurableBranchOperationEvidence[],
  cursor: string | undefined,
  hasMore: boolean,
): DurableOperationScan {
  return {
    operations,
    ...(cursor === undefined ? {} : { cursor }),
    hasMore,
  };
}

async function markEvidenceDelivered<G extends GraphDef>(
  allocation: OperationAllocation<G>,
  expectedOrigin: DurableBranchOrigin,
  idempotencyKey: string,
): Promise<DurableBranchOperationEvidence | undefined> {
  const { evidenceRelation } = allocation;
  const row = await allocation.transaction(async (transaction) => {
    await allocation.lockSealed(transaction, expectedOrigin);
    const updated = await rows<EvidenceRow>(
      transaction,
      sql`UPDATE ${evidenceRelation} SET delivered = true WHERE idempotency_key = ${idempotencyKey} AND NOT delivered RETURNING ${EVIDENCE_COLUMNS}`,
    );
    return (
      updated[0] ??
      (await readEvidence(transaction, evidenceRelation, idempotencyKey))
    );
  }, ALLOCATION_LOCK_TRANSACTION_OPTIONS);
  return row === undefined ? undefined : toEvidence(row);
}

/**
 * Builds the `operations` capability over one manager's allocations. An
 * allocation provisioned before evidence existed has no evidence relation, and
 * the ledger row alone says so: `operate` returns `unsupported`
 * (`evidenceStore`) after one read-only ledger SELECT through `control`, having
 * run no DDL, taken no lock, called no `connect`, and applied and written
 * nothing, and every other member reports "no evidence" (`undefined` /
 * an empty scan / `false`) because nothing could ever have been committed to it.
 */
export function createPostgresOperationCapability<G extends GraphDef>(
  operations: PostgresWorkingCopyOperations<G>,
  withAllocation: OperationAllocationAccess<G>,
): DurableOperationCapability<Readonly<{ allocationId: string }>> {
  return {
    operate: ({ descriptor, descriptorVersion, expectedOrigin, request }) =>
      withAllocation(descriptor, descriptorVersion, expectedOrigin, {
        withEvidence: (allocation) =>
          operateInAllocation(allocation, operations, expectedOrigin, request),
        withoutEvidence: () => UNSUPPORTED_EVIDENCE_STORE,
      }),
    get: ({ descriptor, descriptorVersion, expectedOrigin, idempotencyKey }) =>
      withAllocation(descriptor, descriptorVersion, expectedOrigin, {
        withEvidence: ({ session, evidenceRelation }) =>
          readUnlocked(async () => {
            const row = await readEvidence(
              session,
              evidenceRelation,
              idempotencyKey,
            );
            return row === undefined ? undefined : toEvidence(row);
          }),
        withoutEvidence: () => NO_EVIDENCE,
      }),
    scan: async ({
      descriptor,
      descriptorVersion,
      expectedOrigin,
      after,
      limit,
    }) => {
      const afterSequence = decodeCursor(after);
      return withAllocation(descriptor, descriptorVersion, expectedOrigin, {
        withEvidence: ({ session, evidenceRelation }) =>
          readUnlocked(() =>
            scanEvidence(session, evidenceRelation, after, afterSequence, limit),
          ),
        withoutEvidence: () => scanPage([], after, false),
      });
    },
    markDelivered: ({
      descriptor,
      descriptorVersion,
      expectedOrigin,
      idempotencyKey,
    }) =>
      withAllocation(descriptor, descriptorVersion, expectedOrigin, {
        withEvidence: (allocation) =>
          markEvidenceDelivered(allocation, expectedOrigin, idempotencyKey),
        withoutEvidence: () => NO_EVIDENCE,
      }),
    hasUndelivered: ({ descriptor, descriptorVersion, expectedOrigin }) =>
      withAllocation(descriptor, descriptorVersion, expectedOrigin, {
        withEvidence: ({ session, evidenceRelation }) =>
          readUnlocked(() => hasUndeliveredEvidence(session, evidenceRelation)),
        withoutEvidence: () => false,
      }),
  };
}
