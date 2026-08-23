/**
 * Every `WriteSession` method applies the FULL sidecar set its row work
 * obliges.
 *
 * This is the invariant that makes the session worth having: a fused method
 * cannot write a primary row and skip the derived data that row obliges,
 * because there is no row-only primitive to call and every method is checked
 * here. The table is exhaustive by TYPE — `Record<keyof WriteSession, Case>` —
 * so the batch that adds a method to the session cannot compile until it adds
 * that method's row, and the matrix grows with the surface instead of trailing
 * it.
 *
 * The sidecars a node write owes:
 *
 *  - CLAIMS in the `uniques` relation (`insertUnique*` / `deleteUnique`),
 *  - fulltext (`upsertFulltext*` / `deleteFulltext`),
 *  - embeddings (`upsertEmbedding*` / `deleteEmbedding`), and
 *  - for the delete legs, the DELETE-BEHAVIOR EDGE CASCADE
 *    (`deleteEdgesBatch` / `hardDeleteEdgesBatch`), which is a sidecar family
 *    that lives one module away from the others and is easy to forget exactly
 *    because of that.
 *
 * An edge write obliges no DERIVED data, but a CONSTRAINED edge kind owes a claim
 * in the `edge_claims` relation, which is why the edge rows run against a
 * `cardinality: "unique"` kind: an unconstrained kind would let every edge row
 * pass with an empty sidecar list and the claim placements would be guarded by
 * nothing. The rows that legitimately owe nothing say so with an empty list, and
 * that empty list is a CLAIM, not an omission, so it is asserted as one: a case
 * that declares no sidecars must issue its row statement and NOTHING else off
 * the watched set.
 *
 * Observed as backend member CALLS through the same counting-wrapper idiom
 * `bulk-create-batching.test.ts` uses: what is under test is which statements
 * the fused unit issues, not what the rows end up looking like.
 *
 * Named mutation, one per method: delete that method's sidecar call from
 * `write-session.ts` (`applyNodeInsertSideEffects` from `createNode`,
 * `applyNodeInsertSideEffectsBatch` from `createNodes`, the
 * `enforceNodeDeleteBehavior`-bearing `applyNodeSoftDelete` from `retireNode`,
 * …) and exactly that method's case fails. The edge methods have no sidecar
 * call to delete, so theirs is the row write itself: make `retireEdge`
 * delegate to `applyEdgeHardDelete`, or `createEdges` to `runInsertBatch`, and
 * exactly that method's case fails.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CompilerInvariantError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import {
  createClaimsVerdictThunk,
  uniqueSidecarBatchVerdict,
} from "../src/backend/capabilities/resolve";
import {
  deriveBackend,
  type ExactBackendOverlay,
} from "../src/backend/derive-backend";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import {
  type EdgeCreateCommand,
  type GraphBackend,
  type GraphCommand,
  type GraphCommandExecutionContext,
  type LiveNodeRow,
  type NodeRow,
  type TombstonedNodeRow,
  type TransactionBackend,
} from "../src/backend/types";
import { embedding } from "../src/core/embedding";
import { searchable } from "../src/core/searchable";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import { asCompiledSelectSql } from "../src/query/sql-intent";
import { buildKindRegistry } from "../src/registry";
import { edgeCardinalityClaim } from "../src/store/claims/edge-claims";
import { planNodeCreateClaims } from "../src/store/claims/node-claims";
import {
  runWritePlan,
  type WritePlanContext,
} from "../src/store/operations/write-executor";
import {
  edgeWritePlan,
  nodeWritePlan,
  type WritePlan,
} from "../src/store/operations/write-plan";
import {
  type EdgeInsertWork,
  type NodeCreateWork,
  type WriteSession,
} from "../src/store/operations/write-session";
import { requireDefined } from "../src/utils/presence";

const GRAPH_ID = "session_sidecar_completeness";

function createEdgeWithPlan(session: WriteSession): Promise<unknown> {
  const work: EdgeInsertWork = {
    params: {
      graphId: GRAPH_ID,
      kind: "links",
      id: "edge-fast-fused",
      fromKind: "Doc",
      fromId: "fused",
      toKind: "Doc",
      toId: "fused-b",
      props: {},
    },
    claim: undefined,
  };
  const command: EdgeCreateCommand = {
    kind: "edge.create",
    plan: { entity: "edge", params: work.params },
  };
  return session.createEdgeWithPlan(command);
}

const Document = defineNode("Doc", {
  schema: z.object({
    title: searchable(),
    email: z.string(),
    vector: embedding(4),
  }),
});

const links = defineEdge("links", { schema: z.object({}) });
/**
 * A CONSTRAINED edge kind, so the edge rows exercise the claim their cardinality
 * owes. `unique` keys on the endpoint PAIR, which is what lets one batch create
 * two claiming edges from the same source without contending with itself.
 */
