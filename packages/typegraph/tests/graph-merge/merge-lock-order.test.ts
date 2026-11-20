/**
 * The merge commit's lock order, asserted from the emitted SQL.
 *
 * The store's canonical order is the schema-version fence (`FOR SHARE` on the
 * active schema row) first and the per-graph write lock second. A schema
 * commit takes the row `FOR UPDATE` and then, for an identity-enabled graph,
 * the graph lock, so a merge commit that takes the graph lock before the
 * schema fence closes a cycle with it and PostgreSQL aborts one side with
 * `40P01`. Both orders return the same rows, so the order cannot be seen from
 * the public API; this suite records the statements a PGlite-backed
 * PostgreSQL backend receives.
 *
 * Contract under test: every merge commit seam (`merge()` against an
 * untracked, a revision-tracked and a history target; `mergeIncremental()`;
 * `applyMergePlan()`; `applyMergePlanInTransaction()`) takes the schema fence
 * before any graph lock, on the plan shapes that reach the apply's own direct
 * graph-lock sites: a composition delete (the orphan re-verification) and a
 * composition attach (the composition window decision). A target handle whose
 * schema another handle has advanced is refused as `BaseVersionMismatchError`
 * before the commit takes any graph lock.
 *
 * Named mutation, verified to bite: remove the `lockMergeCommitFence` call
 * from `commitPlan` (`src/graph-merge/merge.ts`). Every `merge()` case then
 * shows a graph lock before any `FOR SHARE`, and the stale handle surfaces as
 * a generic `MergeError` from its first write instead of the typed mismatch,
 * so the assertions below fail. Before this suite's fix the untracked
 * `merge()` cases and the stale-handle case failed the same way; the other
 * seams already took the schema fence first and guard it here.
 */
import { PGlite } from "@electric-sql/pglite";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
  StaleVersionError,
  type Store,
} from "../../src";
import { generatePostgresDDL } from "../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../src/backend/postgres";
import { branch } from "../../src/graph-merge/branch";
import { BaseVersionMismatchError } from "../../src/graph-merge/errors";
import {
  applyMergePlan,
  applyMergePlanInTransaction,
  merge,
  mergeIncremental,
  planMerge,
} from "../../src/graph-merge/merge";
import { isErr, unwrap } from "../../src/graph-merge/result";
import { asBranchId, type GraphBranch } from "../../src/graph-merge/types";

const GRAPH_WRITE_NAMESPACE = "typegraph:recorded-graph-write";

type LoggedStatement = Readonly<{ query: string; params: readonly unknown[] }>;
type LockEvent = "schema fence" | "graph lock";

const Whole = defineNode("Whole", { schema: z.object({}) });
const Part = defineNode("Part", { schema: z.object({}) });
const Note = defineNode("Note", { schema: z.object({}) });
const holds = defineEdge("holds", { schema: z.object({}) });

function compositionGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Whole: { type: Whole }, Part: { type: Part } },
    edges: {
      holds: { type: holds, from: [Part], to: [Whole], cardinality: "one" },
    },
    ontology: [partOf(Part, Whole, { via: holds })],
  });
}

/** {@link compositionGraph} with one more node kind: a schema commit. */
function evolvedCompositionGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      Whole: { type: Whole },
      Part: { type: Part },
      Note: { type: Note },
    },
    edges: {
      holds: { type: holds, from: [Part], to: [Whole], cardinality: "one" },
    },
    ontology: [partOf(Part, Whole, { via: holds })],
  });
}

type CompositionGraph = ReturnType<typeof compositionGraph>;
type CompositionStore = Store<CompositionGraph>;
type TargetOptions = Readonly<{ revisionTracking?: true; history?: true }>;

const statements: LoggedStatement[] = [];

let backend: ReturnType<typeof createPostgresBackend>;
let closeClient: () => Promise<void>;
const cleanups: (() => Promise<void>)[] = [];

function isGraphLock(statement: LoggedStatement): boolean {
  return (
    statement.query.includes("pg_advisory_xact_lock") &&
    (statement.params.includes(GRAPH_WRITE_NAMESPACE) ||
      statement.query.includes(`'${GRAPH_WRITE_NAMESPACE}'`))
  );
}

/**
 * The lock acquisitions in the order the server takes them: statements in
 * emission order, and inside one statement by position in its text.
 */
function lockEvents(): readonly LockEvent[] {
  return statements.flatMap((statement): readonly LockEvent[] => {
    const schemaAt = statement.query.search(/for share/iu);
    const graphAt =
      isGraphLock(statement) ?
        statement.query.indexOf("pg_advisory_xact_lock")
      : -1;
    return [
      ...(schemaAt >= 0 ? [["schema fence", schemaAt] as const] : []),
      ...(graphAt >= 0 ? [["graph lock", graphAt] as const] : []),
    ]
      .toSorted(([, left], [, right]) => left - right)
      .map(([event]) => event);
  });
}

/** Asserts the merge took a graph lock, and never before a schema fence. */
function expectSchemaFenceFirst(): void {
  const events = lockEvents();
  expect(events).toContain("graph lock");
  expect(events[0]).toBe("schema fence");
}

