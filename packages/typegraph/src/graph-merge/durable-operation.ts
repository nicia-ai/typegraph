/**
 * Durable-branch operations: a generic, backend-neutral facility for a durable
 * host to combine an opaque graph mutation with immutable operation evidence in
 * ONE host transaction.
 *
 * The facility is deliberately the same shape as the optional host-native merge
 * command ({@link import("./durable-merge").applyDurableMergePlan}): TypeGraph
 * owns descriptor validation, sealed-origin attestation, request
 * canonicalization, and evidence validation; the host owns the database
 * mechanics. A strategy that cannot combine the mutation and its evidence in a
 * single atomic unit returns `unsupported` BEFORE touching the host, and
 * TypeGraph refuses rather than emulating atomicity with callbacks or best
 * effort.
 *
 * WHAT IS OPAQUE. Both `metadata` and `mutation` are JSON-safe host values.
 * TypeGraph never interprets their application fields; it canonicalizes them to
 * derive {@link DurableBranchOperation.operationDigest} and otherwise carries
 * them through untouched. `metadata` is retained as evidence; `mutation` is the
 * host's own description of the graph change it must apply (for example a
 * serialized statement or a host-defined command) atomically with the evidence
 * row.
 *
 * IDEMPOTENCY. The digest is derived from the complete request content
 * (`mutation` plus `metadata`) with the repository's canonical JSON serializer.
 * The strategy is handed the digest and MUST treat `(idempotencyKey)` as the
 * unique key: identical key AND digest returns the previously committed
 * evidence without re-applying; identical key with a different digest fails
 * with {@link DurableOperationConflictError} and mutates nothing.
 *
 * DELIVERY AND DESTRUCTION. Evidence is delivered explicitly via
 * {@link markDurableOperationDelivered}. Archive/destroy is fenced on
 * undelivered evidence: a strategy MUST refuse destruction while undelivered
 * evidence remains, and the refusal is preserved through
 * {@link import("./durable-branch").destroyDurableBranch} as a
 * {@link DurableEvidenceUndeliveredError}. Concurrent `operate` and `destroy`
 * are serialized by the host's own transaction: either the operation commits
 * first (destroy observes undelivered evidence and refuses) or destroy commits
 * first (the operation fails against the removed allocation). No partial state
 * is ever observable.
 *
 * CURSORS. {@link scanDurableOperations} returns evidence in a stable total
 * order the strategy defines (commit order, ties broken deterministically).
 * `cursor` is an opaque continuation token; pass it back as `after` to resume.
 * A missing `cursor` means the scan reached the end.
 */

import { assertJsonValue } from "../core/json-value";
import { canonicalValueKey } from "./canonical-props";
import type {
  DurableBranchDescriptor,
  DurableBranchOrigin,
  DurableStoreDescriptor,
  DurableWorkingCopyStrategy,
} from "./durable-branch";
import {
  durableDescriptorRefusal,
  durableOriginOfDescriptor,
} from "./durable-branch";
import {
  describeCause,
  DurableOperationError,
  DurableOperationEvidenceError,
  DurableOperationRequestError,
  DurableOperationUnsupportedError,
} from "./errors";
import type { Result } from "./result";
import { err, isErr, ok } from "./result";
import type { EngineRevision, GraphDef, JsonValue } from "./typegraph-internal";
import { sha256Hex } from "./typegraph-internal";
import type { BaseVersion } from "./types";

/** Default page size for {@link scanDurableOperations}. */
export const DURABLE_OPERATION_SCAN_DEFAULT_LIMIT = 100;

/** Largest page a single {@link scanDurableOperations} call may request. */
export const DURABLE_OPERATION_SCAN_MAX_LIMIT = 1000;

/** Bytes of the SHA-256 operation digest (128 bits). */
const OPERATION_DIGEST_BYTE_LENGTH = 16;

/**
 * The dimensions whose absence a strategy reports through the `unsupported`
 * outcome. Each names a guarantee TypeGraph will not fake.
 */
export type DurableOperationUnsupportedDimension =
  "atomicMutation" | "evidenceStore" | "host";

/**
 * The caller's operation request. `idempotencyKey` identifies the operation;
 * `mutation` is the host's opaque, JSON-safe description of the graph change;
 * `metadata` is opaque, JSON-safe host evidence TypeGraph never interprets.
 */
export type DurableBranchOperationRequest = Readonly<{
  idempotencyKey: string;
  metadata: JsonValue;
  mutation: JsonValue;
}>;

