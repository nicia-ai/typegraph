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

const NODE_BULK_FIRST_ARG_METHODS = new Set<NodeWriteMethodName>([
  "bulkCreate",
  "bulkUpsertById",
  "bulkInsert",
  "bulkDelete",
]);

const EDGE_BULK_FIRST_ARG_METHODS = new Set<EdgeWriteMethodName>([
  "bulkCreate",
  "bulkUpsertById",
  "bulkInsert",
  "bulkDelete",
  "bulkGetOrCreateByEndpoints",
]);

function inputLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function nodeWriteIntentCount(
  method: NodeWriteMethodName,
  args: readonly unknown[],
): number {
  if (NODE_BULK_FIRST_ARG_METHODS.has(method)) return inputLength(args[0]);
  if (method === "bulkGetOrCreateByConstraint") return inputLength(args[1]);
  return 1;
}

function edgeWriteIntentCount(
  method: EdgeWriteMethodName,
  args: readonly unknown[],
): number {
  if (EDGE_BULK_FIRST_ARG_METHODS.has(method)) return inputLength(args[0]);
  return 1;
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
  const nodes: Record<string, number> = {};
  const edges: Record<string, number> = {};
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
      return Object.freeze({
        writes: Object.freeze({
          nodes: Object.freeze({ ...nodes }),
          edges: Object.freeze({ ...edges }),
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
        const result = await Reflect.apply(value, target, args);
        recorder.recordNode(kind, nodeWriteIntentCount(method, args));
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
        const result = await Reflect.apply(value, target, args);
        recorder.recordEdge(kind, edgeWriteIntentCount(method, args));
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
