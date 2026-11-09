/** Durable caller-key outcomes for ordinary Store transactions and composed merges. */
import { z } from "zod";

import { statementExecutionMembers } from "../backend/capabilities/bind";
import { statementExecutionVerdict } from "../backend/capabilities/resolve";
import { isOptimisticRetryTier } from "../backend/capabilities/retried-unit";
import { type GraphBackend, type TransactionBackend } from "../backend/types";
import {
  assertGraphAllocationOwner,
  type GraphAllocationOwner,
  sameGraphAllocationOwner,
} from "../core/allocation-owner";
import { assertJsonValue } from "../core/json-value";
import { asRecordedInstant } from "../core/temporal";
import { type JsonValue } from "../core/types";
import { storeOperationsTableName } from "../query/compiler/schema";
import { sql } from "../query/sql-fragment";
import { asCompiledRowsSql, asCompiledStatementSql } from "../query/sql-intent";
import { recordedAnchorOwner } from "../store/recorded-anchor-origin";
import {
  readRecordedClock,
  withTransactionPreCommitHook,
} from "../store/recorded-capture";
import {
  type MeasurableTransactionContext,
  type TransactionReceipt,
} from "../store/types";
import { requireDefined } from "../utils/presence";
import {
  isSerializationFailure,
  isTransientDatabaseError,
} from "../utils/sql-errors";
import {
  computeDurableOperationDigest,
  type DurableOperationRequest,
  isNewDurableOperationKey,
  normalizeDurableOperationRequest,
} from "./durable-operation";
import {
  DurableOperationConflictError,
  DurableOperationError,
  DurableOperationEvidenceError,
  DurableOperationOriginMismatchError,
  DurableOperationRequestError,
  DurableOperationUnsupportedError,
  MergePlanCapabilityError,
  StoreOperationError,
} from "./errors";
import { err, ok, type Result } from "./result";
import {
  type GraphDef,
  sha256Hex,
  type Store,
  storeBackend,
  transactionBackend,
  TransactionConflictError,
} from "./typegraph-internal";
import { lockMergeTargetWrite } from "./write-fence";

/** Persist this allocation target with the request, before the first attempt. */
export type StoreOperationTarget = Readonly<{
  graphId: string;
  owner: GraphAllocationOwner;
  /** Opaque namespace binding for the configured outcome relation. */
  scope: string;
}>;

export type StoreOperationRequest = DurableOperationRequest &
  Readonly<{ target: StoreOperationTarget }>;

/** Immutable, JSON-safe outcome retained until the graph allocation is cleared. */
export type StoreOperationEvidence = StoreOperationRequest &
  Readonly<{
    formatVersion: 2;
    operationDigest: string;
    result: JsonValue;
    receipt: TransactionReceipt;
  }>;

export type StoreOperationOutcome = Readonly<{
  outcome: "applied" | "replayed";
  evidence: StoreOperationEvidence;
}>;

export type StoreOperationLookup = Readonly<{
  target: StoreOperationTarget;
  idempotencyKey: string;
}>;

export type StoreOperationApply<G extends GraphDef> = (
  tx: MeasurableTransactionContext<G>,
  mutation: JsonValue,
) => Promise<JsonValue>;

function jsonValueIsValid(value: unknown): value is JsonValue {
  try {
    assertJsonValue(value, "value", "Durable operation");
    return true;
  } catch {
    return false;
  }
}
const jsonValueSchema = z.custom<JsonValue>((value) => jsonValueIsValid(value));
const callerKeySchema = z.custom<string>((value) =>
  isNewDurableOperationKey(value),
);
const countSchema = z.number().int().nonnegative();
const targetSchema = z
  .object({
    graphId: z.string().min(1),
    owner: z
      .object({
        origin: z.string().min(1),
        namespace: z.string().regex(/^[a-f0-9]{32}$/u),
      })
      .strict(),
    scope: z.string().regex(/^[a-f0-9]{32}$/u),
  })
  .strict();
const requestSchema = z
  .object({
    target: targetSchema,
    idempotencyKey: z.unknown(),
    metadata: z.unknown(),
    mutation: z.unknown(),
  })
  .strict();
const evidenceSchema = z
  .object({
    formatVersion: z.literal(2),
    target: targetSchema,
    idempotencyKey: callerKeySchema,
    operationDigest: z.string().regex(/^[a-f0-9]{32}$/u),
    metadata: jsonValueSchema,
    mutation: jsonValueSchema,
    result: jsonValueSchema,
    receipt: z
      .object({
        writes: z
          .object({
            nodes: z.record(z.string(), countSchema),
            edges: z.record(z.string(), countSchema),
            identity: z
              .object({
                sameAssertions: countSchema,
                differentAssertions: countSchema,
                retractions: countSchema,
                total: countSchema,
              })
              .strict(),
            total: countSchema,
          })
          .strict(),
        recorded: z
          .string()
          .transform((value) => asRecordedInstant(value))
          .optional(),
      })
      .strict(),
  })
  .strict();