/**
 * The canonical operation handed to the strategy: the request plus the
 * TypeGraph-derived digest the strategy must use for idempotency.
 */
export type DurableBranchOperation = Readonly<{
  idempotencyKey: string;
  operationDigest: string;
  metadata: JsonValue;
  mutation: JsonValue;
}>;

/**
 * A branch's content coordinates at one point. `base` is the
 * merge-visible base-version fingerprint (as produced by
 * `computeBaseVersion`); `revision` is the engine revision when the working
 * copy resolves lineage.
 */
export type DurableBranchCoordinates = Readonly<{
  base: BaseVersion;
  revision?: EngineRevision | undefined;
}>;

/**
 * Immutable evidence of one committed operation. `delivered` is the only
 * mutating dimension, and it moves in one direction (`false` → `true`) under
 * {@link DurableOperationCapability.markDelivered}. A newly `applied`
 * operation must return `false`; an exact `replayed` operation returns its
 * current committed delivery state.
 */
export type DurableBranchOperationEvidence = Readonly<{
  idempotencyKey: string;
  operationDigest: string;
  metadata: JsonValue;
  mutation: JsonValue;
  before: DurableBranchCoordinates;
  after: DurableBranchCoordinates;
  delivered: boolean;
}>;

/** One stable-order page of evidence returned by {@link scanDurableOperations}. */
export type DurableOperationScan = Readonly<{
  operations: readonly DurableBranchOperationEvidence[];
  /** Opaque continuation token; absent when the scan reached the end. */
  cursor?: string | undefined;
}>;

/** Outcome of an atomic operation attempt. */
export type DurableOperationOutcome =
  | Readonly<{
      outcome: "applied" | "replayed";
      evidence: DurableBranchOperationEvidence;
    }>
  | Readonly<{
      outcome: "unsupported";
      dimensions: readonly [
        DurableOperationUnsupportedDimension,
        ...DurableOperationUnsupportedDimension[],
      ];
    }>;

/**
 * The optional host capability behind `DurableWorkingCopyStrategy.operations`.
 *
 * Every member receives the opaque locator AND the caller's expected origin, so
 * the host attests the sealed origin exactly as it does for reopen, destroy,
 * and native merge. TypeGraph validates the descriptor before any member is
 * called.
 */
export type DurableOperationCapability<
  TStoreDescriptor extends DurableStoreDescriptor = DurableStoreDescriptor,
> = Readonly<{
  /**
   * Atomically applies `request.mutation` and records evidence, or returns
   * `unsupported` having executed no host SQL or mutation.
   *
   * The host MUST:
   *   1. attest `expectedOrigin` against the allocation `descriptor` names;
   *   2. return the previously committed evidence unchanged when
   *      `(idempotencyKey, operationDigest)` matches a committed operation,
   *      applying nothing;
   *   3. refuse with {@link DurableOperationConflictError} when the key exists
   *      with a different digest, applying nothing; and
   *   4. otherwise apply the mutation and undelivered evidence in ONE
   *      transaction, returning `outcome: "applied"` with `delivered: false`.
   */
  operate: (
    args: Readonly<{
      descriptor: TStoreDescriptor;
      expectedOrigin: DurableBranchOrigin;
      request: DurableBranchOperation;
    }>,
  ) => Promise<DurableOperationOutcome>;
  /** Reads one operation's evidence, or `undefined` when never committed. */
  get: (
    args: Readonly<{
      descriptor: TStoreDescriptor;
      expectedOrigin: DurableBranchOrigin;
      idempotencyKey: string;
    }>,
  ) => Promise<DurableBranchOperationEvidence | undefined>;
  /**
   * Reads evidence in the strategy's stable total order. `after` resumes from
   * a previous page's `cursor`; `limit` bounds the page.
   */
  scan: (
    args: Readonly<{
      descriptor: TStoreDescriptor;
      expectedOrigin: DurableBranchOrigin;
      after?: string | undefined;
      limit: number;
    }>,
  ) => Promise<DurableOperationScan>;
  /**
   * Marks one operation delivered. MUST be idempotent: marking an
   * already-delivered operation returns the same evidence and writes nothing.
   * Returns `undefined` when the operation does not exist.
   */
  markDelivered: (
    args: Readonly<{
      descriptor: TStoreDescriptor;
      expectedOrigin: DurableBranchOrigin;
      idempotencyKey: string;
    }>,
  ) => Promise<DurableBranchOperationEvidence | undefined>;
  /** Whether any committed evidence is still undelivered. */
  hasUndelivered: (
    args: Readonly<{
      descriptor: TStoreDescriptor;
      expectedOrigin: DurableBranchOrigin;
    }>,
  ) => Promise<boolean>;
}>;