beforeAll(async () => {
  const client = await PGlite.create();
  const query = client.query.bind(client);
  const querySpy = vi.spyOn(client, "query").mockImplementation((...args) => {
    statements.push({ query: args[0], params: args[1] ?? [] });
    return query(...args);
  });
  closeClient = async () => {
    querySpy.mockRestore();
    await client.close();
  };
  await client.exec(generatePostgresDDL().join("\n\n"));
  backend = createPostgresBackend(
    drizzle(client, {
      logger: {
        logQuery(queryText: string, params: unknown[]): void {
          statements.push({ query: queryText, params });
        },
      },
    }),
    { vector: false },
  );
});

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
  await closeClient();
});

beforeEach(() => {
  statements.splice(0);
});

let graphSequence = 0;
let branchSequence = 0;

/** A target on its own graph id holding `w1` with its part `p1`. */
async function seededTarget(
  options: TargetOptions = {},
): Promise<CompositionStore> {
  graphSequence += 1;
  const [store] = await createStoreWithSchema(
    compositionGraph(`merge_lock_order_${graphSequence}`),
    backend,
    options,
  );
  const whole = await store.nodes.Whole.create({}, { id: "w1" });
  const part = await store.nodes.Part.create({}, { id: "p1" });
  await store.edges.holds.create(part, whole, {});
  return store;
}

async function branchOf(
  store: CompositionStore,
): Promise<GraphBranch<CompositionGraph>> {
  branchSequence += 1;
  const forked = await branch(
    store,
    () => {
      const { backend: branchBackend } = createLocalSqliteBackend();
      cleanups.push(() => branchBackend.close());
      return Promise.resolve(branchBackend);
    },
    { id: asBranchId(`branch-${branchSequence}`) },
  );
  if (isErr(forked)) throw forked.error;
  return forked.data;
}

/** A branch that deletes the whole, cascading its part: the orphan re-verification. */
async function deletingBranch(
  store: CompositionStore,
): Promise<GraphBranch<CompositionGraph>> {
  const forked = await branchOf(store);
  await forked.store.nodes.Whole.delete("w1" as never);
  return forked;
}

/** A branch that attaches a new part: the composition window decision. */
async function attachingBranch(
  store: CompositionStore,
): Promise<GraphBranch<CompositionGraph>> {
  const forked = await branchOf(store);
  const whole = await forked.store.nodes.Whole.create({}, { id: "w2" });
  const part = await forked.store.nodes.Part.create({}, { id: "p2" });
  await forked.store.edges.holds.create(part, whole, {});
  return forked;
}

const BRANCH_SHAPES = [
  ["deletes a composition whole", deletingBranch],
  ["attaches a composition part", attachingBranch],
] as const;

const TARGETS = [
  ["an untracked target", {}],
  ["a revision-tracked target", { revisionTracking: true }],
  ["a history target", { history: true }],
] as const satisfies readonly (readonly [string, TargetOptions])[];

describe.each(TARGETS)("merge() into %s", (_target, options) => {
  it.each(BRANCH_SHAPES)(
    "takes the schema fence before the graph lock when the branch %s",
    async (_shape, makeBranch) => {
      const store = await seededTarget(options);
      const forked = await makeBranch(store);
      statements.splice(0);

      unwrap(await merge(store, [forked]));

      expectSchemaFenceFirst();
    },
  );
});

describe.each(BRANCH_SHAPES)(
  "the other merge commit seams, when the branch %s",
  (_shape, makeBranch) => {
    it("mergeIncremental() takes the schema fence before the graph lock", async () => {
      const store = await seededTarget();
      // The fork point is a copy of the target's state on its own engine:
      // the incremental commit reads it while the target's transaction is
      // open, and PGlite has one connection.
      const forkPoint = (await branchOf(store)).store;
      const forked = await makeBranch(forkPoint);
      statements.splice(0);

      unwrap(
        await mergeIncremental({
          forkPoint,
          target: store,
          branches: [forked],
        }),
      );

      expectSchemaFenceFirst();
    });

    it("applyMergePlan() takes the schema fence before the graph lock", async () => {
      const store = await seededTarget({ revisionTracking: true });
      const forked = await makeBranch(store);
      const plan = unwrap(await planMerge(store, [forked]));
      statements.splice(0);

      unwrap(await applyMergePlan(store, plan));

      expectSchemaFenceFirst();
    });

    it("applyMergePlanInTransaction() takes the schema fence before the graph lock", async () => {
      const store = await seededTarget({ revisionTracking: true });
      const forked = await makeBranch(store);
      const plan = unwrap(await planMerge(store, [forked]));
      statements.splice(0);

      await store.transaction((tx) =>
        applyMergePlanInTransaction(store, tx, plan),
      );

      expectSchemaFenceFirst();
    });
  },
);

describe("a stale target handle", () => {
  it("is refused as a base-version mismatch before the merge commit takes any graph lock", async () => {
    const store = await seededTarget();
    // Another handle advances the schema before the branch is taken, so the
    // branch's base version and the target's live one agree and only the
    // handle itself is stale.
    await createStoreWithSchema(
      evolvedCompositionGraph(store.graphId),
      backend,
    );
    const forked = await deletingBranch(store);
    statements.splice(0);

    const result = await merge(store, [forked]);

    if (!isErr(result)) throw new Error("Expected the stale merge to fail.");
    expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    expect(result.error.cause).toBeInstanceOf(StaleVersionError);
    expect(lockEvents()).not.toContain("graph lock");
    expect(await store.nodes.Whole.getById("w1" as never)).toBeDefined();
  });
});
