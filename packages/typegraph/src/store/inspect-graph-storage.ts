/**
 * The public per-graph storage inventory: how many rows one store's graph holds
 * in every relation that can hold them.
 */
import {
  countGraphStorage,
  type GraphStorageInspection,
  type GraphStorageRelationTarget,
  inventoryRelationTargets,
} from "../backend/graph-storage";
import type { GraphBackend } from "../backend/types";
import type { GraphDef } from "../core/define-graph";
import { resolveGraphVectorSlots } from "../core/embedding";
import { storeBackend } from "./runtime-port";
import type { Store } from "./store";

const INSPECT_GRAPH_STORAGE_OPERATION = "inspectGraphStorage";

/**
 * The per-`(kind, field)` embedding tables the active vector strategy keeps for
 * this graph's declared vector slots. Empty on a backend with no vector
 * strategy, where embeddings live only in node properties.
 */
function vectorRelationTargets<G extends GraphDef>(
  backend: GraphBackend,
  graph: G,
): readonly GraphStorageRelationTarget[] {
  const strategy = backend.vectorStrategy;
  if (strategy === undefined) return [];
  return resolveGraphVectorSlots(graph).flatMap((slot) =>
    strategy.ownedTables(slot).map((contribution) => ({
      relation: contribution.logicalName,
      table: contribution.tableName,
    })),
  );
}

/**
 * Counts the rows `store`'s graph holds in every graph-scoped relation, plus
 * the graph's per-field vector tables, so an operator can verify that
 * `store.clear()` left nothing behind without reading TypeGraph's physical
 * layout. A relation whose table the database never provisioned counts as `0`.
 *
 * Relations are reported under their logical key with the physical table they
 * resolved to. Two relations can legitimately hold a row after `clear()`:
 * graph-local `contributionMaterializations` markers, which a clear keeps unless
 * `preserveContributionMaterializations: false` is passed, and `recordedClock`
 * on a store with live (non-history) revision tracking, which reseeds its clock
 * inside the clear transaction. Every other relation reads `0`.
 *
 * Read-only, and reports whether its counts share one snapshot in
 * `consistency`. It asks for one read-only `repeatable read` transaction and
 * then observes the isolation level the counting session actually ran under,
 * rather than trusting the request:
 *
 * - `"snapshot"`: every count came from one snapshot. That holds for a SQLite
 *   transaction, for a PostgreSQL session observed at `repeatable read` or
 *   `serializable`, and trivially when fewer than two count statements ran.
 * - `"per-statement"`: each relation was counted by its own statement, so a
 *   write between two counts can leave `relations` and `totalRows` describing a
 *   state that never existed. This is the result on a backend without
 *   interactive transactions (Cloudflare D1, `neon-http`), on a session
 *   observed at `read committed` (for example when a wrapper drops the isolation
 *   option under a `read committed` default; under a `repeatable read` default
 *   the observed level still yields `"snapshot"`), and on a backend that
 *   declares no session isolation read. Read such counts as a lower-fidelity
 *   diagnostic: quiesce writers first, or read twice and compare.
 *
 * The evidence proves the isolation of the session that ran the first count. A
 * backend wrapper that violates the transaction contract by handing the root
 * pool through as its transaction backend can run later counts on other
 * sessions.
 *
 * ```typescript
 * await store.clear();
 * const { totalRows, relations } = await inspectGraphStorage(store);
 * const leftovers = relations.filter((relation) => relation.rows > 0);
 * ```
 */
export async function inspectGraphStorage<G extends GraphDef>(
  store: Store<G>,
): Promise<GraphStorageInspection> {
  const backend = storeBackend(store);
  return countGraphStorage(
    backend,
    store.graphId,
    [
      ...inventoryRelationTargets(backend),
      ...vectorRelationTargets(backend, store.graph),
    ],
    INSPECT_GRAPH_STORAGE_OPERATION,
  );
}
