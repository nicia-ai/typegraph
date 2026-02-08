/**
 * Collection Factory for Store
 *
 * Creates typed node and edge collection proxies for both
 * Store and TransactionContext to reduce code duplication.
 */
import { type GraphBackend, type TransactionBackend } from "../backend/types";
import { type GraphDef } from "../core/define-graph";
import { KindNotFoundError } from "../errors";
import { type KindRegistry } from "../registry/kind-registry";
import { createEdgeCollection, createNodeCollection } from "./collections";
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
 * Row shape from database queries.
 */
type NodeRow = Readonly<{
  kind: string;
  id: string;
  props: string;
  version: number;
  valid_from: string | undefined;
  valid_to: string | undefined;
  created_at: string;
  updated_at: string;
  deleted_at: string | undefined;
}>;

type EdgeRow = Readonly<{
  id: string;
  kind: string;
  from_kind: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  props: string;
  valid_from: string | undefined;
  valid_to: string | undefined;
  created_at: string;
  updated_at: string;
  deleted_at: string | undefined;
}>;

/**
 * Operation functions passed to collections.
 */
export type NodeOperations = Readonly<{
  rowToNode: (row: NodeRow) => Node;
  executeCreate: (
    input: CreateNodeInput,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<Node>;
  executeUpdate: (
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
}>;

export type EdgeOperations = Readonly<{
  rowToEdge: (row: EdgeRow) => Edge;
  executeCreate: (
    input: CreateEdgeInput,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<Edge>;
  executeUpdate: (
    input: {
      id: string;
      props: Partial<Record<string, unknown>>;
      validTo?: string;
    },
    backend: GraphBackend | TransactionBackend,
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
        return createNodeCollection(
          graphId,
          kind,
          registry,
          backend,
          operations.rowToNode,
          operations.executeCreate as Parameters<
            typeof createNodeCollection
          >[5],
          operations.executeUpdate as Parameters<
            typeof createNodeCollection
          >[6],
          operations.executeDelete,
          operations.executeHardDelete,
          operations.matchesTemporalMode as Parameters<
            typeof createNodeCollection
          >[9],
        );
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
        return createEdgeCollection(
          graphId,
          kind,
          registry,
          backend,
          operations.rowToEdge,
          operations.executeCreate as Parameters<
            typeof createEdgeCollection
          >[5],
          operations.executeUpdate,
          operations.executeDelete,
          operations.executeHardDelete,
          operations.matchesTemporalMode as Parameters<
            typeof createEdgeCollection
          >[9],
        );
      },
    },
  );
}
