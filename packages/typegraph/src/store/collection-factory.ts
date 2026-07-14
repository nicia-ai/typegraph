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
  type GetOrCreateAction,
  type GraphEdgeCollections,
  type GraphNodeCollections,
  type IfExistsMode,
  type Node,
  type NodeBulkFindByIndexOptions,
  type NodeGetOrCreateByConstraintOptions,
  type QueryOptions,
  type UpdateNodeInput,
} from "./types";

/**
 * Operation functions passed to collections.
 */
export type NodeOperations = Readonly<{
  defaultTemporalMode: TemporalMode;
  rowToNode: (row: NodeRow) => Node;
  /**
   * Store-provided hook run after an autocommit bulk write completes;
   * refreshes planner statistics when the row count crosses the
   * configured threshold. Absent on transaction-scoped collections.
   */
  maybeRefreshStatisticsAfterBulk?:
    ((rowCount: number) => Promise<void>) | undefined;
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
  /**
   * Coalesce dirty-check for `upsertById` / `bulkUpsertById`. Present only
   * when the store was created with `coalesceUnchangedUpserts: true`; its
   * absence is the off switch. Returns whether upserting `props` onto the
   * given existing live row would leave the stored value unchanged (rule 4);
   * the collection owns the other preconditions via `shouldCoalesceUpsert`.
   */
  isUpsertUnchanged?: (
    existing: NodeRow,
    props: Record<string, unknown>,
  ) => boolean;
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
  temporalRowMatcher: (options?: QueryOptions) => (row: NodeRow) => boolean;
  createQuery?: () => QueryBuilder<GraphDef>;
  executeGetOrCreateByConstraint: (
    kind: string,
    constraintName: string,
    props: Record<string, unknown>,
    backend: GraphBackend | TransactionBackend,
    options?: NodeGetOrCreateByConstraintOptions,
  ) => Promise<Readonly<{ node: Node; action: GetOrCreateAction }>>;
  executeBulkGetOrCreateByConstraint: (
    kind: string,
    constraintName: string,
    items: readonly Readonly<{ props: Record<string, unknown> }>[],
    backend: GraphBackend | TransactionBackend,
    options?: NodeGetOrCreateByConstraintOptions,
  ) => Promise<Readonly<{ node: Node; action: GetOrCreateAction }>[]>;
  executeFindByConstraint: (
    kind: string,
    constraintName: string,
    props: Record<string, unknown>,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<Node | undefined>;
  executeBulkFindByConstraint: (
    kind: string,
    constraintName: string,
    items: readonly Readonly<{ props: Record<string, unknown> }>[],
    backend: GraphBackend | TransactionBackend,
  ) => Promise<(Node | undefined)[]>;
  executeBulkFindByIndex: (
    kind: string,
    indexName: string,
    items: readonly Readonly<{ props: Record<string, unknown> }>[],
    backend: GraphBackend | TransactionBackend,
    options?: NodeBulkFindByIndexOptions,
  ) => Promise<Node[][]>;
}>;

export type EdgeOperations = Readonly<{
  defaultTemporalMode: TemporalMode;
  rowToEdge: (row: EdgeRow) => Edge;
  /**
   * Store-provided hook run after an autocommit bulk write completes;
   * refreshes planner statistics when the row count crosses the
   * configured threshold. Absent on transaction-scoped collections.
   */
  maybeRefreshStatisticsAfterBulk?:
    ((rowCount: number) => Promise<void>) | undefined;
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
  /**
   * Coalesce dirty-check for `bulkUpsertById`. Present only when the store was
   * created with `coalesceUnchangedUpserts: true`; its absence is the off
   * switch. Returns whether upserting `props` onto the given existing live
   * edge would leave the stored value unchanged (props only — endpoints are
   * the edge's identity). The collection owns the other preconditions via
   * `shouldCoalesceUpsert`.
   */
  isUpsertUnchanged?: (
    existing: EdgeRow,
    props: Record<string, unknown>,
  ) => boolean;
  executeDelete: (
    id: string,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<void>;
  executeHardDelete: (
    id: string,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<void>;
  temporalRowMatcher: (options?: QueryOptions) => (row: EdgeRow) => boolean;
  createQuery?: () => QueryBuilder<GraphDef>;
  executeGetOrCreateByEndpoints: (
    kind: string,
    fromKind: string,
    fromId: string,
    toKind: string,
    toId: string,
    props: Record<string, unknown>,
    backend: GraphBackend | TransactionBackend,
    options?: Readonly<{
      matchOn?: readonly string[];
      ifExists?: IfExistsMode;
    }>,
  ) => Promise<Readonly<{ edge: Edge; action: GetOrCreateAction }>>;
  executeBulkGetOrCreateByEndpoints: (
    kind: string,
    items: readonly Readonly<{
      fromKind: string;
      fromId: string;
      toKind: string;
      toId: string;
      props: Record<string, unknown>;
    }>[],
    backend: GraphBackend | TransactionBackend,
    options?: Readonly<{
      matchOn?: readonly string[];
      ifExists?: IfExistsMode;
    }>,
  ) => Promise<Readonly<{ edge: Edge; action: GetOrCreateAction }>[]>;
  executeFindByEndpoints: (
    kind: string,
    fromKind: string,
    fromId: string,
    toKind: string,
    toId: string,
    backend: GraphBackend | TransactionBackend,
    options?: Readonly<{
      matchOn?: readonly string[];
      props?: Record<string, unknown>;
    }>,
  ) => Promise<Edge | undefined>;
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
): GraphNodeCollections<G> {
  const collectionCache = new Map<string, unknown>();

  // The proxy dynamically returns typed collections for each key.
  // Type assertions are necessary because the proxy pattern doesn't preserve
  // the relationship between keys and their specific node types at compile time.
  return new Proxy({} as unknown as GraphNodeCollections<G>, {
    get: (_, kind: string) => {
      if (!Object.hasOwn(graph.nodes, kind)) {
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
  });
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
): GraphEdgeCollections<G> {
  const collectionCache = new Map<string, unknown>();

  // The proxy dynamically returns typed collections for each key.
  // Type assertions are necessary because the proxy pattern doesn't preserve
  // the relationship between keys and their specific edge types at compile time.
  return new Proxy({} as unknown as GraphEdgeCollections<G>, {
    get: (_, kind: string) => {
      if (!Object.hasOwn(graph.edges, kind)) {
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
  });
}
