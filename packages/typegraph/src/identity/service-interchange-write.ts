import { type GraphDef } from "../core/define-graph";
import {
  ConfigurationError,
  IdentityValidityWindowError,
  NodeNotFoundError,
  ValidationError,
} from "../errors";
import { withRecordedIdentityMutationTarget } from "../store/recorded-capture";
import { nowIso } from "../utils/date";
import { identityAssertionSemanticKey } from "./assertion-key";
import {
  requireLiveEndpoints,
  requireStructuralEndpoints,
} from "./service-components";
import {
  partitionRetractedEndpoints,
  retractByIds,
  runIdentityMutation,
} from "./service-facade";
import {
  assertionForExactWindow,
  createIdentityWindowValidator,
  currentAssertionForPair,
  insertAssertion,
  insertAssertionRows,
  loadAssertionsByIds,
  mergeCurrentClasses,
  replaceAffectedClosure,
  replaceSeparationForReferences,
  requireEndpointsCoverIdentityWindow,
  validateCurrentRelation,
} from "./service-mutation";
import type { Backend } from "./service-read";
import { normalizePair, refKey } from "./service-read";
import {
  type IdentityImportSummary,
  type IdentityServiceContext,
  type IdentityTransferAssertion,
} from "./service-types";
import { type PlainNodeRef } from "./sql-target";
import { type IdentityAssertionStorageRow } from "./storage-types";
import {
  type ResolvedIdentityValidityWindow,
  resolveIdentityValidityWindow,
} from "./validity-window";

/**
 * Every transfer-shape rejection reports the same way: one issue against the
 * `identity.assertions` path, attributed to the offending assertion id.
 */
function transferShapeError(
  assertion: IdentityTransferAssertion,
  message: string,
  issue: Readonly<{ message: string; code: string }>,
): ValidationError {
  return new ValidationError(message, {
    issues: [
      {
        path: "identity.assertions",
        assertionId: assertion.id,
        message: issue.message,
        code: issue.code,
      },
    ],
  });
}

function validateTransferShape<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  assertion: IdentityTransferAssertion,
  mode: "state" | "archival",
  operationInstant: string,
): Readonly<{
  endpoints: readonly [PlainNodeRef, PlainNodeRef];
  window: ResolvedIdentityValidityWindow;
}> {
  if (
    !ctx.registry.nodeKinds.has(assertion.a.kind) ||
    !ctx.registry.nodeKinds.has(assertion.b.kind)
  ) {
    throw transferShapeError(
      assertion,
      "Identity import references an unknown node kind.",
      {
        message: `Unknown identity endpoint kind in assertion ${assertion.id}`,
        code: "IDENTITY_IMPORT_UNKNOWN_KIND",
      },
    );
  }
  if (refKey(assertion.a) === refKey(assertion.b)) {
    throw transferShapeError(
      assertion,
      `Identity ${assertion.relation} assertions require two distinct node references.`,
      {
        message: `Assertion ${assertion.id} relates a node to itself`,
        code: "IDENTITY_SELF_ASSERTION",
      },
    );
  }
  const normalized = normalizePair(assertion.a, assertion.b);
  if (
    refKey(normalized[0]) !== refKey(assertion.a) ||
    refKey(normalized[1]) !== refKey(assertion.b)
  ) {
    throw transferShapeError(
      assertion,
      "Identity import pairs must be normalized.",
      {
        message: `Assertion ${assertion.id} endpoints are not in code-point order`,
        code: "IDENTITY_IMPORT_PAIR_NOT_NORMALIZED",
      },
    );
  }
  if (mode === "state" && assertion.validTo !== undefined) {
    throw transferShapeError(
      assertion,
      "State identity import cannot contain ended assertions.",
      {
        message: `Assertion ${assertion.id} is ended`,
        code: "IDENTITY_STATE_IMPORT_ENDED_ASSERTION",
      },
    );
  }
  let window: ResolvedIdentityValidityWindow;
  try {
    window = resolveIdentityValidityWindow(
      {
        validFrom: assertion.validFrom,
        ...(assertion.validTo === undefined ?
          {}
        : { validTo: assertion.validTo }),
      },
      operationInstant,
    );
  } catch (error) {
    if (!(error instanceof IdentityValidityWindowError)) throw error;
    const issue =
      error.details.reason === "future-valid-from" ?
        {
          code: "IDENTITY_IMPORT_FUTURE_VALID_FROM",
          message: `Assertion ${assertion.id} validFrom is in the future`,
        }
      : error.details.reason === "future-valid-to" ?
        {
          code: "IDENTITY_IMPORT_FUTURE_VALID_TO",
          message: `Assertion ${assertion.id} validTo is in the future`,
        }
      : {
          code: "IDENTITY_IMPORT_INVALID_WINDOW",
          message: `Assertion ${assertion.id} validTo must not precede validFrom`,
        };
    throw transferShapeError(
      assertion,
      "Identity import contains an unsupported validity window.",
      issue,
    );
  }
  // A cascade cause is only meaningful on an ENDED row, and only ever names
  // that row's own endpoint — the cascade ends assertions BECAUSE they touch
  // the deleted node. The relation carries the same rule as a CHECK; rejecting
  // it here turns an opaque constraint violation into an attributed one.
  if (assertion.endedBy !== undefined) {
    if (assertion.validTo === undefined) {
      throw transferShapeError(
        assertion,
        "Identity import cannot name an ending cause on an open assertion.",
        {
          message: `Assertion ${assertion.id} carries endedBy without validTo`,
          code: "IDENTITY_IMPORT_ENDED_BY_WITHOUT_END",
        },
      );
    }
    const endedByKey = refKey(assertion.endedBy);
    if (
      endedByKey !== refKey(assertion.a) &&
      endedByKey !== refKey(assertion.b)
    ) {
      throw transferShapeError(
        assertion,
        "Identity import ending cause must name one of the assertion's endpoints.",
        {
          message: `Assertion ${assertion.id} endedBy is not an endpoint of the assertion`,
          code: "IDENTITY_IMPORT_ENDED_BY_NOT_ENDPOINT",
        },
      );
    }
  }
  return { endpoints: normalized, window };
}

