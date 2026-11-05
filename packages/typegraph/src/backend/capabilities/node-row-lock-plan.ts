/**
 * How a backend takes the node-row lock pairing that keeps a live edge from
 * naming a deleted endpoint (see `NodeRowLock`), decided from its
 * resolved {@link WriteFencePlan} — never from its dialect.
 *
 * `resolveNodeRowLockPlan` is the one owner of that decision. The operation
 * backend consumes it for every endpoint-guarded statement, every node-delete
 * lock, and `lockNodes`; the store's own skip for serializing engines reads
 * {@link serializesWriters}, which this plan agrees with by construction.
 */
import { compareCodePoints } from "../../utils/compare";
import {
  type FenceStatements,
  serializesWriters,
  type WriteFencePlan,
} from "./write-fence";

/**
 * - `"row-lock"`: the engine's own row locks, spelled by the dialect
 *   (PostgreSQL `FOR KEY SHARE` for `"edgeEndpoint"`, `FOR UPDATE` for
 *   `"delete"`), inside the statement that reads the rows.
 * - `"fence-row"`: one keyed fence row per node, acquired through `sql` as its
 *   own statement before the rows are read, in the same transaction. A fence
 *   row excludes every other acquirer of the same node, so endpoint locks on
 *   one node exclude each other too; that is the price of an engine with no
 *   row locks. Under `conflict: "commit-time"` the second acquirer's COMMIT
 *   fails instead of waiting, which the unit owner retries.
 * - `"none"`: writers already run one at a time; nothing is taken.
 */
export type NodeRowLockPlan =
  | Readonly<{ kind: "row-lock" }>
  | Readonly<{ kind: "fence-row"; sql: FenceStatements }>
  | Readonly<{ kind: "none" }>;

/**
 * The node-row lock plan a resolved write fence implies.
 *
 * Engine row locks ride the `lock` plan, as the schema-commit fence's
 * `FOR UPDATE`/`FOR SHARE` pair does: an engine that honors the advisory lock
 * honors row locks. A `row` plan is declared by an engine that has neither,
 * so it takes fence rows. An undeclared (`unfenced`) backend keeps the
 * dialect's row locks: an engine that cannot run them fails the statement
 * rather than skipping the lock.
 */
export function resolveNodeRowLockPlan(plan: WriteFencePlan): NodeRowLockPlan {
  if (serializesWriters(plan)) return { kind: "none" };
  if (plan.kind === "row") return { kind: "fence-row", sql: plan.sql };
  return { kind: "row-lock" };
}

/** The fence-row namespace node-row locks acquire under. */
export const NODE_ROW_FENCE_NAMESPACE = "typegraph:node-row";

/** One node whose row a node-row lock covers. */
export type NodeRowLockTarget = Readonly<{ kind: string; id: string }>;

/**
 * The fence-row acquisitions that lock `nodes`, deduplicated and in (kind, id)
 * code-point order — the order every node-row lock statement takes its rows
 * in, so concurrent acquirers of overlapping sets cannot each hold one row
 * while waiting on the other. Both `NodeRowLock` purposes take the same row:
 * a fence row has no shared mode.
 */
export function nodeRowFenceAcquisitions(
  sql: FenceStatements,
  graphId: string,
  nodes: readonly NodeRowLockTarget[],
): readonly ReturnType<FenceStatements["acquireKeyed"]>[] {
  const keys = new Map<string, NodeRowLockTarget>();
  for (const node of nodes) {
    keys.set(JSON.stringify([graphId, node.kind, node.id]), node);
  }
  return [...keys]
    .toSorted(
      ([, left], [, right]) =>
        compareCodePoints(left.kind, right.kind) ||
        compareCodePoints(left.id, right.id),
    )
    .map(([key]) => sql.acquireKeyed(NODE_ROW_FENCE_NAMESPACE, key));
}
