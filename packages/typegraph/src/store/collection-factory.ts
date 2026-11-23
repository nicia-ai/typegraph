/**
 * Collection Factory for Store
 *
 * Creates typed node and edge collection proxies for both
 * Store and TransactionContext to reduce code duplication.
 */
import {
  type BATCH_POINT_READ,
  type ENDPOINT_SET_READ,
} from "../backend/capabilities/bundle-registry";
import { type BundleVerdictOf } from "../backend/capabilities/resolve";
import { type GraphDef } from "../core/define-graph";
import { type TemporalMode } from "../core/types";
import { KindNotFoundError } from "../errors";
import { type QueryBuilder } from "../query/builder";
import type { CompiledSelectSql } from "../query/sql-intent";
import { type KindRegistry } from "../registry/kind-registry";
import { createEdgeCollection, createNodeCollection } from "./collections";
import { type UpsertDirtyCheckFunction } from "./collections/coalesce";
import {
  type EdgeCreateBatchOptions,
  type EdgeUpsertUpdateBatchEntry,
} from "./collections/edge-collection";
import {
  type NodeCreateBatchOptions,
  type NodeSetUpdateRequest,
  type NodeUpsertUpdateBatchEntry,
  type UpsertUpdateNodeInput,
} from "./collections/node-collection";
import type { StatementBackend } from "./operation-scope";
import type { ResolvedMutationSetAttempt } from "./resolved-mutation-set";
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
  type NodeBulkGetOrCreateByConstraintItem,
  type NodeBulkGetOrCreateByConstraintOptions,
  type NodeDeletePlan,
  type NodeGetOrCreateByConstraintOptions,
  type NodeReparentOptions,
  type NodeReparentResult,
  type QueryOptions,
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
    backend: StatementBackend,
  ) => Promise<Node>;
  executeCreateBatch: (
    inputs: readonly CreateNodeInput[],
    backend: StatementBackend,
    options?: NodeCreateBatchOptions,
  ) => Promise<readonly Node[]>;
  executeCreateNoReturnBatch: (
    inputs: readonly CreateNodeInput[],
    backend: StatementBackend,
  ) => Promise<void>;
  executeUpdate: (
    input: UpsertUpdateNodeInput,
    backend: StatementBackend,
    options?: Readonly<{ clearDeleted?: boolean }>,
  ) => Promise<Node>;
  executeNodeSetUpdate: (
    kind: string,
    patch: Record<string, unknown>,
    candidateIds: CompiledSelectSql,
    candidateIdColumn: string,
    backend: StatementBackend,
    request: NodeSetUpdateRequest,
  ) => Promise<Readonly<{ affectedCount: number }>>;
  executeUpsertUpdateBatch: (
    entries: readonly NodeUpsertUpdateBatchEntry[],
    backend: StatementBackend,
  ) => Promise<readonly Node[]>;
  executeResolvedMutationSet: (
    creates: readonly CreateNodeInput[],
    updates: readonly NodeUpsertUpdateBatchEntry[],
    backend: StatementBackend,
  ) => Promise<
    ResolvedMutationSetAttempt<
      Readonly<{ created: readonly Node[]; updated: readonly Node[] }>
    >
  >;
  prepareReplacement: (
    kind: string,
    props: Record<string, unknown>,
  ) => Record<string, unknown>;
  executeReplacementBatch: (
    kind: string,
    items: readonly Readonly<{
      id: string;
      props: Record<string, unknown>;
    }>[],
    backend: StatementBackend,
  ) => Promise<ResolvedMutationSetAttempt<readonly Node[]>>;
  /**
   * Coalesce dirty-check for `upsertById` / `bulkUpsertById`. Present only when
   * the store was created with `coalesceUnchangedUpserts: true`; its absence is
   * the off switch. Given the current (parsed) props, returns the props the
   * upsert would persist and whether they are unchanged; the collection owns
   * the other preconditions.
   */
  upsertDirtyCheck?: UpsertDirtyCheckFunction;
  executeReparent: (
    kind: string,
    id: string,
    options: NodeReparentOptions,
    backend: StatementBackend,
  ) => Promise<NodeReparentResult>;
  executeReparentBatch: (
    kind: string,
    items: readonly Readonly<{ id: string; options: NodeReparentOptions }>[],
    backend: StatementBackend,
  ) => Promise<readonly NodeReparentResult[]>;
  executeDelete: (
    kind: string,
    id: string,
    backend: StatementBackend,
    expect: NodeDeletePlan | undefined,
  ) => Promise<void>;
  executeDeleteBatch: (
    kind: string,
    ids: readonly string[],
    backend: StatementBackend,
  ) => Promise<void>;
  executeHardDelete: (
    kind: string,
    id: string,
    backend: StatementBackend,
  ) => Promise<void>;
  executeHardDeleteBatch: (
    kind: string,
    ids: readonly string[],
    backend: StatementBackend,
  ) => Promise<void>;
  executeDeletePlan: (
    kind: string,
    id: string,
    backend: StatementBackend,
  ) => Promise<NodeDeletePlan | undefined>;
  temporalRowMatcher: (options?: QueryOptions) => (row: NodeRow) => boolean;
  createQuery?: () => QueryBuilder<GraphDef>;
  executeGetOrCreateByConstraint: (
    kind: string,
    constraintName: string,
    props: Record<string, unknown>,
    backend: StatementBackend,
    options?: NodeGetOrCreateByConstraintOptions,
  ) => Promise<Readonly<{ node: Node; action: GetOrCreateAction }>>;
  executeBulkGetOrCreateByConstraint: (
    kind: string,
    constraintName: string,
    items: readonly NodeBulkGetOrCreateByConstraintItem<
      Record<string, unknown>
    >[],
    backend: StatementBackend,
    options?: NodeBulkGetOrCreateByConstraintOptions,
  ) => Promise<Readonly<{ node: Node; action: GetOrCreateAction }>[]>;
  executeFindByConstraint: (
    kind: string,
    constraintName: string,
    props: Record<string, unknown>,
    backend: StatementBackend,
  ) => Promise<Node | undefined>;
  executeBulkFindByConstraint: (
    kind: string,
    constraintName: string,
    items: readonly Readonly<{ props: Record<string, unknown> }>[],
    backend: StatementBackend,
  ) => Promise<(Node | undefined)[]>;
  executeBulkFindByIndex: (
    kind: string,
    indexName: string,
    items: readonly Readonly<{ props: Record<string, unknown> }>[],
    backend: StatementBackend,
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
    backend: StatementBackend,
  ) => Promise<Edge>;
  executeCreateBatch: (
    inputs: readonly CreateEdgeInput[],
    backend: StatementBackend,
    options?: EdgeCreateBatchOptions,
  ) => Promise<readonly Edge[]>;
  executeCreateNoReturnBatch: (
    inputs: readonly CreateEdgeInput[],
    backend: StatementBackend,
  ) => Promise<void>;
  executeUpdate: (
    input: {
      id: string;
      identity: Readonly<{
        kind: string;
        fromKind?: string;
        fromId?: string;
        toKind?: string;
        toId?: string;
      }>;
      props: Partial<Record<string, unknown>>;
      validTo?: string;
      clearValidTo?: true;
    },
    backend: StatementBackend,
  ) => Promise<Edge>;
  executeUpsertUpdateBatch: (
    entries: readonly EdgeUpsertUpdateBatchEntry[],
    backend: StatementBackend,
  ) => Promise<readonly Edge[]>;
  executeResolvedMutationSet: (
    creates: readonly CreateEdgeInput[],
    updates: readonly EdgeUpsertUpdateBatchEntry[],
    backend: StatementBackend,
  ) => Promise<
    ResolvedMutationSetAttempt<
      Readonly<{ created: readonly Edge[]; updated: readonly Edge[] }>
    >
  >;
  /**
   * Coalesce dirty-check for `bulkUpsertById` (props only — endpoints are the
   * edge's identity). Present only when the store was created with
   * `coalesceUnchangedUpserts: true`; its absence is the off switch.
   */
  upsertDirtyCheck?: UpsertDirtyCheckFunction;
  executeDelete: (
    kind: string,
    id: string,
    backend: StatementBackend,
  ) => Promise<void>;
  executeDeleteBatch: (
    kind: string,
    ids: readonly string[],
    backend: StatementBackend,
  ) => Promise<void>;
  executeHardDelete: (
    kind: string,
    id: string,
    backend: StatementBackend,
  ) => Promise<void>;
  executeHardDeleteBatch: (
    kind: string,
    ids: readonly string[],
    backend: StatementBackend,
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
    backend: StatementBackend,
    options?: Readonly<{
      matchOn?: readonly string[];
      ifExists?: IfExistsMode;
      validFrom?: string | null;
      validTo?: string;
      clearValidTo?: true;
      onImmutableLowerBound?: "preserve" | "refuse";
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
      validFrom?: string | null;
      validTo?: string;
      clearValidTo?: true;
      onImmutableLowerBound?: "preserve" | "refuse";
    }>[],
    backend: StatementBackend,
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
    backend: StatementBackend,
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
  backend: StatementBackend,
  batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>,
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
        batchPointRead,
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
  backend: StatementBackend,
  batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>,
  endpointSetRead: BundleVerdictOf<typeof ENDPOINT_SET_READ>,
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
        batchPointRead,
        endpointSetRead,
        ...operations,
      });
      collectionCache.set(kind, collection);
      return collection;
    },
  });
}
