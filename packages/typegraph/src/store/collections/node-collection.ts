/**
 * NodeCollection implementation.
 *
 * Provides an ergonomic API for CRUD operations on a specific node type.
 */
import { type z } from "zod";

import { bindExtraIfReachable } from "../../backend/capabilities/bind";
import { BATCH_POINT_READ } from "../../backend/capabilities/bundle-registry";
import { type BundleVerdictOf } from "../../backend/capabilities/resolve";
import {
  type GraphBackend,
  rowPropsToObject,
  runOptionallyInTransaction,
  type TransactionBackend,
} from "../../backend/types";
import { type GraphDef } from "../../core/define-graph";
import {
  type NodeId,
  type NodeType,
  type TemporalMode,
} from "../../core/types";
import { ConfigurationError } from "../../errors";
import type { DynamicNodeAccessor, NodeAccessor } from "../../query/builder";
import { type QueryBuilder } from "../../query/builder";
import { type Predicate } from "../../query/predicates";
import { sql, type SqlFragment } from "../../query/sql-fragment";
import {
  asCompiledSelectSql,
  type CompiledSelectSql,
} from "../../query/sql-intent";
import { nowIso } from "../../utils/date";
import { requireDefined } from "../../utils/presence";
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
  type ValidityEndMutation,
} from "../types";
import {
  assertClearValidToSupported,
  assertValidityEndMutation,
} from "../validity-end";
import {
  findRepeatedUpsertIds,
  shouldCoalesceUpsert,
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

type OnImmutableLowerBound = "preserve" | "refuse";

type NodeUpsertOptions = Readonly<{
  validFrom?: string;
  onImmutableLowerBound?: OnImmutableLowerBound;
}> &
  ValidityEndMutation;

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

/** Adapts a schema-shaped typed callback to the runtime dynamic accessor. */
type NodeCollectionPredicateAccessor<N extends NodeType> =
  string extends N["kind"] ? DynamicNodeAccessor : NodeAccessor<N>;

/** Supports both dynamic `.field(name)` and a typed property named `field`. */
function createFieldMember(
  accessor: DynamicNodeAccessor,
): DynamicNodeAccessor["field"] {
  const selectField = (name: string) => accessor.field(name);
  return new Proxy(selectField, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        const ownProperty: unknown = Reflect.get(target, property, receiver);
        return ownProperty;
      }
      return (
        accessor.field("field") as unknown as Readonly<
          Record<PropertyKey, unknown>
        >
      )[property];
    },
  });
}

function evaluateNodePredicate<N extends NodeType>(
  accessor: DynamicNodeAccessor,
  predicate: (accessor: NodeCollectionPredicateAccessor<N>) => Predicate,
): Predicate {
  const collectionAccessor = new Proxy(
    {} as NodeCollectionPredicateAccessor<N>,
    {
      get(_target, property) {
        if (typeof property === "symbol") return;
        // No interop exemption for `then` / `toJSON`. This accessor's contract
        // is that EVERY name is a field — the typed signature offers the
        // schema's fields, including ones legally named after a protocol hook,
        // and refusing those names made a declared field unaddressable. The
        // exemption is also unnecessary here: a field builder is an object,
        // never a function, so `await` sees a non-callable `then` and
        // `JSON.stringify` a non-callable `toJSON`, and neither is invoked.
        if (
          property === "id" ||
          property === "kind" ||
          property === "$fulltext"
        ) {
          return accessor[property];
        }
        if (property === "field") return createFieldMember(accessor);
        return accessor.field(property);
      },
    },
  );
  return predicate(collectionAccessor);
}