type StoredOperationRow = Readonly<{
  origin: unknown;
  operation_digest: unknown;
  evidence: unknown;
}>;

function operationFailure(error: unknown): DurableOperationError {
  if (error instanceof MergePlanCapabilityError)
    return new DurableOperationUnsupportedError(error.message, {
      cause: error,
      details: { dimensions: ["atomicMutation"], ...error.details },
    });
  return error instanceof DurableOperationError ? error : (
      new DurableOperationError(
        "Unable to read durable Store operation evidence.",
        { cause: error },
      )
    );
}

function requireOperationStatementMembers(
  target: GraphBackend | TransactionBackend,
) {
  // This bundle inspects only executeStatement. A transaction intentionally
  // lacks the GraphBackend lifecycle ports the generic resolver's type requires.
  const verdict = statementExecutionVerdict(target as GraphBackend);
  if (!verdict.supported)
    throw new DurableOperationUnsupportedError(
      "Durable Store operation evidence requires a statement executor on the actual transaction session.",
      { details: { dimensions: ["evidenceStore"] } },
    );
  return statementExecutionMembers(target, verdict);
}

function assertStoreOperationSupport<G extends GraphDef>(
  store: Store<G>,
): void {
  const backend = storeBackend(store);
  if (
    backend.capabilities.durableStoreOperations !== true ||
    isOptimisticRetryTier(backend) ||
    !backend.capabilities.execution.interactiveTransactions ||
    !store.revisionTrackingEnabled
  ) {
    throw new DurableOperationUnsupportedError(
      "Durable Store operations require atomic transactions, durable revision origins, and a declared operation evidence store.",
      {
        details: {
          dimensions: ["atomicMutation", "evidenceStore"],
          dialect: backend.dialect,
        },
      },
    );
  }
  requireOperationStatementMembers(backend);
}

async function operationScope<G extends GraphDef>(
  store: Store<G>,
): Promise<string> {
  return sha256Hex(storeOperationsTableName(store.revisionSchema), 16);
}

/** Captures an origin and namespace; never recapture this on a retry. */
export async function captureStoreOperationTarget<G extends GraphDef>(
  store: Store<G>,
): Promise<StoreOperationTarget> {
  assertStoreOperationSupport(store);
  return {
    graphId: store.graphId,
    owner: await store.allocationOwner(),
    scope: await operationScope(store),
  };
}

async function validateLookup(
  input: StoreOperationLookup | StoreOperationRequest,
): Promise<StoreOperationLookup & Readonly<{ expectedDigest?: string }>> {
  const record = z.record(z.string(), z.unknown()).safeParse(input);
  if (!record.success)
    throw new DurableOperationRequestError(
      "A durable lookup must be an object.",
    );
  const full =
    Object.hasOwn(record.data, "mutation") ||
    Object.hasOwn(record.data, "metadata");
  if (full) {
    const envelope = requestSchema.safeParse(input);
    if (!envelope.success)
      throw new DurableOperationRequestError(
        "A verified lookup needs the complete original request.",
        { details: { issues: envelope.error.issues } },
      );
    const normalized = await normalizeDurableOperationRequest(envelope.data);
    if (!normalized.success) throw normalized.error;
    return {
      target: envelope.data.target,
      idempotencyKey: normalized.data.idempotencyKey,
      expectedDigest: normalized.data.operationDigest,
    };
  }
  const bare = z
    .object({ target: targetSchema, idempotencyKey: callerKeySchema })
    .strict()
    .safeParse(input);
  if (!bare.success)
    throw new DurableOperationRequestError(
      "A durable lookup needs its persisted allocation target and an admissible caller key.",
      { details: { issues: bare.error.issues } },
    );
  return bare.data;
}

function assertOperationPayload(
  expectedDigest: string,
  actualDigest: string,
  idempotencyKey: string,
): void {
  if (expectedDigest !== actualDigest)
    throw new DurableOperationConflictError(
      "The caller key is already bound to a different mutation or metadata payload.",
      { details: { idempotencyKey } },
    );
}