/**
 * Derives the operation digest from its canonical content. The digest covers
 * the complete request except the idempotency key, so reusing a key with a
 * different mutation OR different metadata conflicts.
 */
export async function computeDurableOperationDigest(
  request: DurableBranchOperationRequest,
): Promise<string> {
  const canonical = canonicalValueKey({
    metadata: request.metadata,
    mutation: request.mutation,
  });
  return sha256Hex(canonical, OPERATION_DIGEST_BYTE_LENGTH);
}

/** The capability fields the public orchestrators require. */
type OperationStrategy<TStoreDescriptor extends DurableStoreDescriptor> =
  Readonly<{
    type: string;
    version: number;
    operations?: DurableOperationCapability<TStoreDescriptor> | undefined;
  }>;

function requireDescriptorOwner<
  TStoreDescriptor extends DurableStoreDescriptor,
>(
  descriptor: DurableBranchDescriptor<TStoreDescriptor>,
  strategy: OperationStrategy<TStoreDescriptor>,
):
  | Readonly<{ ok: true; origin: DurableBranchOrigin }>
  | Readonly<{ ok: false; error: DurableOperationRequestError }> {
  const refusal = durableDescriptorRefusal(descriptor, strategy);
  if (refusal !== undefined) {
    return {
      ok: false,
      error: new DurableOperationRequestError(
        "Durable operation descriptor validation failed.",
        { cause: refusal },
      ),
    };
  }
  return { ok: true, origin: durableOriginOfDescriptor(descriptor) };
}

/** Validates JSON safety and shape of a caller-supplied operation request. */
async function normalizeOperationRequest(
  request: DurableBranchOperationRequest,
): Promise<Result<DurableBranchOperation, DurableOperationRequestError>> {
  const rawRequest: unknown = request;
  if (
    typeof rawRequest !== "object" ||
    rawRequest === null ||
    Array.isArray(rawRequest)
  ) {
    return err(
      new DurableOperationRequestError(
        "Durable operation request must be a JSON object.",
      ),
    );
  }
  if (
    typeof request.idempotencyKey !== "string" ||
    request.idempotencyKey.length === 0
  ) {
    return err(
      new DurableOperationRequestError(
        "Durable operation request is malformed: idempotencyKey must be a non-empty string.",
        { details: { idempotencyKey: request.idempotencyKey } },
      ),
    );
  }
  try {
    assertJsonValue(request.metadata, "metadata", "Durable operation");
    assertJsonValue(request.mutation, "mutation", "Durable operation");
  } catch (error) {
    return err(
      new DurableOperationRequestError(
        `Durable operation request is not JSON-safe: ${describeCause(error)}`,
        { cause: error, details: { idempotencyKey: request.idempotencyKey } },
      ),
    );
  }
  return ok({
    idempotencyKey: request.idempotencyKey,
    metadata: request.metadata,
    mutation: request.mutation,
    operationDigest: await computeDurableOperationDigest(request),
  });
}

/**
 * Validates that evidence returned by a host is structurally sound and
 * consistent with the operation that produced it. A host cannot forge a
 * different digest, echo a different request, or return non-JSON metadata.
 */
async function normalizeStoredEvidence(
  evidence: unknown,
  expectedIdempotencyKey?: string,
): Promise<
  Result<DurableBranchOperationEvidence, DurableOperationEvidenceError>
