/**
 * EdgeCollection implementation.
 *
 * Provides an ergonomic API for CRUD operations on a specific edge type.
 */
import { type z } from "zod";

import { type BATCH_POINT_READ } from "../../backend/capabilities/bundle-registry";
import { type BundleVerdictOf } from "../../backend/capabilities/resolve";
import {
  type EdgeEndpointSide,
  type EdgeRow as BackendEdgeRow,
  type FindEdgesByKindParams,
  type GraphBackend,
  rowPropsToObject,
  runOptionallyInTransaction,
  type TransactionBackend,
} from "../../backend/types";
import { type GraphDef } from "../../core/define-graph";
import { type AnyEdgeType, type TemporalMode } from "../../core/types";
import {
  ConfigurationError,
  UnsupportedPredicateError,
  ValidationError,
} from "../../errors";
import { type QueryBuilder } from "../../query/builder";
import type { BatchableQuery } from "../../query/builder/types";
import { groupBy } from "../../utils/array";
import { requireDefined } from "../../utils/presence";
import { encodeTupleKey } from "../../utils/tuple-key";
import { getEdgeRowsByIds } from "../edge-fetch";
import {
  assertEdgeIdentityMatches,
  type EdgeIdentity,
  type EdgeIdentityExpectation,
  edgeIdentityFromRow,
} from "../operations/edge-identity";
import {
  type ResolvedMutationSetAttempt,
  runResolvedMutationSetConverging,
} from "../resolved-mutation-set";
import { type EdgeRow } from "../row-mappers";
import {
  type CreateEdgeInput,
  type Edge,
  type EdgeBulkFindEndpointOptions,
  type EdgeCollection,
  type EdgeFindByEndpointsOptions,
  type EdgeGetOrCreateByEndpointsOptions,
  type EdgeGetOrCreateByEndpointsResult,
  type GetOrCreateAction,
  type IfExistsMode,
  type NodeRef,
  type QueryOptions,
  type ValidityEndMutation,
} from "../types";
import {
  assertClearValidToSupported,
  assertValidityEndMutation,
} from "../validity-end";
import {
  findRepeatedUpsertIds,
  type UpsertDirtyCheck,
  type UpsertDirtyCheckFunction,
  type UpsertWindow,
  upsertWindowChanges,
  windowAfterUpsertCreate,
  windowAfterUpsertUpdate,
} from "./coalesce";
import {
  resolveTemporalReadParams,
  type TemporalReadParams,
} from "./temporal-read-params";

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
  /** Threaded `batchPointRead` verdict — never re-resolved here. */
  batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>;
  defaultTemporalMode: TemporalMode;
  rowToEdge: (row: EdgeRow) => Edge;
  /** See EdgeOperations.maybeRefreshStatisticsAfterBulk. */
  maybeRefreshStatisticsAfterBulk?:
    ((rowCount: number) => Promise<void>) | undefined;
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
      identity: EdgeIdentityExpectation;
      props: Partial<Record<string, unknown>>;
      validTo?: string;
      clearValidTo?: true;
    },
    backend: GraphBackend | TransactionBackend,
  ) => Promise<Edge>;
  executeUpsertUpdateBatch: (
    entries: readonly EdgeUpsertUpdateBatchEntry[],
    backend: GraphBackend | TransactionBackend,
  ) => Promise<readonly Edge[]>;
  executeResolvedMutationSet: (
    creates: readonly CreateEdgeInput[],
    updates: readonly EdgeUpsertUpdateBatchEntry[],
    backend: GraphBackend | TransactionBackend,
  ) => Promise<
    ResolvedMutationSetAttempt<
      Readonly<{ created: readonly Edge[]; updated: readonly Edge[] }>
    >
  >;
  /** See EdgeOperations.upsertDirtyCheck. */
  upsertDirtyCheck?: UpsertDirtyCheckFunction;
  executeDelete: (
    kind: string,
    id: string,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<void>;
  executeDeleteBatch: (
    kind: string,
    ids: readonly string[],
    backend: GraphBackend | TransactionBackend,
  ) => Promise<void>;
  executeHardDelete: (
    kind: string,
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
      validFrom?: string;
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
      validFrom?: string;
      validTo?: string;
      clearValidTo?: true;
      onImmutableLowerBound?: "preserve" | "refuse";
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
      excludeDeleted?: boolean;
      temporalMode?: TemporalMode;
      asOf?: string;
    }>,
  ) => Promise<Edge | undefined>;
}>;

