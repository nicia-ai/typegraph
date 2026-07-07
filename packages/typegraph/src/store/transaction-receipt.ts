import { type GraphDef } from "../core/define-graph";
import { type AnyEdgeType, type NodeType } from "../core/types";
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

type Assert<T extends true> = T;
type Equal<A, B> =
  [A] extends [B] ?
    [B] extends [A] ?
      true
    : false
  : false;

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
  snapshot: (recorded?: TransactionReceipt["recorded"]) => TransactionReceipt;
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

export function createTransactionReceiptRecorder(): TransactionReceiptRecorder {
  const nodes = createCountBucket();
  const edges = createCountBucket();
  let total = 0;

  return {
    recordNode(kind, count): void {
      increment(nodes, kind, count);
      total += count;
    },

    recordEdge(kind, count): void {
      increment(edges, kind, count);
      total += count;
    },

    snapshot(recorded): TransactionReceipt {
      // Object.assign onto a fresh null-prototype bucket (rather than spread)
      // keeps prototype-colliding kind names readable on the returned receipt.
      return Object.freeze({
        writes: Object.freeze({
          nodes: Object.freeze(Object.assign(createCountBucket(), nodes)),
          edges: Object.freeze(Object.assign(createCountBucket(), edges)),
          total,
        }),
        ...(recorded === undefined ? {} : { recorded }),
      });
    },
  };
}

function isWrappedMethod(value: unknown): value is WrappedMethod {
  return typeof value === "function";
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && Boolean(value);
}

function wrapNodeCollection<T extends object>(
  collection: T,
  kind: string,
  recorder: TransactionReceiptRecorder,
): T {
  const methodNames = new Set<string>(NODE_WRITE_NAMES);
  const cache = new Map<PropertyKey, unknown>();

  return new Proxy(collection, {
    get(target, property, receiver) {
      if (typeof property !== "string" || !methodNames.has(property)) {
        return Reflect.get(target, property, receiver);
      }

      const cached = cache.get(property);
      if (cached !== undefined) return cached;

      const value = Reflect.get(target, property, receiver);
      if (!isWrappedMethod(value)) return value;

      const method = property as NodeWriteMethodName;
      const wrapped: WrappedMethod = async (...args) => {
        // Pin the intent count at call time: a caller may mutate a bulk input
        // array while the write is in flight, and the backend has already
        // snapshotted the items. Recording still waits for resolution so a
        // rejected write counts 0.
        const count = NODE_WRITE_INTENT_COUNTERS[method](args);
        const result = await Reflect.apply(value, target, args);
        recorder.recordNode(kind, count);
        return result;
      };
      cache.set(property, wrapped);
      return wrapped;
    },
  });
}

function wrapEdgeCollection<T extends object>(
  collection: T,
  kind: string,
  recorder: TransactionReceiptRecorder,
): T {
  const methodNames = new Set<string>(EDGE_WRITE_NAMES);
  const cache = new Map<PropertyKey, unknown>();

  return new Proxy(collection, {
    get(target, property, receiver) {
      if (typeof property !== "string" || !methodNames.has(property)) {
        return Reflect.get(target, property, receiver);
      }

      const cached = cache.get(property);
      if (cached !== undefined) return cached;

      const value = Reflect.get(target, property, receiver);
      if (!isWrappedMethod(value)) return value;

      const method = property as EdgeWriteMethodName;
      const wrapped: WrappedMethod = async (...args) => {
        const count = EDGE_WRITE_INTENT_COUNTERS[method](args);
        const result = await Reflect.apply(value, target, args);
        recorder.recordEdge(kind, count);
        return result;
      };
      cache.set(property, wrapped);
      return wrapped;
    },
  });
}

function wrapNodeCollections<G extends GraphDef>(
  collections: GraphNodeCollections<G>,
  recorder: TransactionReceiptRecorder,
): GraphNodeCollections<G> {
  const cache = new Map<string, unknown>();

  return new Proxy(collections, {
    get(target, property, receiver) {
      if (typeof property !== "string") {
        return Reflect.get(target, property, receiver);
      }

      const cached = cache.get(property);
      if (cached !== undefined) return cached;

      const collection = Reflect.get(target, property, receiver);
      if (!isObject(collection)) {
        return collection;
      }
      const wrapped = wrapNodeCollection(collection, property, recorder);
      cache.set(property, wrapped);
      return wrapped;
    },
  });
}

function wrapEdgeCollections<G extends GraphDef>(
  collections: GraphEdgeCollections<G>,
  recorder: TransactionReceiptRecorder,
): GraphEdgeCollections<G> {
  const cache = new Map<string, unknown>();

  return new Proxy(collections, {
    get(target, property, receiver) {
      if (typeof property !== "string") {
        return Reflect.get(target, property, receiver);
      }

      const cached = cache.get(property);
      if (cached !== undefined) return cached;

      const collection = Reflect.get(target, property, receiver);
      if (!isObject(collection)) {
        return collection;
      }
      const wrapped = wrapEdgeCollection(collection, property, recorder);
      cache.set(property, wrapped);
      return wrapped;
    },
  });
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
    nodes: wrapNodeCollections(nodes, recorder),
    edges: wrapEdgeCollections(edges, recorder),
  };
}
