/**
 * `tx.assertUnchangedSince()`: optimistic concurrency with a declared read
 * set, validated inside the caller's write transaction.
 *
 * The fence takes the store's canonical write-fence prelude (schema-version
 * fence, then the per-graph write fence, with evidence that the session's
 * reads observe every earlier holder), and only then asks the store's
 * lineage source what changed in each declared scope since the anchor. No
 * decision is made from a read taken before the lock, and the fence writes
 * nothing.
 */
import { type EngineRevision } from "../backend/types";
import { type GraphDef } from "../core/define-graph";
import {
  ConfigurationError,
  ReadSetChangedError,
  ReadSetUnverifiableError,
  UnsupportedBackendCapabilityError,
} from "../errors";
import type { OperationBackend } from "./operation-scope";
import {
  freshSnapshotUnprovableError,
  lockStoreWriteFence,
} from "./operations/write-fence-prelude";
import {
  refuseReadOnlyTransactionWrite,
  storeWritersTakeGraphWriteFence,
  type WriteTransactionContext,
} from "./operations/write-transaction";
import { type ReadSetEdgeDirection, type ReadSetScope } from "./read-set";
import {
  changesInReadSet,
  type ReadSetRegion,
  type RecordedLineageStore,
  resolveLineage,
} from "./recorded-capture";
import {
  assertRegisteredEdgeKinds,
  assertRegisteredNodeKinds,
} from "./registered-kinds";

const ASSERT_UNCHANGED_SINCE_OPERATION = "tx.assertUnchangedSince()";

const READ_SET_CAPABILITY = {
  lineage: "lineage",
  graphWriteFence: "graphWriteFence",
} as const;

const READ_SET_SCOPE_INVALID_CODE = "READ_SET_SCOPE_INVALID";

const READ_SET_EDGE_DIRECTIONS: Readonly<Record<ReadSetEdgeDirection, true>> = {
  out: true,
  in: true,
  both: true,
};

function isReadSetEdgeDirection(value: unknown): value is ReadSetEdgeDirection {
  return (
    typeof value === "string" && Object.hasOwn(READ_SET_EDGE_DIRECTIONS, value)
  );
}

/**
 * The scope keys that name what a read-set scope covers (exactly one is set),
 * each with every key a scope of that target may carry. A key outside its
 * target's list is refused rather than ignored: `{ node, direction, kind }`
 * type-checks against the scope union but would silently drop the
 * neighbourhood the caller meant to declare.
 */