/**
 * Update input for the internal upsert path, which owns the WHOLE validity
 * window: a resurrecting upsert rewrites both endpoints, so it must be able to
 * carry `validFrom` as well as `validTo`. Dropping `validFrom` here would leave
 * a stated lower bound unreachable by the only node write that stores one: a
 * resurrection rewrites `valid_from` whether or not the caller named it, so the
 * caller's bound would be replaced by the instant that write stamps rather than
 * honored. It would no longer INVERT the window — a resurrection stating only a
 * historical `validTo` stores no lower bound at all — which is why the sibling
 * note on `UpsertUpdateEdgeInput` still reads in terms of inversion and this one
 * does not: an edge resurrection RETAINS its stored bound.
 *
 * The public `update()` API cannot reach this member: its options type exposes
 * `validTo` only, and it builds its input through {@link buildUpdateInput}. Only
 * `upsertById` / `bulkUpsertById`, which accept `validFrom` by contract, route
 * through {@link buildUpsertUpdateInput}.
 */
export type UpsertUpdateNodeInput = UpdateNodeInput &
  Readonly<{
    validFrom?: string;
    onImmutableLowerBound?: OnImmutableLowerBound;
  }>;

/**
 * Config for creating a NodeCollection.
 */
export type NodeCollectionConfig = Readonly<{
  graphId: string;
  kind: string;
  backend: GraphBackend | TransactionBackend;
  /** Threaded `batchPointRead` verdict — never re-resolved here. */
  batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>;
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
    input: UpsertUpdateNodeInput,
    backend: GraphBackend | TransactionBackend,
    options?: Readonly<{ clearDeleted?: boolean }>,
  ) => Promise<Node>;
  executeUpdateWhere: (
    kind: string,
    patch: Record<string, unknown>,
    candidateIds: CompiledSelectSql,
    candidateIdColumn: string,
    backend: GraphBackend | TransactionBackend,
  ) => Promise<Readonly<{ affectedCount: number }>>;
  executeUpsertUpdate: (
    input: UpsertUpdateNodeInput,
    backend: GraphBackend | TransactionBackend,
    options?: Readonly<{ clearDeleted?: boolean }>,
  ) => Promise<Node>;
  /** See NodeOperations.upsertDirtyCheck. */
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
  options?: ValidityEndMutation,
): UpdateNodeInput {
  const input: {
    kind: string;
    id: string;
    props: Partial<Record<string, unknown>>;
    validTo?: string;
    clearValidTo?: true;
  } = { kind, id, props };
  if (options?.validTo !== undefined) input.validTo = options.validTo;
  if (options?.clearValidTo === true) input.clearValidTo = true;
  return input as UpdateNodeInput;
}

