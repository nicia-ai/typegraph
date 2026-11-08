/** Durable caller-key outcomes for ordinary Store transactions and composed merges. */
import { z } from "zod";

import { statementExecutionMembers } from "../backend/capabilities/bind";
import { statementExecutionVerdict } from "../backend/capabilities/resolve";
import { type GraphBackend, type TransactionBackend } from "../backend/types";
import { assertJsonValue } from "../core/json-value";
import { asRecordedInstant } from "../core/temporal";
import { type JsonValue } from "../core/types";
import { storeOperationsTableName } from "../query/compiler/schema";
import { sql } from "../query/sql-fragment";
import { asCompiledRowsSql, asCompiledStatementSql } from "../query/sql-intent";
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
  computeDurableOperationDigest,
  type DurableBranchOperationRequest,
} from "./durable-operation";
import {
  DurableOperationConflictError,
  DurableOperationError,
  DurableOperationEvidenceError,
  DurableOperationRequestError,
  DurableOperationUnsupportedError,
  MergePlanCapabilityError,
} from "./errors";
import { err, ok, type Result } from "./result";
import {
  type GraphDef,
  sha256Hex,
  type Store,
  storeBackend,
  transactionBackend,
} from "./typegraph-internal";
import { lockMergeTargetWrite } from "./write-fence";

/** Persist this allocation target with the request, before the first attempt. */
export type StoreOperationTarget = Readonly<{
  graphId: string;
  origin: string;
  /** Opaque namespace binding for the configured outcome relation. */
  scope: string;
}>;

export type StoreOperationRequest = DurableBranchOperationRequest &
  Readonly<{ target: StoreOperationTarget }>;

/** Immutable, JSON-safe outcome retained until the graph allocation is cleared. */
export type StoreOperationEvidence = StoreOperationRequest &
  Readonly<{
    formatVersion: 1;
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
const callerKeySchema = z.string().min(1).max(256);
const countSchema = z.number().int().nonnegative();
const targetSchema = z
  .object({
    graphId: z.string().min(1),
    origin: z.string().min(1),
    scope: z.string().regex(/^[a-f0-9]{32}$/u),
  })
  .strict();
const requestSchema = z
  .object({
    target: targetSchema,
    idempotencyKey: callerKeySchema,
    metadata: jsonValueSchema,
    mutation: jsonValueSchema,
  })
  .strict();
const evidenceSchema = z
  .object({
    formatVersion: z.literal(1),
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
        "Durable Store operation failed; retry or look up the same persisted request to recover a possibly committed outcome.",
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
    origin: await store.revisionOriginNow(),
    scope: await operationScope(store),
  };
}

function validateLookup(input: StoreOperationLookup): StoreOperationLookup {
  const parsed = z
    .object({ target: targetSchema, idempotencyKey: callerKeySchema })
    .safeParse(input);
  if (!parsed.success)
    throw new DurableOperationRequestError(
      "A durable Store operation needs its persisted allocation target and a caller key of 1 through 256 characters.",
      { details: { issues: parsed.error.issues } },
    );
  return parsed.data;
}

async function assertTargetScope<G extends GraphDef>(
  store: Store<G>,
  target: StoreOperationTarget,
): Promise<void> {
  if (
    target.graphId !== store.graphId ||
    target.scope !== (await operationScope(store))
  )
    throw new DurableOperationRequestError(
      "The durable operation belongs to another graph or storage namespace.",
      { details: { reason: "target-mismatch" } },
    );
}

function assertTargetOrigin(
  expected: StoreOperationTarget,
  actual: unknown,
): void {
  if (expected.origin !== actual)
    throw new DurableOperationRequestError(
      "The durable operation belongs to a different or retired graph origin.",
      {
        details: {
          reason: "origin-mismatch",
          expectedOrigin: expected.origin,
          actualOrigin: actual,
        },
      },
    );
}

async function decodeEvidence(
  row: StoredOperationRow,
  lookup: StoreOperationLookup,
): Promise<StoreOperationEvidence | undefined> {
  assertTargetOrigin(lookup.target, row.origin);
  // SQL LEFT JOIN uses NULL for a key with no evidence row.

  if (row.evidence === undefined || row.evidence === null) return undefined;
  try {
    if (typeof row.evidence !== "string")
      throw new Error("Expected serialized operation evidence.");
    const evidence = evidenceSchema.parse(JSON.parse(row.evidence));
    if (
      evidence.target.graphId !== lookup.target.graphId ||
      evidence.target.origin !== lookup.target.origin ||
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
    assertTargetOrigin(lookup.target, undefined);
    return undefined;
  }
  return decodeEvidence(row, lookup);
}

/** Reads committed evidence with one indexed lookup, including after restart. */
export async function getStoreOperation<G extends GraphDef>(
  store: Store<G>,
  input: StoreOperationLookup,
): Promise<Result<StoreOperationEvidence | undefined, DurableOperationError>> {
  try {
    assertStoreOperationSupport(store);
    const lookup = validateLookup(input);
    await assertTargetScope(store, lookup.target);
    return ok(await readOperation(store, storeBackend(store), lookup));
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
  try {
    assertStoreOperationSupport(store);
    let snapshot: unknown;
    try {
      snapshot = structuredClone(input);
    } catch (error) {
      throw new DurableOperationRequestError(
        "A durable Store-operation request must be serializable data.",
        { cause: error },
      );
    }
    const validated = requestSchema.safeParse(snapshot);
    if (!validated.success)
      throw new DurableOperationRequestError(
        "Invalid durable Store-operation request.",
        { details: { issues: validated.error.issues } },
      );
    const request = validated.data;
    await assertTargetScope(store, request.target);
    const operationDigest = await computeDurableOperationDigest(request);
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
          formatVersion: 1,
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
            VALUES (${store.graphId}, ${request.target.origin}, ${request.target.scope}, ${request.idempotencyKey}, ${operationDigest}, ${serialized})
          `),
        );
        pending.evidence = evidence;
      },
    );
    const outcome = await store.transactionWithReceipt(async (tx) => {
      pending = undefined;
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
        if (previous.operationDigest !== operationDigest)
          throw new DurableOperationConflictError(
            "The caller key is already bound to a different mutation or metadata payload.",
            { details: { idempotencyKey: request.idempotencyKey } },
          );
        return { outcome: "replayed" as const, evidence: previous };
      }
      const before =
        store.historyEnabled ?
          await readRecordedClock(backend, store.revisionSchema, store.graphId)
        : undefined;
      const measured = await tx.measure(async (scoped) =>
        apply(scoped, structuredClone(request.mutation)),
      );
      const result = structuredClone(measured.result);
      assertJsonValue(result, "result", "Durable Store operation");
      const attempt: Pending = { result, receipt: measured.receipt, before };
      pending = attempt;
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
    return err(operationFailure(error));
  }
}