function buildCreateEdgeInput(
  kind: string,
  from: NodeRef,
  to: NodeRef,
  props: Record<string, unknown>,
  options?: Readonly<{ id?: string; validFrom?: string; validTo?: string }>,
): CreateEdgeInput {
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
    fromKind: from.kind,
    fromId: from.id,
    toKind: to.kind,
    toId: to.id,
    props,
  };
  if (options?.id !== undefined) input.id = options.id;
  if (options?.validFrom !== undefined) input.validFrom = options.validFrom;
  if (options?.validTo !== undefined) input.validTo = options.validTo;
  return input;
}

/** The scalar endpoint predicate of a `findFrom` / `findTo` read. */
type EdgeEndpointPredicate =
  | Readonly<{ fromKind: string; fromId: string }>
  | Readonly<{ toKind: string; toId: string }>;

type EdgeUpdateInput = Readonly<{
  id: string;
  identity: EdgeIdentityExpectation;
  props: Partial<Record<string, unknown>>;
  validTo?: string;
  clearValidTo?: true;
}>;

/**
 * Update input for the internal upsert path, which owns the WHOLE validity
 * window: a resurrecting upsert rewrites both endpoints, so it must be able to
 * carry `validFrom` as well as `validTo`. Dropping `validFrom` here would leave
 * the backend defaulting the lower bound to the resurrection instant while the
 * caller's (possibly already past) `validTo` stayed — an inverted window that
 * no read coordinate can observe.
 *
 * The public `update()` API cannot reach this member: its options type exposes
 * `validTo` only, and it builds its input through {@link buildUpdateEdgeInput}.
 * `bulkUpsertById` and endpoint-matched upserts route through this input because
 * both may accept `validFrom`; only the endpoint surface currently exposes the
 * create/resurrection-only policy.
 */
export type UpsertUpdateEdgeInput = EdgeUpdateInput &
  Readonly<{
    validFrom?: string;
    onImmutableLowerBound?: "preserve" | "refuse";
  }>;

export type EdgeUpsertUpdateBatchEntry = Readonly<{
  input: UpsertUpdateEdgeInput;
  clearDeleted: boolean;
  existing?: BackendEdgeRow;
}>;

function buildUpdateEdgeInput(
  kind: string,
  id: string,
  props: Record<string, unknown>,
  options?: ValidityEndMutation,
): EdgeUpdateInput {
  const input: {
    id: string;
    identity: EdgeIdentityExpectation;
    props: Partial<Record<string, unknown>>;
    validTo?: string;
    clearValidTo?: true;
  } = { id, identity: { kind }, props };
  if (options?.validTo !== undefined) input.validTo = options.validTo;
  if (options?.clearValidTo === true) input.clearValidTo = true;
  return input;
}

/** Builds an {@link UpsertUpdateEdgeInput} — see that type for why upsert alone carries `validFrom`. */
function buildUpsertUpdateEdgeInput(
  kind: string,
  id: string,
  from: NodeRef,
  to: NodeRef,
  props: Record<string, unknown>,
  options?: Readonly<{
    validFrom?: string;
    validTo?: string;
    clearValidTo?: true;
  }>,
): UpsertUpdateEdgeInput {
  const input: {
    id: string;
    identity: EdgeIdentityExpectation;
    props: Partial<Record<string, unknown>>;
    validFrom?: string;
    validTo?: string;
    clearValidTo?: true;
  } = {
    id,
    identity: {
      kind,
      fromKind: from.kind,
      fromId: from.id,
      toKind: to.kind,
      toId: to.id,
    },
    props,
  };
  if (options?.validFrom !== undefined) input.validFrom = options.validFrom;
  if (options?.validTo !== undefined) input.validTo = options.validTo;
  if (options?.clearValidTo === true) input.clearValidTo = true;
  return input;
}

/**
 * Composite bucket key for an endpoint. Node ids are unique per kind, not
 * globally, so the kind is part of the key — the same key shape the endpoint
 * predicate itself uses (`from_kind` + `from_id`).
 */
function endpointKey(endpointKind: string, id: string): string {
  return encodeTupleKey([endpointKind, id]);
}

/**
 * Buckets endpoint refs into one id list per kind, preserving input order.
 * Repeated ids are left in place — the backend dedupes an endpoint set before
 * splitting it into bind-budget chunks, which is the only place duplicates
 * could do harm.
 */
function groupEndpointIdsByKind(
  references: readonly NodeRef[],
): Map<string, string[]> {
  const referencesByKind = groupBy(references, (ref) => ref.kind);
  return new Map(
    [...referencesByKind].map(([endpointKind, group]) => [
      endpointKind,
      group.map((ref) => ref.id),
    ]),
  );
}

/**
 * Validates the caller-facing fan-out cap. This runs in the collection rather
 * than only in the backend because the cap is not always pushed into SQL: on a
 * backend without window functions it is applied in JS, where an invalid value
 * would silently truncate instead of failing.
 */