/** Builds an {@link UpsertUpdateNodeInput} — see that type for why upsert alone carries `validFrom`. */
function buildUpsertUpdateInput(
  kind: string,
  id: string,
  props: Record<string, unknown>,
  options?: Readonly<{
    validFrom?: string;
    validTo?: string;
    clearValidTo?: true;
    onImmutableLowerBound?: OnImmutableLowerBound;
  }>,
): UpsertUpdateNodeInput {
  const input: {
    kind: string;
    id: string;
    props: Partial<Record<string, unknown>>;
    validFrom?: string;
    validTo?: string;
    clearValidTo?: true;
    onImmutableLowerBound?: OnImmutableLowerBound;
  } = { kind, id, props };
  if (options?.validFrom !== undefined) input.validFrom = options.validFrom;
  if (options?.validTo !== undefined) input.validTo = options.validTo;
  if (options?.clearValidTo === true) input.clearValidTo = true;
  if (options?.onImmutableLowerBound !== undefined) {
    input.onImmutableLowerBound = options.onImmutableLowerBound;
  }
  return input as UpsertUpdateNodeInput;
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
    batchPointRead,
    defaultTemporalMode,
    rowToNode,
    executeCreate: executeNodeCreate,
    executeCreateNoReturnBatch: executeNodeCreateNoReturnBatch,
    executeCreateBatch: executeNodeCreateBatch,
    executeUpdate: executeNodeUpdate,
    executeUpdateWhere: executeNodeUpdateWhere,
    executeUpsertUpdate: executeNodeUpsertUpdate,
    executeDelete: executeNodeDelete,
    executeDeleteBatch: executeNodeDeleteBatch,
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

      const rowsById = await getNodeRowsByIds(
        backend,
        batchPointRead,
        graphId,
        kind,
        ids,
      );
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
      options?: ValidityEndMutation,
    ): Promise<Node<N>> {
      const result = await executeNodeUpdate(
        buildUpdateInput(kind, id, props, options),
        backend,
      );
      return narrowNode<N>(result);
    },

    async updateWhere(params): Promise<Readonly<{ affectedCount: number }>> {
      if (createQuery === undefined) {
        throw new ConfigurationError(
          `store.nodes.${kind}.updateWhere() requires a query-capable store`,
          { kind, operation: "updateWhere" },
        );
      }
      const exists = params.exists ?? [];
      if (params.where === undefined && exists.length === 0 && !params.all) {
        throw new ConfigurationError(
          `store.nodes.${kind}.updateWhere() requires where, exists, or explicit all: true`,
          { kind, operation: "updateWhere" },
        );
      }

      const rootAlias = "update_candidate";
      const readInstant = nowIso();
      let base = createQuery()
        .fromDynamic(kind, rootAlias)
        .temporal("asOf", readInstant);
      const where = params.where;
      if (where !== undefined) {
        base = base.whereNode(rootAlias, (accessor) =>
          evaluateNodePredicate<N>(accessor, where),
        );
      }
      const candidateIdColumn = `${rootAlias}_id`;
      const compiledBranches: CompiledSelectSql[] = [];
      for (const [index, relation] of exists.entries()) {
        const edgeAlias = `update_edge_${index}`;
        const relatedAlias = `update_related_${index}`;
        const relationRoot = createQuery()
          .fromDynamic(kind, rootAlias)
          .temporal("asOf", readInstant);
        let traversal = relationRoot.traverseDynamic(
          relation.edgeKind,
          edgeAlias,
          {
            direction: relation.direction,
            expand: "none",
          },
        );
        if (relation.whereEdge !== undefined) {
          traversal = traversal.whereEdge(edgeAlias, relation.whereEdge);
        }
        let related = traversal.toDynamic(relation.relatedKind, relatedAlias);
        if (relation.whereRelated !== undefined) {
          related = related.whereNode(relatedAlias, relation.whereRelated);
        }
        compiledBranches.push(
          related
            .select(
              (ctx: Record<string, { id: unknown }>) => ctx[rootAlias]?.id,
            )
            .compile(),
        );
      }
      compiledBranches.unshift(
        base
          .select((ctx: Record<string, { id: unknown }>) => ctx[rootAlias]?.id)
          .compile(),
      );
      const projectCandidateId = (
        branch: CompiledSelectSql,
        index: number,
      ): SqlFragment => sql`
        SELECT ${sql.identifier(candidateIdColumn)}
        FROM (${branch}) AS ${sql.identifier(`update_branch_${index}`)}
      `;
      let combinedCandidates = projectCandidateId(
        requireDefined(compiledBranches[0]),
        0,
      );
      for (let index = 1; index < compiledBranches.length; index++) {
        combinedCandidates = sql`${combinedCandidates} INTERSECT ${projectCandidateId(
          requireDefined(compiledBranches[index]),
          index,
        )}`;
      }
      const compiledCandidates = asCompiledSelectSql(combinedCandidates);

      const result = await executeNodeUpdateWhere(
        kind,
        params.patch,
        compiledCandidates,
        candidateIdColumn,
        backend,
      );
      await config.maybeRefreshStatisticsAfterBulk?.(result.affectedCount);
      return result;
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
          .select((ctx: Record<string, unknown>) => ctx["_n"]);
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
      options?: NodeUpsertOptions,
    ): Promise<Node<N>> {
      return this.upsertByIdFromRecord(id, props, options);
    },

    async upsertByIdFromRecord(
      id: string,
      data: Record<string, unknown>,
      options?: NodeUpsertOptions,
    ): Promise<Node<N>> {
      assertValidityEndMutation(options ?? {}, {
        entityType: "node",
        kind,
        id,
      });
      if (options?.clearValidTo === true) {
        assertClearValidToSupported(backend, "node");
      }
      const existing = await backend.getNode(graphId, kind, id);

      // Coalesce a value-identical replay: skip the write entirely (no
      // updateNode, no recorded capture, no revision advance, no hooks) and
      // resolve with the existing node. See
      // BaseStoreOptions.coalesceUnchangedUpserts.
      const coalesces = (row: NonNullable<typeof existing>): boolean => {
        const runDirtyCheck =
          config.upsertDirtyCheck &&
          (() =>
            requireDefined(config.upsertDirtyCheck)(
              kind,
              id,
              rowPropsToObject(row.props),
              data,
            ));
        return shouldCoalesceUpsert(row, options, runDirtyCheck);
      };

      // INVARIANT: a coalescing upsert's decision to SKIP is both taken and
      // executed inside one transaction. The read that justifies the skip and
      // the skip itself are the same transaction; the skip IS that
      // transaction's empty commit, and nothing after the commit writes, so
      // there is no window between deciding and acting for a competitor to
      // occupy.
      //
      // Coalescing must be an optimization, never a semantic: with the flag
      // off, `executeNodeUpdate` opens a transaction, re-reads, and merges the
      // caller's props over whatever it finds, so a writer that commits between
      // the autocommit read above and the write still has the caller's props
      // applied on top. Deciding "skip" from that earlier read gave a DIFFERENT
      // answer — the caller was told its props were stored while the store held
      // the other writer's — so the flag changed the outcome instead of the
      // cost. Deciding inside the transaction restores the equivalence: a
      // "write" verdict falls through to the ordinary path, whose own
      // in-transaction re-read merges over the current row.
      //
      // Note the shape difference from a plain re-read: the verdict is computed
      // where `target` is live, not after the transaction closed. Committing
      // and THEN deciding would narrow the window rather than close it, which
      // is what the bulk paths avoid by deciding inside `upsertAll`.
      //
      // Only a coalescing store that is ABOUT to skip pays the second read; a
      // store without the flag, or one whose props differ, keeps the single
      // read and the single write it always had. On SQLite the transaction is
      // `BEGIN IMMEDIATE`, which excludes every other writer for its duration;
      // on a backend without transactions there is nothing to open and the
      // decision is as fenced as that backend's writes are — which is to say
      // not at all, matching the atomicity it already cannot offer.
      type UpsertVerdict =
        | Readonly<{ verdict: "skip"; row: NodeRow }>
        | Readonly<{ verdict: "write"; row: NodeRow | undefined }>;

      const decision: UpsertVerdict =
        existing !== undefined && coalesces(existing) ?
          await runOptionallyInTransaction(
            backend,
            async (target): Promise<UpsertVerdict> => {
              const confirmed = await target.getNode(graphId, kind, id);
              return confirmed !== undefined && coalesces(confirmed) ?
                  { verdict: "skip", row: confirmed }
                : { verdict: "write", row: confirmed };
            },
          )
        : { verdict: "write", row: existing };

      if (decision.verdict === "skip") {
        return narrowNode<N>(rowToNode(decision.row));
      }

      if (decision.row !== undefined) {
        const result = await executeNodeUpdate(
          buildUpsertUpdateInput(kind, id, data, options),
          backend,
          { clearDeleted: decision.row.deleted_at !== undefined },
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
        clearValidTo?: true;
        onImmutableLowerBound?: OnImmutableLowerBound;
      }>[],
    ): Promise<Node<N>[]> {
      if (items.length === 0) return [];

      for (const item of items) {
        assertValidityEndMutation(item, {
          entityType: "node",
          kind,
          id: item.id,
        });
        if (item.clearValidTo === true) {
          assertClearValidToSupported(backend, "node");
        }
      }

      const upsertAll = async (
        target: GraphBackend | TransactionBackend,
      ): Promise<{ results: Node<N>[]; mutations: number }> => {
        const ids = items.map((item) => item.id);
        // Full existing rows: the coalesce dirty-check needs their stored
        // props, not just deleted_at.
        const existingMap = new Map<string, NodeRow>();

        const boundGetNodes = bindExtraIfReachable(
          target,
          batchPointRead.extras.getNodes,
          BATCH_POINT_READ.id,
        );
        if (boundGetNodes === undefined) {
          const rows = await Promise.all(
            ids.map((id) => target.getNode(graphId, kind, id)),
          );
          for (const row of rows) {
            if (row !== undefined) existingMap.set(row.id, row);
          }
        } else {
          const rows = await boundGetNodes.getNodes(graphId, kind, ids);
          for (const row of rows) {
            existingMap.set(row.id, row);
          }
        }

        // Coalesced items are written straight to results (the existing or
        // last-written node) and skipped from the write batch; see the
        // single-upsert path and BaseStoreOptions.coalesceUnchangedUpserts.
        const results: Node<N>[] = Array.from({ length: items.length });

        // Bucket items into creates and updates
        const toCreate: { index: number; input: CreateNodeInput }[] = [];
        const toUpdate: {
          index: number;
          input: UpsertUpdateNodeInput;
          clearDeleted: boolean;
        }[] = [];

        // Batch-local running state per id: the props AND validity window the
        // row would hold after the writes queued so far, and the item index that
        // queued that write. A later same-id item coalesces against this running
        // value, not the once-prefetched row — otherwise [{x:B},{x:A}] on a row
        // holding A would coalesce the second item against the stale prefetched
        // A and drop the first item's write, breaking last-write-wins. The same
        // staleness applies to the window: a copy re-stating the bound the
        // prefetched row held, after an earlier copy already moved it, must
        // write it back rather than coalesce.
        //
        // A QUEUED CREATE is registered here too. Leaving it out queued a SECOND
        // create for a repeated id whose row does not exist yet, and the create
        // batch rejected it as "already exists". Registered, the later copy
        // takes the update path against the queued create — creates run before
        // updates, so the row is there by then — producing exactly the row that
        // sequential `upsertById` calls produce.
        //
        // `props` is the running value the dirty check compares against. It is
        // undefined when no value could be computed (coalescing off, or the
        // check rejected the input): presence of the ENTRY is what routes a
        // later copy away from a second create, while the props only decide
        // coalescing, and an unknown running value simply never coalesces.
        // `window` is always computed — unlike the props it costs no Zod parse.
        const pending = new Map<
          string,
          {
            props: Record<string, unknown> | undefined;
            window: UpsertWindow;
            sourceIndex: number;
          }
        >();
        // A coalesced item that matched an in-batch write resolves to that
        // write's result (filled once the writes run), not a fabricated row.
        const deferred: { index: number; sourceIndex: number }[] = [];

        // A running value exists only to be dirty-checked, so a store without
        // coalescing never needs to know which ids repeat.
        const repeatedIds =
          config.upsertDirtyCheck === undefined ?
            new Set<string>()
          : findRepeatedUpsertIds(items);

        /**
         * The dirty check for one item, or undefined when coalescing is off or
         * the check rejected the input — a validation error must surface from
         * the hooked write path, which re-validates and rejects the batch
         * (matching flag-off), not from here.
         */
        function runDirtyCheck(
          id: string,
          currentProps: Record<string, unknown>,
          inputProps: Record<string, unknown>,
        ): UpsertDirtyCheck | undefined {
          if (config.upsertDirtyCheck === undefined) return undefined;
          try {
            return config.upsertDirtyCheck(kind, id, currentProps, inputProps);
          } catch {
            return undefined;
          }
        }

        let itemIndex = 0;
        for (const item of items) {
          const pendingEntry = pending.get(item.id);
          const original = existingMap.get(item.id);

          if (pendingEntry === undefined && original === undefined) {
            toCreate.push({
              index: itemIndex,
              input: buildCreateInput(kind, item.props, item),
            });
            // A create merges over nothing, so the dirty check run against an
            // EMPTY base is exactly the validated props the insert will store —
            // the running value a later copy of this id compares against, and
            // needed only when there IS a later copy.
            pending.set(item.id, {
              props:
                repeatedIds.has(item.id) ?
                  runDirtyCheck(item.id, {}, item.props)?.validatedProps
                : undefined,
              window: windowAfterUpsertCreate(item),
              sourceIndex: itemIndex,
            });
            itemIndex++;
            continue;
          }

          // A prior in-batch write left the row live; only the prefetched row
          // (no prior write) can be soft-deleted and trigger a resurrection.
          const deletedAt =
            pendingEntry === undefined ?
              requireDefined(original).deleted_at
            : undefined;

          const currentProps =
            pendingEntry === undefined ?
              rowPropsToObject(requireDefined(original).props)
            : pendingEntry.props;
          const dirty =
            currentProps === undefined ? undefined : (
              runDirtyCheck(item.id, currentProps, item.props)
            );

          // The window the row holds going into this item: the prefetched row's,
          // or the one the batch's last queued write for this id leaves behind.
          const currentWindow: UpsertWindow =
            pendingEntry === undefined ?
              {
                valid_from: requireDefined(original).valid_from,
                valid_to: requireDefined(original).valid_to,
              }
            : pendingEntry.window;

          // An explicit window blocks coalescing ONLY when it would change the
          // window already held — the same rule, through the same comparison,
          // that shouldCoalesceUpsert applies to a single upsert. Blocking on the
          // mere PRESENCE of a bound (what this path used to do) rewrote version,
          // history, and revision state for every re-stated row a caller happened
          // to hand its own current window.
          const coalesce =
            dirty?.unchanged === true &&
            deletedAt === undefined &&
            !upsertWindowChanges(item, currentWindow);

          if (coalesce) {
            if (pendingEntry === undefined) {
              results[itemIndex] = narrowNode<N>(
                rowToNode(requireDefined(original)),
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
              input: buildUpsertUpdateInput(kind, item.id, item.props, item),
              clearDeleted: deletedAt !== undefined,
            });
            pending.set(item.id, {
              props: dirty?.validatedProps,
              // A resurrecting update rewrites BOTH bounds (buildUpdateNode's
              // clearDeleted leg stamps `valid_from` and reopens `valid_to`);
              // a live-row update moves only `valid_to`.
              window:
                deletedAt === undefined ?
                  windowAfterUpsertUpdate(currentWindow, item)
                : windowAfterUpsertCreate(item),
              sourceIndex: itemIndex,
            });
          }
          itemIndex++;
        }

        if (toCreate.length > 0) {
          const createInputs = toCreate.map((entry) => entry.input);
          const created = await executeNodeCreateBatch(createInputs, target);
          for (const [index, entry] of toCreate.entries()) {
            results[entry.index] = narrowNode<N>(
              requireDefined(created[index]),
            );
          }
        }

        // Hookless individual updates
        for (const entry of toUpdate) {
          const result = await executeNodeUpsertUpdate(entry.input, target, {
            clearDeleted: entry.clearDeleted,
          });
          results[entry.index] = narrowNode<N>(result);
        }

        // Items that coalesced against an in-batch write take that write's
        // result (now filled). Its sourceIndex is always a write slot — a
        // queued create or a queued update, both filled above.
        for (const { index, sourceIndex } of deferred) {
          results[index] = requireDefined(results[sourceIndex]);
        }

        return { results, mutations: toCreate.length + toUpdate.length };
      };

      const { results, mutations } = await runOptionallyInTransaction(
        backend,
        (target) => upsertAll(target),
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
        props: z.input<N["schema"]>;
        id?: string;
        validFrom?: string;
        validTo?: string;
      }>[],
    ): Promise<void> {
      const batchInputs = mapBulkNodeInputs(kind, items);

      await executeNodeCreateNoReturnBatch(batchInputs, backend);
      await config.maybeRefreshStatisticsAfterBulk?.(batchInputs.length);
    },

    async bulkDelete(ids: readonly NodeId<N>[]): Promise<void> {
      if (ids.length === 0) return;
      await executeNodeDeleteBatch(kind, ids, backend);
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