> {
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    Array.isArray(evidence)
  ) {
    return err(
      new DurableOperationEvidenceError(
        "Durable operation evidence must be a JSON object.",
        { details: { idempotencyKey: expectedIdempotencyKey } },
      ),
    );
  }
  const record = evidence as Readonly<Record<string, unknown>>;
  if (
    typeof record["idempotencyKey"] !== "string" ||
    record["idempotencyKey"].length === 0
  ) {
    return err(
      new DurableOperationEvidenceError(
        "Durable operation evidence needs a non-empty idempotency key.",
        { details: { expectedKey: expectedIdempotencyKey } },
      ),
    );
  }
  if (
    expectedIdempotencyKey !== undefined &&
    record["idempotencyKey"] !== expectedIdempotencyKey
  ) {
    return err(
      new DurableOperationEvidenceError(
        "Durable operation evidence does not carry the requested idempotency key.",
        {
          details: {
            expectedKey: expectedIdempotencyKey,
            receivedKey: record["idempotencyKey"],
          },
        },
      ),
    );
  }
  if (
    typeof record["operationDigest"] !== "string" ||
    record["operationDigest"].length === 0
  ) {
    return err(
      new DurableOperationEvidenceError(
        "Durable operation evidence needs a non-empty operation digest.",
        { details: { idempotencyKey: record["idempotencyKey"] } },
      ),
    );
  }
  try {
    assertJsonValue(
      record["metadata"],
      "metadata",
      "Durable operation evidence",
    );
    assertJsonValue(
      record["mutation"],
      "mutation",
      "Durable operation evidence",
    );
  } catch (error) {
    return err(
      new DurableOperationEvidenceError(
        `Durable operation evidence content is not JSON-safe: ${describeCause(error)}`,
        { cause: error, details: { idempotencyKey: record["idempotencyKey"] } },
      ),
    );
  }
  const refusal =
    validateCoordinates(record["before"], record, "before") ??
    validateCoordinates(record["after"], record, "after") ??
    (typeof record["delivered"] === "boolean" ?
      undefined
    : new DurableOperationEvidenceError(
        "Durable operation evidence is missing its delivered flag.",
        { details: { idempotencyKey: record["idempotencyKey"] } },
      ));
  if (refusal !== undefined) return err(refusal);
  const normalized = evidence as DurableBranchOperationEvidence;
  const canonicalDigest = await computeDurableOperationDigest(normalized);
  if (normalized.operationDigest !== canonicalDigest) {
    return err(
      new DurableOperationEvidenceError(
        "Durable operation evidence digest disagrees with its canonical content.",
        {
          details: {
            idempotencyKey: normalized.idempotencyKey,
            expectedDigest: canonicalDigest,
            receivedDigest: normalized.operationDigest,
          },
        },
      ),
    );
  }
  return ok(normalized);
}

async function validateEvidenceForOperation(
  evidence: unknown,
  expected: DurableBranchOperation,
): Promise<
  Result<DurableBranchOperationEvidence, DurableOperationEvidenceError>
> {
  const normalized = await normalizeStoredEvidence(
    evidence,
    expected.idempotencyKey,
  );
  if (isErr(normalized)) return normalized;
  if (normalized.data.operationDigest !== expected.operationDigest) {
    return err(
      new DurableOperationEvidenceError(
        "Durable operation evidence digest disagrees with the canonical request digest.",
        {
          details: {
            idempotencyKey: expected.idempotencyKey,
            expectedDigest: expected.operationDigest,
            receivedDigest: normalized.data.operationDigest,
          },
        },
      ),
    );
  }
  if (
    canonicalValueKey(normalized.data.metadata) !==
      canonicalValueKey(expected.metadata) ||
    canonicalValueKey(normalized.data.mutation) !==
      canonicalValueKey(expected.mutation)
  ) {
    return err(
      new DurableOperationEvidenceError(
        "Durable operation evidence does not echo the canonical request content.",
        { details: { idempotencyKey: expected.idempotencyKey } },
      ),
    );
  }
  return normalized;
}

const DURABLE_OPERATION_UNSUPPORTED_DIMENSIONS =
  new Set<DurableOperationUnsupportedDimension>([
    "atomicMutation",
    "evidenceStore",
    "host",
  ]);

function isDurableOperationUnsupportedDimension(
  value: unknown,
): value is DurableOperationUnsupportedDimension {
  return (
    typeof value === "string" &&
    DURABLE_OPERATION_UNSUPPORTED_DIMENSIONS.has(
      value as DurableOperationUnsupportedDimension,
    )
  );
}