function assertLimitPerInput(
  kind: string,
  limitPerInput: number | undefined,
): void {
  if (limitPerInput === undefined) return;
  if (Number.isInteger(limitPerInput) && limitPerInput > 0) return;
  throw new ValidationError(
    "bulk endpoint reads require limitPerInput to be a positive integer",
    {
      entityType: "edge",
      kind,
      issues: [
        {
          path: "limitPerInput",
          message: `Expected a positive integer, received ${String(limitPerInput)}`,
          code: "invalid_value",
        },
      ],
    },
  );
}

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
  return items.map((item) =>
    buildCreateEdgeInput(kind, item.from, item.to, item.props ?? {}, item),
  );
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
    batchPointRead,
    defaultTemporalMode,
    rowToEdge,
    executeCreate: executeEdgeCreate,
    executeCreateNoReturnBatch: executeEdgeCreateNoReturnBatch,
    executeCreateBatch: executeEdgeCreateBatch,
    executeUpdate: executeEdgeUpdate,
    executeUpsertUpdateBatch: executeEdgeUpsertUpdateBatch,
    executeResolvedMutationSet: executeEdgeResolvedMutationSet,
    executeDelete: executeEdgeDelete,
    executeDeleteBatch: executeEdgeDeleteBatch,
    executeHardDelete: executeEdgeHardDelete,
    temporalRowMatcher,
  } = config;

  const mapRows = (rows: readonly EdgeRow[]): Edge<E>[] =>
    rows.map((row) => narrowEdge<E>(rowToEdge(row)));

  /**
   * Builds the `findEdgesByKind` params for an endpoint lookup, resolving
   * the temporal mode the same way `find` / `getById` do: the per-call
   * `options` win, falling back to the graph's default mode. Keeps
   * `findFrom` / `findTo` honoring the temporal model instead of silently
   * returning every non-deleted edge.
   *
   * The scalar and set forms of the endpoint predicate share this builder, so
   * `bulkFindFrom` / `bulkFindTo` cannot resolve a different coordinate than
   * the singleton reads they widen.
   */
  function buildEndpointFindParams(
    endpoint: EdgeEndpointPredicate,
    temporal: TemporalReadParams,
  ): FindEdgesByKindParams {
    return { graphId, kind, ...endpoint, ...temporal };
  }

  async function findEdgesFrom(
    from: NodeRef,
    target: GraphBackend | TransactionBackend,
    options?: QueryOptions,
  ): Promise<Edge<E>[]> {
    const rows = await target.findEdgesByKind(
      buildEndpointFindParams(
        { fromKind: from.kind, fromId: from.id },
        resolveTemporalReadParams(options, defaultTemporalMode),
      ),
    );
    return mapRows(rows);
  }

  async function findEdgesTo(
    to: NodeRef,
    target: GraphBackend | TransactionBackend,
    options?: QueryOptions,
  ): Promise<Edge<E>[]> {
    const rows = await target.findEdgesByKind(
      buildEndpointFindParams(
        { toKind: to.kind, toId: to.id },
        resolveTemporalReadParams(options, defaultTemporalMode),
      ),
    );
    return mapRows(rows);
  }

  /**
   * Shared implementation of `bulkFindFrom` / `bulkFindTo`: `findEdgesFrom` /
   * `findEdgesTo` with the endpoint equality widened to set membership.
   *
   * The edge relation's system index is keyed
   * `(graph_id, from_kind, from_id, kind, ...)`, so the id set is issued per
   * endpoint KIND — a set within one kind is a prefix seek, while mixing kinds
   * would force a scan. Inputs of a single kind therefore cost one statement
   * per bind-budget chunk rather than one statement per endpoint.
   */
  async function findEdgesByEndpointSet(
    side: EdgeEndpointSide,
    references: readonly NodeRef[],
    options?: EdgeBulkFindEndpointOptions,
  ): Promise<Edge<E>[][]> {
    if (references.length === 0) return [];

    const method = side === "from" ? "bulkFindFrom" : "bulkFindTo";
    const readEndpointSet = backend.findEdgesByEndpointSet;
    if (readEndpointSet === undefined) {
      throw new ConfigurationError(
        `store.edges.${kind}.${method}() requires a backend that can read a set of ` +
          `endpoints with set-oriented statements, and this backend does not implement ` +
          `findEdgesByEndpointSet.`,
        {
          backend: backend.dialect,
          capability: "findEdgesByEndpointSet",
          kind,
          operation: method,
        },
        {
          suggestion:
            `Falling back to one findFrom/findTo per endpoint is deliberately NOT done here: ` +
            `a caller reaching for a bulk endpoint read is asking for a set-oriented read, and ` +
            `silently issuing N singleton statements is the cost surprise this method exists ` +
            `to avoid. Loop over ` +
            `findFrom/findTo explicitly if that trade is acceptable.`,
        },
      );
    }

    const limitPerInput = options?.limitPerInput;
    assertLimitPerInput(kind, limitPerInput);

    // Resolve the read coordinate ONCE. `current` mode materializes an `asOf`
    // of "now", so resolving per endpoint kind would let a mixed-kind read
    // straddle a validity boundary and return an internally inconsistent
    // answer from a single logical read.
    const temporal = resolveTemporalReadParams(options, defaultTemporalMode);

    // The per-endpoint cap is pushed into SQL when the engine has window
    // functions; otherwise the rows arrive uncapped and the JS slice below
    // (which every path applies) keeps the same leading edges.
    const limitPerEndpoint =
      limitPerInput !== undefined && backend.capabilities.windowFunctions ?
        { limitPerEndpoint: limitPerInput }
      : {};

    const edgesByEndpoint = new Map<string, Edge<E>[]>();
    for (const [endpointKind, endpointIds] of groupEndpointIdsByKind(
      references,
    )) {
      const rows = await readEndpointSet({
        graphId,
        kind,
        side,
        endpointKind,
        endpointIds,
        ...limitPerEndpoint,
        ...temporal,
      });
      for (const edge of mapRows(rows)) {
        const key =
          side === "from" ?
            endpointKey(edge.fromKind, edge.fromId)
          : endpointKey(edge.toKind, edge.toId);
        const bucket = edgesByEndpoint.get(key);
        if (bucket === undefined) edgesByEndpoint.set(key, [edge]);
        else bucket.push(edge);
      }
    }

    // Each input position gets its own array: repeated inputs share an
    // endpoint bucket, and callers must not see one input's mutation in
    // another's.
    return references.map((ref) => {
      const bucket = edgesByEndpoint.get(endpointKey(ref.kind, ref.id)) ?? [];
      return limitPerInput === undefined ?
          [...bucket]
        : bucket.slice(0, limitPerInput);
    });
  }

  function buildFindByEndpointsOptions(
    options?: EdgeFindByEndpointsOptions<E>,
    temporal?: QueryOptions,
  ): Readonly<{
    matchOn?: readonly string[];
    props?: Record<string, unknown>;
    excludeDeleted?: boolean;
    temporalMode?: TemporalMode;
    asOf?: string;
  }> {
    const result: {
      matchOn?: readonly string[];
      props?: Record<string, unknown>;
      excludeDeleted?: boolean;
      temporalMode?: TemporalMode;
      asOf?: string;
    } = { ...resolveTemporalReadParams(temporal, defaultTemporalMode) };
    if (options?.matchOn !== undefined)
      result.matchOn = options.matchOn as readonly string[];
    if (options?.props !== undefined) result.props = options.props;
    return result;
  }

  return {
    async create(
      from: NodeRef,
      to: NodeRef,
      props?: z.input<E["schema"]>,
      options?: Readonly<{ id?: string; validFrom?: string; validTo?: string }>,
    ): Promise<Edge<E>> {
      const result = await executeEdgeCreate(
        buildCreateEdgeInput(kind, from, to, props ?? {}, options),
        backend,
      );
      return narrowEdge<E>(result);
    },

    async getById(
      id: string,
      options?: QueryOptions,
    ): Promise<Edge<E> | undefined> {
      const row = await backend.getEdge(graphId, id);
      if (!row) return undefined;
      if (row.kind !== kind) return undefined; // Edge is a different type
      if (!temporalRowMatcher(options)(row)) return undefined;
      return narrowEdge<E>(rowToEdge(row));
    },

    async getByIds(
      ids: readonly string[],
      options?: QueryOptions,
    ): Promise<readonly (Edge<E> | undefined)[]> {
      if (ids.length === 0) return [];

      const rowsById = await getEdgeRowsByIds(
        backend,
        batchPointRead,
        graphId,
        ids,
      );
      // Resolve the coordinate once so the whole batch observes one instant.
      const matches = temporalRowMatcher(options);
      return ids.map((id) => {
        const row = rowsById.get(id);
        if (!row) return;
        if (row.kind !== kind) return;
        if (!matches(row)) return;
        return narrowEdge<E>(rowToEdge(row));
      });
    },

    async update(
      id: string,
      props: Partial<z.input<E["schema"]>>,
      options?: ValidityEndMutation,
    ): Promise<Edge<E>> {
      const result = await executeEdgeUpdate(
        buildUpdateEdgeInput(kind, id, props, options),
        backend,
      );
      return narrowEdge<E>(result);
    },

    async findFrom(from: NodeRef, options?: QueryOptions): Promise<Edge<E>[]> {
      return findEdgesFrom(from, backend, options);
    },

    async findTo(to: NodeRef, options?: QueryOptions): Promise<Edge<E>[]> {
      return findEdgesTo(to, backend, options);
    },

    async bulkFindFrom(
      froms: readonly NodeRef[],
      options?: EdgeBulkFindEndpointOptions,
    ): Promise<readonly Edge<E>[][]> {
      return findEdgesByEndpointSet("from", froms, options);
    },

    async bulkFindTo(
      tos: readonly NodeRef[],
      options?: EdgeBulkFindEndpointOptions,
    ): Promise<readonly Edge<E>[][]> {
      return findEdgesByEndpointSet("to", tos, options);
    },

    batchFindFrom(
      from: NodeRef,
      options?: QueryOptions,
    ): BatchableQuery<Edge<E>> {
      return { executeOn: (target) => findEdgesFrom(from, target, options) };
    },

    batchFindTo(to: NodeRef, options?: QueryOptions): BatchableQuery<Edge<E>> {
      return { executeOn: (target) => findEdgesTo(to, target, options) };
    },

    batchFindByEndpoints(
      from: NodeRef,
      to: NodeRef,
      options?: EdgeFindByEndpointsOptions<E>,
      temporal?: QueryOptions,
    ): BatchableQuery<Edge<E>> {
      return {
        executeOn: async (target) => {
          const result = await config.executeFindByEndpoints(
            kind,
            from.kind,
            from.id,
            to.kind,
            to.id,
            target,
            buildFindByEndpointsOptions(options, temporal),
          );
          return result === undefined ? [] : [narrowEdge<E>(result)];
        },
      };
    },

    async delete(id: string): Promise<void> {
      await executeEdgeDelete(kind, id, backend);
    },

    async hardDelete(id: string): Promise<void> {
      await executeEdgeHardDelete(kind, id, backend);
    },

    async find(
      filter?: Readonly<{
        from?: NodeRef;
        to?: NodeRef;
        limit?: number;
        offset?: number;
      }>,
      temporal?: QueryOptions,
    ): Promise<Edge<E>[]> {
      const untypedFilter = filter as Readonly<{ where?: unknown }> | undefined;
      if (untypedFilter?.where !== undefined) {
        throw new UnsupportedPredicateError(
          `store.edges.${kind}.find({ where }) is not supported. ` +
            `Use store.query().traverse(...).whereEdge(...) for edge property filters.`,
          { kind, operation: "find" },
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
      } & TemporalReadParams = {
        graphId,
        kind,
        ...resolveTemporalReadParams(temporal, defaultTemporalMode),
      };
      if (filter?.from?.kind !== undefined) params.fromKind = filter.from.kind;
      if (filter?.from?.id !== undefined) params.fromId = filter.from.id;
      if (filter?.to?.kind !== undefined) params.toKind = filter.to.kind;
      if (filter?.to?.id !== undefined) params.toId = filter.to.id;
      if (filter?.limit !== undefined) params.limit = filter.limit;
      if (filter?.offset !== undefined) params.offset = filter.offset;

      const rows = await backend.findEdgesByKind(params);
      return mapRows(rows);
    },

    async count(
      filter?: Readonly<{
        from?: NodeRef;
        to?: NodeRef;
      }>,
      temporal?: QueryOptions,
    ): Promise<number> {
      const params: {
        graphId: string;
        kind: string;
        fromKind?: string;
        fromId?: string;
        toKind?: string;
        toId?: string;
      } & TemporalReadParams = {
        graphId,
        kind,
        ...resolveTemporalReadParams(temporal, defaultTemporalMode),
      };
      if (filter?.from?.kind !== undefined) params.fromKind = filter.from.kind;
      if (filter?.from?.id !== undefined) params.fromId = filter.from.id;
      if (filter?.to?.kind !== undefined) params.toKind = filter.to.kind;
      if (filter?.to?.id !== undefined) params.toId = filter.to.id;

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
      const batchInputs = mapBulkEdgeInputs(kind, items);
      const results = await executeEdgeCreateBatch(batchInputs, backend);
      await config.maybeRefreshStatisticsAfterBulk?.(results.length);
      return narrowEdges<E>(results);
    },

    async bulkUpsertById(
      items: readonly Readonly<{
        id: string;
        from: NodeRef;
        to: NodeRef;
        props?: z.input<E["schema"]>;
        validFrom?: string;
        validTo?: string;
        clearValidTo?: true;
      }>[],
    ): Promise<Edge<E>[]> {
      if (items.length === 0) return [];

      for (const item of items) {
        assertValidityEndMutation(item, {
          entityType: "edge",
          kind,
          id: item.id,
        });
        if (item.clearValidTo === true) {
          assertClearValidToSupported(backend, "edge");
        }
      }

      const upsertAll = async (
        target: GraphBackend | TransactionBackend,
      ): Promise<{ results: Edge<E>[]; mutations: number }> => {
        const ids = items.map((item) => item.id);
        const existingMap = await getEdgeRowsByIds(
          target,
          batchPointRead,
          graphId,
          ids,
        );

        // Coalesced items are written straight to results (the existing or
        // last-written edge) and skipped from the write batch; see the node
        // collection and BaseStoreOptions.coalesceUnchangedUpserts.
        const results: Edge<E>[] = Array.from({ length: items.length });

        // Bucket items into creates and updates
        const toCreate: { index: number; input: CreateEdgeInput }[] = [];
        const toUpdate: {
          index: number;
          input: UpsertUpdateEdgeInput;
          clearDeleted: boolean;
          existing?: BackendEdgeRow;
        }[] = [];

        // Batch-local running state per id so a repeated id coalesces against
        // the props AND validity window earlier items in this batch would write,
        // preserving last-write-wins — and so a repeated id whose edge does not
        // exist yet queues ONE create plus an update over it rather than two
        // creates the create batch rejects as "already exists". See the node
        // collection for the full rationale, including why `props` may be
        // undefined while `window` is always computed.
        const pending = new Map<
          string,
          {
            identity: EdgeIdentity;
            props: Record<string, unknown> | undefined;
            window: UpsertWindow;
            sourceIndex: number;
          }
        >();
        const deferred: { index: number; sourceIndex: number }[] = [];

        // See the node collection: only a coalescing store reads a running
        // value, so only it needs the repeated-id set.
        const repeatedIds =
          config.upsertDirtyCheck === undefined ?
            new Set<string>()
          : findRepeatedUpsertIds(items);

        /** See the node collection's runDirtyCheck. */
        function runDirtyCheck(
          edgeKind: string,
          id: string,
          currentProps: Record<string, unknown>,
          inputProps: Record<string, unknown>,
        ): UpsertDirtyCheck | undefined {
          if (config.upsertDirtyCheck === undefined) return undefined;
          try {
            return config.upsertDirtyCheck(
              edgeKind,
              id,
              currentProps,
              inputProps,
            );
          } catch {
            return undefined;
          }
        }

        let itemIndex = 0;
        for (const item of items) {
          const pendingEntry = pending.get(item.id);
          const original = existingMap.get(item.id);
          const inputProps = item.props ?? {};

          if (pendingEntry === undefined && original === undefined) {
            toCreate.push({
              index: itemIndex,
              input: buildCreateEdgeInput(
                kind,
                item.from,
                item.to,
                inputProps,
                item,
              ),
            });
            // A create merges over nothing, so the dirty check run against an
            // EMPTY base is exactly the validated props the insert will store —
            // needed only when a later copy of this id will compare against it.
            pending.set(item.id, {
              identity: {
                kind,
                fromKind: item.from.kind,
                fromId: item.from.id,
                toKind: item.to.kind,
                toId: item.to.id,
              },
              props:
                repeatedIds.has(item.id) ?
                  runDirtyCheck(kind, item.id, {}, inputProps)?.validatedProps
                : undefined,
              window: windowAfterUpsertCreate(item),
              sourceIndex: itemIndex,
            });
            itemIndex++;
            continue;
          }

          const deletedAt =
            pendingEntry === undefined ?
              requireDefined(original).deleted_at
            : undefined;

          const expectedIdentity: EdgeIdentityExpectation = {
            kind,
            fromKind: item.from.kind,
            fromId: item.from.id,
            toKind: item.to.kind,
            toId: item.to.id,
          };
          const actualIdentity =
            pendingEntry === undefined ?
              edgeIdentityFromRow(requireDefined(original))
            : pendingEntry.identity;
          assertEdgeIdentityMatches(
            item.id,
            expectedIdentity,
            actualIdentity,
            "update",
          );

          const currentProps =
            pendingEntry === undefined ?
              rowPropsToObject(requireDefined(original).props)
            : pendingEntry.props;
          // The fetched edge carries the authoritative kind (an id may resolve
          // to a different edge kind than this collection); a queued create is
          // this collection's kind by construction.
          const dirty =
            currentProps === undefined ? undefined : (
              runDirtyCheck(
                original?.kind ?? kind,
                item.id,
                currentProps,
                inputProps,
              )
            );

          // The window the edge holds going into this item: the prefetched row's,
          // or the one the batch's last queued write for this id leaves behind.
          const currentWindow: UpsertWindow =
            pendingEntry === undefined ?
              {
                valid_from: requireDefined(original).valid_from,
                valid_to: requireDefined(original).valid_to,
              }
            : pendingEntry.window;

          // An explicit window blocks coalescing ONLY when it would change the
          // window already held: merge commits pass the staged survivor's window
          // on every edge write, so a target edge staged back at itself
          // (identical props AND identical window) must still coalesce instead of
          // rewriting history and revision state. The comparison is
          // shouldCoalesceUpsert's own, which reads both sides as INSTANTS —
          // comparing the driver's text directly (what this path used to do) let
          // an identical re-stated window coalesce on one dialect and write on
          // another.
          const coalesce =
            dirty?.unchanged === true &&
            deletedAt === undefined &&
            !upsertWindowChanges(item, currentWindow);

          if (coalesce) {
            if (pendingEntry === undefined) {
              results[itemIndex] = narrowEdge<E>(
                rowToEdge(requireDefined(original)),
              );
            } else {
              deferred.push({
                index: itemIndex,
                sourceIndex: pendingEntry.sourceIndex,
              });
            }
          } else {
            toUpdate.push({
              index: itemIndex,
              input: buildUpsertUpdateEdgeInput(
                kind,
                item.id,
                item.from,
                item.to,
                inputProps,
                item,
              ),
              clearDeleted: deletedAt !== undefined,
              ...(pendingEntry === undefined && original !== undefined ?
                { existing: original }
              : {}),
            });
            pending.set(item.id, {
              identity: actualIdentity,
              props: dirty?.validatedProps,
              // A resurrection rewrites both bounds only when it NAMES the lower
              // one (buildUpdateEdge's clearDeleted leg); omitting `validFrom`
              // keeps the stored window, exactly like a live-row update.
              window:
                deletedAt !== undefined && item.validFrom !== undefined ?
                  windowAfterUpsertCreate(item)
                : windowAfterUpsertUpdate(currentWindow, item),
              sourceIndex: itemIndex,
            });
          }
          itemIndex++;
        }

        const createInputs = toCreate.map((entry) => entry.input);
        const updateEntries = toUpdate.map((entry) => ({
          input: entry.input,
          clearDeleted: entry.clearDeleted,
          ...(entry.existing === undefined ? {} : { existing: entry.existing }),
        }));
        const mutationAttempt = await executeEdgeResolvedMutationSet(
          createInputs,
          updateEntries,
          target,
        );
        if (mutationAttempt.outcome === "unsupported") {
          if (toCreate.length > 0) {
            const created = await executeEdgeCreateBatch(createInputs, target);
            for (const [index, entry] of toCreate.entries()) {
              results[entry.index] = narrowEdge<E>(
                requireDefined(created[index]),
              );
            }
          }

          if (toUpdate.length > 0) {
            const updated = await executeEdgeUpsertUpdateBatch(
              updateEntries,
              target,
            );
            for (const [updateIndex, entry] of toUpdate.entries()) {
              const result = requireDefined(updated[updateIndex]);
              results[entry.index] = narrowEdge<E>(result);
            }
          }
        } else {
          const mutationSet = mutationAttempt.value;
          for (const [index, entry] of toCreate.entries()) {
            results[entry.index] = narrowEdge<E>(
              requireDefined(mutationSet.created[index]),
            );
          }
          for (const [index, entry] of toUpdate.entries()) {
            results[entry.index] = narrowEdge<E>(
              requireDefined(mutationSet.updated[index]),
            );
          }
        }

        // Items that coalesced against an in-batch write take that write's
        // result (now filled). Its sourceIndex is always a write slot — a
        // queued create or a queued update, both filled above.
        for (const { index, sourceIndex } of deferred) {
          results[index] = requireDefined(results[sourceIndex]);
        }

        return { results, mutations: toCreate.length + toUpdate.length };
      };

      // INVARIANT: the prefetch that feeds every coalesce decision and the
      // writes those decisions elect run against ONE target — so an item is
      // skipped only on evidence taken inside the transaction that would have
      // written it, never on an autocommit read taken before it (the defect
      // `upsertById` had on the node side).
      //
      // `runOptionallyInTransaction` is the one owner of "open a transaction if
      // this backend has one": already inside `store.transaction(...)` the
      // target IS the caller's transaction and no nested one opens, and on a
      // backend without interactive transactions there is nothing to open, so
      // the decision is exactly as fenced as that backend's writes are — which
      // is to say not at all, matching the atomicity it already cannot offer.
      const { results, mutations } = await runResolvedMutationSetConverging(
        "edge",
        backend,
        () =>
          runOptionallyInTransaction(backend, (target) => upsertAll(target)),
      );
      // Match bulkCreate/bulkInsert: refresh planner statistics after a large
      // autocommit bulk write. Coalesced items wrote nothing, so only real
      // mutations count toward the threshold. A no-op inside a caller
      // transaction (the hook is intentionally undefined there).
      await config.maybeRefreshStatisticsAfterBulk?.(mutations);
      return results;
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
      const batchInputs = mapBulkEdgeInputs(kind, items);
      await executeEdgeCreateNoReturnBatch(batchInputs, backend);
      await config.maybeRefreshStatisticsAfterBulk?.(batchInputs.length);
    },

    async bulkDelete(ids: readonly string[]): Promise<void> {
      if (ids.length === 0) return;
      await executeEdgeDeleteBatch(kind, ids, backend);
    },

    async findByEndpoints(
      from: NodeRef,
      to: NodeRef,
      options?: EdgeFindByEndpointsOptions<E>,
      temporal?: QueryOptions,
    ): Promise<Edge<E> | undefined> {
      const result = await config.executeFindByEndpoints(
        kind,
        from.kind,
        from.id,
        to.kind,
        to.id,
        backend,
        buildFindByEndpointsOptions(options, temporal),
      );
      return result === undefined ? undefined : narrowEdge<E>(result);
    },

    async getOrCreateByEndpoints(
      from: NodeRef,
      to: NodeRef,
      props: z.input<E["schema"]>,
      options?: EdgeGetOrCreateByEndpointsOptions<E>,
    ): Promise<EdgeGetOrCreateByEndpointsResult<E>> {
      assertValidityEndMutation(options ?? {}, {
        entityType: "edge",
        kind,
      });
      const getOrCreateOptions = {
        ...(options?.matchOn !== undefined && {
          matchOn: options.matchOn as readonly string[],
        }),
        ...(options?.ifExists !== undefined && {
          ifExists: options.ifExists,
        }),
        ...(options?.validFrom !== undefined && {
          validFrom: options.validFrom,
        }),
        ...(options?.validTo !== undefined && { validTo: options.validTo }),
        ...(options?.clearValidTo === true && { clearValidTo: true as const }),
        ...(options?.onImmutableLowerBound !== undefined && {
          onImmutableLowerBound: options.onImmutableLowerBound,
        }),
      };

      const result = await config.executeGetOrCreateByEndpoints(
        kind,
        from.kind,
        from.id,
        to.kind,
        to.id,
        props,
        backend,
        getOrCreateOptions,
      );
      return { edge: narrowEdge<E>(result.edge), action: result.action };
    },

    async bulkGetOrCreateByEndpoints(
      items: readonly Readonly<{
        from: NodeRef;
        to: NodeRef;
        props: z.input<E["schema"]>;
        validFrom?: string;
        validTo?: string;
        clearValidTo?: true;
        onImmutableLowerBound?: "preserve" | "refuse";
      }>[],
      options?: Pick<
        EdgeGetOrCreateByEndpointsOptions<E>,
        "matchOn" | "ifExists"
      >,
    ): Promise<EdgeGetOrCreateByEndpointsResult<E>[]> {
      if (items.length === 0) return [];

      for (const item of items) {
        assertValidityEndMutation(item, {
          entityType: "edge",
          kind,
        });
      }

      const mappedItems = items.map((item) => ({
        fromKind: item.from.kind,
        fromId: item.from.id,
        toKind: item.to.kind,
        toId: item.to.id,
        props: item.props,
        ...(item.validFrom !== undefined && { validFrom: item.validFrom }),
        ...(item.validTo !== undefined && { validTo: item.validTo }),
        ...(item.clearValidTo === true && { clearValidTo: true as const }),
        ...(item.onImmutableLowerBound !== undefined && {
          onImmutableLowerBound: item.onImmutableLowerBound,
        }),
      }));

      const getOrCreateOptions = {
        ...(options?.matchOn !== undefined && {
          matchOn: options.matchOn as readonly string[],
        }),
        ...(options?.ifExists !== undefined && {
          ifExists: options.ifExists,
        }),
      };

      const getOrCreateAll = async (
        target: GraphBackend | TransactionBackend,
      ): Promise<EdgeGetOrCreateByEndpointsResult<E>[]> => {
        const results = await config.executeBulkGetOrCreateByEndpoints(
          kind,
          mappedItems,
          target,
          getOrCreateOptions,
        );
        return results.map((result) => ({
          edge: narrowEdge<E>(result.edge),
          action: result.action,
        }));
      };

      // The operation owns its transaction boundary. This lets exact-root
      // atomic convergence dispatch before a derived transaction target hides
      // the bundled backend proof; the portable implementation still enters
      // `runWritePlan` and receives the same all-or-nothing boundary.
      return getOrCreateAll(backend);
    },
  };
}
