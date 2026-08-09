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
 * Observed as backend member CALLS through the same counting-wrapper idiom
 * `bulk-create-batching.test.ts` uses: what is under test is which statements
 * the fused unit issues, not what the rows end up looking like.
 *
 * Named mutation, one per method: delete that method's sidecar call from
 * `write-session.ts` (`applyNodeInsertSideEffects` from `createNode`,
 * `applyNodeInsertSideEffectsBatch` from `createNodes`, the
 * `enforceNodeDeleteBehavior`-bearing `applyNodeSoftDelete` from `retireNode`,
 * …) and exactly that method's case fails.
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
import { buildKindRegistry } from "../src/registry";
import {
  runWritePlan,
  type WritePlanContext,
} from "../src/store/operations/write-executor";
import { nodeWritePlan } from "../src/store/operations/write-plan";
import {
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
  "upsertFulltext",
  "upsertFulltextBatch",
  "deleteFulltext",
  "upsertEmbedding",
  "upsertEmbeddingBatch",
  "deleteEmbedding",
  "deleteEdge",
  "deleteEdgesBatch",
  "hardDeleteEdge",
  "hardDeleteEdgesBatch",
  "insertNode",
  "insertNodeNoReturn",
  "insertNodesBatch",
  "insertNodesBatchReturning",
  "updateNode",
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
  /** Members this method MUST reach, each at least once. */
  sidecars: readonly WatchedMember[];
  /** The primary row statement, asserted so a no-op case cannot pass. */
  row: WatchedMember;
}>;

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
  },
  createNodeNoReturn: {
    run: () =>
      Promise.resolve((session) => session.createNodeNoReturn(insertWork("b"))),
    sidecars: ["insertUnique", "upsertFulltext", "upsertEmbedding"],
    row: "insertNodeNoReturn",
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

        await runWritePlan(
          writeContext(),
          nodeWritePlan(undefined, undefined),
          backend,
          (session) => rowWork(session),
        );

        const missing = [testCase.row, ...testCase.sidecars].filter(
          (member) => counts[member] === 0,
        );
        expect(missing).toEqual([]);
      } finally {
        await raw.close();
      }
    });
  }
});