/** Validates the complete result envelope returned by a host operation. */
async function normalizeOperationOutcome(
  outcome: unknown,
  expected: DurableBranchOperation,
): Promise<Result<DurableOperationOutcome, DurableOperationEvidenceError>> {
  if (
    typeof outcome !== "object" ||
    outcome === null ||
    Array.isArray(outcome)
  ) {
    return err(
      new DurableOperationEvidenceError(
        "Durable operation host returned a malformed outcome envelope.",
        { details: { idempotencyKey: expected.idempotencyKey } },
      ),
    );
  }

  const record = outcome as Readonly<Record<string, unknown>>;
  const outcomeKind = record["outcome"];
  if (outcomeKind === "unsupported") {
    const dimensions = record["dimensions"];
    const normalizedDimensions =
      Array.isArray(dimensions) ?
        dimensions.filter((dimension) =>
          isDurableOperationUnsupportedDimension(dimension),
        )
      : [];
    const [firstDimension, ...remainingDimensions] = normalizedDimensions;
    if (
      !Array.isArray(dimensions) ||
      firstDimension === undefined ||
      normalizedDimensions.length !== dimensions.length ||
      new Set(normalizedDimensions).size !== normalizedDimensions.length
    ) {
      return err(
        new DurableOperationEvidenceError(
          "Durable operation host returned malformed unsupported dimensions.",
          { details: { idempotencyKey: expected.idempotencyKey } },
        ),
      );
    }
    return ok({
      outcome: "unsupported",
      dimensions: [firstDimension, ...remainingDimensions],
    });
  }

  if (outcomeKind !== "applied" && outcomeKind !== "replayed") {
    return err(
      new DurableOperationEvidenceError(
        "Durable operation host returned an unknown outcome.",
        {
          details: {
            idempotencyKey: expected.idempotencyKey,
            outcome: outcomeKind,
          },
        },
      ),
    );
  }

  const evidence = await validateEvidenceForOperation(
    record["evidence"],
    expected,
  );
  if (isErr(evidence)) return evidence;
  if (outcomeKind === "applied" && evidence.data.delivered) {
    return err(
      new DurableOperationEvidenceError(
        "Newly applied durable operation evidence must be undelivered.",
        { details: { idempotencyKey: expected.idempotencyKey } },
      ),
    );
  }
  return ok({ outcome: outcomeKind, evidence: evidence.data });
}

function validateCoordinates(
  coordinates: unknown,
  evidence: Readonly<Record<string, unknown>>,
  side: "before" | "after",
): DurableOperationEvidenceError | undefined {
  const idempotencyKey = evidence["idempotencyKey"];
  if (
    typeof coordinates !== "object" ||
    coordinates === null ||
    Array.isArray(coordinates)
  ) {
    return new DurableOperationEvidenceError(
      `Durable operation evidence ${side} coordinates are malformed.`,
      { details: { idempotencyKey, side } },
    );
  }
  const record = coordinates as Readonly<Record<string, unknown>>;
  if (typeof record["base"] !== "string" || record["base"].length === 0) {
    return new DurableOperationEvidenceError(
      `Durable operation evidence ${side} coordinates need a non-empty base.`,
      { details: { idempotencyKey, side } },
    );
  }
  if (
    record["revision"] !== undefined &&
    (typeof record["revision"] !== "string" || record["revision"].length === 0)
  ) {
    return new DurableOperationEvidenceError(
      `Durable operation evidence ${side} coordinates revision must be a non-empty string.`,
      { details: { idempotencyKey, side } },
    );
  }
  return undefined;
}

function unsupportedError(
  member: string,
  strategyType: string,
): DurableOperationUnsupportedError {
  return new DurableOperationUnsupportedError(
    `Durable strategy "${strategyType}" does not provide the "${member}" operation capability.`,
    {
      details: { strategyType, member },
      suggestion:
        "Use a strategy whose `operations` capability provides atomic mutation-plus-evidence and evidence access; TypeGraph never emulates the atomic guarantee.",
    },
  );
}

/**
 * Atomically applies an opaque graph mutation and commits its evidence through
 * the strategy's optional `operations.operate` capability.
 *
 * Descriptor format/type/version validation and the sealed-origin attestation
 * are exactly those of reopen, destroy, and native merge: TypeGraph validates
 * the envelope and hands the caller's expected origin to the host, which
 * attests it inside its own transaction. A strategy without the capability
 * yields the `unsupported` outcome with no host call.
 */
export async function operateDurableBranch<
  G extends GraphDef,
  TStoreDescriptor extends DurableStoreDescriptor = DurableStoreDescriptor,
