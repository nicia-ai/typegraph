/**
 * NodeCollection implementation.
 *
 * Provides an ergonomic API for CRUD operations on a specific node type.
 */
import { type z } from "zod";

import {
  type GraphBackend,
  type TransactionBackend,
} from "../../backend/types";
import { type GraphDef } from "../../core/define-graph";
import {
  type NodeId,
  type NodeType,
  type TemporalMode,
} from "../../core/types";
import { ConfigurationError } from "../../errors";
import { type QueryBuilder } from "../../query/builder";
import { getNodeRowsByIds } from "../node-fetch";
import { type NodeRow } from "../row-mappers";
import {
  type CreateNodeInput,
  type GetOrCreateAction,
  type Node,
  type NodeBulkFindByIndexOptions,
  type NodeCollection,
  type NodeGetOrCreateByConstraintOptions,
  type NodeGetOrCreateByConstraintResult,
  type QueryOptions,
  type UpdateNodeInput,
} from "../types";
import { shouldCoalesceUpsert } from "./coalesce";
import {
  resolveTemporalReadParams,
  type TemporalReadParams,
} from "./temporal-read-params";

/**
 * Narrows unparameterized Node to Node<N>.
 * Safe: props are validated by Zod at creation/update boundaries.
 */
function narrowNode<N extends NodeType>(node: Node): Node<N> {
  return node as Node<N>;
}

/**
 * Narrows a readonly Node array to Node<N>[].
 */
function narrowNodes<N extends NodeType>(nodes: readonly Node[]): Node<N>[] {
  return nodes as Node<N>[];
}

/**
 * Config for creating a NodeCollection.
 */
