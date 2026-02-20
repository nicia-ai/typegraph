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
import { type AnyEdgeType, type TemporalMode } from "../../core/types";
import { UnsupportedPredicateError } from "../../errors";
import { type QueryBuilder } from "../../query/builder";
import { nowIso } from "../../utils/date";
import { type EdgeRow } from "../row-mappers";
import {
  type CreateEdgeInput,
  type Edge,
  type EdgeCollection,
  type EdgeFindOrCreateOptions,
  type EdgeFindOrCreateResult,
  type NodeRef,
  type QueryOptions,
} from "../types";

/**
 * Narrows unparameterized Edge to Edge<E>.
 * Safe: props are validated by Zod at creation/update boundaries.
 */
function narrowEdge<E extends AnyEdgeType>(edge: Edge): Edge<E> {
  return edge as Edge<E>;
}

/**
 * Narrows a readonly Edge array to Edge<E>[].
 */
function narrowEdges<E extends AnyEdgeType>(edges: readonly Edge[]): Edge<E>[] {
  return edges as Edge<E>[];
}

/**
 * Config for creating an EdgeCollection.
 */
export type EdgeCollectionConfig = Readonly<{
  graphId: string;
  kind: string;
  backend: GraphBackend | TransactionBackend;
  defaultTemporalMode: TemporalMode;
  rowToEdge: (row: EdgeRow) => Edge;
  executeCreate: (
    input: CreateEdgeInput,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<Edge>;
  executeCreateNoReturnBatch: (
    inputs: readonly CreateEdgeInput[],
    backend: GraphBackend | TransactionBackend,
  ) => Promise<void>;
  executeCreateBatch: (
    inputs: readonly CreateEdgeInput[],
    backend: GraphBackend | TransactionBackend,
  ) => Promise<readonly Edge[]>;
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
  executeFindOrCreate: (
    kind: string,
    fromKind: string,
    fromId: string,
    toKind: string,
    toId: string,
    props: Record<string, unknown>,
    backend: GraphBackend | TransactionBackend,
    options?: Readonly<{
      matchOn?: readonly string[];
      onConflict?: "skip" | "update";
    }>,
  ) => Promise<Readonly<{ edge: Edge; created: boolean }>>;
  executeBulkFindOrCreate: (
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
      onConflict?: "skip" | "update";
    }>,
  ) => Promise<Readonly<{ edge: Edge; created: boolean }>[]>;
}>;

function mapBulkEdgeInputs(
  kind: string,
  items: readonly Readonly<{
    from: NodeRef;
    to: NodeRef;
    props?: Record<string, unknown>;
    id?: string;
    validFrom?: string;
    validTo?: string;
  }>[],
): CreateEdgeInput[] {
  return items.map((item) => {
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
      kind,
      fromKind: item.from.kind,
      fromId: item.from.id,
      toKind: item.to.kind,
      toId: item.to.id,
      props: item.props ?? {},
    };
    if (item.id !== undefined) input.id = item.id;
    if (item.validFrom !== undefined) input.validFrom = item.validFrom;
    if (item.validTo !== undefined) input.validTo = item.validTo;
    return input;
  });
}

/**
 * Creates an EdgeCollection for a specific edge type.
 */
export function createEdgeCollection<
  G extends GraphDef,
  K extends keyof G["edges"] & string,
