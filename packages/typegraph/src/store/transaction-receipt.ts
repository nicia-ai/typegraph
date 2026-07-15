import { type GraphDef } from "../core/define-graph";
import { type AnyEdgeType, type NodeType } from "../core/types";
import { ConfigurationError } from "../errors";
import { type IdentityFacade } from "../identity/types";
import { type Assert, type Equal } from "../utils/type-assert";
import { EDGE_WRITE_NAMES, NODE_WRITE_NAMES } from "./collection-surface";
import type {
  EdgeWrites,
  GraphEdgeCollections,
  GraphNodeCollections,
  NodeWrites,
  TransactionReceipt,
} from "./types";

type NodeWriteMethodName = (typeof NODE_WRITE_NAMES)[number];
type EdgeWriteMethodName = (typeof EDGE_WRITE_NAMES)[number];

// If these fail, the receipt wrapper drifted away from the collection write
// surface that defines NodeWrites / EdgeWrites.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time assertion
type _receiptNodeSurfaceIsComplete = Assert<
  Equal<NodeWriteMethodName, keyof NodeWrites<NodeType, string>>
>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time assertion
type _receiptEdgeSurfaceIsComplete = Assert<
  Equal<EdgeWriteMethodName, keyof EdgeWrites<AnyEdgeType, NodeType, NodeType>>
>;

export type TransactionReceiptRecorder = Readonly<{
  recordNode: (kind: string, count: number) => void;
  recordEdge: (kind: string, count: number) => void;
  recordIdentity: (
    kind: "sameAssertions" | "differentAssertions" | "retractions",
    count: number,
  ) => void;
  snapshot: (recorded?: TransactionReceipt["recorded"]) => TransactionReceipt;
  /**
   * Seals the recorder: every subsequent write through a collection wrapped with
   * it (see {@link wrapTransactionCollections}) throws. Used to fail loud when a
   * transaction context is retained and written through *after* its callback
   * returned — where the receipt is already snapshotted and the write would
   * otherwise persist uncounted.
   */
  seal: () => void;
  /**
   * Throws {@link ConfigurationError} once {@link seal} has been called. Invoked
   * at the top of every wrapped write method, before the live write runs, so a
   * post-seal write never reaches the backend.
   */
  assertWritable: () => void;
}>;

type WrappedMethod = (...args: unknown[]) => Promise<unknown>;

type WriteIntentCounter = (args: readonly unknown[]) => number;

function inputLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function countSingleWrite(): number {
  return 1;
}

function countBulkInputAt(index: number): WriteIntentCounter {
  return (args) => inputLength(args[index]);
}

// `satisfies Record<...MethodName, ...>` forces a per-method decision: a new
// write method fails to compile here until its intent count is chosen, so a
// future bulk method cannot silently fall back to counting 1 per call.
const NODE_WRITE_INTENT_COUNTERS = {
  create: countSingleWrite,
  createFromRecord: countSingleWrite,
  update: countSingleWrite,
  delete: countSingleWrite,
  hardDelete: countSingleWrite,
  upsertById: countSingleWrite,
  upsertByIdFromRecord: countSingleWrite,
  bulkCreate: countBulkInputAt(0),
  bulkUpsertById: countBulkInputAt(0),
  bulkInsert: countBulkInputAt(0),
  bulkDelete: countBulkInputAt(0),
  getOrCreateByConstraint: countSingleWrite,
  bulkGetOrCreateByConstraint: countBulkInputAt(1),
} as const satisfies Record<NodeWriteMethodName, WriteIntentCounter>;

const EDGE_WRITE_INTENT_COUNTERS = {
  create: countSingleWrite,
  update: countSingleWrite,
  delete: countSingleWrite,
  hardDelete: countSingleWrite,
  bulkCreate: countBulkInputAt(0),
  bulkUpsertById: countBulkInputAt(0),
  bulkInsert: countBulkInputAt(0),
  bulkDelete: countBulkInputAt(0),
  getOrCreateByEndpoints: countSingleWrite,
  bulkGetOrCreateByEndpoints: countBulkInputAt(0),
} as const satisfies Record<EdgeWriteMethodName, WriteIntentCounter>;