const owns = defineEdge("owns", { schema: z.object({}) });

const graph = defineGraph({
  id: GRAPH_ID,
  nodes: {
    Doc: {
      type: Document,
      unique: [
        {
          name: "doc_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    links: { type: links, from: [Document], to: [Document] },
    owns: {
      type: owns,
      from: [Document],
      to: [Document],
      cardinality: "unique",
    },
  },
});

const registry = buildKindRegistry(graph);
const uniqueConstraints = requireDefined(graph.nodes.Doc.unique);
const schema = Document.schema;

/** Every backend member a node write's sidecars can reach. */
const WATCHED_MEMBERS = [
  "insertUnique",
  "insertUniqueBatch",
  "deleteUnique",
  "hardDeleteUniquesByNodeIds",
  "hardDeleteUniquesByConcreteKind",
  "claimEdgeCardinality",
  "claimEdgeCardinalityGuarded",
  "claimEdgeCardinalityBatch",
  "purgeEdgeClaims",
  "upsertFulltext",
  "upsertFulltextBatch",
  "deleteFulltext",
  "upsertEmbedding",
  "upsertEmbeddingBatch",
  "deleteEmbedding",
  "insertEdge",
  "commands",
  "insertEdgeNoReturn",
  "insertEdgesBatch",
  "insertEdgesBatchReturning",
  "updateEdge",
  "deleteEdge",
  "deleteEdgesBatch",
  "hardDeleteEdge",
  "hardDeleteEdgesBatch",
  "insertNode",
  "insertNodeIfAbsent",
  "insertNodeIfAbsentWithSchemaFence",
  "insertNodeWithSchemaFence",
  "insertNodeNoReturn",
  "insertNodesBatch",
  "insertNodesBatchReturning",
  "updateNode",
  "updateNodeSet",
  "deleteNode",
  "hardDeleteNode",
] as const;

type WatchedMember = (typeof WATCHED_MEMBERS)[number];
type CallCounts = Record<WatchedMember, number>;

function emptyCounts(): CallCounts {
  return Object.fromEntries(
    WATCHED_MEMBERS.map((member) => [member, 0]),
  ) as CallCounts;
}

/**
 * Counts calls on the backend AND on every transaction-scoped backend it hands
 * out: the session runs inside the write transaction, so counting only the
 * outer object would see nothing.
 */
function withCallCounts(backend: GraphBackend): Readonly<{
  backend: GraphBackend;
  counts: CallCounts;
  /** Every watched call in the order it was issued — see `preRow` / `postRow`. */
  sequence: WatchedMember[];
}> {
  const counts = emptyCounts();
  const sequence: WatchedMember[] = [];

  function wrapMethods<T extends GraphBackend | TransactionBackend>(
    target: T,
  ): T {
    const overlay: Record<string, unknown> = {};
    for (const member of WATCHED_MEMBERS) {
      const original = (target as Record<string, unknown>)[member];
      if (typeof original !== "function") continue;
      overlay[member] = (...args: unknown[]) => {
        counts[member] += 1;
        sequence.push(member);
        return (original as (...a: unknown[]) => unknown).apply(target, args);
      };
    }
    overlay["commands"] = {
      session: target.commands.session,
      execute(command: GraphCommand, context: GraphCommandExecutionContext) {
        counts.commands += 1;
        sequence.push("commands");
        return target.commands.execute(command, context);
      },
    };
    // Derived, never spread: a fixture built by copying a backend is the #435
    // defect written into the double the store under test then runs against.
    // The cast states what a keyed loop cannot show the compiler — every overlay
    // member IS the target's own function with a counter in front of it.
    return deriveBackend(target, overlay as ExactBackendOverlay<T, Partial<T>>);
  }

  return {
    backend: deriveBackend(wrapMethods(backend), {
      transaction: (fn, options) =>
        backend.transaction((target) => fn(wrapMethods(target)), options),
    }),
    counts,
    sequence,
  };
}

function writeContext(backend: GraphBackend): WritePlanContext {
  return {
    graphId: GRAPH_ID,
    registry,
    schemaVersion: undefined,
    historyEnabled: false,
    revisionTrackingEnabled: false,
    revisionSchema: createSqlSchema(),
    claimsVerdict: createClaimsVerdictThunk(backend),
    uniqueSidecarBatch: uniqueSidecarBatchVerdict(backend),
  };
}

function documentProps(id: string): Record<string, unknown> {
  return {
    title: `title ${id}`,
    email: `${id}@example.com`,
    vector: [1, 2, 3, 4],
  };
}

function createWork(id: string): NodeCreateWork {
  const claim = {
    kind: "Doc",
    id,
    props: documentProps(id),
    constraints: uniqueConstraints,
  } as const;
  return {
    params: { graphId: GRAPH_ID, kind: "Doc", id, props: documentProps(id) },
    claim,
    claimPlan: planNodeCreateClaims({ graphId: GRAPH_ID, registry }, claim),
    sideEffects: {
      kind: "Doc",
      id,
      schema,
      props: documentProps(id),
      uniqueConstraints,
    },
    projections: [],
  };
}

function claimFreeCreateWork(id: string): NodeCreateWork {
  const work = createWork(id);
  const claim = { ...work.claim, constraints: [] };
  return {
    ...work,
    claim,
    claimPlan: planNodeCreateClaims({ graphId: GRAPH_ID, registry }, claim),
  };
}

function edgeInsertWork(
  id: string,
  fromId: string,
  toId: string,
): EdgeInsertWork {
  const params = {
    graphId: GRAPH_ID,
    id,
    kind: "owns",
    fromKind: "Doc",
    fromId,
    toKind: "Doc",
    toId,
    props: {},
  };
  // Built exactly as the production paths build it — through the claim decider —
  // so a change to what a `unique` kind claims moves this fixture too.
  return {
    params,
    claim: requireDefined(edgeCardinalityClaim("unique", params)),
  };
}

/** The fixture every case starts from: one live node, one connected edge. */
async function seed(
  backend: GraphBackend,
  id: string,
): Promise<Readonly<{ row: NodeRow }>> {
  await backend.insertNode({
    graphId: GRAPH_ID,
    kind: "Doc",
    id,
    props: documentProps(id),
  });
  // A second endpoint, so a batch case can create two `unique` edges from one
  // source without the two contending for the same claim row.
  await backend.insertNode({
    graphId: GRAPH_ID,
    kind: "Doc",
    id: `${id}-b`,
    props: documentProps(`${id}-b`),
  });
  await backend.insertEdge({
    graphId: GRAPH_ID,
    kind: "links",
    id: `edge-${id}`,
    fromKind: "Doc",
    fromId: id,
    toKind: "Doc",
    toId: id,
    props: {},
  });
  return {
    row: requireDefined(await backend.getNode(GRAPH_ID, "Doc", id)),
  };
}

async function tombstone(
  backend: GraphBackend,
  id: string,
): Promise<TombstonedNodeRow> {
  await backend.deleteNode({ graphId: GRAPH_ID, kind: "Doc", id });
  const row = requireDefined(await backend.getNode(GRAPH_ID, "Doc", id));
  if (row.deleted_at === undefined) throw new Error("Expected a tombstone.");
  return row as TombstonedNodeRow;
}

function liveRow(row: NodeRow): LiveNodeRow {
  if (row.deleted_at !== undefined) throw new Error("Expected a live row.");
  return row as LiveNodeRow;
}

type Case = Readonly<{
  /** Prepares fixture rows and returns the row work to run. */
  run: (
    raw: GraphBackend,
  ) => Promise<(session: WriteSession) => Promise<unknown>>;
  /**
   * Members this method MUST reach, each at least once. An EMPTY list is the
   * claim "this write obliges no derived data" and is asserted as such: see the
   * exclusivity check in the runner.
   */
  sidecars: readonly WatchedMember[];
  /** The primary row statement, asserted so a no-op case cannot pass. */
  row: WatchedMember;
  /**
   * Sidecars that must be issued BEFORE the row — the claim placements. A claim
   * issued after the row it gates is not a fence, so its POSITION is as
   * load-bearing as its presence, and presence alone is what `sidecars` checks.
   */
  preRow?: readonly WatchedMember[];
  /**
   * CLAIM writes that must follow the row: a claim whose own key is the fence
   * may be issued after the row it fences, and those are the entries here.
   */
  postRowClaims?: readonly WatchedMember[];
  /**
   * SYNC FANS, which must follow the row AND every post-row claim: derived data
   * with no claim to make, which must not be written for a row that never landed
   * nor before the reservation the row depends on. The two fans are issued
   * concurrently, so their order relative to EACH OTHER is deliberately not
   * asserted — only their position relative to the row and the claims.
   */
  postRowFans?: readonly WatchedMember[];
  /**
   * The plan this row work runs under. It selects no behavior here — neither
   * the constraint probe nor identity participation is under test — but a node
   * case running an edge plan (or the reverse) would misdescribe the write.
   */
  plan: WritePlan;
}>;

const NODE_PLAN = nodeWritePlan(undefined, false);
const EDGE_PLAN = edgeWritePlan(undefined);

/**
 * Exhaustive over the session by type: a method with no case here does not
 * compile.
 */
const CASES: Record<keyof WriteSession, Case> = {
  createNode: {
    run: () =>
      Promise.resolve((session) => session.createNode(createWork("a"))),
    sidecars: ["insertUnique", "upsertFulltext", "upsertEmbedding"],
    row: "insertNode",
    // The fixture's constraint is `scope: "kind"`, whose own primary key IS the
    // fence, so its claim keeps the POST-insert placement it ships with. The
    // PRE-insert placement — a scope spanning kinds, where the claim is the only
    // fence — is pinned in `write-plan-statement-order.test.ts`, against real
    // SQL and a `kindWithSubClasses` scope.
    postRowClaims: ["insertUnique"],
    postRowFans: ["upsertFulltext", "upsertEmbedding"],
    plan: NODE_PLAN,
  },
  createNodeIfAbsent: {
    run: () =>
      Promise.resolve((session) =>
        session.createNodeIfAbsent(claimFreeCreateWork("a")),
      ),
    sidecars: ["upsertFulltext", "upsertEmbedding"],
    row: "insertNodeIfAbsent",
    postRowFans: ["upsertFulltext", "upsertEmbedding"],
    plan: NODE_PLAN,
  },
  createNodeIfAbsentWithSchemaFence: {
    run: () =>
      Promise.resolve((session) =>
        session.createNodeIfAbsentWithSchemaFence(
          claimFreeCreateWork("schema-a"),
          {
            expectedVersion: 1,
            graphId: GRAPH_ID,
          },
        ),
      ),
    sidecars: ["upsertFulltext", "upsertEmbedding"],
    row: "insertNodeIfAbsentWithSchemaFence",
    postRowFans: ["upsertFulltext", "upsertEmbedding"],
    plan: NODE_PLAN,
  },
  createNodeWithSchemaFence: {
    run: () =>
      Promise.resolve((session) =>
        session.createNodeWithSchemaFence(createWork("schema-b"), {
          expectedVersion: 1,
          graphId: GRAPH_ID,
        }),
      ),
    sidecars: ["upsertFulltext", "upsertEmbedding"],
    row: "insertNodeWithSchemaFence",
    postRowFans: ["upsertFulltext", "upsertEmbedding"],
    plan: NODE_PLAN,
  },
  createNodeNoReturn: {
    run: () =>
      Promise.resolve((session) => session.createNodeNoReturn(createWork("b"))),
    sidecars: ["insertUnique", "upsertFulltext", "upsertEmbedding"],
    row: "insertNodeNoReturn",
    postRowClaims: ["insertUnique"],
    postRowFans: ["upsertFulltext", "upsertEmbedding"],
    plan: NODE_PLAN,
  },
  createNodes: {
    run: () =>
      Promise.resolve((session) =>
        session.createNodes([createWork("c"), createWork("d")]),
      ),
    sidecars: [
      "insertUniqueBatch",
      "upsertFulltextBatch",
      "upsertEmbeddingBatch",
    ],
    row: "insertNodesBatchReturning",
    postRowClaims: ["insertUniqueBatch"],
    postRowFans: ["upsertFulltextBatch", "upsertEmbeddingBatch"],
    plan: NODE_PLAN,
  },
  createNodesNoReturn: {
    run: () =>
      Promise.resolve((session) =>
        session.createNodesNoReturn([createWork("e"), createWork("f")]),
      ),
    sidecars: [
      "insertUniqueBatch",
      "upsertFulltextBatch",
      "upsertEmbeddingBatch",
    ],
    row: "insertNodesBatch",
    postRowClaims: ["insertUniqueBatch"],
    postRowFans: ["upsertFulltextBatch", "upsertEmbeddingBatch"],
    plan: NODE_PLAN,
  },
  reviseNode: {
    run: async (raw) => {
      const { row } = await seed(raw, "g");
      return (session) =>
        session.reviseNode(
          {
            existing: liveRow(row),
            schema,
            // A CHANGED unique key: the uniqueness transition is a diff, so an
            // update that keeps every key reserves and releases nothing.
            validatedProps: {
              ...documentProps("g"),
              title: "revised",
              email: "g-revised@example.com",
            },
            uniqueConstraints,
          },
          { validityLowerBound: {} },
        );
    },
    sidecars: [
      "deleteUnique",
      "insertUnique",
      "upsertFulltext",
      "upsertEmbedding",
    ],
    row: "updateNode",
    plan: NODE_PLAN,
  },
  retireNode: {
    run: async (raw) => {
      const { row } = await seed(raw, "h");
      return (session) =>
        session.retireNode({
          existing: liveRow(row),
          schema,
          uniqueConstraints,
          onDelete: "cascade",
        });
    },
    // The edge cascade is the sidecar family that lives one module away.
    sidecars: [
      "deleteEdgesBatch",
      "deleteUnique",
      "deleteFulltext",
      "deleteEmbedding",
    ],
    row: "deleteNode",
    plan: NODE_PLAN,
  },
  purgeNode: {
    run: async (raw) => {
      await seed(raw, "i");
      // eslint-disable-next-line unicorn/consistent-function-scoping -- every case returns its row work the same way; hoisting this one would make the table read as if it were different.
      return (session) =>
        session.purgeNode({
          kind: "Doc",
          id: "i",
          schema,
          onDelete: "cascade",
        });
    },
    sidecars: ["hardDeleteEdgesBatch", "deleteEmbedding"],
    row: "hardDeleteNode",
    plan: NODE_PLAN,
  },
  reviveNode: {
    run: async (raw) => {
      await seed(raw, "j");
      const row = await tombstone(raw, "j");
      return (session) =>
        session.reviveNode({ existing: row, schema, uniqueConstraints });
    },
    sidecars: ["insertUnique", "upsertFulltext", "upsertEmbedding"],
    row: "updateNode",
    plan: NODE_PLAN,
  },
  reviseNodeSet: {
    run: async (raw) => {
      await seed(raw, "k");
      const candidates = asCompiledSelectSql(sql`
        SELECT id AS n_id
        FROM ${createSqlSchema(raw.tableNames).nodesTable}
        WHERE graph_id = ${GRAPH_ID} AND kind = 'Doc' AND id = 'k'
      `);
      return (session) =>
        session.reviseNodeSet(
          {
            kind: "Doc",
            schema,
            uniqueConstraints,
            // A CHANGED unique key, for the same reason as `reviseNode`: the
            // set update drops every affected node's entries key-blind and
            // rebuilds them from the after-images.
            patch: {
              title: "set-revised",
              email: "k-revised@example.com",
            },
            unsetProperties: [],
            candidateIds: candidates,
            candidateIdColumn: "n_id",
          },
          { validityLowerBound: {} },
        );
    },
    sidecars: [
      "hardDeleteUniquesByNodeIds",
      "insertUniqueBatch",
      "upsertFulltextBatch",
      "upsertEmbeddingBatch",
    ],
    row: "updateNodeSet",
    // The set update writes its row FIRST — the after-images its claims are
    // computed from are not knowable before the statement runs — so every claim
    // here is a post-row one, and the fans still follow them.
    postRowClaims: ["hardDeleteUniquesByNodeIds", "insertUniqueBatch"],
    postRowFans: ["upsertFulltextBatch", "upsertEmbeddingBatch"],
    plan: NODE_PLAN,
  },
  createEdge: {
    run: async (raw) => {
      await seed(raw, "l");
      const work = edgeInsertWork("edge-new-l", "l", "l-b");
      return (session) => session.createEdge(work);
    },
    sidecars: ["claimEdgeCardinalityGuarded"],
    row: "insertEdge",
    preRow: ["claimEdgeCardinalityGuarded"],
    plan: EDGE_PLAN,
  },
  createEdgeWithPlan: {
    run: async (raw) => {
      await seed(raw, "fused");
      return createEdgeWithPlan;
    },
    sidecars: [],
    row: "commands",
    plan: EDGE_PLAN,
  },
  createEdgeNoReturn: {
    run: async (raw) => {
      await seed(raw, "m");
      const work = edgeInsertWork("edge-new-m", "m", "m-b");
      return (session) => session.createEdgeNoReturn(work);
    },
    sidecars: ["claimEdgeCardinalityGuarded"],
    row: "insertEdgeNoReturn",
    preRow: ["claimEdgeCardinalityGuarded"],
    plan: EDGE_PLAN,
  },
  createEdges: {
    run: async (raw) => {
      await seed(raw, "n");
      const work = [
        edgeInsertWork("edge-new-n1", "n", "n"),
        edgeInsertWork("edge-new-n2", "n", "n-b"),
      ];
      return (session) => session.createEdges(work);
    },
    sidecars: ["claimEdgeCardinalityBatch"],
    row: "insertEdgesBatchReturning",
    preRow: ["claimEdgeCardinalityBatch"],
    plan: EDGE_PLAN,
  },
  createEdgesNoReturn: {
    run: async (raw) => {
      await seed(raw, "o");
      const work = [
        edgeInsertWork("edge-new-o1", "o", "o"),
        edgeInsertWork("edge-new-o2", "o", "o-b"),
      ];
      return (session) => session.createEdgesNoReturn(work);
    },
    sidecars: ["claimEdgeCardinalityBatch"],
    row: "insertEdgesBatch",
    preRow: ["claimEdgeCardinalityBatch"],
    plan: EDGE_PLAN,
  },
  reviseEdge: {
    run: async (raw) => {
      await seed(raw, "p");
      const work = { id: "edge-p", props: {} };
      return (session) =>
        session.reviseEdge(work, {
          validityLowerBound: {},
          // An in-place props update re-admits the row to no counted population,
          // so it reads no stored end and asserts none.
          validityUpperBound: {},
          // The kind the seeded row carries: an edge update always asserts the
          // identity it resolved the row under, and the applier carries it
          // into the statement's own `WHERE`.
          edgeIdentity: { kind: "links" },
        });
    },
    sidecars: [],
    row: "updateEdge",
    plan: EDGE_PLAN,
  },
  retireEdge: {
    run: async (raw) => {
      await seed(raw, "q");
      const work = { id: "edge-q", kind: "links" };
      return (session) => session.retireEdge(work);
    },
    sidecars: [],
    row: "deleteEdge",
    plan: EDGE_PLAN,
  },
  purgeEdge: {
    run: async (raw) => {
      await seed(raw, "r");
      // A CONSTRAINED kind, so the claim release is a statement this case can
      // observe: an unconstrained kind holds no claim and pays nothing for one.
      const work = await (async () => {
        await raw.insertEdge({
          graphId: GRAPH_ID,
          kind: "owns",
          id: "edge-owns-r",
          fromKind: "Doc",
          fromId: "r",
          toKind: "Doc",
          toId: "r-b",
          props: {},
        });
        return { id: "edge-owns-r", kind: "owns", holdsCardinalityClaim: true };
      })();
      return (session) => session.purgeEdge(work);
    },
    sidecars: ["purgeEdgeClaims"],
    row: "hardDeleteEdge",
    postRowClaims: ["purgeEdgeClaims"],
    plan: EDGE_PLAN,
  },
};

describe("write session sidecar completeness", () => {
  it.each(["ordinary", "schema-fenced"] as const)(
    "refuses a %s insert-if-absent unit that carries claims",
    async (mode) => {
      const { backend: raw } = createLocalSqliteBackend();
      try {
        await createStoreWithSchema(graph, raw);
        const { backend, counts } = withCallCounts(raw);

        await expect(
          runWritePlan(writeContext(backend), NODE_PLAN, backend, (session) =>
            mode === "ordinary" ?
              session.createNodeIfAbsent(createWork(`claimed-${mode}`))
            : session.createNodeIfAbsentWithSchemaFence(
                createWork(`claimed-${mode}`),
                { expectedVersion: 1, graphId: GRAPH_ID },
              ),
          ),
        ).rejects.toBeInstanceOf(CompilerInvariantError);
        expect(counts.insertNodeIfAbsent).toBe(0);
        expect(counts.insertNodeIfAbsentWithSchemaFence).toBe(0);
      } finally {
        await raw.close();
      }
    },
  );

  for (const [method, testCase] of Object.entries(CASES)) {
    it(`${method} applies every sidecar its row work obliges`, async () => {
      const { backend: raw } = createLocalSqliteBackend();
      try {
        // Fulltext and vector storage are provisioned at boot, not by a write:
        // the session under test issues the sidecar statements, it does not
        // create their tables.
        await createStoreWithSchema(graph, raw);
        const rowWork = await testCase.run(raw);
        const { backend, counts, sequence } = withCallCounts(raw);

        await runWritePlan(
          writeContext(backend),
          testCase.plan,
          backend,
          (session) =>
            // `CASES` is heterogeneous by plan family. `Object.entries` erases
            // the correlation between each plan and its row-work session, while
            // the exhaustive table above establishes that correlation per entry.
            rowWork(session as WriteSession),
        );

        const missing = [testCase.row, ...testCase.sidecars].filter(
          (member) => counts[member] === 0,
        );
        expect(missing).toEqual([]);

        // A method that declares NO sidecars is claiming something, not
        // omitting something — an edge write obliges no derived data — so the
        // empty list is asserted rather than trusted: nothing but the row
        // statement may reach the backend. A method that DOES declare sidecars
        // is checked by the list above; this adds nothing for it.
        const undeclared =
          testCase.sidecars.length === 0 ?
            WATCHED_MEMBERS.filter(
              (member) => member !== testCase.row && counts[member] > 0,
            )
          : [];
        expect(undeclared).toEqual([]);

        // …and each declared sidecar sits on the side of the row its PLACEMENT
        // says it does. A claim issued after the row it gates is not a fence,
        // and derived data written before the row can describe a row that never
        // landed, so position is a separate assertion from presence.
        const rowAt = sequence.indexOf(testCase.row);
        const postRowClaims = testCase.postRowClaims ?? [];
        const postRowFans = testCase.postRowFans ?? [];
        const at = (member: WatchedMember): number => sequence.indexOf(member);
        const misplaced = [
          ...(testCase.preRow ?? []).filter((member) => at(member) > rowAt),
          ...[...postRowClaims, ...postRowFans].filter(
            (member) => at(member) < rowAt,
          ),
          // A fan before any claim the same write owes would be derived data
          // written against a reservation nobody had taken yet.
          ...postRowFans.filter((fan) =>
            postRowClaims.some((claim) => at(fan) < at(claim)),
          ),
        ];
        expect(misplaced).toEqual([]);
      } finally {
        await raw.close();
      }
    });
  }
});