const READ_SET_SCOPE_KEYS = {
  node: ["node"],
  edge: ["edge"],
  edgesAt: ["edgesAt", "direction", "kind"],
  nodeKind: ["nodeKind"],
  edgeKind: ["edgeKind"],
  graph: ["graph"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

type ReadSetScopeTarget = keyof typeof READ_SET_SCOPE_KEYS;

const READ_SET_SCOPE_TARGETS = Object.keys(
  READ_SET_SCOPE_KEYS,
) as readonly ReadSetScopeTarget[];

/** What the store hands the fence about itself and the transaction. */
export type ReadSetFenceContext<G extends GraphDef> = Readonly<{
  graph: G;
  lineageStore: RecordedLineageStore<G>;
  /** Whether the store's ordinary writers take the per-graph write fence. */
  writers: Pick<
    WriteTransactionContext,
    "historyEnabled" | "revisionTrackingEnabled"
  >;
  schemaVersion: number | undefined;
  /** The transaction was opened with `accessMode: "read_only"`. */
  readOnly: boolean;
}>;

/**
 * Refuses the transaction when a row inside a declared read-set scope
 * changed after `anchor`, or when the store cannot prove it did not. See
 * `TransactionContext.assertUnchangedSince` for the caller contract.
 *
 * @throws KindNotFoundError when a scope names an unregistered kind.
 * @throws ConfigurationError when a scope is malformed.
 * @throws UnsupportedBackendCapabilityError when the transaction is read
 *   only, the store has no lineage source, its writers do not take the graph
 *   write fence, or the session cannot prove a fresh snapshot.
 * @throws ReadSetUnverifiableError when the lineage source cannot bound the
 *   span since `anchor`.
 * @throws ReadSetChangedError listing every changed scope and its keys,
 *   bounded per scope.
 */
export async function assertReadSetUnchangedSince<G extends GraphDef>(
  ctx: ReadSetFenceContext<G>,
  txBackend: OperationBackend,
  anchor: EngineRevision,
  scopes: readonly ReadSetScope<G>[],
): Promise<void> {
  const graphId = ctx.lineageStore.graphId;
  const regions = scopes.map((scope, index) =>
    resolveReadSetRegion(ctx.graph, scope, index),
  );
  if (ctx.readOnly) {
    refuseReadOnlyTransactionWrite(
      ASSERT_UNCHANGED_SINCE_OPERATION,
      graphId,
      'Remove accessMode: "read_only": the read-set fence takes the graph write lock so no writer can commit between the check and this transaction\'s writes.',
    );
  }
  assertReadSetFenceSupported(ctx, graphId);

  await lockStoreWriteFence(txBackend, {
    graphId,
    schemaVersion: ctx.schemaVersion,
    graphLock: "required",
    requireFreshSnapshot: true,
    freshSnapshotError: (isolation) =>
      freshSnapshotUnprovableError(
        ASSERT_UNCHANGED_SINCE_OPERATION,
        graphId,
        isolation,
        "evidence",
      ),
    staleSchemaError: (cause) => cause,
  });

  const delta = await changesInReadSet(
    ctx.lineageStore,
    txBackend,
    anchor,
    regions,
  );
  if (delta.kind === "unbounded") {
    throw new ReadSetUnverifiableError({ graphId, anchor });
  }
  if (delta.changes.length > 0) {
    throw new ReadSetChangedError({ graphId, anchor, changes: delta.changes });
  }
}

/**
 * Refuses a store that cannot answer the fence soundly: one with no lineage
 * source, or one whose ordinary writers do not serialize behind the graph
 * write fence (holding the fence would exclude nothing).
 */
function assertReadSetFenceSupported<G extends GraphDef>(
  ctx: ReadSetFenceContext<G>,
  graphId: string,
): void {
  if (resolveLineage(ctx.lineageStore) === undefined) {
    throw new UnsupportedBackendCapabilityError(
      ASSERT_UNCHANGED_SINCE_OPERATION,
      READ_SET_CAPABILITY.lineage,
      { graphId },
      "Use a Store with history: true or revisionTracking: true, or a backend that declares its own lineage.",
    );
  }
  if (!storeWritersTakeGraphWriteFence(ctx.writers)) {
    throw new UnsupportedBackendCapabilityError(
      ASSERT_UNCHANGED_SINCE_OPERATION,
      READ_SET_CAPABILITY.graphWriteFence,
      { graphId },
      "Enable TypeGraph-owned history capture or revisionTracking so every writer of this graph takes the graph write fence.",
    );
  }
}

function isScopeObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A declared scope as an object, refused before any key is read when it is
 * not one (`null`, a primitive, or an array).
 */
function requireScopeObject(scope: unknown): Readonly<Record<string, unknown>> {
  if (isScopeObject(scope)) return scope;
  throw invalidScopeError(scope, "a scope must be an object.");
}

/**
 * The one target key a scope sets, refused when it sets none or several, or
 * carries a key that target does not define.
 */
function readSetScopeTarget(
  scope: Readonly<Record<string, unknown>>,
): ReadSetScopeTarget {
  const targets = READ_SET_SCOPE_TARGETS.filter((target) =>
    Object.hasOwn(scope, target),
  );
  const [target] = targets;
  if (target === undefined || targets.length > 1) {
    throw invalidScopeError(scope, "a scope must name exactly one target.");
  }
  const allowedKeys: readonly string[] = READ_SET_SCOPE_KEYS[target];
  const unknownKeys = Object.keys(scope).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unknownKeys.length > 0) {
    throw invalidScopeError(
      scope,
      `a ${target} scope does not take ${unknownKeys.map((key) => `"${key}"`).join(", ")}.`,
    );
  }
  return target;
}

function invalidScopeError(scope: unknown, reason: string): ConfigurationError {
  return new ConfigurationError(
    `Invalid read-set scope: ${reason}`,
    { code: READ_SET_SCOPE_INVALID_CODE, scope },
    {
      suggestion:
        "Declare each scope as exactly one of { node }, { edge }, { edgesAt, direction, kind? }, { nodeKind }, { edgeKind } or { graph: true }.",
    },
  );
}

/** A `{ kind, id }` reference a scope names, refused when it is not one. */
function requireRowReference(
  scope: Readonly<Record<string, unknown>>,
  value: unknown,
): Readonly<{ kind: string; id: string }> {
  if (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "id" in value &&
    typeof value.kind === "string" &&
    typeof value.id === "string"
  ) {
    return { kind: value.kind, id: value.id };
  }
  throw invalidScopeError(scope, "a row reference must be { kind, id }.");
}

/**
 * Validates one declared scope against the graph and resolves it to the
 * region a lineage source answers. Every kind it names must be registered.
 */
function resolveReadSetRegion<G extends GraphDef>(
  graph: G,
  scope: ReadSetScope<G>,
  index: number,
): ReadSetRegion {
  const declared = requireScopeObject(scope);
  switch (readSetScopeTarget(declared)) {
    case "node": {
      const node = requireRowReference(declared, declared["node"]);
      assertRegisteredNodeKinds(graph, [node.kind]);
      return { index, target: "node", kind: node.kind, id: node.id };
    }
    case "edge": {
      const edge = requireRowReference(declared, declared["edge"]);
      assertRegisteredEdgeKinds(graph, [edge.kind]);
      return { index, target: "edge", kind: edge.kind, id: edge.id };
    }
    case "edgesAt": {
      return resolveNeighbourhoodRegion(graph, declared, index);
    }
    case "nodeKind": {
      const kind = requireKindName(declared, declared["nodeKind"]);
      assertRegisteredNodeKinds(graph, [kind]);
      return { index, target: "nodeKind", kind };
    }
    case "edgeKind": {
      const kind = requireKindName(declared, declared["edgeKind"]);
      assertRegisteredEdgeKinds(graph, [kind]);
      return { index, target: "edgeKind", kind };
    }
    case "graph": {
      if (declared["graph"] !== true) {
        throw invalidScopeError(
          declared,
          "a whole-graph scope is { graph: true }.",
        );
      }
      return { index, target: "graph" };
    }
  }
}

function requireKindName(
  scope: Readonly<Record<string, unknown>>,
  value: unknown,
): string {
  if (typeof value === "string") return value;
  throw invalidScopeError(scope, "a kind scope names a kind as a string.");
}

function resolveNeighbourhoodRegion(
  graph: GraphDef,
  declared: Readonly<Record<string, unknown>>,
  index: number,
): ReadSetRegion {
  const node = requireRowReference(declared, declared["edgesAt"]);
  const direction = declared["direction"];
  if (!isReadSetEdgeDirection(direction)) {
    throw invalidScopeError(
      declared,
      'an edgesAt scope declares direction "out", "in" or "both".',
    );
  }
  const edgeKind =
    declared["kind"] === undefined ?
      undefined
    : requireKindName(declared, declared["kind"]);
  assertRegisteredNodeKinds(graph, [node.kind]);
  if (edgeKind !== undefined) assertRegisteredEdgeKinds(graph, [edgeKind]);
  return {
    index,
    target: "edgesAt",
    nodeKind: node.kind,
    nodeId: node.id,
    direction,
    edgeKind,
  };
}
