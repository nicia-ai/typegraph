/**
 * The repair beside the uniqueness claim audit: re-keys stale and missing
 * claims in the claim relation, and touches nothing else.
 *
 * It writes only uniqueness claim rows, through the backend's own claim
 * members (`releaseUniquesByOwner`, `insertUnique`, `deleteUnique`). No node
 * row, edge, history row, validity window or revision is written, which is
 * what separates it from the repairs a store write can perform (an update off
 * and back, a delete and revival), each of which rewrites the holder.
 *
 * A constraint that carries a duplicate (two live holders of one value) is
 * left exactly as it is: choosing which holder keeps the value is the
 * operator's decision, and re-keying the other claims of that constraint
 * first would only move the refusal onto whichever write touches it next.
 *
 * Concurrency. The applying run is one write transaction that takes the
 * graph's write fence, row-locks every holder it re-keys (`lockNodes`, the
 * lock a node delete takes), and then audits again: a holder a concurrent
 * write changed between the first audit and its lock makes the two audits
 * differ, and the run is refused with nothing written. Each claim it takes is
 * fenced by the claim relation's primary key, as a create's is, so a
 * concurrent create of the same value either is refused by the repaired claim
 * or, when it claimed the key first, refuses the repair with
 * `UniquenessError`, which rolls the whole run back.
 */
import { type GraphBackend } from "../../backend/types";
import { ConfigurationError } from "../../errors";
import { compareStrings } from "../../utils/compare";
import { claimOwnerKey } from "./axis";
import {
  planUniquenessClaimRepair,
  type UniquenessClaimAuditContext,
  type UniquenessClaimFinding,
  uniquenessClaimFindings,
  type UniquenessClaimPlan,
  type UniquenessClaimWork,
  type UniquenessValueDuplicate,
} from "./uniqueness-claim-audit";
import { compareConstraintFenceViolations } from "./verify";

/** Options for `store.repairUniquenessClaims()`. */
export type UniquenessClaimRepairOptions = Readonly<{
  /**
   * `true` (the default) plans and writes nothing; `false` applies the plan.
   */
  dryRun?: boolean;
}>;

/** What `store.repairUniquenessClaims()` found and did. */
export type UniquenessClaimRepairResult = Readonly<{
  dryRun: boolean;
  /**
   * The stale and missing claims re-keyed by this run, or, on a dry run, the
   * ones an applying run would re-key.
   */
  repaired: readonly UniquenessClaimFinding[];
  /**
   * Every value two or more live nodes store under one constraint. Resolve
   * each (for example by hard-deleting one of the holders) and run again.
   */
  duplicates: readonly UniquenessValueDuplicate[];
  /**
   * The stale and missing claims of a constraint that carries a duplicate,
   * left as they are.
   */
  blocked: readonly UniquenessClaimFinding[];
}>;

/** The members an applying run writes and locks through. */
type RepairTarget = UniquenessClaimAuditContext["backend"] &
  Pick<
    GraphBackend,
    "lockNodes" | "releaseUniquesByOwner" | "insertUnique" | "deleteUnique"
  >;

function sortedFindings(
  findings: readonly UniquenessClaimFinding[],
): readonly UniquenessClaimFinding[] {
  return findings.toSorted((left, right) =>
    compareConstraintFenceViolations(left, right),
  );
}

/** The plan split into what runs and what a duplicate blocks. */
function splitPlan(plan: UniquenessClaimPlan): Readonly<{
  runnable: readonly UniquenessClaimWork[];
  blocked: readonly UniquenessClaimWork[];
}> {
  const blockedGroups = new Set(
    plan.duplicates.map((duplicate) => duplicate.group),
  );
  return {
    runnable: plan.work.filter((item) => !blockedGroups.has(item.group)),
    blocked: plan.work.filter((item) => blockedGroups.has(item.group)),
  };
}

function resultOf(
  graphId: string,
  plan: UniquenessClaimPlan,
  dryRun: boolean,
): UniquenessClaimRepairResult {
  const { runnable, blocked } = splitPlan(plan);
  return {
    dryRun,
    repaired: sortedFindings(
      runnable.flatMap((item) => uniquenessClaimFindings(graphId, item)),
    ),
    duplicates: plan.duplicates
      .map((duplicate): UniquenessValueDuplicate => ({
        family: duplicate.family,
        target: duplicate.target,
        owners: duplicate.owners,
      }))
      .toSorted((left, right) => compareConstraintFenceViolations(left, right)),
    blocked: sortedFindings(
      blocked.flatMap((item) => uniquenessClaimFindings(graphId, item)),
    ),
  };
}

