/**
 * Collection Factory for Store
 *
 * Creates typed node and edge collection proxies for both
 * Store and TransactionContext to reduce code duplication.
 */
import { type GraphBackend, type TransactionBackend } from "../backend/types";
import { type GraphDef } from "../core/define-graph";
import { type TemporalMode } from "../core/types";
import { KindNotFoundError } from "../errors";
import { type QueryBuilder } from "../query/builder";
import { type KindRegistry } from "../registry/kind-registry";
import { createEdgeCollection, createNodeCollection } from "./collections";
import { type EdgeRow, type NodeRow } from "./row-mappers";
import {
  type CreateEdgeInput,
  type CreateNodeInput,
  type Edge,
  type Node,
  type NodeCollection,
  type QueryOptions,
  type TypedEdgeCollection,
  type UpdateNodeInput,
} from "./types";

/**
 * Operation functions passed to collections.
 */
export type NodeOperations = Readonly<{
  defaultTemporalMode: TemporalMode;
  rowToNode: (row: NodeRow) => Node;
  executeCreate: (
    input: CreateNodeInput,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<Node>;
  executeCreateBatch: (
    inputs: readonly CreateNodeInput[],
    backend: GraphBackend | TransactionBackend,
  ) => Promise<readonly Node[]>;
  executeCreateNoReturnBatch: (
    inputs: readonly CreateNodeInput[],
    backend: GraphBackend | TransactionBackend,
  ) => Promise<void>;
  executeUpdate: (
    input: UpdateNodeInput,
    backend: GraphBackend | TransactionBackend,
    options?: Readonly<{ clearDeleted?: boolean }>,
  ) => Promise<Node>;
  executeUpsertUpdate: (
    input: UpdateNodeInput,
    backend: GraphBackend | TransactionBackend,
    options?: Readonly<{ clearDeleted?: boolean }>,
  ) => Promise<Node>;
  executeDelete: (
    kind: string,
    id: string,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<void>;
  executeHardDelete: (
    kind: string,
    id: string,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<void>;
  matchesTemporalMode: (row: NodeRow, options?: QueryOptions) => boolean;
  createQuery?: () => QueryBuilder<GraphDef>;
}>;

export type EdgeOperations = Readonly<{
  defaultTemporalMode: TemporalMode;
  rowToEdge: (row: EdgeRow) => Edge;
  executeCreate: (
    input: CreateEdgeInput,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<Edge>;
  executeCreateBatch: (
    inputs: readonly CreateEdgeInput[],
    backend: GraphBackend | TransactionBackend,
  ) => Promise<readonly Edge[]>;
  executeCreateNoReturnBatch: (
    inputs: readonly CreateEdgeInput[],
    backend: GraphBackend | TransactionBackend,
  ) => Promise<void>;
  executeUpdate: (
    input: {
      id: string;
      props: Partial<Record<string, unknown>>;
      validTo?: string;
    },
    backend: GraphBackend | TransactionBackend,
  ) => Promise<Edge>;
  executeUpsertUpdate: (
    input: {
      id: string;
      props: Partial<Record<string, unknown>>;
      validTo?: string;
    },
    backend: GraphBackend | TransactionBackend,
    options?: Readonly<{ clearDeleted?: boolean }>,
  ) => Promise<Edge>;
  executeDelete: (
    id: string,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<void>;
  executeHardDelete: (
    id: string,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<void>;
  matchesTemporalMode: (row: EdgeRow, options?: QueryOptions) => boolean;
  createQuery?: () => QueryBuilder<GraphDef>;
}>;

/**
 * Creates a typed node collections proxy.
 *
 * The proxy dynamically creates NodeCollection instances for each node kind
 * when accessed.
 */
export function createNodeCollectionsProxy<G extends GraphDef>(
  graph: G,
  graphId: string,
  registry: KindRegistry,
  backend: GraphBackend | TransactionBackend,
  operations: NodeOperations,
): {
  [K in keyof G["nodes"] & string]-?: NodeCollection<G["nodes"][K]["type"]>;
} {
  const collectionCache = new Map<string, unknown>();

  // The proxy dynamically returns typed collections for each key.
  // Type assertions are necessary because the proxy pattern doesn't preserve
  // the relationship between keys and their specific node types at compile time.
  return new Proxy(
    {} as unknown as {
      [K in keyof G["nodes"] & string]-?: NodeCollection<G["nodes"][K]["type"]>;
    },
    {
      get: (_, kind: string) => {
        if (!(kind in graph.nodes)) {
          throw new KindNotFoundError(kind, "node");
        }

        const cached = collectionCache.get(kind);
        if (cached !== undefined) {
          return cached;
        }

        const collection = createNodeCollection({
          graphId,
          kind,
          backend,
          ...operations,
        });
        collectionCache.set(kind, collection);
        return collection;
      },
    },
  );
}

/**
 * Creates a typed edge collections proxy.
 *
 * The proxy dynamically creates EdgeCollection instances for each edge kind
 * when accessed.
 */
export function createEdgeCollectionsProxy<G extends GraphDef>(
  graph: G,
  graphId: string,
  registry: KindRegistry,
  backend: GraphBackend | TransactionBackend,
  operations: EdgeOperations,
): { [K in keyof G["edges"] & string]-?: TypedEdgeCollection<G["edges"][K]> } {
  const collectionCache = new Map<string, unknown>();

  // The proxy dynamically returns typed collections for each key.
  // Type assertions are necessary because the proxy pattern doesn't preserve
  // the relationship between keys and their specific edge types at compile time.
  return new Proxy(
    {} as unknown as {
      [K in keyof G["edges"] & string]-?: TypedEdgeCollection<G["edges"][K]>;
    },
    {
      get: (_, kind: string) => {
        if (!(kind in graph.edges)) {
          throw new KindNotFoundError(kind, "edge");
        }

        const cached = collectionCache.get(kind);
        if (cached !== undefined) {
          return cached;
        }

        const collection = createEdgeCollection({
          graphId,
          kind,
          backend,
          ...operations,
        });
        collectionCache.set(kind, collection);
        return collection;
      },
    },
  );
}
