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
 * Bucketed orchestration for index-materialization runners.
 *
 * `stopOnError === true` runs sequentially in input order and
 * short-circuits after the first `failed` entry (returning the partial
 * results). Otherwise items are grouped by `bucketKey` and the groups run
 * concurrently with each group sequential — the shape Postgres requires
 * for `CREATE INDEX CONCURRENTLY` (one in-flight build per relation).
 * Results always come back in input order regardless of how the buckets
 * resolved.
 */
export async function runBucketedMaterialization<
  TItem,
  TEntry extends { status: string },
>(
  items: readonly TItem[],
  options: Readonly<{ stopOnError?: boolean }>,
  bucketKey: (item: TItem) => string,
  runOne: (item: TItem) => Promise<TEntry>,
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

  const buckets = new Map<string, [number, TItem][]>();
  for (const [index, item] of items.entries()) {
    const key = bucketKey(item);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [[index, item]]);
    else bucket.push([index, item]);
  }

  const results: TEntry[] = Array.from({ length: items.length });
  await Promise.all(
    [...buckets.values()].map(async (group) => {
      for (const [index, item] of group) {
        results[index] = await runOne(item);
      }
    }),
  );
  return results;
}

/**
 * Best-effort vs strict orchestration for materialization runners.
 * `stopOnError === true` runs sequentially and short-circuits on the
 * first `failed` entry (mirrors typical schema-migration safety
 * semantics); the default best-effort path runs `runOne` over `items`
 * concurrently. Custom orchestrators bypass this helper and assemble
 * their own Promise topology.
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
