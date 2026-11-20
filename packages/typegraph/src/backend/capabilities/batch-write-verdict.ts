/**
 * The one classification of a schema-managed write's fitness for a
 * `"batch"` engine (Cloudflare D1's `batch()`, Neon HTTP's
 * `transaction(queries)`) — a backend whose `capabilities.execution.unitOfWork`
 * is `"batch"` fixes every statement before the first one runs and commits
 * them together with no interactive session in between.
 *
 * A leaf module so both halves of the write path can reach it without a
 * cycle: `store/operations/write-transaction.ts` re-exports it beside
 * `constraintFenceRefusal`, and `store/recorded-capture/guards.ts` (which
 * `write-transaction.ts` itself imports through the `recorded-capture`
 * barrel) imports it directly instead of reaching back through that barrel.
 */
import { type BackendCapabilities } from "../types";

/**
 * What a schema-managed write needs that a closed batch program cannot
 * supply. Each reason names the one thing, of the five kinds this module's
 * callers already refuse, that requires a session instead.
 */
export type BatchWriteRefusalReason =
  | "interactive-callback"
  | "constraint-needs-probe"
  | "identity"
  | "history"
  | "schema-commit";

/**
 * Either an atomic program or a fused statement carries the write
 * (`program`), or it needs something a closed batch cannot supply, named by
 * `reason` with the `explanation` every enforcing gate embeds.
 */
export type BatchWriteVerdict =
  | Readonly<{ kind: "program" }>
  | Readonly<{
      kind: "refused";
      code: "BATCH_WRITE_UNSUPPORTED";
      reason: BatchWriteRefusalReason;
      explanation: string;
    }>;

/**
 * The one canonical explanation per {@link BatchWriteRefusalReason}, so the
 * enforcing gates (the constrained-write probe, `store.transaction`,
 * Operational Identity, recorded-time capture, and a schema commit) describe
 * the same limitation in the same words instead of independently-worded
 * sentences.
 */
const BATCH_WRITE_REFUSAL_EXPLANATIONS: Readonly<
  Record<BatchWriteRefusalReason, string>
> = {
  "interactive-callback":
    "hold an interactive callback transaction open across several round trips",
  "constraint-needs-probe":
    "read a value it wrote earlier in the same write before deciding what to write next",
  identity:
    "read and write Operational Identity's closure across several round trips inside one held transaction",
  history:
    "hold the per-graph write lock and clock open across a whole write cascade",
  "schema-commit":
    "hold one transaction across its compare-and-swap read and its activating write",
};

/**
 * Classifies a schema-managed write's fitness for the backend's declared
 * `unitOfWork`, for a caller that has ALREADY decided — from its own
 * existing predicate (identity enabled, history enabled, a probe-needing
 * constraint, an interactive `store.transaction` call, a schema commit) —
 * that `write.needs` names what this write requires. This function does
 * not re-derive that classification; it only decides whether the backend's
 * declared tier is the reason the need goes unmet, so that a backend which
 * is non-transactional AND has no atomic batch either — a custom
 * `GraphBackend` with neither primitive — keeps its own plain wording
 * (`kind: "program"` here, meaning "not a batch-tier limitation") instead
 * of being misdescribed as a batch-engine limitation it does not have.
 *
 * `needs` is required: a caller with no proven need has nothing to classify
 * and must not call this function at all, rather than pass an absent value
 * through it and silently receive the same "not a batch limitation" answer.
 */
export function resolveBatchWriteVerdict(
  backend: Readonly<{ capabilities: Pick<BackendCapabilities, "execution"> }>,
  write: Readonly<{ needs: BatchWriteRefusalReason }>,
): BatchWriteVerdict {
  if (backend.capabilities.execution.unitOfWork !== "batch") {
    return { kind: "program" };
  }
  return {
    kind: "refused",
    code: "BATCH_WRITE_UNSUPPORTED",
    reason: write.needs,
    explanation: BATCH_WRITE_REFUSAL_EXPLANATIONS[write.needs],
  };
}

/**
 * The one composed sentence fragment every enforcing gate appends to its own
 * base message — empty when `verdict.kind` is `"program"`, so a gate can
 * always write `baseSentence + batchRefusalSuffix(verdict)` with no
 * conditional of its own.
 */
export function batchRefusalSuffix(verdict: BatchWriteVerdict): string {
  return verdict.kind === "refused" ?
      ` Specifically, this needs to ${verdict.explanation}, which a closed batch program cannot do.`
    : "";
}

/**
 * The one `details` fragment every enforcing gate spreads into its error's
 * `details` object, nested under `batchRefusal` so it never collides with a
 * gate's own `code` (`SCHEMA_WRITE_FENCE_UNSUPPORTED`,
 * `CONSTRAINT_WRITE_FENCE_UNSUPPORTED`, `IDENTITY_REQUIRES_ATOMIC_BACKEND`,
 * …) — empty when `verdict.kind` is `"program"`.
 */
export function batchRefusalDetails(
  verdict: BatchWriteVerdict,
): Readonly<Record<string, unknown>> {
  return verdict.kind === "refused" ?
      { batchRefusal: { code: verdict.code, reason: verdict.reason } }
    : {};
}