async function assertTargetScope<G extends GraphDef>(
  store: Store<G>,
  target: StoreOperationTarget,
): Promise<void> {
  const configuredOwner = await recordedAnchorOwner(
    store.revisionSchema,
    target.owner.origin,
  );
  assertTargetOwner(target.owner, configuredOwner);
  if (
    target.graphId !== store.graphId ||
    target.scope !== (await operationScope(store))
  )
    throw new DurableOperationRequestError(
      "The durable operation belongs to another graph or storage namespace.",
      { details: { reason: "target-mismatch" } },
    );
}

function assertTargetOwner(
  expected: GraphAllocationOwner,
  actual: GraphAllocationOwner | undefined,
): void {
  try {
    assertGraphAllocationOwner(expected, actual);
  } catch (error) {
    throw new DurableOperationOriginMismatchError(error);
  }
}

async function decodeEvidence(
  row: StoredOperationRow,
  lookup: StoreOperationLookup,
): Promise<StoreOperationEvidence | undefined> {
  // SQL LEFT JOIN uses NULL for a key with no evidence row.

  if (row.evidence === undefined || row.evidence === null) return undefined;
  try {
    if (typeof row.evidence !== "string")
      throw new Error("Expected serialized operation evidence.");
    const evidence = evidenceSchema.parse(JSON.parse(row.evidence));
    if (
      evidence.target.graphId !== lookup.target.graphId ||
      !sameGraphAllocationOwner(evidence.target.owner, lookup.target.owner) ||
      evidence.target.scope !== lookup.target.scope ||
      evidence.idempotencyKey !== lookup.idempotencyKey ||
      row.operation_digest !== evidence.operationDigest ||
      (await computeDurableOperationDigest(evidence)) !==
        evidence.operationDigest
    ) {
      throw new Error(
        "Stored operation evidence does not match its allocation, key, or payload digest.",
      );
    }
    return {
      ...evidence,
      receipt: {
        writes: evidence.receipt.writes,
        ...(evidence.receipt.recorded === undefined ?
          {}
        : { recorded: evidence.receipt.recorded }),
      },
    };
  } catch (error) {
    throw new DurableOperationEvidenceError(
      "Stored durable Store-operation evidence is invalid.",
      { cause: error },
    );
  }
}

async function readOperation<G extends GraphDef>(
  store: Store<G>,
  backend: Pick<GraphBackend, "execute">,
  lookup: StoreOperationLookup,
): Promise<StoreOperationEvidence | undefined> {
  const rows = await backend.execute<StoredOperationRow>(
    asCompiledRowsSql(sql`
      SELECT origins.origin, operations.operation_digest, operations.evidence
      FROM ${store.revisionSchema.revisionOriginsTable} origins
      LEFT JOIN ${sql.identifier(storeOperationsTableName(store.revisionSchema))} operations
        ON operations.graph_id = origins.graph_id AND operations.origin = origins.origin
          AND operations.scope = ${lookup.target.scope} AND operations.idempotency_key = ${lookup.idempotencyKey}
      WHERE origins.graph_id = ${store.graphId}
    `),
  );
  const row = rows[0];
  if (row === undefined) {
    assertTargetOwner(lookup.target.owner, undefined);
    return undefined;
  }
  assertTargetOwner(
    lookup.target.owner,
    typeof row.origin === "string" ?
      await recordedAnchorOwner(store.revisionSchema, row.origin)
    : undefined,
  );
  return decodeEvidence(row, lookup);
}

/** Reads committed evidence with one indexed lookup, including after restart. */
export async function getStoreOperation<G extends GraphDef>(
  store: Store<G>,
  input: StoreOperationLookup | StoreOperationRequest,
): Promise<Result<StoreOperationEvidence | undefined, DurableOperationError>> {
  try {
    assertStoreOperationSupport(store);
    const lookup = await validateLookup(input);
    await assertTargetScope(store, lookup.target);
    const evidence = await readOperation(store, storeBackend(store), lookup);
    if (evidence !== undefined && lookup.expectedDigest !== undefined)
      assertOperationPayload(
        lookup.expectedDigest,
        evidence.operationDigest,
        lookup.idempotencyKey,
      );
    return ok(evidence);
  } catch (error) {
    return err(operationFailure(error));
  }
}

/**
 * Atomically persists native transaction writes and their terminal outcome.
 * Identical requests replay before invoking apply; conflicting payloads refuse.
 */
