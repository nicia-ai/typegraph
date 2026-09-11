/**
 * The in-batch cardinality accounting an edge batch validates against.
 *
 * A batch decides every row before it writes any of them, so a probe that read
 * only the database would let two rows of one batch each see "no conflict" and
 * both land — the in-batch collision. This wrapper is the state that closes
 * that: it overlays the reads a cardinality probe makes (`countEdgesAtEndpoint`,
 * `edgeExistsBetween`) with the rows the batch has already accepted, so row
 * k+1's probe sees rows 1..k and refuses per ROW rather than at the flush.
 *
 * It lives in its own module because it has two callers that reach it from
 * different directions: the store's batch create path
 * ({@link file://./edge-operations.ts prepareEdgeBatchCreates}) and
 * `interchange/import`'s edge slice. One owner of in-batch cardinality
 * accounting, not two implementations — a second copy is exactly how import's
 * edge path came to have none at all.
 *
 * It is a read overlay only. The CLAIM is issued against the real backend, once
 * per batch, by the caller — a claim against this wrapper would still reach the
 * real target (`deriveBackend` forwards every non-overlaid member) but
 * would be a second, unsorted, per-row claim in addition to the batch's.
 *
 * The pending counters fold over {@link edgeCardinalityAxisReferences} — the same
 * fold the write-time probe and the real claim use — rather than re-spelling
 * each cardinality's rules inline, so a target-only declaration accumulates
 * in-batch pending state exactly as a source-only one always has. Both the
 * write side (`registerPendingEdgeForCardinality`) and the read side
 * (`countEdgesAtEndpointCached`) key a `from`/`to`-shaped axis by the exact
 * tuple `countEdgesAtEndpoint` itself reads — `(graphId, edgeKind, endpoint,
 * endpointKind, endpointId, activeOnly)` — so the two sides cannot drift
 * without one comparison in one function catching it.
 *
 * The module's second overlay, {@link createRetiringEdgeValidationBackend},
 * is the same device pointed the other way: a frame that RETIRES a row and
 * inserts its replacement prepares the replacement against a count the
 * retiring row has already left.
 */
import { deriveBackend } from "../../backend/derive-backend";
import {
  type CountEdgesAtEndpointParams,
  type EdgeRow,
  type GraphBackend,
  type InsertEdgeParams,
} from "../../backend/types";
import { encodeTupleKey } from "../../utils/tuple-key";
import {
  edgeCardinalityAxisReferences,
  type EdgeCardinalityDeclarations,
  edgeCardinalitySpec,
} from "../claims/edge-claims";
import { type WriteTarget } from "./write-session";

function buildEdgeEndpointCacheKey(
  graphId: string,
  kind: string,
  id: string,
): string {
  return encodeTupleKey([graphId, kind, id]);
}

function buildEdgeBetweenCacheKey(
  graphId: string,
  edgeKind: string,
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
): string {
  return encodeTupleKey([graphId, edgeKind, fromKind, fromId, toKind, toId]);
}

function buildCountEdgesAtEndpointCacheKey(
  params: CountEdgesAtEndpointParams,
): string {
  const activeOnly = params.activeOnly === true ? "1" : "0";
  return encodeTupleKey([
    params.graphId,
    params.edgeKind,
    params.endpoint,
    params.endpointKind,
    params.endpointId,
    activeOnly,
  ]);
}

function incrementPendingCount(counts: Map<string, number>, key: string): void {
  const previous = counts.get(key) ?? 0;
  counts.set(key, previous + 1);
}