>(config: EdgeCollectionConfig): EdgeCollection<G["edges"][K]["type"]> {
  type E = G["edges"][K]["type"];

  const {
    graphId,
    kind,
    backend,
    defaultTemporalMode,
    rowToEdge,
    executeCreate: executeEdgeCreate,
    executeCreateNoReturnBatch: executeEdgeCreateNoReturnBatch,
    executeCreateBatch: executeEdgeCreateBatch,
    executeUpdate: executeEdgeUpdate,
    executeUpsertUpdate: executeEdgeUpsertUpdate,
    executeDelete: executeEdgeDelete,
    executeHardDelete: executeEdgeHardDelete,
    matchesTemporalMode,
  } = config;

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
      return narrowEdge<E>(result);
    },

    async getById(
      id: string,
      options?: QueryOptions,
    ): Promise<Edge<E> | undefined> {
      const row = await backend.getEdge(graphId, id);
      if (!row) return undefined;
      if (row.kind !== kind) return undefined; // Edge is a different type
      if (!matchesTemporalMode(row, options)) return undefined;
      return narrowEdge<E>(rowToEdge(row));
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
          return narrowEdge<E>(rowToEdge(row));
        });
      }

      return Promise.all(
        ids.map(async (id) => {
          const row = await backend.getEdge(graphId, id);
          if (!row) return;
          if (row.kind !== kind) return;
          if (!matchesTemporalMode(row, options)) return;
          return narrowEdge<E>(rowToEdge(row));
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
      return narrowEdge<E>(result);
    },

    async findFrom(from: NodeRef): Promise<Edge<E>[]> {
      const rows = await backend.findEdgesByKind({
        graphId,
        kind,
        fromKind: from.kind,
        fromId: from.id,
        excludeDeleted: true,
      });
      return rows.map((row) => narrowEdge<E>(rowToEdge(row)));
    },

    async findTo(to: NodeRef): Promise<Edge<E>[]> {
      const rows = await backend.findEdgesByKind({
        graphId,
        kind,
        toKind: to.kind,
        toId: to.id,
        excludeDeleted: true,
      });
      return rows.map((row) => narrowEdge<E>(rowToEdge(row)));
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
        temporalMode?: TemporalMode;
        asOf?: string;
      }>,
    ): Promise<Edge<E>[]> {
      const untypedOptions = options as
        | Readonly<{ where?: unknown }>
        | undefined;
      if (untypedOptions?.where !== undefined) {
        throw new UnsupportedPredicateError(
          `store.edges.${kind}.find({ where }) is not supported. ` +
            `Use store.query().traverse(...).whereEdge(...) for edge property filters.`,
          { kind, operation: "find" },
        );
      }

      const mode = options?.temporalMode ?? defaultTemporalMode;
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
      if (options?.from?.kind !== undefined)
        params.fromKind = options.from.kind;
      if (options?.from?.id !== undefined) params.fromId = options.from.id;
      if (options?.to?.kind !== undefined) params.toKind = options.to.kind;
      if (options?.to?.id !== undefined) params.toId = options.to.id;
      if (options?.limit !== undefined) params.limit = options.limit;
      if (options?.offset !== undefined) params.offset = options.offset;

      const rows = await backend.findEdgesByKind(params);
      return rows.map((row) => narrowEdge<E>(rowToEdge(row)));
    },

    async count(
      options?: Readonly<{
        from?: NodeRef;
        to?: NodeRef;
        temporalMode?: TemporalMode;
        asOf?: string;
      }>,
    ): Promise<number> {
      const mode = options?.temporalMode ?? defaultTemporalMode;
      const params: {
        graphId: string;
        kind: string;
        fromKind?: string;
        fromId?: string;
        toKind?: string;
        toId?: string;
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
    ): Promise<Edge<E>[]> {
      const batchInputs = mapBulkEdgeInputs(
        kind,
        items as readonly Readonly<{
          from: NodeRef;
          to: NodeRef;
          props?: Record<string, unknown>;
          id?: string;
          validFrom?: string;
          validTo?: string;
        }>[],
      );

      if (backend.capabilities.transactions && "transaction" in backend) {
        const results = await backend.transaction(async (txBackend) =>
          executeEdgeCreateBatch(batchInputs, txBackend),
        );
        return narrowEdges<E>(results);
      }
      const results = await executeEdgeCreateBatch(batchInputs, backend);
      return narrowEdges<E>(results);
    },

    async bulkUpsert(
      items: readonly Readonly<{
        id: string;
        from: NodeRef;
        to: NodeRef;
        props?: z.input<E["schema"]>;
        validFrom?: string;
        validTo?: string;
      }>[],
    ): Promise<Edge<E>[]> {
      if (items.length === 0) return [];

      const upsertAll = async (
        target: GraphBackend | TransactionBackend,
      ): Promise<Edge<E>[]> => {
        const ids = items.map((item) => item.id);
        const existingMap = new Map<
          string,
          { deleted_at: string | undefined }
        >();

        if (target.getEdges === undefined) {
          const rows = await Promise.all(
            ids.map((id) => target.getEdge(graphId, id)),
          );
          for (const row of rows) {
            if (row !== undefined) existingMap.set(row.id, row);
          }
        } else {
          const rows = await target.getEdges(graphId, ids);
          for (const row of rows) {
            existingMap.set(row.id, row);
          }
        }

        // Bucket items into creates and updates
        const toCreate: { index: number; input: CreateEdgeInput }[] = [];
        const toUpdate: {
          index: number;
          input: {
            id: string;
            props: Partial<Record<string, unknown>>;
            validTo?: string;
          };
          clearDeleted: boolean;
        }[] = [];

        let itemIndex = 0;
        for (const item of items) {
          const existing = existingMap.get(item.id);

          if (existing) {
            const input: {
              id: string;
              props: Partial<Record<string, unknown>>;
              validTo?: string;
            } = {
              id: item.id,
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
              fromKind: string;
              fromId: string;
              toKind: string;
              toId: string;
              props: Record<string, unknown>;
              validFrom?: string;
              validTo?: string;
            } = {
              kind,
              id: item.id,
              fromKind: item.from.kind,
              fromId: item.from.id,
              toKind: item.to.kind,
              toId: item.to.id,
              props: item.props as Record<string, unknown>,
            };
            if (item.validFrom !== undefined) input.validFrom = item.validFrom;
            if (item.validTo !== undefined) input.validTo = item.validTo;

            toCreate.push({ index: itemIndex, input });
          }
          itemIndex++;
        }

        // Hookless batch create
        const results: Edge<E>[] = Array.from({ length: items.length });

        if (toCreate.length > 0) {
          const createInputs = toCreate.map((entry) => entry.input);
          const created = await executeEdgeCreateBatch(createInputs, target);
          for (const [index, entry] of toCreate.entries()) {
            results[entry.index] = narrowEdge<E>(created[index]!);
          }
        }

        // Hookless individual updates (executeEdgeUpsertUpdate is already hookless)
        for (const entry of toUpdate) {
          const result = await executeEdgeUpsertUpdate(entry.input, target, {
            clearDeleted: entry.clearDeleted,
          });
          results[entry.index] = narrowEdge<E>(result);
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
        from: NodeRef;
        to: NodeRef;
        props?: z.input<E["schema"]>;
        id?: string;
        validFrom?: string;
        validTo?: string;
      }>[],
    ): Promise<void> {
      const batchInputs = mapBulkEdgeInputs(
        kind,
        items as readonly Readonly<{
          from: NodeRef;
          to: NodeRef;
          props?: Record<string, unknown>;
          id?: string;
          validFrom?: string;
          validTo?: string;
        }>[],
      );

      if (backend.capabilities.transactions && "transaction" in backend) {
        await backend.transaction(async (txBackend) => {
          await executeEdgeCreateNoReturnBatch(batchInputs, txBackend);
        });
        return;
      }

      await executeEdgeCreateNoReturnBatch(batchInputs, backend);
    },

    async bulkDelete(ids: readonly string[]): Promise<void> {
      if (ids.length === 0) return;
      const deleteAll = async (
        target: GraphBackend | TransactionBackend,
      ): Promise<void> => {
        for (const id of ids) {
          await executeEdgeDelete(id, target);
        }
      };
      if (backend.capabilities.transactions && "transaction" in backend) {
        await backend.transaction(async (txBackend) => deleteAll(txBackend));
        return;
      }
      await deleteAll(backend);
    },

    async findOrCreate(
      from: NodeRef,
      to: NodeRef,
      props: z.input<E["schema"]>,
      options?: EdgeFindOrCreateOptions<E>,
    ): Promise<EdgeFindOrCreateResult<E>> {
      const findOrCreateOptions: {
        matchOn?: readonly string[];
        onConflict?: "skip" | "update";
      } = {};
      if (options?.matchOn !== undefined)
        findOrCreateOptions.matchOn = options.matchOn as readonly string[];
      if (options?.onConflict !== undefined)
        findOrCreateOptions.onConflict = options.onConflict;

      const result = await config.executeFindOrCreate(
        kind,
        from.kind,
        from.id,
        to.kind,
        to.id,
        props as Record<string, unknown>,
        backend,
        findOrCreateOptions,
      );
      return { edge: narrowEdge<E>(result.edge), created: result.created };
    },

    async bulkFindOrCreate(
      items: readonly Readonly<{
        from: NodeRef;
        to: NodeRef;
        props: z.input<E["schema"]>;
      }>[],
      options?: EdgeFindOrCreateOptions<E>,
    ): Promise<EdgeFindOrCreateResult<E>[]> {
      if (items.length === 0) return [];

      const mappedItems = items.map((item) => ({
        fromKind: item.from.kind,
        fromId: item.from.id,
        toKind: item.to.kind,
        toId: item.to.id,
        props: item.props as Record<string, unknown>,
      }));

      const findOrCreateOptions: {
        matchOn?: readonly string[];
        onConflict?: "skip" | "update";
      } = {};
      if (options?.matchOn !== undefined)
        findOrCreateOptions.matchOn = options.matchOn as readonly string[];
      if (options?.onConflict !== undefined)
        findOrCreateOptions.onConflict = options.onConflict;

      const findOrCreateAll = async (
        target: GraphBackend | TransactionBackend,
      ): Promise<EdgeFindOrCreateResult<E>[]> => {
        const results = await config.executeBulkFindOrCreate(
          kind,
          mappedItems,
          target,
          findOrCreateOptions,
        );
        return results.map((result) => ({
          edge: narrowEdge<E>(result.edge),
          created: result.created,
        }));
      };

      if (backend.capabilities.transactions && "transaction" in backend) {
        return backend.transaction(async (txBackend) =>
          findOrCreateAll(txBackend),
        );
      }
      return findOrCreateAll(backend);
    },
  };
}
