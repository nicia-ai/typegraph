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
 *  - uniqueness entries (`insertUnique*` / `deleteUnique`),
 *  - fulltext (`upsertFulltext*` / `deleteFulltext`),
 *  - embeddings (`upsertEmbedding*` / `deleteEmbedding`), and
 *  - for the delete legs, the DELETE-BEHAVIOR EDGE CASCADE
 *    (`deleteEdgesBatch` / `hardDeleteEdgesBatch`), which is a sidecar family
 *    that lives one module away from the others and is easy to forget exactly
 *    because of that.
 *
 * An EDGE write obliges none of them, and the seven edge rows say so with an
 * empty sidecar list. That empty list is a CLAIM, not an omission, so it is
 * asserted as one: a case that declares no sidecars must issue its row
 * statement and NOTHING else off the watched set.
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
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import {
  type GraphBackend,
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
  type NodeInsertWork,
  type WriteSession,
} from "../src/store/operations/write-session";
import { requireDefined } from "../src/utils/presence";

const GRAPH_ID = "session_sidecar_completeness";

const Document = defineNode("Doc", {
  schema: z.object({
    title: searchable(),
    email: z.string(),
    vector: embedding(4),
  }),
});

const links = defineEdge("links", { schema: z.object({}) });

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
  edges: { links: { type: links, from: [Document], to: [Document] } },
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
  "upsertFulltext",
  "upsertFulltextBatch",
  "deleteFulltext",
  "upsertEmbedding",
  "upsertEmbeddingBatch",
  "deleteEmbedding",
  "insertEdge",
  "insertEdgeNoReturn",
  "insertEdgesBatch",
  "insertEdgesBatchReturning",
  "updateEdge",
  "deleteEdge",
  "deleteEdgesBatch",
  "hardDeleteEdge",
  "hardDeleteEdgesBatch",
  "insertNode",
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
}> {
  const counts = emptyCounts();

  function wrapMethods<T extends GraphBackend | TransactionBackend>(
    target: T,
  ): T {
    const wrapped = { ...target } as Record<string, unknown>;
    for (const member of WATCHED_MEMBERS) {
      const original = (target as Record<string, unknown>)[member];
      if (typeof original !== "function") continue;
      wrapped[member] = (...args: unknown[]) => {
        counts[member] += 1;
        return (original as (...a: unknown[]) => unknown).apply(target, args);
      };
    }
    return wrapped as T;
  }

  return {
    backend: {
      ...wrapMethods(backend),
      transaction: (fn, options) =>
        backend.transaction((target) => fn(wrapMethods(target)), options),
    },
    counts,
  };
}

function writeContext(): WritePlanContext {
  return {
    graphId: GRAPH_ID,
    registry,
    schemaVersion: undefined,
    historyEnabled: false,
    revisionTrackingEnabled: false,
    revisionSchema: createSqlSchema(),
  };
}

function documentProps(id: string): Record<string, unknown> {
  return {
    title: `title ${id}`,
    email: `${id}@example.com`,
    vector: [1, 2, 3, 4],
  };
}

function insertWork(id: string): NodeInsertWork {
  return {
    params: { graphId: GRAPH_ID, kind: "Doc", id, props: documentProps(id) },
    sideEffects: {
      kind: "Doc",
      id,
      schema,
      props: documentProps(id),
      uniqueConstraints,
    },
  };
}