export function createEdgeBatchValidationBackend(
  backend: WriteTarget,
): Readonly<{
  backend: WriteTarget;
  registerPendingEdgeForCardinality: (
    insertParams: InsertEdgeParams,
    declarations: EdgeCardinalityDeclarations,
  ) => void;
  seedEndpointRow: (
    graphId: string,
    kind: string,
    id: string,
    row: Awaited<ReturnType<GraphBackend["getNode"]>>,
  ) => void;
}> {
  const endpointCache = new Map<
    string,
    Awaited<ReturnType<GraphBackend["getNode"]>>
  >();
  const countEdgesAtEndpointCache = new Map<string, number>();
  const edgeExistsCache = new Map<string, boolean>();
  const pendingByTarget = new Map<string, number>();
  const pendingUniqueTargets = new Set<string>();

  async function getNodeCached(
    graphId: string,
    kind: string,
    id: string,
  ): Promise<Awaited<ReturnType<GraphBackend["getNode"]>>> {
    const cacheKey = buildEdgeEndpointCacheKey(graphId, kind, id);
    if (endpointCache.has(cacheKey)) {
      return endpointCache.get(cacheKey);
    }
    const node = await backend.getNode(graphId, kind, id);
    endpointCache.set(cacheKey, node);
    return node;
  }

  // Lets batch preparation prime the endpoint cache from one getNodes
  // round trip per (kind) instead of a per-edge getNode probe for each
  // from/to endpoint — mirrors seedNodeRow in createNodeBatchValidationBackend.
  // Seeding an absent result (`undefined`) is meaningful — it marks the key
  // as known-missing so the per-edge check skips the backend read. An
  // earlier lookup or seed always wins; seeding never overwrites.
  function seedEndpointRow(
    graphId: string,
    kind: string,
    id: string,
    row: Awaited<ReturnType<GraphBackend["getNode"]>>,
  ): void {
    const cacheKey = buildEdgeEndpointCacheKey(graphId, kind, id);
    if (endpointCache.has(cacheKey)) return;
    endpointCache.set(cacheKey, row);
  }

  async function countEdgesAtEndpointCached(
    params: CountEdgesAtEndpointParams,
  ): Promise<number> {
    const cacheKey = buildCountEdgesAtEndpointCacheKey(params);
    let baseCount = countEdgesAtEndpointCache.get(cacheKey);
    if (baseCount === undefined) {
      baseCount = await backend.countEdgesAtEndpoint(params);
      countEdgesAtEndpointCache.set(cacheKey, baseCount);
    }
    const pendingCount = pendingByTarget.get(cacheKey) ?? 0;
    return baseCount + pendingCount;
  }

  async function edgeExistsBetweenCached(
    params: Parameters<GraphBackend["edgeExistsBetween"]>[0],
  ): Promise<boolean> {
    const cacheKey = buildEdgeBetweenCacheKey(
      params.graphId,
      params.edgeKind,
      params.fromKind,
      params.fromId,
      params.toKind,
      params.toId,
    );
    if (pendingUniqueTargets.has(cacheKey)) {
      return true;
    }
    if (edgeExistsCache.has(cacheKey)) {
      return edgeExistsCache.get(cacheKey) ?? false;
    }
    const exists = await backend.edgeExistsBetween(params);
    edgeExistsCache.set(cacheKey, exists);
    return exists;
  }

  /**
   * Folds the row's declaration through {@link edgeCardinalityAxisReferences},
   * exactly as the write-time probe and the real claim do, and records ONE
   * pending entry per applicable axis — a `fromAndTo`-shaped axis (source
   * `unique`) into `pendingUniqueTargets`, a `from`/`to`-shaped one into
   * `pendingByTarget` under the same key `countEdgesAtEndpointCached` reads.
   * An axis whose spec exempts a born-ended row (`claimsWhenBornEnded ===
   * false`, and this row states a `validTo`) records nothing, matching the
   * real claim it would never take.
   */
  function registerPendingEdgeForCardinality(
    insertParams: InsertEdgeParams,
    declarations: EdgeCardinalityDeclarations,
  ): void {
    for (const ref of edgeCardinalityAxisReferences(declarations)) {
      const spec = edgeCardinalitySpec(ref);
      if (!spec.claimsWhenBornEnded && insertParams.validTo !== undefined) {
        continue;
      }
      if (spec.keyShape === "fromAndTo") {
        pendingUniqueTargets.add(
          buildEdgeBetweenCacheKey(
            insertParams.graphId,
            insertParams.kind,
            insertParams.fromKind,
            insertParams.fromId,
            insertParams.toKind,
            insertParams.toId,
          ),
        );
        continue;
      }
      const endpoint = spec.keyShape;
      const { endpointKind, endpointId } =
        endpoint === "from" ?
          {
            endpointKind: insertParams.fromKind,
            endpointId: insertParams.fromId,
          }
        : { endpointKind: insertParams.toKind, endpointId: insertParams.toId };
      const key = buildCountEdgesAtEndpointCacheKey({
        graphId: insertParams.graphId,
        edgeKind: insertParams.kind,
        endpoint,
        endpointKind,
        endpointId,
        activeOnly: spec.holderLiveness === "liveAndActive",
      });
      incrementPendingCount(pendingByTarget, key);
    }
  }

  const validationBackend = deriveBackend(backend, {
    getNode: getNodeCached,
    countEdgesAtEndpoint: countEdgesAtEndpointCached,
    edgeExistsBetween: edgeExistsBetweenCached,
  } satisfies Partial<WriteTarget>);

  return {
    backend: validationBackend,
    registerPendingEdgeForCardinality,
    seedEndpointRow,
  };
}

