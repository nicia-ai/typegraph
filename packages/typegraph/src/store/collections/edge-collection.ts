/**
 * EdgeCollection implementation.
 *
 * Provides an ergonomic API for CRUD operations on a specific edge type.
 */
import { type z } from "zod";

import {
  type GraphBackend,
  type TransactionBackend,
} from "../../backend/types";
import { type GraphDef } from "../../core/define-graph";
import { type QueryBuilder } from "../../query/builder";
import { type KindRegistry } from "../../registry";
import {
  type Edge,
  type EdgeCollection,
  type NodeRef,
  type QueryOptions,
} from "../types";

/**
 * Creates an EdgeCollection for a specific edge type.
 */
export function createEdgeCollection<
  G extends GraphDef,
  K extends keyof G["edges"] & string,
>(
  graphId: string,
  kind: K,
  _registry: KindRegistry,
  backend: GraphBackend | TransactionBackend,
  rowToEdge: (row: {
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
  }) => Edge,
  executeEdgeCreate: (
    input: {
      kind: string;
      id?: string;
      fromKind: string;
      fromId: string;
      toKind: string;
      toId: string;
      props: Record<string, unknown>;
      validFrom?: string;
      validTo?: string;
    },
    backend: GraphBackend | TransactionBackend,
  ) => Promise<Edge>,
  executeEdgeCreateNoReturnBatch: (
    inputs: readonly Readonly<{
      kind: string;
      id?: string;
      fromKind: string;
      fromId: string;
      toKind: string;
      toId: string;
      props: Record<string, unknown>;
      validFrom?: string;
      validTo?: string;
    }>[],
    backend: GraphBackend | TransactionBackend,
  ) => Promise<void>,
  executeEdgeCreateBatch: (
    inputs: readonly Readonly<{
      kind: string;
      id?: string;
      fromKind: string;
      fromId: string;
      toKind: string;
      toId: string;
      props: Record<string, unknown>;
      validFrom?: string;
      validTo?: string;
    }>[],
    backend: GraphBackend | TransactionBackend,
  ) => Promise<readonly Edge[]>,
  executeEdgeUpdate: (
    input: {
      id: string;
      props: Partial<Record<string, unknown>>;
      validTo?: string;
    },
    backend: GraphBackend | TransactionBackend,
  ) => Promise<Edge>,
  executeEdgeDelete: (
    id: string,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<void>,
  executeEdgeHardDelete: (
    id: string,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<void>,
  matchesTemporalMode: (
    row: {
      deleted_at: string | undefined;
      valid_from: string | undefined;
      valid_to: string | undefined;
    },
    options?: QueryOptions,
  ) => boolean,
  _createQuery?: () => QueryBuilder<GraphDef>,
): EdgeCollection<G["edges"][K]["type"]> {
  type E = G["edges"][K]["type"];

  return {
    async create(
      from: NodeRef,
      to: NodeRef,
      props?: z.input<E["schema"]>,
      options?: Readonly<{ id?: string; validFrom?: string; validTo?: string }>,
    ): Promise<Edge<E>> {
      const input: {
        kind: string;
        id?: string;
        fromKind: string;
        fromId: string;
        toKind: string;
        toId: string;
        props: Record<string, unknown>;
        validFrom?: string;
        validTo?: string;
      } = {
        kind: kind,
        fromKind: from.kind,
        fromId: from.id,
        toKind: to.kind,
        toId: to.id,
        props: (props ?? {}) as Record<string, unknown>,
      };
      if (options?.id !== undefined) input.id = options.id;
      if (options?.validFrom !== undefined) input.validFrom = options.validFrom;
      if (options?.validTo !== undefined) input.validTo = options.validTo;

      const result = await executeEdgeCreate(input, backend);
      return result as Edge<E>;
    },

    async getById(
      id: string,
      options?: QueryOptions,
    ): Promise<Edge<E> | undefined> {
      const row = await backend.getEdge(graphId, id);
      if (!row) return undefined;
      if (row.kind !== kind) return undefined; // Edge is a different type
      if (!matchesTemporalMode(row, options)) return undefined;
      return rowToEdge(row) as Edge<E>;
    },

    async getByIds(
      ids: readonly string[],
      options?: QueryOptions,
    ): Promise<readonly (Edge<E> | undefined)[]> {
      if (ids.length === 0) return [];

      if (backend.getEdges !== undefined) {
        const rows = await backend.getEdges(graphId, ids);
        const rowMap = new Map<string, (typeof rows)[number]>();
        for (const row of rows) {
          rowMap.set(row.id, row);
        }
        return ids.map((id) => {
          const row = rowMap.get(id);
          if (!row) return;
          if (row.kind !== kind) return;
          if (!matchesTemporalMode(row, options)) return;
          return rowToEdge(row) as Edge<E>;
        });
      }

      return Promise.all(
        ids.map(async (id) => {
          const row = await backend.getEdge(graphId, id);
          if (!row) return;
          if (row.kind !== kind) return;
          if (!matchesTemporalMode(row, options)) return;
          return rowToEdge(row) as Edge<E>;
        }),
      );
    },

    async update(
      id: string,
      props: Partial<z.input<E["schema"]>>,
      options?: Readonly<{ validTo?: string }>,
    ): Promise<Edge<E>> {
      const input: {
        id: string;
        props: Partial<Record<string, unknown>>;
        validTo?: string;
      } = {
        id,
        props: props as Partial<Record<string, unknown>>,
      };
      if (options?.validTo !== undefined) input.validTo = options.validTo;

      const result = await executeEdgeUpdate(input, backend);
      return result as Edge<E>;
    },

    async findFrom(from: NodeRef): Promise<Edge<E>[]> {
      const rows = await backend.findEdgesByKind({
        graphId,
        kind,
        fromKind: from.kind,
        fromId: from.id,
        excludeDeleted: true,
      });
      return rows.map((row) => rowToEdge(row) as Edge<E>);
    },

    async findTo(to: NodeRef): Promise<Edge<E>[]> {
      const rows = await backend.findEdgesByKind({
        graphId,
        kind,
        toKind: to.kind,
        toId: to.id,
        excludeDeleted: true,
      });
      return rows.map((row) => rowToEdge(row) as Edge<E>);
    },

    async delete(id: string): Promise<void> {
      await executeEdgeDelete(id, backend);
    },

    async hardDelete(id: string): Promise<void> {
      await executeEdgeHardDelete(id, backend);
    },

    async find(
      options?: Readonly<{
        from?: NodeRef;
        to?: NodeRef;
        limit?: number;
        offset?: number;
      }>,
    ): Promise<Edge<E>[]> {
      const untypedOptions = options as
        | Readonly<{ where?: unknown }>
        | undefined;
      if (untypedOptions?.where !== undefined) {
        throw new Error(
          `store.edges.${kind}.find({ where }) is not supported. ` +
            `Use store.query().traverse(...).whereEdge(...) for edge property filters.`,
        );
      }

      const params: {
        graphId: string;
        kind: string;
        fromKind?: string;
        fromId?: string;
        toKind?: string;
        toId?: string;
        limit?: number;
        offset?: number;
        excludeDeleted: boolean;
      } = {
        graphId,
        kind,
        excludeDeleted: true,
      };
      if (options?.from?.kind !== undefined)
        params.fromKind = options.from.kind;
      if (options?.from?.id !== undefined) params.fromId = options.from.id;
      if (options?.to?.kind !== undefined) params.toKind = options.to.kind;
      if (options?.to?.id !== undefined) params.toId = options.to.id;
      if (options?.limit !== undefined) params.limit = options.limit;
      if (options?.offset !== undefined) params.offset = options.offset;

      const rows = await backend.findEdgesByKind(params);
      return rows.map((row) => rowToEdge(row) as Edge<E>);
    },

    async count(
      options?: Readonly<{
        from?: NodeRef;
        to?: NodeRef;
      }>,
    ): Promise<number> {
      const params: {
        graphId: string;
        kind: string;
        fromKind?: string;
        fromId?: string;
        toKind?: string;
        toId?: string;
        excludeDeleted: boolean;
      } = {
        graphId,
        kind,
        excludeDeleted: true,
      };
      if (options?.from?.kind !== undefined)
        params.fromKind = options.from.kind;
      if (options?.from?.id !== undefined) params.fromId = options.from.id;
      if (options?.to?.kind !== undefined) params.toKind = options.to.kind;
      if (options?.to?.id !== undefined) params.toId = options.to.id;

      return backend.countEdgesByKind(params);
    },

    async bulkCreate(
      items: readonly Readonly<{
        from: NodeRef;
        to: NodeRef;
        props?: z.input<E["schema"]>;
        id?: string;
        validFrom?: string;
        validTo?: string;
      }>[],
      options?: Readonly<{ returnResults?: boolean }>,
    ): Promise<Edge<E>[]> {
      const shouldReturnResults = options?.returnResults ?? true;

      const batchInputs = items.map((item) => {
        const input: {
          kind: string;
          id?: string;
          fromKind: string;
          fromId: string;
          toKind: string;
          toId: string;
          props: Record<string, unknown>;
          validFrom?: string;
          validTo?: string;
        } = {
          kind: kind,
          fromKind: item.from.kind,
          fromId: item.from.id,
          toKind: item.to.kind,
          toId: item.to.id,
          props: (item.props ?? {}) as Record<string, unknown>,
        };
        if (item.id !== undefined) input.id = item.id;
        if (item.validFrom !== undefined) input.validFrom = item.validFrom;
        if (item.validTo !== undefined) input.validTo = item.validTo;
        return input;
      });

      if (!shouldReturnResults) {
        await ("transaction" in backend ?
          backend.transaction(async (txBackend) => {
            await executeEdgeCreateNoReturnBatch(batchInputs, txBackend);
          })
        : executeEdgeCreateNoReturnBatch(batchInputs, backend));
        return [];
      }

      const results = await executeEdgeCreateBatch(batchInputs, backend);
      return results as Edge<E>[];
    },

    async bulkInsert(
      items: readonly Readonly<{
        from: NodeRef;
        to: NodeRef;
        props?: z.input<E["schema"]>;
        id?: string;
        validFrom?: string;
        validTo?: string;
      }>[],
    ): Promise<void> {
      const batchInputs = items.map((item) => {
        const input: {
          kind: string;
          id?: string;
          fromKind: string;
          fromId: string;
          toKind: string;
          toId: string;
          props: Record<string, unknown>;
          validFrom?: string;
          validTo?: string;
        } = {
          kind: kind,
          fromKind: item.from.kind,
          fromId: item.from.id,
          toKind: item.to.kind,
          toId: item.to.id,
          props: (item.props ?? {}) as Record<string, unknown>,
        };
        if (item.id !== undefined) input.id = item.id;
        if (item.validFrom !== undefined) input.validFrom = item.validFrom;
        if (item.validTo !== undefined) input.validTo = item.validTo;
        return input;
      });

      if ("transaction" in backend) {
        await backend.transaction(async (txBackend) => {
          await executeEdgeCreateNoReturnBatch(batchInputs, txBackend);
        });
        return;
      }

      await executeEdgeCreateNoReturnBatch(batchInputs, backend);
    },

    async bulkDelete(ids: readonly string[]): Promise<void> {
      for (const id of ids) {
        try {
          await executeEdgeDelete(id, backend);
        } catch {
          // Silently ignore edges that don't exist
        }
      }
    },
  };
}