/** Plans and writes nothing. */
export async function planUniquenessClaimRepairResult(
  ctx: UniquenessClaimAuditContext,
): Promise<UniquenessClaimRepairResult> {
  return resultOf(ctx.graphId, await planUniquenessClaimRepair(ctx), true);
}

/** Locks every holder row the runnable work re-keys, kind by kind, in id order. */
async function lockHolders(
  target: RepairTarget,
  graphId: string,
  work: readonly UniquenessClaimWork[],
): Promise<void> {
  const idsByKind = new Map<string, Set<string>>();
  for (const item of work) {
    if (item.holder === "absent") continue;
    const ids = idsByKind.get(item.owner.concreteKind) ?? new Set<string>();
    ids.add(item.owner.nodeId);
    idsByKind.set(item.owner.concreteKind, ids);
  }
  const kinds = [...idsByKind.keys()].toSorted((left, right) =>
    compareStrings(left, right),
  );
  for (const kind of kinds) {
    const ids = [...(idsByKind.get(kind) ?? [])].toSorted((left, right) =>
      compareStrings(left, right),
    );
    await target.lockNodes(graphId, kind, ids, "delete");
  }
}

/** Applies the runnable work: every release first, then every claim. */
async function applyWork(
  target: RepairTarget,
  graphId: string,
  work: readonly UniquenessClaimWork[],
): Promise<void> {
  const releasesByOwner = new Map<string, UniquenessClaimWork[]>();
  for (const item of work) {
    if (item.stale.length === 0) continue;
    const ownerKey = claimOwnerKey(item.owner);
    releasesByOwner.set(ownerKey, [
      ...(releasesByOwner.get(ownerKey) ?? []),
      item,
    ]);
  }
  // Releases first: a stale claim of one owner can sit on the key another
  // owner is owed.
  for (const items of releasesByOwner.values()) {
    const owner = items[0]?.owner;
    if (owner === undefined) continue;
    await target.releaseUniquesByOwner({
      graphId,
      concreteKind: owner.concreteKind,
      nodeId: owner.nodeId,
      constraintNames: items.map((item) => item.constraintName),
      keep: items.flatMap((item) =>
        item.holder === "live" && item.derivedKey !== undefined ?
          [{ constraintName: item.constraintName, key: item.derivedKey }]
        : [],
      ),
    });
  }
  for (const item of work) {
    if (item.missing === undefined || item.derivedKey === undefined) continue;
    const claim = {
      graphId,
      nodeKind: item.axis,
      constraintName: item.constraintName,
      key: item.derivedKey,
      nodeId: item.owner.nodeId,
      concreteKind: item.owner.concreteKind,
    };
    await target.insertUnique(claim);
    if (item.missing === "released") await target.deleteUnique(claim);
  }
}

/**
 * Audits, locks the holders the plan re-keys, audits again, and applies the
 * plan when the two audits agree. Runs on the write transaction's target.
 *
 * @throws ConfigurationError `UNIQUENESS_CLAIM_REPAIR_CONCURRENT_WRITE` when
 *   a write changed the audited state while the run took its locks.
 * @throws UniquenessError when a concurrent write holds a key the run claims.
 */
export async function applyUniquenessClaimRepair(
  ctx: UniquenessClaimAuditContext & Readonly<{ backend: RepairTarget }>,
): Promise<UniquenessClaimRepairResult> {
  const first = await planUniquenessClaimRepair(ctx);
  await lockHolders(ctx.backend, ctx.graphId, splitPlan(first).runnable);
  const second = await planUniquenessClaimRepair(ctx);
  const planned = resultOf(ctx.graphId, first, false);
  const locked = resultOf(ctx.graphId, second, false);
  if (JSON.stringify(planned) !== JSON.stringify(locked)) {
    throw new ConfigurationError(
      "The uniqueness claim repair was refused: a concurrent write changed " +
        "a holder or a claim it audited before it could lock them. Nothing " +
        "was written.",
      {
        code: "UNIQUENESS_CLAIM_REPAIR_CONCURRENT_WRITE",
        graphId: ctx.graphId,
      },
      {
        suggestion:
          "Run store.repairUniquenessClaims({ dryRun: false }) again, " +
          "ideally with writers to this graph stopped.",
      },
    );
  }
  await applyWork(ctx.backend, ctx.graphId, splitPlan(second).runnable);
  return locked;
}