/**
 * Whether `countEdgesAtEndpoint(params)` counts `row`: the row-level rendering
 * of the exact predicate that read applies — same graph, edge kind, and
 * endpoint column pair, not deleted, and open-ended when the read is
 * `activeOnly`. Kept beside the cache key above, which mirrors the same
 * tuple, so the two renderings of one read live in one place.
 */
function countEdgesAtEndpointIncludes(
  params: CountEdgesAtEndpointParams,
  row: EdgeRow,
): boolean {
  const [endpointKind, endpointId] =
    params.endpoint === "from" ?
      [row.from_kind, row.from_id]
    : [row.to_kind, row.to_id];
  return (
    row.graph_id === params.graphId &&
    row.kind === params.edgeKind &&
    endpointKind === params.endpointKind &&
    endpointId === params.endpointId &&
    row.deleted_at === undefined &&
    (params.activeOnly !== true || row.valid_to === undefined)
  );
}

/**
 * The frame's write target as a replacement edge's preparation must read it:
 * with `retiring` — a row this same frame retires AFTER the preparation and
 * BEFORE the insert — already gone from every endpoint count it holds.
 *
 * `reparent`'s replace arm (`applyCompositionAttachmentDecision`,
 * `node-operations.ts`) is the caller: preparing the replacement before the
 * incumbent is retired is what keeps a refusal the preparation raises
 * (cardinality, acyclicity, invalid edge props) from leaving the part
 * detached when the caller catches it inside an enclosing transaction, and
 * preparing it against the raw count would refuse every move whose incumbent
 * realizes the same edge kind — the incumbent still counts against the
 * part's own cardinality until it is retired. Subtracting the one row the
 * frame retires yields exactly the count the insert will see: a
 * `population: "one"` incumbent is soft-deleted (leaves a `live` count), a
 * `population: "oneActive"` incumbent has its window ended (leaves a
 * `liveAndActive` count), and the axis a pair's population names is the
 * one whose count it leaves.
 *
 * `edgeExistsBetween` is deliberately not overlaid: an incumbent that shared
 * the replacement's `(kind, from, to)` would be the same attachment, which
 * the decision reports as `"satisfied"` and never replaces.
 */
export function createRetiringEdgeValidationBackend(
  target: WriteTarget,
  retiring: EdgeRow,
): WriteTarget {
  return deriveBackend(target, {
    countEdgesAtEndpoint: async (
      params: CountEdgesAtEndpointParams,
    ): Promise<number> => {
      const count = await target.countEdgesAtEndpoint(params);
      return countEdgesAtEndpointIncludes(params, retiring) ? count - 1 : count;
    },
  } satisfies Partial<WriteTarget>);
}