export type NodeCollectionConfig = Readonly<{
  graphId: string;
  kind: string;
  backend: GraphBackend | TransactionBackend;
  defaultTemporalMode: TemporalMode;
  rowToNode: (row: NodeRow) => Node;
  /** See NodeOperations.maybeRefreshStatisticsAfterBulk. */
  maybeRefreshStatisticsAfterBulk?:
    ((rowCount: number) => Promise<void>) | undefined;
  executeCreate: (
    input: CreateNodeInput,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<Node>;
  executeCreateNoReturnBatch: (
    inputs: readonly CreateNodeInput[],
    backend: GraphBackend | TransactionBackend,
  ) => Promise<void>;
  executeCreateBatch: (
    inputs: readonly CreateNodeInput[],
    backend: GraphBackend | TransactionBackend,
  ) => Promise<readonly Node[]>;
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
  /** See NodeOperations.isUpsertUnchanged. */
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

function buildCreateInput(
  kind: string,
  props: Record<string, unknown>,
  options?: Readonly<{ id?: string; validFrom?: string; validTo?: string }>,
): CreateNodeInput {
  const input: {
    kind: string;
    id?: string;
    props: Record<string, unknown>;
    validFrom?: string;
    validTo?: string;
  } = { kind, props };
  if (options?.id !== undefined) input.id = options.id;
  if (options?.validFrom !== undefined) input.validFrom = options.validFrom;
  if (options?.validTo !== undefined) input.validTo = options.validTo;
  return input;
}

function buildUpdateInput(
  kind: string,
  id: string,
  props: Record<string, unknown>,
  options?: Readonly<{ validTo?: string }>,
): UpdateNodeInput {
  const input: {
    kind: string;
    id: string;
    props: Partial<Record<string, unknown>>;
    validTo?: string;
  } = { kind, id, props };
  if (options?.validTo !== undefined) input.validTo = options.validTo;
  return input as UpdateNodeInput;
}

function mapBulkNodeInputs(
  kind: string,
  items: readonly Readonly<{
    props: Record<string, unknown>;
    id?: string;
    validFrom?: string;
    validTo?: string;
  }>[],
): CreateNodeInput[] {
  return items.map((item) => buildCreateInput(kind, item.props, item));
}

/**
 * Creates a NodeCollection for a specific node type.
 */
export function createNodeCollection<
  G extends GraphDef,
  K extends keyof G["nodes"] & string,
>(config: NodeCollectionConfig): NodeCollection<G["nodes"][K]["type"]> {
  type N = G["nodes"][K]["type"];

  const {
    graphId,
    kind,
    backend,
    defaultTemporalMode,
    rowToNode,
    executeCreate: executeNodeCreate,
    executeCreateNoReturnBatch: executeNodeCreateNoReturnBatch,
    executeCreateBatch: executeNodeCreateBatch,
    executeUpdate: executeNodeUpdate,
    executeUpsertUpdate: executeNodeUpsertUpdate,
    executeDelete: executeNodeDelete,
    executeHardDelete: executeNodeHardDelete,
    temporalRowMatcher,
    createQuery,
    executeGetOrCreateByConstraint,
    executeBulkGetOrCreateByConstraint,
    executeFindByConstraint,
    executeBulkFindByConstraint,
    executeBulkFindByIndex,
  } = config;

  return {
    async create(
      props: z.input<N["schema"]>,
      options?: Readonly<{ id?: string; validFrom?: string; validTo?: string }>,
    ): Promise<Node<N>> {
      return this.createFromRecord(props, options);
    },

    async createFromRecord(
      data: Record<string, unknown>,
      options?: Readonly<{ id?: string; validFrom?: string; validTo?: string }>,
    ): Promise<Node<N>> {
      const result = await executeNodeCreate(
        buildCreateInput(kind, data, options),
        backend,
      );
      return narrowNode<N>(result);
    },

    async getById(
      id: NodeId<N>,
      options?: QueryOptions,
    ): Promise<Node<N> | undefined> {
      const row = await backend.getNode(graphId, kind, id);
      if (!row) return undefined;
      if (!temporalRowMatcher(options)(row)) return undefined;
      return narrowNode<N>(rowToNode(row));
    },

    async getByIds(
      ids: readonly NodeId<N>[],
      options?: QueryOptions,
    ): Promise<readonly (Node<N> | undefined)[]> {
      if (ids.length === 0) return [];

      const rowsById = await getNodeRowsByIds(backend, graphId, kind, ids);
      // Resolve the coordinate once so the whole batch observes one instant.
      const matches = temporalRowMatcher(options);
      return ids.map((id) => {
        const row = rowsById.get(id);
        if (!row) return;
        if (!matches(row)) return;
        return narrowNode<N>(rowToNode(row));
      });
    },

    async update(
      id: NodeId<N>,
      props: Partial<z.input<N["schema"]>>,
      options?: Readonly<{ validTo?: string }>,
    ): Promise<Node<N>> {
      const result = await executeNodeUpdate(
        buildUpdateInput(kind, id, props, options),
        backend,
      );
      return narrowNode<N>(result);
    },

    async delete(id: NodeId<N>): Promise<void> {
      await executeNodeDelete(kind, id, backend);
    },

    async hardDelete(id: NodeId<N>): Promise<void> {
      await executeNodeHardDelete(kind, id, backend);
    },

    async find(
      filter?: Readonly<{
        where?: (accessor: never) => unknown;
        limit?: number;
        offset?: number;
      }>,
      temporal?: QueryOptions,
    ): Promise<Node<N>[]> {
      if (filter?.where !== undefined && createQuery === undefined) {
        throw new ConfigurationError(
          `store.nodes.${kind}.find({ where }) requires a query-capable store`,
          { kind, operation: "find" },
        );
      }
      if (filter?.where !== undefined && createQuery !== undefined) {
        // Resolve the coordinate through the same helper as the non-where
        // branch and count(), so find({ where }) and find(filter) observe
        // identical rows. `current` / `asOf` both resolve to a concrete instant
        // the backend find path compares against; pin the query to that same
        // instant — `current` would otherwise compile against the DB clock and
        // ignore the resolved asOf. includeEnded / includeTombstones carry no
        // instant. Routing through resolveTemporalReadParams also makes a
        // missing asOf in asOf mode throw here, matching the non-where branch.
        const { temporalMode, asOf } = resolveTemporalReadParams(
          temporal,
          defaultTemporalMode,
        );
        let query = createQuery()
          .from(kind, "_n")
          .temporal(asOf === undefined ? temporalMode : "asOf", asOf)
          .whereNode("_n", filter.where as never)
          .select((ctx: Record<string, unknown>) => ctx._n);
        if (filter.limit !== undefined) query = query.limit(filter.limit);
        if (filter.offset !== undefined) query = query.offset(filter.offset);
        const results = await query.execute();
        return results as Node<N>[];
      }

      const params: {
        graphId: string;
        kind: string;
        limit?: number;
        offset?: number;
      } & TemporalReadParams = {
        graphId,
        kind,
        ...resolveTemporalReadParams(temporal, defaultTemporalMode),
      };
      if (filter?.limit !== undefined) params.limit = filter.limit;
      if (filter?.offset !== undefined) params.offset = filter.offset;

      const rows = await backend.findNodesByKind(params);
      return rows.map((row) => narrowNode<N>(rowToNode(row)));
    },

    async count(temporal?: QueryOptions): Promise<number> {
      const params: {
        graphId: string;
        kind: string;
      } & TemporalReadParams = {
        graphId,
        kind,
        ...resolveTemporalReadParams(temporal, defaultTemporalMode),
      };
      return backend.countNodesByKind(params);
    },

    async upsertById(
      id: string,
      props: z.input<N["schema"]>,
      options?: Readonly<{ validFrom?: string; validTo?: string }>,
    ): Promise<Node<N>> {
      return this.upsertByIdFromRecord(id, props, options);
    },

    async upsertByIdFromRecord(
      id: string,
      data: Record<string, unknown>,
      options?: Readonly<{ validFrom?: string; validTo?: string }>,
    ): Promise<Node<N>> {
      const existing = await backend.getNode(graphId, kind, id);

      if (existing) {
        // Coalesce a value-identical replay: skip the write entirely (no
        // updateNode, no recorded capture, no revision advance, no hooks) and
        // resolve with the existing node. See
        // BaseStoreOptions.coalesceUnchangedUpserts.
        if (
          shouldCoalesceUpsert(existing, options, () =>
            config.isUpsertUnchanged?.(existing, data),
          )
        ) {
          return narrowNode<N>(rowToNode(existing));
        }
        const result = await executeNodeUpdate(
          buildUpdateInput(kind, id, data, options),
          backend,
          { clearDeleted: existing.deleted_at !== undefined },
        );
        return narrowNode<N>(result);
      }

      const result = await executeNodeCreate(
        buildCreateInput(kind, data, { ...options, id }),
        backend,
      );
      return narrowNode<N>(result);
    },

    async bulkCreate(
      items: readonly Readonly<{
        props: z.input<N["schema"]>;
        id?: string;
        validFrom?: string;
        validTo?: string;
      }>[],
    ): Promise<Node<N>[]> {
      const batchInputs = mapBulkNodeInputs(kind, items);

      if (backend.capabilities.transactions && "transaction" in backend) {
        const results = await backend.transaction(async (txBackend) =>
          executeNodeCreateBatch(batchInputs, txBackend),
        );
        await config.maybeRefreshStatisticsAfterBulk?.(results.length);
        return narrowNodes<N>(results);
      }
      const results = await executeNodeCreateBatch(batchInputs, backend);
      await config.maybeRefreshStatisticsAfterBulk?.(results.length);
      return narrowNodes<N>(results);
    },

    async bulkUpsertById(
      items: readonly Readonly<{
        id: string;
        props: z.input<N["schema"]>;
        validFrom?: string;
        validTo?: string;
      }>[],
    ): Promise<Node<N>[]> {
      if (items.length === 0) return [];

      const upsertAll = async (
        target: GraphBackend | TransactionBackend,
      ): Promise<{ results: Node<N>[]; mutations: number }> => {
        const ids = items.map((item) => item.id);
        // Full existing rows: the coalesce dirty-check needs their stored
        // props, not just deleted_at.
        const existingMap = new Map<string, NodeRow>();

        if (target.getNodes === undefined) {
          const rows = await Promise.all(
            ids.map((id) => target.getNode(graphId, kind, id)),
          );
          for (const row of rows) {
            if (row !== undefined) existingMap.set(row.id, row);
          }
        } else {
          const rows = await target.getNodes(graphId, kind, ids);
          for (const row of rows) {
            existingMap.set(row.id, row);
          }
        }

        // Coalesced items are written straight to results (the existing node)
        // and skipped from the write batch; see the single-upsert path and
        // BaseStoreOptions.coalesceUnchangedUpserts.
        const results: Node<N>[] = Array.from({ length: items.length });

        // Bucket items into creates and updates
        const toCreate: { index: number; input: CreateNodeInput }[] = [];
        const toUpdate: {
          index: number;
          input: UpdateNodeInput;
          clearDeleted: boolean;
        }[] = [];

        // Only the FIRST occurrence of an id in this batch may coalesce: the
        // dirty-check compares against the once-prefetched row, so a later
        // same-id item would otherwise coalesce against stale state and drop
        // an earlier queued write (breaking last-write-wins). A repeated id
        // always writes; the sequential updates below re-read in order, so the
        // last item's value wins as before coalescing existed.
        const seenIds = new Set<string>();

        let itemIndex = 0;
        for (const item of items) {
          const existing = existingMap.get(item.id);
          const firstOccurrence = !seenIds.has(item.id);
          seenIds.add(item.id);

          if (existing) {
            if (
              firstOccurrence &&
              shouldCoalesceUpsert(existing, item, () =>
                config.isUpsertUnchanged?.(existing, item.props),
              )
            ) {
              results[itemIndex] = narrowNode<N>(rowToNode(existing));
            } else {
              toUpdate.push({
                index: itemIndex,
                input: buildUpdateInput(kind, item.id, item.props, item),
                clearDeleted: existing.deleted_at !== undefined,
              });
            }
          } else {
            toCreate.push({
              index: itemIndex,
              input: buildCreateInput(kind, item.props, item),
            });
          }
          itemIndex++;
        }

        if (toCreate.length > 0) {
          const createInputs = toCreate.map((entry) => entry.input);
          const created = await executeNodeCreateBatch(createInputs, target);
          for (const [index, entry] of toCreate.entries()) {
            results[entry.index] = narrowNode<N>(created[index]!);
          }
        }

        // Hookless individual updates
        for (const entry of toUpdate) {
          const result = await executeNodeUpsertUpdate(entry.input, target, {
            clearDeleted: entry.clearDeleted,
          });
          results[entry.index] = narrowNode<N>(result);
        }

        return { results, mutations: toCreate.length + toUpdate.length };
      };

      const { results, mutations } =
        backend.capabilities.transactions && "transaction" in backend ?
          await backend.transaction(async (txBackend) => upsertAll(txBackend))
        : await upsertAll(backend);
      // Match bulkCreate/bulkInsert: refresh planner statistics after a large
      // autocommit bulk write. Coalesced items wrote nothing, so only real
      // mutations count toward the threshold. A no-op inside a caller
      // transaction (the hook is intentionally undefined there).
      await config.maybeRefreshStatisticsAfterBulk?.(mutations);
      return results;
    },

    async bulkInsert(
      items: readonly Readonly<{
        props: z.input<N["schema"]>;
        id?: string;
        validFrom?: string;
        validTo?: string;
      }>[],
    ): Promise<void> {
      const batchInputs = mapBulkNodeInputs(kind, items);

      if (backend.capabilities.transactions && "transaction" in backend) {
        await backend.transaction(async (txBackend) => {
          await executeNodeCreateNoReturnBatch(batchInputs, txBackend);
        });
        await config.maybeRefreshStatisticsAfterBulk?.(batchInputs.length);
        return;
      }

      await executeNodeCreateNoReturnBatch(batchInputs, backend);
      await config.maybeRefreshStatisticsAfterBulk?.(batchInputs.length);
    },

    async bulkDelete(ids: readonly NodeId<N>[]): Promise<void> {
      if (ids.length === 0) return;
      const deleteAll = async (
        target: GraphBackend | TransactionBackend,
      ): Promise<void> => {
        for (const id of ids) {
          await executeNodeDelete(kind, id, target);
        }
      };
      if (backend.capabilities.transactions && "transaction" in backend) {
        await backend.transaction(async (txBackend) => deleteAll(txBackend));
        return;
      }
      await deleteAll(backend);
    },

    async findByConstraint(
      constraintName: string,
      props: z.input<N["schema"]>,
    ): Promise<Node<N> | undefined> {
      const result = await executeFindByConstraint(
        kind,
        constraintName,
        props,
        backend,
      );
      return result === undefined ? undefined : narrowNode<N>(result);
    },

    async bulkFindByConstraint(
      constraintName: string,
      items: readonly Readonly<{
        props: z.input<N["schema"]>;
      }>[],
    ): Promise<(Node<N> | undefined)[]> {
      if (items.length === 0) return [];

      const mappedItems = items.map((item) => ({
        props: item.props,
      }));

      const results = await executeBulkFindByConstraint(
        kind,
        constraintName,
        mappedItems,
        backend,
      );
      return results.map((result) =>
        result === undefined ? undefined : narrowNode<N>(result),
      );
    },

    async bulkFindByIndex(
      indexName: string,
      items: readonly Readonly<{
        props: Partial<z.input<N["schema"]>>;
      }>[],
      options?: NodeBulkFindByIndexOptions,
    ): Promise<readonly Node<N>[][]> {
      if (items.length === 0) return [];

      const mappedItems = items.map((item) => ({
        props: item.props,
      }));

      const results = await executeBulkFindByIndex(
        kind,
        indexName,
        mappedItems,
        backend,
        options,
      );
      return results.map((bucket) => narrowNodes<N>(bucket));
    },

    async getOrCreateByConstraint(
      constraintName: string,
      props: z.input<N["schema"]>,
      options?: NodeGetOrCreateByConstraintOptions,
    ): Promise<NodeGetOrCreateByConstraintResult<N>> {
      // No enclosing transaction: the found path is a pure read and must not
      // pay for one, and each write leg (create / upsert) opens its own
      // hooked transaction — nesting them here would fire their hooks before
      // this wrapper's COMMIT. Race convergence lives in
      // executeGetOrCreateByConstraint (re-probe on a create collision).
      const result = await executeGetOrCreateByConstraint(
        kind,
        constraintName,
        props,
        backend,
        options,
      );
      return result as NodeGetOrCreateByConstraintResult<N>;
    },

    async bulkGetOrCreateByConstraint(
      constraintName: string,
      items: readonly Readonly<{
        props: z.input<N["schema"]>;
      }>[],
      options?: NodeGetOrCreateByConstraintOptions,
    ): Promise<NodeGetOrCreateByConstraintResult<N>[]> {
      if (items.length === 0) return [];

      const mappedItems = items.map((item) => ({
        props: item.props,
      }));

      const getOrCreateAll = async (
        target: GraphBackend | TransactionBackend,
      ): Promise<NodeGetOrCreateByConstraintResult<N>[]> => {
        const results = await executeBulkGetOrCreateByConstraint(
          kind,
          constraintName,
          mappedItems,
          target,
          options,
        );
        return results as NodeGetOrCreateByConstraintResult<N>[];
      };

      if (backend.capabilities.transactions && "transaction" in backend) {
        return backend.transaction(async (txBackend) =>
          getOrCreateAll(txBackend),
        );
      }
      return getOrCreateAll(backend);
    },
  };
}