>(
  descriptor: DurableBranchDescriptor<TStoreDescriptor>,
  strategy: DurableWorkingCopyStrategy<G, TStoreDescriptor>,
  request: DurableBranchOperationRequest,
): Promise<Result<DurableOperationOutcome, DurableOperationError>> {
  const owner = requireDescriptorOwner(descriptor, strategy);
  if (!owner.ok) return err(owner.error);
  const normalized = await normalizeOperationRequest(request);
  if (isErr(normalized)) return normalized;

  if (strategy.operations === undefined) {
    return ok({
      outcome: "unsupported",
      dimensions: ["atomicMutation"],
    });
  }

  try {
    const outcome: unknown = await strategy.operations.operate({
      descriptor: descriptor.store,
      expectedOrigin: owner.origin,
      request: normalized.data,
    });
    return await normalizeOperationOutcome(outcome, normalized.data);
  } catch (error) {
    return err(
      error instanceof DurableOperationError ? error : (
        new DurableOperationError(
          `Durable operation failed: ${describeCause(error)}`,
          {
            cause: error,
            details: { idempotencyKey: request.idempotencyKey },
          },
        )
      ),
    );
  }
}

/**
 * Reads one operation's evidence. Returns `undefined` when the operation was
 * never committed. A strategy without evidence access is an explicit typed
 * refusal.
 */
export async function getDurableOperation<
  G extends GraphDef,
  TStoreDescriptor extends DurableStoreDescriptor = DurableStoreDescriptor,
>(
  descriptor: DurableBranchDescriptor<TStoreDescriptor>,
  strategy: DurableWorkingCopyStrategy<G, TStoreDescriptor>,
  idempotencyKey: string,
): Promise<
  Result<DurableBranchOperationEvidence | undefined, DurableOperationError>
> {
  const owner = requireDescriptorOwner(descriptor, strategy);
  if (!owner.ok) return err(owner.error);
  if (strategy.operations === undefined) {
    return err(unsupportedError("get", strategy.type));
  }
  try {
    const evidence = await strategy.operations.get({
      descriptor: descriptor.store,
      expectedOrigin: owner.origin,
      idempotencyKey,
    });
    if (evidence === undefined) return ok(undefined);
    return await normalizeStoredEvidence(evidence, idempotencyKey);
  } catch (error) {
    return err(
      error instanceof DurableOperationError ? error : (
        new DurableOperationError(
          `Failed to read durable operation "${idempotencyKey}": ${describeCause(error)}`,
          { cause: error, details: { idempotencyKey } },
        )
      ),
    );
  }
}

/**
 * Reads evidence in a stable order. `after` resumes from a previous page's
 * `cursor`; `limit` defaults to {@link DURABLE_OPERATION_SCAN_DEFAULT_LIMIT}
 * and may not exceed {@link DURABLE_OPERATION_SCAN_MAX_LIMIT}. The returned
 * `cursor` is absent at the end of the scan.
 */
export async function scanDurableOperations<
  G extends GraphDef,
  TStoreDescriptor extends DurableStoreDescriptor = DurableStoreDescriptor,
>(
  descriptor: DurableBranchDescriptor<TStoreDescriptor>,
  strategy: DurableWorkingCopyStrategy<G, TStoreDescriptor>,
  options: Readonly<{
    after?: string | undefined;
    limit?: number | undefined;
  }> = {},
): Promise<Result<DurableOperationScan, DurableOperationError>> {
  const owner = requireDescriptorOwner(descriptor, strategy);
  if (!owner.ok) return err(owner.error);
  const limit = options.limit ?? DURABLE_OPERATION_SCAN_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    return err(
      new DurableOperationRequestError(
        "Durable operation scan limit must be a positive integer.",
        { details: { limit } },
      ),
    );
  }
  if (limit > DURABLE_OPERATION_SCAN_MAX_LIMIT) {
    return err(
      new DurableOperationRequestError(
        `Durable operation scan limit ${limit} exceeds the maximum of ${DURABLE_OPERATION_SCAN_MAX_LIMIT}.`,
        {
          details: { limit, max: DURABLE_OPERATION_SCAN_MAX_LIMIT },
          suggestion: `Request at most ${DURABLE_OPERATION_SCAN_MAX_LIMIT} operations per page and page with the returned cursor.`,
        },
      ),
    );
  }
  if (strategy.operations === undefined) {
    return err(unsupportedError("scan", strategy.type));
  }
  try {
    const rawPage: unknown = await strategy.operations.scan({
      descriptor: descriptor.store,
      expectedOrigin: owner.origin,
      after: options.after,
      limit,
    });
    if (
      typeof rawPage !== "object" ||
      rawPage === null ||
      Array.isArray(rawPage)
    ) {
      return err(
        new DurableOperationEvidenceError(
          "Durable operation scan returned a malformed page.",
          { details: { limit } },
        ),
      );
    }
    const page = rawPage as Readonly<Record<string, unknown>>;
    const rawOperations = page["operations"];
    const cursor = page["cursor"];
    if (
      !Array.isArray(rawOperations) ||
      rawOperations.length > limit ||
      (cursor !== undefined &&
        (typeof cursor !== "string" || cursor.length === 0))
    ) {
      return err(
        new DurableOperationEvidenceError(
          "Durable operation scan returned a malformed page.",
          { details: { limit } },
        ),
      );
    }
    const operations: DurableBranchOperationEvidence[] = [];
    for (const evidence of rawOperations) {
      const normalized = await normalizeStoredEvidence(evidence);
      if (isErr(normalized)) return normalized;
      operations.push(normalized.data);
    }
    return ok(
      cursor === undefined ? { operations } : { operations, cursor: cursor },
    );
  } catch (error) {
    return err(
      error instanceof DurableOperationError ? error : (
        new DurableOperationError(
          `Failed to scan durable operations: ${describeCause(error)}`,
          { cause: error, details: { limit } },
        )
      ),
    );
  }
}