/**
 * Attribution tag the import coordinator attaches to an error it rethrows:
 * the id of the assertion it was APPLYING when the failure surfaced. Interchange
 * error reporting reads it so an `IdentityContradictionError` or
 * `NodeNotFoundError` is attributed to the failing assertion, not to whichever
 * earlier assertion happens to touch the same endpoints. A non-enumerable
 * symbol so the original error class, message, and details stay byte-identical
 * for direct callers.
 */
export const IDENTITY_IMPORT_FAILED_ASSERTION: unique symbol = Symbol(
  "typegraph.identity.failedAssertionId",
);

/** Committed import work recorded on an attributed import failure. */
export const IDENTITY_IMPORT_PROGRESS: unique symbol = Symbol(
  "typegraph.identity.importProgress",
);

function rethrowTaggedWithAssertion(
  error: unknown,
  assertionId: string,
  progress: IdentityImportSummary,
): never {
  if (typeof error === "object" && error !== null) {
    Object.defineProperty(error, IDENTITY_IMPORT_FAILED_ASSERTION, {
      value: assertionId,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(error, IDENTITY_IMPORT_PROGRESS, {
      value: progress,
      enumerable: false,
      configurable: true,
    });
  }
  throw error;
}

function reconcileReplacementWindows(
  assertions: readonly IdentityTransferAssertion[],
  retractions: Iterable<IdentityAssertionStorageRow>,
): readonly IdentityTransferAssertion[] {
  const retractionEndByReplacement = new Map<string, string>();
  for (const retraction of retractions) {
    if (retraction.valid_to === undefined) continue;
    const replacementRelation =
      retraction.rel === "same" ? "different" : "same";
    const key = identityAssertionSemanticKey(
      replacementRelation,
      { kind: retraction.a_kind, id: retraction.a_id },
      { kind: retraction.b_kind, id: retraction.b_id },
    );
    const existingEnd = retractionEndByReplacement.get(key);
    if (existingEnd === undefined || existingEnd < retraction.valid_to) {
      retractionEndByReplacement.set(key, retraction.valid_to);
    }
  }
  return assertions.map((assertion) => {
    if (assertion.validTo !== undefined) return assertion;
    const retractionEnd = retractionEndByReplacement.get(
      identityAssertionSemanticKey(
        assertion.relation,
        assertion.a,
        assertion.b,
      ),
    );
    if (retractionEnd === undefined || assertion.validFrom >= retractionEnd) {
      return assertion;
    }
    // A merge replacement is current truth from the instant its opposing
    // target assertion is retracted. Keeping the branch's earlier start
    // would manufacture a historical overlap that neither side resolved.
    return { ...assertion, validFrom: retractionEnd };
  });
}

/**
 * Applies interchange identity rows inside the caller-owned write transaction.
 * The caller owns import conflict policy and acquires the graph identity lock;
 * this coordinator owns integrity, persistence, capture, and closure repair.
 */
export async function importIdentityAssertionsIntoTarget<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  target: Backend,
  assertions: readonly IdentityTransferAssertion[],
  mode: "state" | "archival",
  ignoredAssertionIds: ReadonlySet<string> = new Set(),
): Promise<IdentityImportSummary> {
  let created = 0;
  let skipped = 0;
  await withRecordedIdentityMutationTarget(target, async (rawTarget, touch) => {
    const operationInstant = nowIso();
    // Pre-pass: validate every shape in input order and normalize endpoints,
    // then batch the two reads the loop would otherwise issue per item — the
    // existing-row-by-id lookup and the current-endpoint liveness check.
    const normalized = assertions.map((assertion) => ({
      assertion,
      ...validateTransferShape(ctx, assertion, mode, operationInstant),
    }));
    const existingById = await loadAssertionsByIds(
      rawTarget,
      ctx.schema,
      ctx.graphId,
      assertions.map((assertion) => assertion.id),
    );
    const currentEndpoints: PlainNodeRef[] = [];
    const endedEndpoints: PlainNodeRef[] = [];
    for (const { assertion, endpoints } of normalized) {
      const [a, b] = endpoints;
      if (assertion.validTo === undefined) {
        currentEndpoints.push(a, b);
      } else {
        endedEndpoints.push(a, b);
      }
    }
    const attributeMissingEndpoint = (
      error: unknown,
      ended: boolean,
    ): never => {
      // The batch checks lose per-assertion context; the first assertion of
      // the checked kind touching the missing ref is the failing candidate.
      if (error instanceof NodeNotFoundError) {
        const missing = { kind: error.details.kind, id: error.details.id };
        const failing = normalized.find(
          ({ assertion, endpoints }) =>
            (assertion.validTo !== undefined) === ended &&
            endpoints.some(
              (endpoint) =>
                endpoint.kind === missing.kind && endpoint.id === missing.id,
            ),
        );
        if (failing !== undefined) {
          rethrowTaggedWithAssertion(error, failing.assertion.id, {
            created,
            skipped,
          });
        }
      }
      throw error;
    };
    try {
      await requireLiveEndpoints(
        rawTarget,
        ctx.schema,
        ctx.graphId,
        currentEndpoints,
      );
    } catch (error) {
      attributeMissingEndpoint(error, false);
    }
    try {
      await requireStructuralEndpoints(
        rawTarget,
        ctx.schema,
        ctx.graphId,
        endedEndpoints,
      );
    } catch (error) {
      attributeMissingEndpoint(error, true);
    }
    const windowValidator = await createIdentityWindowValidator(
      ctx,
      rawTarget,
      normalized.map(({ endpoints, window }) => ({
        references: endpoints,
        window,
      })),
      operationInstant,
      ignoredAssertionIds,
    );

    for (const { assertion, endpoints, window } of normalized) {
      const [a, b] = endpoints;
      try {
        const sameId = existingById.get(assertion.id);
        if (sameId !== undefined) {
          const exact =
            sameId.rel === assertion.relation &&
            sameId.a_kind === a.kind &&
            sameId.a_id === a.id &&
            sameId.b_kind === b.kind &&
            sameId.b_id === b.id &&
            sameId.valid_from === assertion.validFrom &&
            sameId.valid_to === assertion.validTo &&
            sameId.ended_by_kind === assertion.endedBy?.kind &&
            sameId.ended_by_id === assertion.endedBy?.id;
          if (exact) {
            skipped += 1;
            continue;
          }
          throw new ConfigurationError(
            `Identity assertion id ${assertion.id} already identifies different truth.`,
            {
              code: "IDENTITY_IMPORT_ID_CONFLICT",
              graphId: ctx.graphId,
              assertionId: assertion.id,
            },
          );
        }

        const exactWindow = await assertionForExactWindow(
          rawTarget,
          ctx.schema,
          ctx.graphId,
          assertion.relation,
          a,
          b,
          window,
        );
        if (exactWindow !== undefined) {
          skipped += 1;
          continue;
        }
        if (window.effective === "current") {
          const current = await currentAssertionForPair(
            rawTarget,
            ctx.schema,
            ctx.graphId,
            assertion.relation,
            a,
            b,
          );
          if (current !== undefined) {
            skipped += 1;
            continue;
          }
          await requireEndpointsCoverIdentityWindow(
            rawTarget,
            ctx.graphId,
            [a, b],
            window,
          );
          windowValidator.validate(assertion.relation, "import", a, b, window);
          // The temporal check owns historical correctness. The current check
          // also exercises the materialized separation backstop/readiness guard
          // before this row changes current derived state.
          await validateCurrentRelation(
            ctx,
            rawTarget,
            assertion.relation,
            "import",
            a,
            b,
          );
          const inserted = await insertAssertion(
            rawTarget,
            ctx.schema,
            ctx.graphId,
            assertion.relation,
            a,
            b,
            operationInstant,
            touch,
            { id: assertion.id, validFrom: window.validFrom },
          );
          existingById.set(inserted.id, inserted);
          windowValidator.record(inserted);
          created += 1;
          if (assertion.relation === "same") {
            await mergeCurrentClasses(rawTarget, ctx.schema, ctx.graphId, a, b);
          } else {
            await replaceSeparationForReferences(
              rawTarget,
              ctx.schema,
              ctx.graphId,
              [a, b],
            );
          }
          continue;
        }

        await requireEndpointsCoverIdentityWindow(
          rawTarget,
          ctx.graphId,
          [a, b],
          window,
        );
        windowValidator.validate(assertion.relation, "import", a, b, window);

        const timestamp = window.validFrom;
        const row: IdentityAssertionStorageRow = {
          graph_id: ctx.graphId,
          id: assertion.id,
          rel: assertion.relation,
          a_kind: a.kind,
          a_id: a.id,
          b_kind: b.kind,
          b_id: b.id,
          valid_from: window.validFrom,
          valid_to: window.validTo,
          created_at: timestamp,
          updated_at: window.validTo ?? window.validFrom,
          deleted_at: undefined,
          ended_by_kind: assertion.endedBy?.kind,
          ended_by_id: assertion.endedBy?.id,
        };
        await insertAssertionRows(rawTarget, ctx.schema, [row]);
        touch(ctx.graphId, row.id, row);
        existingById.set(row.id, row);
        windowValidator.record(row);
        created += 1;
      } catch (error) {
        rethrowTaggedWithAssertion(error, assertion.id, { created, skipped });
      }
    }
  });
  return { created, skipped };
}

export async function applyIdentityChangesForContext<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  retractionIds: readonly string[],
  assertions: readonly IdentityTransferAssertion[],
): Promise<Readonly<{ created: number; retracted: number }>> {
  if (retractionIds.length === 0 && assertions.length === 0) {
    return { created: 0, retracted: 0 };
  }
  return runIdentityMutation(ctx, async (target, touch, markWritten) => {
    const retracted = await retractByIds(ctx, target, retractionIds, touch);
    const { closureReferences, separationReferences } =
      partitionRetractedEndpoints(retracted);
    // Repair the closure from the retractions BEFORE importing: a batch that
    // retracts same(a,b) and then asserts different(a,b) must validate the new
    // assertion against a closure that already reflects the split, not the
    // stale merged class the import validation would otherwise reject against.
    if (closureReferences.length > 0) {
      await replaceAffectedClosure(
        target,
        ctx.schema,
        ctx.graphId,
        closureReferences,
        ctx.sameIdAcrossKinds,
      );
    }
    await replaceSeparationForReferences(
      target,
      ctx.schema,
      ctx.graphId,
      separationReferences,
    );
    const retractionRows = await loadAssertionsByIds(
      target,
      ctx.schema,
      ctx.graphId,
      retractionIds,
    );
    const reconciledAssertions = reconcileReplacementWindows(
      assertions,
      retractionRows.values(),
    );
    const summary = await importIdentityAssertionsIntoTarget(
      ctx,
      target,
      reconciledAssertions,
      "archival",
      new Set(retracted.map((assertion) => assertion.id)),
    );
    // The import records capture touches through its OWN recorded binding, so
    // the mutation's wrapped touch never fires for created rows — an
    // identity-only merge would otherwise leave the durable revision clock
    // unmoved and every base@V token stale.
    if (summary.created > 0) markWritten();
    // ACTUAL ledger effects, not planned intents: rows the import created
    // (idempotent exact/pair matches excluded) and rows the retraction ended
    // (already-ended or unknown ids excluded).
    return { created: summary.created, retracted: retracted.length };
  });
}