function edgeInsertWork(id: string, endpointId: string): EdgeInsertWork {
  return {
    graphId: GRAPH_ID,
    id,
    kind: "links",
    fromKind: "Doc",
    fromId: endpointId,
    toKind: "Doc",
    toId: endpointId,
    props: {},
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
   * The plan this row work runs under. It selects no behavior here — neither
   * the constraint probe nor identity participation is under test — but a node
   * case running an edge plan (or the reverse) would misdescribe the write.
   */
  plan: WritePlan;
}>;

const NODE_PLAN = nodeWritePlan(undefined, undefined);
const EDGE_PLAN = edgeWritePlan(undefined);

/**
 * Exhaustive over the session by type: a method with no case here does not
 * compile.
 */
const CASES: Record<keyof WriteSession, Case> = {
  createNode: {
    run: () =>
      Promise.resolve((session) => session.createNode(insertWork("a"))),
    sidecars: ["insertUnique", "upsertFulltext", "upsertEmbedding"],
    row: "insertNode",
    plan: NODE_PLAN,
  },
  createNodeNoReturn: {
    run: () =>
      Promise.resolve((session) => session.createNodeNoReturn(insertWork("b"))),
    sidecars: ["insertUnique", "upsertFulltext", "upsertEmbedding"],
    row: "insertNodeNoReturn",
    plan: NODE_PLAN,
  },
  createNodes: {
    run: () =>
      Promise.resolve((session) =>
        session.createNodes([insertWork("c"), insertWork("d")]),
      ),
    sidecars: [
      "insertUniqueBatch",
      "upsertFulltextBatch",
      "upsertEmbeddingBatch",
    ],
    row: "insertNodesBatchReturning",
    plan: NODE_PLAN,
  },
  createNodesNoReturn: {
    run: () =>
      Promise.resolve((session) =>
        session.createNodesNoReturn([insertWork("e"), insertWork("f")]),
      ),
    sidecars: [
      "insertUniqueBatch",
      "upsertFulltextBatch",
      "upsertEmbeddingBatch",
    ],
    row: "insertNodesBatch",
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
    plan: NODE_PLAN,
  },
  createEdge: {
    run: async (raw) => {
      await seed(raw, "l");
      const work = edgeInsertWork("edge-new-l", "l");
      return (session) => session.createEdge(work);
    },
    sidecars: [],
    row: "insertEdge",
    plan: EDGE_PLAN,
  },
  createEdgeNoReturn: {
    run: async (raw) => {
      await seed(raw, "m");
      const work = edgeInsertWork("edge-new-m", "m");
      return (session) => session.createEdgeNoReturn(work);
    },
    sidecars: [],
    row: "insertEdgeNoReturn",
    plan: EDGE_PLAN,
  },
  createEdges: {
    run: async (raw) => {
      await seed(raw, "n");
      const work = [
        edgeInsertWork("edge-new-n1", "n"),
        edgeInsertWork("edge-new-n2", "n"),
      ];
      return (session) => session.createEdges(work);
    },
    sidecars: [],
    row: "insertEdgesBatchReturning",
    plan: EDGE_PLAN,
  },
  createEdgesNoReturn: {
    run: async (raw) => {
      await seed(raw, "o");
      const work = [
        edgeInsertWork("edge-new-o1", "o"),
        edgeInsertWork("edge-new-o2", "o"),
      ];
      return (session) => session.createEdgesNoReturn(work);
    },
    sidecars: [],
    row: "insertEdgesBatch",
    plan: EDGE_PLAN,
  },
  reviseEdge: {
    run: async (raw) => {
      await seed(raw, "p");
      const work = { id: "edge-p", props: {} };
      return (session) =>
        session.reviseEdge(work, {
          validityLowerBound: {},
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
      const work = { id: "edge-r", kind: "links" };
      return (session) => session.purgeEdge(work);
    },
    sidecars: [],
    row: "hardDeleteEdge",
    plan: EDGE_PLAN,
  },
};

describe("write session sidecar completeness", () => {
  for (const [method, testCase] of Object.entries(CASES)) {
    it(`${method} applies every sidecar its row work obliges`, async () => {
      const { backend: raw } = createLocalSqliteBackend();
      try {
        // Fulltext and vector storage are provisioned at boot, not by a write:
        // the session under test issues the sidecar statements, it does not
        // create their tables.
        await createStoreWithSchema(graph, raw);
        const rowWork = await testCase.run(raw);
        const { backend, counts } = withCallCounts(raw);

        await runWritePlan(writeContext(), testCase.plan, backend, (session) =>
          rowWork(session),
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
      } finally {
        await raw.close();
      }
    });
  }
});
