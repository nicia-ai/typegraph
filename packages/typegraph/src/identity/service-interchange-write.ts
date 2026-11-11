import { type GraphDef } from "../core/define-graph";
import {
  ConfigurationError,
  IdentityValidityWindowError,
  NodeNotFoundError,
  ValidationError,
} from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import {
  withRecordedIdentityDecision,
  withRecordedIdentityMutationTarget,
} from "../store/recorded-capture";
import { nowIso } from "../utils/date";
import { toTransferAssertion } from "./row-codec";
import {
  requireLiveEndpoints,
  requireStructuralEndpoints,
} from "./service-components";
import {
  applyRetractionAftermath,
  retractPlannedAssertions,
  runIdentityMutation,
} from "./service-facade";
import {
  applyPairRelationEffect,
  assertionForExactWindow,
  createIdentityWindowValidator,
  currentAssertionForPair,
  insertAssertion,
  insertAssertionRows,
  loadAssertionsByIds,
  readIdentityWindowLedger,
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
import { type IdentityTarget, type PlainNodeRef } from "./sql-target";
import { type IdentityAssertionStorageRow } from "./storage-types";
import {
  advanceIdentityTransitionCut,
  encodeIdentityTransitionRow,
  type IdentityDecisionProvenance,
  type IdentityTransitionCut,
  type IdentityTransitionTransfer,
  insertIdentityTransitionValues,
} from "./transition-log";
import {
  type ResolvedIdentityValidityWindow,
  resolveIdentityValidityWindow,
} from "./validity-window";

/**
 * What importing a ledger of assertions reads off the service context: the
 * graph it writes for, the registry it validates kinds against, the SQL schema
 * its statements are built from, and the folding mode.
 *
 * A SLICE, not the whole context, because the target these statements run
 * against is passed separately — and the caller that passes it may hold only a
 * write frame's read projection, which cannot supply the context's backend (the
 * transaction opener). The same idiom `validateCurrentRelation` already uses.
 */
type IdentityAssertionImportContext = Pick<
  IdentityServiceContext<GraphDef>,
  "graphId" | "registry" | "schema" | "sameIdAcrossKinds"
>;

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

function validateTransferShape(
  ctx: IdentityAssertionImportContext,
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

/**
 * The target's live assertion rows — current and ended — that this importer's
 * window validator would read for applying `assertions` as a merge does
 * (`"archival"`), as transfer rows: the history a merge plan's contradiction
 * simulation must judge its claims against. Each assertion is validated and
 * its window resolved exactly as {@link importIdentityAssertionsIntoTarget}
 * does, so a claim the importer would refuse for its shape is refused here
 * with the same typed error, and the rows come from the same
 * `readIdentityWindowLedger` read.
 */
export async function loadIdentityWindowHistory(
  ctx: IdentityAssertionImportContext,
  target: Backend,
  assertions: readonly IdentityTransferAssertion[],
  operationInstant: string,
): Promise<readonly IdentityTransferAssertion[]> {
  const ledger = await readIdentityWindowLedger(
    ctx,
    target,
    assertions.map((assertion) => {
      const { endpoints, window } = validateTransferShape(
        ctx,
        assertion,
        "archival",
        operationInstant,
      );
      return { references: endpoints, window };
    }),
    operationInstant,
  );
  return ledger.assertions
    .filter((row) => row.deleted_at === undefined)
    .map((row) => toTransferAssertion(row));
}

/**
 * Applies interchange identity rows inside the caller-owned write transaction.
 * The caller owns import conflict policy and acquires the graph identity lock;
 * this coordinator owns integrity, persistence, capture, and closure repair.
 */
export async function importIdentityAssertionsIntoTarget(
  ctx: IdentityAssertionImportContext,
  target: Backend,
  assertions: readonly IdentityTransferAssertion[],
  mode: "state" | "archival",
  ignoredAssertionIds: ReadonlySet<string> = new Set(),
  // `"assert"` for a plain interchange import (union, matching what
  // `mergeCurrentClasses` always does): the caller that instead applies a
  // reviewed merge decision (`applyIdentityChangesForContext`) states
  // `"reconcile"` explicitly — the cause is never inferred from context here.
  cause: "assert" | "reconcile" = "assert",
): Promise<IdentityImportSummary> {
  let created = 0;
  let skipped = 0;
  await withRecordedIdentityMutationTarget(
    target,
    async (rawTarget, touch, noteTransition) => {
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
            windowValidator.validate(
              assertion.relation,
              "import",
              a,
              b,
              window,
            );
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
            await applyPairRelationEffect(
              ctx,
              rawTarget,
              assertion.relation,
              a,
              b,
              noteTransition,
              {
                cause,
                assertions: [inserted],
                validAt: operationInstant,
              },
            );
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
    },
  );
  return { created, skipped };
}

/** What `importIdentityTransitionsIntoTarget` reads off the service context. */
type IdentityTransitionImportContext = Readonly<{
  graphId: string;
  schema: SqlSchema;
}>;

function transitionShapeError(message: string, code: string): ValidationError {
  return new ValidationError(message, {
    issues: [{ path: "identity.transitions", message, code }],
  });
}

/**
 * Whether an import restores retained identity explanation: transition rows,
 * or the watermark of a source that pruned. A zero watermark records that
 * nothing was pruned, which restores nothing. THE one decision every import
 * site takes on it — the up-front refusal on a target that keeps no
 * transition log, a stream's check that its header announced the restore,
 * and the restore itself — so no site restores what another refused, or
 * refuses what another would skip.
 */
export function isIdentityTransitionRestore(
  hasTransitions: boolean,
  prunedBeforeRevision: number | undefined,
): boolean {
  return hasTransitions || (prunedBeforeRevision ?? 0) > 0;
}

/**
 * Checks one restore's archival transitions for the two properties a
 * well-formed section has before any of it is written, and remembers what it
 * has seen so a streamed restore whose rows arrive over several chunks is
 * held to them across chunk boundaries, exactly as a single document is:
 *
 * - non-decreasing `recordedRevision` order
 *   (`IDENTITY_IMPORT_TRANSITIONS_NOT_MONOTONE`), the order every export
 *   writes;
 * - a `transitionId` that names one row only
 *   (`IDENTITY_IMPORT_TRANSITIONS_DUPLICATE_ID`). The source graph's log
 *   keys rows by it, so two rows under one id in one section never came from
 *   an export, and restoring them would keep whichever the insert met first
 *   and drop the other without a trace.
 *
 * Returns the check for one restore; call it with every part of the section
 * in order.
 */
export function createIdentityTransitionShapeCheck(): (
  transitions: readonly Readonly<{
    transitionId: string;
    recordedRevision: number;
  }>[],
) => void {
  let previousRevision = Number.NEGATIVE_INFINITY;
  // Owned by this one restore and never handed out, so it is safe to grow in
  // place rather than copy per chunk.
  const seenIds = new Set<string>();
  return (transitions) => {
    for (const row of transitions) {
      if (row.recordedRevision < previousRevision) {
        throw transitionShapeError(
          `Archival identity transitions must be ordered by non-decreasing recorded revision; ${row.transitionId} carries ${String(row.recordedRevision)} after ${String(previousRevision)}.`,
          "IDENTITY_IMPORT_TRANSITIONS_NOT_MONOTONE",
        );
      }
      if (seenIds.has(row.transitionId)) {
        throw transitionShapeError(
          `Archival identity transitions must name each transitionId once; ${row.transitionId} appears more than once.`,
          "IDENTITY_IMPORT_TRANSITIONS_DUPLICATE_ID",
        );
      }
      seenIds.add(row.transitionId);
      previousRevision = row.recordedRevision;
    }
  };
}

/**
 * Restores archival transition-log rows verbatim — no closure repair, no
 * re-derived membership, no renumbering onto the destination graph's live
 * revision sequence, because a restore records history, it does not relive
 * it (see "Archival transitions and the retention watermark" in the identity
 * documentation). Its rows arrive already validated for SHAPE only, before
 * the import's first write: the interchange schema enforces a known cause and
 * a well-formed `{kind, id}` ref, and {@link createIdentityTransitionShapeCheck}
 * a non-decreasing `recordedRevision` and unique ids across the whole restore.
 *
 * Every inserted row is marked `restored_at` (the restore's own wall time),
 * regardless of what the wire payload carried — see
 * `encodeIdentityTransitionRow`'s docblock. That marker, not a revision
 * comparison, is what keeps `identityReplay` from ever pairing one of these
 * rows with a fabricated before/after: a restored row's `recordedRevision`
 * is minted by the SOURCE graph's own clock and interleaves arbitrarily with
 * this graph's, so no floor on this graph's axis could separate "restored"
 * from "native" by number alone.
 *
 * `carriedCut` is the archive's retention: rows below it had already been
 * pruned (on the source, or on a graph the source restored them from) when
 * the archive was taken. It is a fact about the restored rows, on the raw
 * revisions they keep, so it advances the destination's RESTORED cut and
 * never its own watermark: this graph's own history below any revision is
 * untouched by a restore, and claiming otherwise would report a gap in the
 * destination's own timeline that does not exist while hiding the one that
 * does. The write goes through the same monotonic
 * `advanceIdentityTransitionCut` a prune uses, so a later restore can only
 * raise the restored cut, never lower it.
 */
export async function importIdentityTransitionsIntoTarget(
  ctx: IdentityTransitionImportContext,
  target: IdentityTarget,
  transitions: readonly IdentityTransitionTransfer[],
  carriedCut: IdentityTransitionCut | undefined,
): Promise<Readonly<{ created: number }>> {
  // Raw identity statements run through the capture-approved handle
  // `withRecordedIdentityMutationTarget` resolves — under `history: true` the
  // target this function was HANDED refuses `executeStatement` outright (raw
  // SQL bypasses recorded-time capture), exactly as every other identity
  // relation writer already goes through this seam. Neither `touch` nor
  // `noteTransition` is used: a restore inserts historical rows verbatim, it
  // does not touch live entities or note a NEW transition.
  return withRecordedIdentityMutationTarget(target, async (rawTarget) => {
    const restoredAt = nowIso();
    if (transitions.length > 0) {
      const values = transitions.map((row) =>
        encodeIdentityTransitionRow(
          {
            graphId: ctx.graphId,
            cause: row.cause,
            classRef: row.class,
            priorClassRef: row.priorClass,
            assertionIds: row.assertionIds,
            decision: row.decision,
            validAt: row.validAt,
          },
          row.recordedRevision,
          row.recordedAt,
          row.transitionId,
          restoredAt,
        ),
      );
      await insertIdentityTransitionValues(rawTarget, ctx.schema, values);
    }
    if (carriedCut !== undefined && carriedCut.revision > 0) {
      await advanceIdentityTransitionCut(
        rawTarget,
        ctx.schema,
        ctx.graphId,
        "restored-pruned",
        carriedCut,
        "transition-restore",
      );
    }
    return { created: transitions.length };
  });
}

export async function applyIdentityChangesForContext<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  retractions: readonly IdentityTransferAssertion[],
  assertions: readonly IdentityTransferAssertion[],
  // The governing merge decision, when this apply runs under a reviewed
  // graph-merge plan. `undefined` for an ordinary interchange apply with no
  // decision to attach — every note this call takes then carries
  // `decision: undefined`, matching an unreviewed API write.
  decision?: IdentityDecisionProvenance,
): Promise<Readonly<{ created: number; retracted: number }>> {
  if (retractions.length === 0 && assertions.length === 0) {
    return { created: 0, retracted: 0 };
  }
  return runIdentityMutation(
    ctx,
    async (target, touch, markWritten, noteTransition) => {
      // A `reconcile` cause always carries a decision.
      // Without a governing decision this is an ordinary interchange apply, and its closure repair / import carry the cause
      // that already describes them elsewhere (`retract` for the split a
      // batch of retractions can cause, `assert` for the union an import
      // performs) — never a hardcoded `reconcile` that would misrepresent an
      // undecided write as governed.
      const closureRepairCause =
        decision === undefined ? "retract" : "reconcile";
      const importCause = decision === undefined ? "assert" : "reconcile";
      const applyBody = async (): Promise<
        Readonly<{ created: number; retracted: number }>
      > => {
        const operationInstant = nowIso();
        const retracted = await retractPlannedAssertions(
          ctx,
          target,
          retractions,
          touch,
        );
        // Repair the closure from the retractions BEFORE importing: a batch that
        // retracts same(a,b) and then asserts different(a,b) must validate the new
        // assertion against a closure that already reflects the split, not the
        // stale merged class the import validation would otherwise reject against.
        await applyRetractionAftermath(ctx, target, retracted, noteTransition, {
          cause: closureRepairCause,
          validAt: operationInstant,
        });
        const summary = await importIdentityAssertionsIntoTarget(
          ctx,
          target,
          assertions,
          "archival",
          new Set(retracted.map((assertion) => assertion.id)),
          importCause,
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
      };
      if (decision === undefined) return applyBody();
      return withRecordedIdentityDecision(target, decision, applyBody);
    },
  );
}