// Null-prototype buckets: kind names are arbitrary identifiers, so
// `constructor`, `toString`, or `__proto__` are valid kinds. On a plain `{}`
// they would read inherited Object.prototype members (corrupting the count)
// or trigger the `__proto__` setter (dropping it).
function createCountBucket(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

function increment(
  counts: Record<string, number>,
  kind: string,
  count: number,
): void {
  if (count === 0) return;
  counts[kind] = (counts[kind] ?? 0) + count;
}

/**
 * One receipt's running counts. Each recorder owns exactly one: the outer
 * transaction's receipt, or the sub-receipt of one `tx.measure` scope. Scope
 * attribution is structural — a scope is a *second* recorder wrapping the outer
 * collections again (see `attachMeasure` in store.ts) — so no recorder ever
 * needs to know about another's scopes.
 */
interface WriteCounters {
  readonly nodes: Record<string, number>;
  readonly edges: Record<string, number>;
  readonly identity: {
    sameAssertions: number;
    differentAssertions: number;
    retractions: number;
    total: number;
  };
  total: number;
}

export function createTransactionReceiptRecorder(): TransactionReceiptRecorder {
  const counters: WriteCounters = {
    nodes: createCountBucket(),
    edges: createCountBucket(),
    identity: {
      sameAssertions: 0,
      differentAssertions: 0,
      retractions: 0,
      total: 0,
    },
    total: 0,
  };
  let sealed = false;

  return {
    recordNode(kind, count): void {
      increment(counters.nodes, kind, count);
      counters.total += count;
    },

    recordEdge(kind, count): void {
      increment(counters.edges, kind, count);
      counters.total += count;
    },

    recordIdentity(kind, count): void {
      counters.identity[kind] += count;
      counters.identity.total += count;
      counters.total += count;
    },

    snapshot(recorded): TransactionReceipt {
      // Object.assign onto a fresh null-prototype bucket (rather than spread)
      // keeps prototype-colliding kind names readable on the returned receipt.
      return Object.freeze({
        writes: Object.freeze({
          nodes: Object.freeze(
            Object.assign(createCountBucket(), counters.nodes),
          ),
          edges: Object.freeze(
            Object.assign(createCountBucket(), counters.edges),
          ),
          identity: Object.freeze({ ...counters.identity }),
          total: counters.total,
        }),
        ...(recorded === undefined ? {} : { recorded }),
      });
    },

    seal(): void {
      sealed = true;
    },

    assertWritable(): void {
      if (sealed) {
        throw new ConfigurationError(
          "Transaction context is sealed: a write happened through the receipt-tracked collections after the transaction callback returned.",
          {},
          {
            suggestion:
              "Perform all writes inside the transactionWithReceipt / withRecordedTransaction callback; do not reuse the transaction context after it returns.",
          },
        );
      }
    },
  };
}

export function wrapTransactionIdentity<G extends GraphDef>(
  identity: IdentityFacade<G>,
  recorder: TransactionReceiptRecorder,
): IdentityFacade<G> {
  return {
    representativeOf: (ref) => identity.representativeOf(ref),
    membersOf: (ref) => identity.membersOf(ref),
    areSame: (a, b) => identity.areSame(a, b),
    areDifferent: (a, b) => identity.areDifferent(a, b),
    assertionsOf: (ref) => identity.assertionsOf(ref),
    async assertSame(a, b) {
      recorder.assertWritable();
      const result = await identity.assertSame(a, b);
      recorder.recordIdentity("sameAssertions", 1);
      return result;
    },
    async assertDifferent(a, b) {
      recorder.assertWritable();
      const result = await identity.assertDifferent(a, b);
      recorder.recordIdentity("differentAssertions", 1);
      return result;
    },
    async bulkAssertSame(pairs) {
      recorder.assertWritable();
      // Pin the intent count before awaiting: the caller may mutate the input
      // array while the write is in flight (matches the node/edge wrappers).
      const count = pairs.length;
      const result = await identity.bulkAssertSame(pairs);
      recorder.recordIdentity("sameAssertions", count);
      return result;
    },
    async bulkAssertDifferent(pairs) {
      recorder.assertWritable();
      const count = pairs.length;
      const result = await identity.bulkAssertDifferent(pairs);
      recorder.recordIdentity("differentAssertions", count);
      return result;
    },
    async retractAssertion(id) {
      recorder.assertWritable();
      await identity.retractAssertion(id);
      recorder.recordIdentity("retractions", 1);
    },
    async retractSameAssertion(a, b) {
      recorder.assertWritable();
      await identity.retractSameAssertion(a, b);
      recorder.recordIdentity("retractions", 1);
    },
    async retractDifferentAssertion(a, b) {
      recorder.assertWritable();
      await identity.retractDifferentAssertion(a, b);
      recorder.recordIdentity("retractions", 1);
    },
    async bulkRetractAssertions(ids) {
      recorder.assertWritable();
      const count = ids.length;
      await identity.bulkRetractAssertions(ids);
      recorder.recordIdentity("retractions", count);
    },
  };
}

function isWrappedMethod(value: unknown): value is WrappedMethod {
  return typeof value === "function";
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && Boolean(value);
}

/**
 * Which methods on a node/edge collection count as writes, and how each
 * counts its intent. Bundled into one value per entity kind (below) rather
 * than passed as separate `methodNames`/`counters` parameters, so a call
 * site can only pick "the node surface" or "the edge surface" as a unit —
 * it cannot independently mismatch a method-name set against the wrong
 * counter table.
 */
type WriteIntentSurface<M extends string> = Readonly<{
  methodNames: ReadonlySet<string>;
  counters: Record<M, WriteIntentCounter>;
}>;

const NODE_WRITE_SURFACE: WriteIntentSurface<NodeWriteMethodName> = {
  methodNames: new Set(NODE_WRITE_NAMES),
  counters: NODE_WRITE_INTENT_COUNTERS,
};

const EDGE_WRITE_SURFACE: WriteIntentSurface<EdgeWriteMethodName> = {
  methodNames: new Set(EDGE_WRITE_NAMES),
  counters: EDGE_WRITE_INTENT_COUNTERS,
};

/**
 * Proxies `target`, memoizing the wrapped value for each string-keyed
 * property after first access. `shouldWrap` gates which properties run
 * through `wrap`; everything else (including symbol keys) passes through
 * via `Reflect.get` untouched. Shared by `wrapWriteCollection` (wraps write
 * methods on one collection) and `wrapCollections` (wraps every collection
 * in a kind-keyed map) — both are "lazily transform and cache one property
 * of an object" with a different `shouldWrap`/`wrap` pair.
 */
function memoizedProxyGet<T extends object>(
  target: T,
  shouldWrap: (property: string) => boolean,
  wrap: (value: unknown, property: string) => unknown,
): T {
  const cache = new Map<string, unknown>();

  return new Proxy(target, {
    get(proxyTarget, property, receiver) {
      if (typeof property !== "string" || !shouldWrap(property)) {
        return Reflect.get(proxyTarget, property, receiver);
      }

      const cached = cache.get(property);
      if (cached !== undefined) return cached;

      const value = Reflect.get(proxyTarget, property, receiver);
      const wrapped = wrap(value, property);
      cache.set(property, wrapped);
      return wrapped;
    },
  });
}

/**
 * Wraps one node/edge collection so every write method on it (per
 * `surface.methodNames`) fails loud once the recorder is sealed, then counts
 * its intent through `record` on resolution.
 */
function wrapWriteCollection<T extends object, M extends string>(
  collection: T,
  kind: string,
  surface: WriteIntentSurface<M>,
  record: (kind: string, count: number) => void,
  assertWritable: () => void,
): T {
  return memoizedProxyGet(
    collection,
    (property) => surface.methodNames.has(property),
    (value, property) => {
      if (!isWrappedMethod(value)) return value;

      const method = property as M;
      const wrapped: WrappedMethod = async (...args) => {
        // Reject before the live write: a context retained past its callback
        // must not persist a row the already-snapshotted receipt cannot count.
        assertWritable();
        // Pin the intent count at call time: a caller may mutate a bulk input
        // array while the write is in flight, and the backend has already
        // snapshotted the items. Recording still waits for resolution so a
        // rejected write counts 0.
        const count = surface.counters[method](args);
        const result = await Reflect.apply(value, collection, args);
        record(kind, count);
        return result;
      };
      return wrapped;
    },
  );
}

/**
 * Wraps a kind-keyed collection map (`GraphNodeCollections<G>` /
 * `GraphEdgeCollections<G>`), lazily wrapping each collection with
 * `wrapOne` on first access.
 */
function wrapCollections<T extends object>(
  collections: T,
  wrapOne: (collection: object, kind: string) => unknown,
): T {
  return memoizedProxyGet(
    collections,
    () => true,
    (collection, kind) =>
      isObject(collection) ? wrapOne(collection, kind) : collection,
  );
}

export function wrapTransactionCollections<G extends GraphDef>(
  nodes: GraphNodeCollections<G>,
  edges: GraphEdgeCollections<G>,
  recorder: TransactionReceiptRecorder,
): Readonly<{
  nodes: GraphNodeCollections<G>;
  edges: GraphEdgeCollections<G>;
}> {
  return {
    nodes: wrapCollections(nodes, (collection, kind) =>
      wrapWriteCollection(
        collection,
        kind,
        NODE_WRITE_SURFACE,
        recorder.recordNode,
        recorder.assertWritable,
      ),
    ),
    edges: wrapCollections(edges, (collection, kind) =>
      wrapWriteCollection(
        collection,
        kind,
        EDGE_WRITE_SURFACE,
        recorder.recordEdge,
        recorder.assertWritable,
      ),
    ),
  };
}
