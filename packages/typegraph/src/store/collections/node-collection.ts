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
import { type NodeId } from "../../core/types";
import { type KindRegistry } from "../../registry";
import { type Node, type NodeCollection, type QueryOptions } from "../types";

/**
 * Creates a NodeCollection for a specific node type.
 */
export function createNodeCollection<
  G extends GraphDef,
  K extends keyof G["nodes"] & string,
>(
  graphId: string,
  kind: K,
  _registry: KindRegistry,
  backend: GraphBackend | TransactionBackend,
  rowToNode: (row: {
    kind: string;
    id: string;
    props: string;
    version: number;
    valid_from: string | undefined;
    valid_to: string | undefined;
    created_at: string;
    updated_at: string;
    deleted_at: string | undefined;
  }) => Node,
  executeNodeCreate: (
    input: {
      kind: string;
      id?: string;
      props: Record<string, unknown>;
      validFrom?: string;
      validTo?: string;
    },
    backend: GraphBackend | TransactionBackend,
  ) => Promise<Node>,
  executeNodeUpdate: (
    input: {
      kind: string;
      id: string;
      props: Partial<Record<string, unknown>>;
      validTo?: string;
    },
    backend: GraphBackend | TransactionBackend,
    options?: Readonly<{ clearDeleted?: boolean }>,
  ) => Promise<Node>,
  executeNodeDelete: (
    kind: string,
    id: string,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<void>,
  executeNodeHardDelete: (
    kind: string,
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
): NodeCollection<G["nodes"][K]["type"]> {
  type N = G["nodes"][K]["type"];

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
      return result as Node<N>;
    },

    async getById(
      id: NodeId<N>,
      options?: QueryOptions,
    ): Promise<Node<N> | undefined> {
      const row = await backend.getNode(graphId, kind, id);
      if (!row) return undefined;
      if (!matchesTemporalMode(row, options)) return undefined;
      return rowToNode(row) as Node<N>;
    },

    async update(
      id: NodeId<N>,
      props: Partial<z.input<N["schema"]>>,
      options?: Readonly<{ validTo?: string }>,
    ): Promise<Node<N>> {
      const input: {
        kind: string;
        id: string;
        props: Partial<Record<string, unknown>>;
        validTo?: string;
      } = {
        kind: kind,
        id: id as string,
        props: props as Partial<Record<string, unknown>>,
      };
      if (options?.validTo !== undefined) input.validTo = options.validTo;

      const result = await executeNodeUpdate(input, backend);
      return result as Node<N>;
    },

    async delete(id: NodeId<N>): Promise<void> {
      await executeNodeDelete(kind, id as string, backend);
    },

    async hardDelete(id: NodeId<N>): Promise<void> {
      await executeNodeHardDelete(kind, id as string, backend);
    },

    async find(
      options?: Readonly<{ limit?: number; offset?: number }>,
    ): Promise<Node<N>[]> {
      const params: {
        graphId: string;
        kind: string;
        limit?: number;
        offset?: number;
        excludeDeleted: boolean;
      } = {
        graphId,
        kind,
        excludeDeleted: true,
      };
      if (options?.limit !== undefined) params.limit = options.limit;
      if (options?.offset !== undefined) params.offset = options.offset;

      const rows = await backend.findNodesByKind(params);
      return rows.map((row) => rowToNode(row) as Node<N>);
    },

    async count(): Promise<number> {
      return backend.countNodesByKind({
        graphId,
        kind,
        excludeDeleted: true,
      });
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
          id: string;
          props: Partial<Record<string, unknown>>;
          validTo?: string;
        } = {
          kind: kind,
          id,
          props: props as Record<string, unknown>,
        };
        if (options?.validTo !== undefined) input.validTo = options.validTo;

        // If the node is soft-deleted, clear the deletion
        const clearDeleted = existing.deleted_at !== undefined;
        const result = await executeNodeUpdate(input, backend, {
          clearDeleted,
        });
        return result as Node<N>;
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
        return result as Node<N>;
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
      const results: Node<N>[] = [];

      for (const item of items) {
        const input: {
          kind: string;
          id?: string;
          props: Record<string, unknown>;
          validFrom?: string;
          validTo?: string;
        } = {
          kind: kind,
          props: item.props as Record<string, unknown>,
        };
        if (item.id !== undefined) input.id = item.id;
        if (item.validFrom !== undefined) input.validFrom = item.validFrom;
        if (item.validTo !== undefined) input.validTo = item.validTo;

        const result = await executeNodeCreate(input, backend);
        results.push(result as Node<N>);
      }

      return results;
    },

    async bulkUpsert(
      items: readonly Readonly<{
        id: string;
        props: z.input<N["schema"]>;
        validFrom?: string;
        validTo?: string;
      }>[],
    ): Promise<Node<N>[]> {
      const results: Node<N>[] = [];

      for (const item of items) {
        // Check if node exists (including soft-deleted nodes)
        const existing = await backend.getNode(graphId, kind, item.id);

        if (existing) {
          // Update existing node (this also un-deletes soft-deleted nodes)
          const input: {
            kind: string;
            id: string;
            props: Partial<Record<string, unknown>>;
            validTo?: string;
          } = {
            kind: kind,
            id: item.id,
            props: item.props as Record<string, unknown>,
          };
          if (item.validTo !== undefined) input.validTo = item.validTo;

          // If the node is soft-deleted, clear the deletion
          const clearDeleted = existing.deleted_at !== undefined;
          const result = await executeNodeUpdate(input, backend, {
            clearDeleted,
          });
          results.push(result as Node<N>);
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
            id: item.id,
            props: item.props as Record<string, unknown>,
          };
          if (item.validFrom !== undefined) input.validFrom = item.validFrom;
          if (item.validTo !== undefined) input.validTo = item.validTo;

          const result = await executeNodeCreate(input, backend);
          results.push(result as Node<N>);
        }
      }

      return results;
    },

    async bulkDelete(ids: readonly NodeId<N>[]): Promise<void> {
      for (const id of ids) {
        try {
          await executeNodeDelete(kind, id as string, backend);
        } catch {
          // Silently ignore nodes that don't exist
        }
      }
    },
  };
}