export async function operateStore<G extends GraphDef>(
  store: Store<G>,
  input: StoreOperationRequest,
  apply: StoreOperationApply<NoInfer<G>>,
): Promise<Result<StoreOperationOutcome, DurableOperationError>> {
  const attemptState: {
    phase: StoreOperationError["phase"];
    commitBoundary: boolean;
  } = { phase: "preflight", commitBoundary: false };
  try {
    assertStoreOperationSupport(store);
    const validated = requestSchema.safeParse(input);
    if (!validated.success)
      throw new DurableOperationRequestError(
        "Invalid durable Store-operation request.",
        { details: { issues: validated.error.issues } },
      );
    const normalized = await normalizeDurableOperationRequest(validated.data);
    if (!normalized.success) throw normalized.error;
    const { operationDigest, ...payload } = normalized.data;
    const request = { ...payload, target: validated.data.target };
    await assertTargetScope(store, request.target);
    const activeSchema = await storeBackend(store).getActiveSchema(
      store.graphId,
    );
    type Pending = { evidence?: StoreOperationEvidence } & Readonly<{
      result: JsonValue;
      receipt: TransactionReceipt;
      before: string | undefined;
    }>;
    let pending: Pending | undefined;
    const options = withTransactionPreCommitHook(
      { isolationLevel: "read_committed" },
      async (backend) => {
        if (pending === undefined) return;
        const recorded =
          store.historyEnabled ?
            await readRecordedClock(
              backend,
              store.revisionSchema,
              store.graphId,
            )
          : undefined;
        const evidence: StoreOperationEvidence = {
          ...request,
          formatVersion: 2,
          operationDigest,
          result: pending.result,
          receipt: {
            ...pending.receipt,
            ...(recorded === undefined || recorded === pending.before ?
              {}
            : { recorded }),
          },
        };
        // Serialize before executing SQL; a failure still rolls back native rows and sidecars.
        const serialized = JSON.stringify(evidence);
        const { executeStatement } = requireOperationStatementMembers(backend);
        await executeStatement(
          asCompiledStatementSql(sql`
            INSERT INTO ${sql.identifier(storeOperationsTableName(store.revisionSchema))}
              (graph_id, origin, scope, idempotency_key, operation_digest, evidence)
            VALUES (${store.graphId}, ${request.target.owner.origin}, ${request.target.scope}, ${request.idempotencyKey}, ${operationDigest}, ${serialized})
          `),
        );
        pending.evidence = evidence;
        attemptState.phase = "commit";
        attemptState.commitBoundary = true;
      },
    );
    const outcome = await store.transactionWithReceipt(async (tx) => {
      pending = undefined;
      attemptState.phase = "preflight";
      attemptState.commitBoundary = false;
      const backend: TransactionBackend = transactionBackend(tx);
      requireOperationStatementMembers(backend);
      await lockMergeTargetWrite(backend, {
        graphId: store.graphId,
        schemaVersion: activeSchema?.version,
        graphLock: "required",
        requireFreshSnapshot: true,
        staleSchemaError: (cause) =>
          new DurableOperationRequestError(
            "The Store schema changed before the durable operation.",
            { cause },
          ),
      });
      const previous = await readOperation(store, backend, request);
      if (previous !== undefined) {
        assertOperationPayload(
          operationDigest,
          previous.operationDigest,
          request.idempotencyKey,
        );
        attemptState.phase = "commit";
        attemptState.commitBoundary = true;
        return { outcome: "replayed" as const, evidence: previous };
      }
      const before =
        store.historyEnabled ?
          await readRecordedClock(backend, store.revisionSchema, store.graphId)
        : undefined;
      attemptState.phase = "callback";
      const measured = await tx.measure(async (scoped) =>
        apply(scoped, structuredClone(request.mutation)),
      );
      assertJsonValue(measured.result, "result", "Durable Store operation");
      const result = structuredClone(measured.result);
      assertJsonValue(result, "result", "Durable Store operation");
      const attempt: Pending = { result, receipt: measured.receipt, before };
      pending = attempt;
      attemptState.phase = "evidence";
      return { outcome: "applied" as const, attempt };
    }, options);
    return ok(
      outcome.result.outcome === "replayed" ?
        outcome.result
      : {
          outcome: "applied",
          evidence: requireDefined(
            outcome.result.attempt.evidence,
            "The committed operation produced no durable evidence.",
          ),
        },
    );
  } catch (error) {
    if (
      attemptState.phase === "preflight" &&
      !attemptState.commitBoundary &&
      (error instanceof DurableOperationError ||
        error instanceof MergePlanCapabilityError)
    )
      return err(operationFailure(error));
    const conflict =
      error instanceof TransactionConflictError ||
      isSerializationFailure(error, storeBackend(store));
    const unknown = attemptState.commitBoundary && !conflict;
    const retryable =
      unknown ||
      conflict ||
      isTransientDatabaseError(error, storeBackend(store));
    return err(
      new StoreOperationError(
        unknown ? "unknown" : "not-committed",
        attemptState.phase,
        retryable,
        error,
      ),
    );
  }
}
