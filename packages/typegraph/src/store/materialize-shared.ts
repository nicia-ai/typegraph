/**
 * Shared building blocks for the materialize-* verbs (`materializeIndexes`
 * and `materializeRemovals`) and `Store.removeKinds`. Each verb owns a
 * per-deployment status table (`typegraph_index_materializations`,
 * `typegraph_kind_removals`) and bootstraps it lazily; this module
 * centralizes the bootstrap dispatch + parallel orchestration shape so
 * the runners stay thin.
 */
import { type GraphBackend } from "../backend/types";

/**
 * Idempotently ensure a per-verb status table exists, preferring the
 * focused `ensure*Table` primitive when available and falling back to
 * the full `bootstrapTables` for legacy backends.
 *
 * Why focused: `bootstrapTables` issues 20+ `CREATE TABLE / CREATE
 * INDEX IF NOT EXISTS` statements covering every base table. Two
 * concurrent callers (e.g. two replicas of the same `schema_doc` both
 * starting up) deadlock on Postgres SHARE locks. Restricting the
 * ensure-step to a single table eliminates the cross-table race —
 * concurrent `CREATE TABLE IF NOT EXISTS` for one specific table is
 * well-behaved on Postgres.
 */
export async function ensureFocusedStatusTable(
  backend: GraphBackend,
  ensureFocused: (() => Promise<void>) | undefined,
): Promise<void> {
  if (ensureFocused !== undefined) {
    await ensureFocused();
    return;
  }
  await backend.bootstrapTables?.();
}

/**
 * Best-effort vs strict orchestration for materialization runners.
 * `stopOnError === true` runs sequentially and short-circuits on the
 * first `failed` entry (mirrors typical schema-migration safety
 * semantics); the default best-effort path runs `runOne` over `items`
 * concurrently. Custom orchestrators (e.g. `materializeIndexes`'s
 * per-relation bucketing) bypass this helper and assemble their own
 * Promise topology.
 */
export async function runMaterialization<
  TInput,
  TEntry extends { status: string },
>(
  items: readonly TInput[],
  options: Readonly<{ stopOnError?: boolean }>,
  runOne: (item: TInput) => Promise<TEntry>,
): Promise<readonly TEntry[]> {
  if (options.stopOnError === true) {
    const results: TEntry[] = [];
    for (const item of items) {
      const entry = await runOne(item);
      results.push(entry);
      if (entry.status === "failed") break;
    }
    return results;
  }
  return Promise.all(items.map((item) => runOne(item)));
}