/**
 * Marks one operation delivered, idempotently. Marking an already-delivered
 * operation returns the same evidence without writing. Returns `undefined` when
 * the operation does not exist.
 */
export async function markDurableOperationDelivered<
  G extends GraphDef,
  TStoreDescriptor extends DurableStoreDescriptor = DurableStoreDescriptor,
>(
  descriptor: DurableBranchDescriptor<TStoreDescriptor>,
  strategy: DurableWorkingCopyStrategy<G, TStoreDescriptor>,
  idempotencyKey: string,
): Promise<
  Result<DurableBranchOperationEvidence | undefined, DurableOperationError>
> {
  const owner = requireDescriptorOwner(descriptor, strategy);
  if (!owner.ok) return err(owner.error);
  if (strategy.operations === undefined) {
    return err(unsupportedError("markDelivered", strategy.type));
  }
  try {
    const evidence = await strategy.operations.markDelivered({
      descriptor: descriptor.store,
      expectedOrigin: owner.origin,
      idempotencyKey,
    });
    if (evidence === undefined) return ok(undefined);
    const normalized = await normalizeStoredEvidence(evidence, idempotencyKey);
    if (isErr(normalized)) return normalized;
    if (!normalized.data.delivered) {
      return err(
        new DurableOperationEvidenceError(
          "Durable operation delivery marking returned undelivered evidence.",
          { details: { idempotencyKey } },
        ),
      );
    }
    return normalized;
  } catch (error) {
    return err(
      error instanceof DurableOperationError ? error : (
        new DurableOperationError(
          `Failed to mark durable operation "${idempotencyKey}" delivered: ${describeCause(error)}`,
          { cause: error, details: { idempotencyKey } },
        )
      ),
    );
  }
}

/**
 * Reports whether any committed evidence is still undelivered. Archive/destroy
 * must fence on this; the strategy enforces the fence atomically, this is the
 * queryable half.
 */
export async function durableBranchHasUndeliveredEvidence<
  G extends GraphDef,
  TStoreDescriptor extends DurableStoreDescriptor = DurableStoreDescriptor,
>(
  descriptor: DurableBranchDescriptor<TStoreDescriptor>,
  strategy: DurableWorkingCopyStrategy<G, TStoreDescriptor>,
): Promise<Result<boolean, DurableOperationError>> {
  const owner = requireDescriptorOwner(descriptor, strategy);
  if (!owner.ok) return err(owner.error);
  if (strategy.operations === undefined) {
    return err(unsupportedError("hasUndelivered", strategy.type));
  }
  try {
    const hasUndelivered: unknown = await strategy.operations.hasUndelivered({
      descriptor: descriptor.store,
      expectedOrigin: owner.origin,
    });
    return typeof hasUndelivered === "boolean" ?
        ok(hasUndelivered)
      : err(
          new DurableOperationEvidenceError(
            "Durable operation undelivered query returned a non-boolean value.",
          ),
        );
  } catch (error) {
    return err(
      error instanceof DurableOperationError ? error : (
        new DurableOperationError(
          `Failed to query undelivered durable evidence: ${describeCause(error)}`,
          { cause: error },
        )
      ),
    );
  }
}
