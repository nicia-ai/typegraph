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
import { type NodeId, type TemporalMode } from "../../core/types";
import { type NodeType } from "../../core/types";
import { ConfigurationError } from "../../errors";
import { type QueryBuilder } from "../../query/builder";
import { nowIso } from "../../utils/date";
import { type NodeRow } from "../row-mappers";
import {
  type CreateNodeInput,
  type Node,
  type NodeCollection,
  type QueryOptions,
  type UpdateNodeInput,
} from "../types";

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

function mapBulkNodeInputs(
  kind: string,
  items: readonly Readonly<{
    props: Record<string, unknown>;
    id?: string;
    validFrom?: string;
    validTo?: string;
  }>[],
): CreateNodeInput[] {
  return items.map((item) => {
    const input: {
      kind: string;
      id?: string;
      props: Record<string, unknown>;
      validFrom?: string;
      validTo?: string;
    } = {
      kind,
      props: item.props,
    };
    if (item.id !== undefined) input.id = item.id;
    if (item.validFrom !== undefined) input.validFrom = item.validFrom;
    if (item.validTo !== undefined) input.validTo = item.validTo;
    return input;
  });
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
    matchesTemporalMode,
    createQuery,
  } = config;

  return {
    async create(
      props: z.input<N["schema"]>,
      options?: Readonly<{ id?: string; validFrom?: string; validTo?: string }>,
    ): Promise<Node<N>> {
      const input: {
        kind: string;
        id?: string;
        props: Record<string, unknown>;
        validFrom?: string;
        validTo?: string;
      } = {
        kind: kind,
        props: props as Record<string, unknown>,
      };
      if (options?.id !== undefined) input.id = options.id;
      if (options?.validFrom !== undefined) input.validFrom = options.validFrom;
      if (options?.validTo !== undefined) input.validTo = options.validTo;

      const result = await executeNodeCreate(input, backend);
      return narrowNode<N>(result);
    },

    async getById(
      id: NodeId<N>,
      options?: QueryOptions,
    ): Promise<Node<N> | undefined> {
      const row = await backend.getNode(graphId, kind, id);
      if (!row) return undefined;
      if (!matchesTemporalMode(row, options)) return undefined;
      return narrowNode<N>(rowToNode(row));
    },

    async getByIds(
      ids: readonly NodeId<N>[],
      options?: QueryOptions,
    ): Promise<readonly (Node<N> | undefined)[]> {
      if (ids.length === 0) return [];

      if (backend.getNodes !== undefined) {
        const rows = await backend.getNodes(
          graphId,
          kind,
          ids as readonly string[],
        );
        const rowMap = new Map<string, (typeof rows)[number]>();
        for (const row of rows) {
          rowMap.set(row.id, row);
        }
        return ids.map((id) => {
          const row = rowMap.get(id as string);
          if (!row) return;
          if (!matchesTemporalMode(row, options)) return;
          return narrowNode<N>(rowToNode(row));
        });
      }

      return Promise.all(
        ids.map(async (id) => {
          const row = await backend.getNode(graphId, kind, id as string);
          if (!row) return;
          if (!matchesTemporalMode(row, options)) return;
          return narrowNode<N>(rowToNode(row));
        }),
      );
    },

    async update(
      id: NodeId<N>,
      props: Partial<z.input<N["schema"]>>,
      options?: Readonly<{ validTo?: string }>,
    ): Promise<Node<N>> {
      const input: {
        kind: string;
        id: NodeId<N>;
        props: Partial<Record<string, unknown>>;
        validTo?: string;
      } = {
        kind: kind,
        id,
        props: props as Partial<Record<string, unknown>>,
      };
      if (options?.validTo !== undefined) input.validTo = options.validTo;

      const result = await executeNodeUpdate(input, backend);
      return narrowNode<N>(result);
    },

    async delete(id: NodeId<N>): Promise<void> {
      await executeNodeDelete(kind, id as string, backend);
    },

    async hardDelete(id: NodeId<N>): Promise<void> {
      await executeNodeHardDelete(kind, id as string, backend);
    },

    async find(
      options?: Readonly<{
        where?: (accessor: never) => unknown;
        limit?: number;
        offset?: number;
        temporalMode?: TemporalMode;
        asOf?: string;
      }>,
    ): Promise<Node<N>[]> {
      if (options?.where !== undefined && createQuery === undefined) {
        throw new ConfigurationError(
          `store.nodes.${kind}.find({ where }) requires a query-capable store`,
          { kind, operation: "find" },
        );
      }
      if (options?.where !== undefined && createQuery !== undefined) {
        const mode = options.temporalMode ?? defaultTemporalMode;
        let query = createQuery()
          .from(kind, "_n")
          .temporal(
            mode,
            mode === "asOf" ? (options.asOf ?? nowIso()) : undefined,
          )
          .whereNode("_n", options.where as never)
          .select((ctx: Record<string, unknown>) => ctx._n);
        if (options.limit !== undefined) query = query.limit(options.limit);
        if (options.offset !== undefined) query = query.offset(options.offset);
        const results = await query.execute();
        return results as Node<N>[];
      }

      const mode = options?.temporalMode ?? defaultTemporalMode;
      const params: {
        graphId: string;
        kind: string;
        limit?: number;
        offset?: number;
        excludeDeleted: boolean;
        temporalMode: TemporalMode;
        asOf?: string;
      } = {
        graphId,
        kind,
        excludeDeleted: mode !== "includeTombstones",
        temporalMode: mode,
      };
      if (mode === "current" || mode === "asOf") {
        params.asOf = options?.asOf ?? nowIso();
      }
      if (options?.limit !== undefined) params.limit = options.limit;
      if (options?.offset !== undefined) params.offset = options.offset;

      const rows = await backend.findNodesByKind(params);
      return rows.map((row) => narrowNode<N>(rowToNode(row)));
    },

    async count(options?: QueryOptions): Promise<number> {
      const mode = options?.temporalMode ?? defaultTemporalMode;
      const params: {
        graphId: string;
        kind: string;
        excludeDeleted: boolean;
        temporalMode: TemporalMode;
        asOf?: string;
      } = {
        graphId,
        kind,
        excludeDeleted: mode !== "includeTombstones",
        temporalMode: mode,
      };
      if (mode === "current" || mode === "asOf") {
        params.asOf = options?.asOf ?? nowIso();
      }
      return backend.countNodesByKind(params);
    },

    async upsert(
      id: string,
      props: z.input<N["schema"]>,
      options?: Readonly<{ validFrom?: string; validTo?: string }>,
    ): Promise<Node<N>> {
      // Check if node exists (including soft-deleted nodes)
      const existing = await backend.getNode(graphId, kind, id);

      if (existing) {
        // Update existing node (this also un-deletes soft-deleted nodes)
        const input: {
          kind: string;
          id: NodeId<N>;
          props: Partial<Record<string, unknown>>;
          validTo?: string;
        } = {
          kind: kind,
          id: id as NodeId<N>,
          props: props as Record<string, unknown>,
        };
        if (options?.validTo !== undefined) input.validTo = options.validTo;

        // If the node is soft-deleted, clear the deletion
        const clearDeleted = existing.deleted_at !== undefined;
        const result = await executeNodeUpdate(input, backend, {
          clearDeleted,
        });
        return narrowNode<N>(result);
      } else {
        // Create new node
        const input: {
          kind: string;
          id?: string;
          props: Record<string, unknown>;
          validFrom?: string;
          validTo?: string;
        } = {
          kind: kind,
          id,
          props: props as Record<string, unknown>,
        };
        if (options?.validFrom !== undefined)
          input.validFrom = options.validFrom;
        if (options?.validTo !== undefined) input.validTo = options.validTo;

        const result = await executeNodeCreate(input, backend);
        return narrowNode<N>(result);
      }
    },

    async bulkCreate(
      items: readonly Readonly<{
        props: z.input<N["schema"]>;
        id?: string;
        validFrom?: string;
        validTo?: string;
      }>[],
    ): Promise<Node<N>[]> {
      const batchInputs = mapBulkNodeInputs(
        kind,
        items as readonly Readonly<{
          props: Record<string, unknown>;
          id?: string;
          validFrom?: string;
          validTo?: string;
        }>[],
      );

      if (backend.capabilities.transactions && "transaction" in backend) {
        const results = await backend.transaction(async (txBackend) =>
          executeNodeCreateBatch(batchInputs, txBackend),
        );
        return narrowNodes<N>(results);
      }
      const results = await executeNodeCreateBatch(batchInputs, backend);
      return narrowNodes<N>(results);
    },

    async bulkUpsert(
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
      ): Promise<Node<N>[]> => {
        const ids = items.map((item) => item.id);
        const existingMap = new Map<
          string,
          {
            deleted_at: string | undefined;
          }
        >();

        if (target.getNodes === undefined) {
          const rows = await Promise.all(
            ids.map((id) => target.getNode(graphId, kind, id)),
          );
          for (const row of rows) {
            if (row !== undefined) existingMap.set(row.id, row);
          }
        } else {
          const rows = await target.getNodes(
            graphId,
            kind,
            ids as readonly string[],
          );
          for (const row of rows) {
            existingMap.set(row.id, row);
          }
        }

        // Bucket items into creates and updates
        const toCreate: { index: number; input: CreateNodeInput }[] = [];
        const toUpdate: {
          index: number;
          input: UpdateNodeInput;
          clearDeleted: boolean;
        }[] = [];

        let itemIndex = 0;
        for (const item of items) {
          const existing = existingMap.get(item.id);

          if (existing) {
            const input: {
              kind: string;
              id: NodeId<N>;
              props: Partial<Record<string, unknown>>;
              validTo?: string;
            } = {
              kind,
              id: item.id as NodeId<N>,
              props: item.props as Record<string, unknown>,
            };
            if (item.validTo !== undefined) input.validTo = item.validTo;

            toUpdate.push({
              index: itemIndex,
              input,
              clearDeleted: existing.deleted_at !== undefined,
            });
          } else {
            const input: {
              kind: string;
              id?: string;
              props: Record<string, unknown>;
              validFrom?: string;
              validTo?: string;
            } = {
              kind,
              id: item.id,
              props: item.props as Record<string, unknown>,
            };
            if (item.validFrom !== undefined) input.validFrom = item.validFrom;
            if (item.validTo !== undefined) input.validTo = item.validTo;

            toCreate.push({ index: itemIndex, input });
          }
          itemIndex++;
        }

        // Hookless batch create
        const results: Node<N>[] = Array.from({ length: items.length });

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

        return results;
      };

      if (backend.capabilities.transactions && "transaction" in backend) {
        return backend.transaction(async (txBackend) => upsertAll(txBackend));
      }
      return upsertAll(backend);
    },

    async bulkInsert(
      items: readonly Readonly<{
        props: z.input<N["schema"]>;
        id?: string;
        validFrom?: string;
        validTo?: string;
      }>[],
    ): Promise<void> {
      const batchInputs = mapBulkNodeInputs(
        kind,
        items as readonly Readonly<{
          props: Record<string, unknown>;
          id?: string;
          validFrom?: string;
          validTo?: string;
        }>[],
      );

      if (backend.capabilities.transactions && "transaction" in backend) {
        await backend.transaction(async (txBackend) => {
          await executeNodeCreateNoReturnBatch(batchInputs, txBackend);
        });
        return;
      }

      await executeNodeCreateNoReturnBatch(batchInputs, backend);
    },

    async bulkDelete(ids: readonly NodeId<N>[]): Promise<void> {
      if (ids.length === 0) return;
      const deleteAll = async (
        target: GraphBackend | TransactionBackend,
      ): Promise<void> => {
        for (const id of ids) {
          await executeNodeDelete(kind, id as string, target);
        }
      };
      if (backend.capabilities.transactions && "transaction" in backend) {
        await backend.transaction(async (txBackend) => deleteAll(txBackend));
        return;
      }
      await deleteAll(backend);
    },
  };
}
