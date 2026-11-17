/**
 * Cross-backend contract for `tx.assertUnchangedSince()`, the read-set fence.
 *
 * Parameterized over both lineage sources the fence can ask: a history store
 * (exact, answered from the recorded relations) and a revision-tracked live
 * store (answered from the entity-key journal and filtered per scope). The two
 * agree on everything except one documented conservative difference: the
 * journal records no edge endpoints, so on that source an `edgesAt` scope
 * counts every changed edge of its kind (`exactNeighbourhoods` below).
 *
 * Belongs in the shared suite because scope semantics are query-layer
 * behavior: only the same case on every backend certifies equivalence.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  type Store,
  type TransactionContext,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import type { EngineRevision } from "../../../src/backend/types";
import {
  ConfigurationError,
  KindNotFoundError,
  ReadSetChangedError,
  ReadSetUnverifiableError,
  UnsupportedBackendCapabilityError,
} from "../../../src/errors-entry";
import type { ReadSetScope } from "../../../src/store/read-set";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";

const Document = defineNode("Doc", { schema: z.object({ title: z.string() }) });
const Note = defineNode("Note", { schema: z.object({ body: z.string() }) });
const cites = defineEdge("cites", { schema: z.object({ weight: z.number() }) });
const mentions = defineEdge("mentions", {
  schema: z.object({ weight: z.number() }),
});

const readSetGraph = defineGraph({
  id: "read_set_fence",
  nodes: { Doc: { type: Document }, Note: { type: Note } },
  edges: {
    cites: { type: cites, from: [Document], to: [Document] },
    mentions: { type: mentions, from: [Document], to: [Document] },
  },
});
type ReadSetGraph = typeof readSetGraph;
type Scope = ReadSetScope<ReadSetGraph>;

const PLAIN_STORE_GRAPH = defineGraph({
  id: "read_set_fence_plain",
  nodes: { Doc: { type: Document } },
  edges: {},
});

const identityReadSetGraph = defineGraph({
  id: "read_set_fence_identity",
  nodes: { Doc: { type: Document }, Note: { type: Note } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});
type IdentityReadSetGraph = typeof identityReadSetGraph;

const REPORTED_KEYS_LIMIT = 100;
const MANY_SCOPES = 400;

type FenceTransaction = Pick<
  TransactionContext<ReadSetGraph>,
  "assertUnchangedSince" | "nodes" | "edges"
>;

/** The members both store flavors share; `transaction` is narrowed to what the fence cases use. */
type FenceStore = Pick<
  Store<ReadSetGraph>,
  "nodes" | "edges" | "clear" | "lineageRevisionNow" | "changesSince"
> &
  Readonly<{
    transaction: <T>(
      run: (tx: FenceTransaction) => Promise<T>,
      options?: Readonly<{ accessMode?: "read_only" | "read_write" }>,
    ) => Promise<T>;
  }>;

type IdentityFenceStore = Pick<
  Store<IdentityReadSetGraph>,
  "nodes" | "identity" | "lineageRevisionNow" | "changesSince" | "transaction"
>;

type LineageFlavor = Readonly<{
  name: string;
  create: (context: IntegrationTestContext) => Promise<FenceStore>;
  createWithIdentity: (
    context: IntegrationTestContext,
  ) => Promise<IdentityFenceStore>;
  /**
   * The history source keeps every version's endpoints and answers an
   * `edgesAt` scope exactly. The journal records only edge kind and id, so it
   * answers at edge-kind granularity: any changed edge of the scope's kind
   * (any kind when it has none) counts, whatever its endpoints or direction.
   */
  exactNeighbourhoods: boolean;
}>;

const FLAVORS: readonly LineageFlavor[] = [
  {
    name: "history store",
    create: (context) => context.createHistoryStore(readSetGraph),
    createWithIdentity: (context) =>
      context.createHistoryStore(identityReadSetGraph),
    exactNeighbourhoods: true,
  },
  {
    name: "revision-tracked live store",
    create: (context) =>
      context.createStore(readSetGraph, { revisionTracking: true }),
    createWithIdentity: (context) =>
      context.createStore(identityReadSetGraph, { revisionTracking: true }),
    exactNeighbourhoods: false,
  },
];

function paddedId(index: number): string {
  return `capped-${String(index).padStart(4, "0")}`;
}

async function seed(store: FenceStore) {
  const a = await store.nodes.Doc.create({ title: "a" });
  const b = await store.nodes.Doc.create({ title: "b" });
  const c = await store.nodes.Doc.create({ title: "c" });
  const unrelated = await store.nodes.Doc.create({ title: "unrelated" });
  return { a, b, c, unrelated };
}

async function anchorNow(store: FenceStore): Promise<EngineRevision> {
  return requireDefined(
    await store.lineageRevisionNow(),
    "the lineage store must mint an anchor",
  );
}

/** Runs the fence alone in its own transaction; resolves when nothing changed. */
async function assertFence(
  store: FenceStore,
  anchor: EngineRevision,
  scopes: readonly Scope[],
): Promise<void> {
  await store.transaction(async (tx) => {
    await tx.assertUnchangedSince(anchor, scopes);
  });
}

async function rejectionOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return undefined;
}

async function expectRefused(
  store: FenceStore,
  anchor: EngineRevision,
  scopes: readonly Scope[],
  label: string,
): Promise<ReadSetChangedError> {
  const error = await rejectionOf(assertFence(store, anchor, scopes));
  expect(
    error,
    `${label}: the fence must refuse with ReadSetChangedError, got ${String(error)}`,
  ).toBeInstanceOf(ReadSetChangedError);
  return error as ReadSetChangedError;
}

async function expectPasses(
  store: FenceStore,
  anchor: EngineRevision,
  scopes: readonly Scope[],
  label: string,
): Promise<void> {
  const error = await rejectionOf(assertFence(store, anchor, scopes));
  expect(
    error,
    `${label}: the fence must not refuse, got ${String(error)}`,
  ).toBeUndefined();
}

async function addOutEdge(store: FenceStore) {
  const { a, b } = await seed(store);
  const anchor = await anchorNow(store);
  const edge = await store.edges.cites.create(a, b, { weight: 1 });

  const error = await expectRefused(
    store,
    anchor,
    [{ edgesAt: a, direction: "out", kind: "cites" }],
    "added out-edge, direction out",
  );
  expect(error.details.changes[0]?.edges).toEqual([
    { kind: "cites", id: edge.id },
  ]);
  return { store, anchor, a, edge };
}

async function addInEdge(store: FenceStore) {
  const { a, c } = await seed(store);
  const anchor = await anchorNow(store);
  const edge = await store.edges.cites.create(c, a, { weight: 1 });

  await expectRefused(
    store,
    anchor,
    [{ edgesAt: a, direction: "in" }],
    "added in-edge, direction in",
  );
  await expectRefused(
    store,
    anchor,
    [{ edgesAt: a, direction: "both" }],
    "added in-edge, direction both",
  );
  return { store, anchor, a, edge };
}

async function addEdgeBetweenOtherNodes(store: FenceStore) {
  const { a, b, c } = await seed(store);
  const anchor = await anchorNow(store);
  const edge = await store.edges.cites.create(b, c, { weight: 1 });
  const scopes: readonly Scope[] = [{ edgesAt: a, direction: "both" }];
  return { store, anchor, scopes, edge };
}

export function registerReadSetFenceIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe.each(FLAVORS)("read-set fence: $name", (flavor) => {
    const createStore = () => flavor.create(context);

    describe("passing", () => {
      it("passes an unchanged read set and commits the caller's write", async () => {
        const store = await createStore();
        const { a } = await seed(store);
        const anchor = await anchorNow(store);

        await store.transaction(async (tx) => {
          await tx.assertUnchangedSince(anchor, [
            { node: a },
            { edgesAt: a, direction: "both" },
            { nodeKind: "Doc" },
            { edgeKind: "cites" },
          ]);
          await tx.nodes.Note.create({ body: "summary" });
        });

        const notes = await store.nodes.Note.find({});
        expect(
          notes.map((note) => note.body),
          "the write after a passing assertion must commit",
        ).toEqual(["summary"]);
      });

      it("accepts an empty scope list", async () => {
        const store = await createStore();
        await seed(store);
        const anchor = await anchorNow(store);
        await expectPasses(store, anchor, [], "empty scope list");
      });

      it("ignores a change to an unrelated node", async () => {
        const store = await createStore();
        const { a, unrelated } = await seed(store);
        const anchor = await anchorNow(store);
        await store.nodes.Doc.update(unrelated.id, { title: "changed" });
        await expectPasses(
          store,
          anchor,
          [{ node: a }, { edgesAt: a, direction: "both" }],
          "unrelated node update",
        );
      });

      it("writes nothing: the revision and the delta are untouched by a passing assertion", async () => {
        const store = await createStore();
        const { a } = await seed(store);
        const anchor = await anchorNow(store);

        await assertFence(store, anchor, [{ node: a }, { graph: true }]);

        expect(
          await store.lineageRevisionNow(),
          "a fence that writes nothing must not advance the revision",
        ).toBe(anchor);
        expect(await store.changesSince(anchor)).toEqual({
          kind: "keys",
          nodes: [],
          edges: [],
        });
      });
    });

    describe("node and edge scopes", () => {
      it("catches a node update", async () => {
        const store = await createStore();
        const { a } = await seed(store);
        const anchor = await anchorNow(store);
        await store.nodes.Doc.update(a.id, { title: "a2" });
        const error = await expectRefused(
          store,
          anchor,
          [{ node: a }],
          "node update",
        );
        expect(error.details.changes).toEqual([
          {
            index: 0,
            scope: { target: "node", kind: "Doc", id: a.id },
            nodes: [{ kind: "Doc", id: a.id }],
            edges: [],
            nodesTruncated: false,
            edgesTruncated: false,
          },
        ]);
      });

      it("catches a node soft delete", async () => {
        const store = await createStore();
        const { a } = await seed(store);
        const anchor = await anchorNow(store);
        await store.nodes.Doc.delete(a.id);
        await expectRefused(store, anchor, [{ node: a }], "node soft delete");
      });

      it("catches a node hard delete", async () => {
        const store = await createStore();
        const { a } = await seed(store);
        const anchor = await anchorNow(store);
        await store.nodes.Doc.hardDelete(a.id);
        await expectRefused(store, anchor, [{ node: a }], "node hard delete");
      });

      it("catches an edge update", async () => {
        const store = await createStore();
        const { a, b } = await seed(store);
        const edge = await store.edges.cites.create(a, b, { weight: 1 });
        const anchor = await anchorNow(store);
        await store.edges.cites.update(edge.id, { weight: 2 });
        const error = await expectRefused(
          store,
          anchor,
          [{ edge }],
          "edge update",
        );
        expect(error.details.changes[0]?.edges).toEqual([
          { kind: "cites", id: edge.id },
        ]);
      });

      it("does not imply an edge scope: an edge added at a node leaves a node scope unchanged", async () => {
        const store = await createStore();
        const { a, b } = await seed(store);
        const anchor = await anchorNow(store);
        await store.edges.cites.create(a, b, { weight: 1 });
        await expectPasses(
          store,
          anchor,
          [{ node: a }],
          "edge added at a node under a node scope",
        );
      });
    });

    describe("edgesAt scopes", () => {
      it.runIf(flavor.exactNeighbourhoods)(
        "catches an added out-edge for direction out but not for in",
        async () => {
          const { store, anchor, a } = await addOutEdge(await createStore());
          await expectPasses(
            store,
            anchor,
            [{ edgesAt: a, direction: "in", kind: "cites" }],
            "added out-edge, direction in",
          );
        },
      );

      it.runIf(!flavor.exactNeighbourhoods)(
        "catches an added out-edge for direction out and, at edge-kind granularity, for in",
        async () => {
          const { store, anchor, a, edge } = await addOutEdge(
            await createStore(),
          );
          const error = await expectRefused(
            store,
            anchor,
            [{ edgesAt: a, direction: "in", kind: "cites" }],
            "added out-edge, direction in on the journal source",
          );
          expect(error.details.changes[0]?.edges).toEqual([
            { kind: "cites", id: edge.id },
          ]);
        },
      );

      it.runIf(flavor.exactNeighbourhoods)(
        "catches an added in-edge for direction in and both but not for out",
        async () => {
          const { store, anchor, a } = await addInEdge(await createStore());
          await expectPasses(
            store,
            anchor,
            [{ edgesAt: a, direction: "out" }],
            "added in-edge, direction out",
          );
        },
      );

      it.runIf(!flavor.exactNeighbourhoods)(
        "catches an added in-edge for direction in and both and, at edge-kind granularity, for out",
        async () => {
          const { store, anchor, a, edge } = await addInEdge(
            await createStore(),
          );
          const error = await expectRefused(
            store,
            anchor,
            [{ edgesAt: a, direction: "out" }],
            "added in-edge, direction out on the journal source",
          );
          expect(error.details.changes[0]?.edges).toEqual([
            { kind: "cites", id: edge.id },
          ]);
        },
      );

      it("catches a removed edge", async () => {
        const store = await createStore();
        const { a, b } = await seed(store);
        const edge = await store.edges.cites.create(a, b, { weight: 1 });
        const anchor = await anchorNow(store);
        await store.edges.cites.delete(edge.id);
        await expectRefused(
          store,
          anchor,
          [{ edgesAt: a, direction: "out", kind: "cites" }],
          "soft-deleted out-edge",
        );
      });

      it("does not refuse for an edge of another kind at the same node", async () => {
        const store = await createStore();
        const { a, b } = await seed(store);
        const anchor = await anchorNow(store);
        await store.edges.mentions.create(a, b, { weight: 1 });
        await expectPasses(
          store,
          anchor,
          [{ edgesAt: a, direction: "both", kind: "cites" }],
          "edge of another kind",
        );
        await expectRefused(
          store,
          anchor,
          [{ edgesAt: a, direction: "both" }],
          "kind-less edgesAt covers every kind",
        );
      });

      it.runIf(flavor.exactNeighbourhoods)(
        "ignores an edge added between other nodes",
        async () => {
          const { store, anchor, scopes } = await addEdgeBetweenOtherNodes(
            await createStore(),
          );
          await expectPasses(
            store,
            anchor,
            scopes,
            "edge elsewhere in the graph",
          );
        },
      );

      it.runIf(!flavor.exactNeighbourhoods)(
        "conservatively refuses an edge added between other nodes",
        async () => {
          const { store, anchor, scopes, edge } =
            await addEdgeBetweenOtherNodes(await createStore());
          const error = await expectRefused(
            store,
            anchor,
            scopes,
            "edge elsewhere in the graph on the journal source",
          );
          expect(error.details.changes[0]?.edges).toEqual([
            { kind: "cites", id: edge.id },
          ]);
        },
      );

      it("refuses when an edge id is hard-deleted and recreated at other endpoints", async () => {
        const store = await createStore();
        const { a, b, c } = await seed(store);
        const d = await store.nodes.Doc.create({ title: "d" });
        const edge = await store.edges.cites.create(a, b, { weight: 1 });
        const anchor = await anchorNow(store);

        await store.edges.cites.hardDelete(edge.id);
        await store.edges.cites.create(c, d, { weight: 2 }, { id: edge.id });

        const error = await expectRefused(
          store,
          anchor,
          [{ edgesAt: a, direction: "out", kind: "cites" }],
          "edge id recreated at other endpoints",
        );
        expect(error.details.changes[0]?.edges).toContainEqual({
          kind: "cites",
          id: edge.id,
        });
      });
    });

    describe("kind and graph scopes", () => {
      it("catches a newly created row of the node kind only", async () => {
        const store = await createStore();
        await seed(store);
        const anchor = await anchorNow(store);
        const created = await store.nodes.Doc.create({ title: "new" });

        const error = await expectRefused(
          store,
          anchor,
          [{ nodeKind: "Doc" }],
          "node created under nodeKind",
        );
        expect(error.details.changes[0]?.nodes).toEqual([
          { kind: "Doc", id: created.id },
        ]);
        await expectPasses(
          store,
          anchor,
          [{ nodeKind: "Note" }],
          "node of another kind under nodeKind",
        );
      });

      it("catches a newly created edge of the edge kind only", async () => {
        const store = await createStore();
        const { a, b } = await seed(store);
        const anchor = await anchorNow(store);
        await store.edges.cites.create(a, b, { weight: 1 });

        await expectRefused(
          store,
          anchor,
          [{ edgeKind: "cites" }],
          "edge created under edgeKind",
        );
        await expectPasses(
          store,
          anchor,
          [{ edgeKind: "mentions" }],
          "edge of another kind under edgeKind",
        );
      });

      it("catches any change under the graph scope", async () => {
        const store = await createStore();
        await seed(store);
        const anchor = await anchorNow(store);
        await store.nodes.Note.create({ body: "anything" });
        await expectRefused(store, anchor, [{ graph: true }], "graph scope");
      });
    });

    describe("refusal reporting", () => {
      it("lists every changed scope with exact keys and omits unchanged ones", async () => {
        const store = await createStore();
        const { a, b, unrelated } = await seed(store);
        const anchor = await anchorNow(store);
        await store.nodes.Doc.update(a.id, { title: "a2" });
        const edge = await store.edges.cites.create(a, b, { weight: 1 });

        const nodeScope: Scope = { node: a };
        const neighbourhoodScope: Scope = {
          edgesAt: a,
          direction: "out",
          kind: "cites",
        };
        const error = await expectRefused(
          store,
          anchor,
          [nodeScope, { node: unrelated }, neighbourhoodScope],
          "two changed scopes among three",
        );

        expect(error.details.graphId).toBe(readSetGraph.id);
        expect(error.details.anchor).toBe(anchor);
        expect(
          error.details.changes,
          "exactly the two changed scopes, in declaration order",
        ).toEqual([
          {
            index: 0,
            scope: { target: "node", kind: "Doc", id: a.id },
            nodes: [{ kind: "Doc", id: a.id }],
            edges: [],
            nodesTruncated: false,
            edgesTruncated: false,
          },
          {
            index: 2,
            scope: {
              target: "edgesAt",
              nodeKind: "Doc",
              nodeId: a.id,
              direction: "out",
              edgeKind: "cites",
            },
            nodes: [],
            edges: [{ kind: "cites", id: edge.id }],
            nodesTruncated: false,
            edgesTruncated: false,
          },
        ]);
      });

      it("carries no node properties in the refusal details", async () => {
        const store = await createStore();
        const { a } = await seed(store);
        const anchor = await anchorNow(store);
        const secretTitle = "distinctive-title-payload";
        const secretNode = await store.nodes.Doc.update(a.id, {
          title: secretTitle,
        });
        const error = await expectRefused(
          store,
          anchor,
          [{ node: secretNode }],
          "node read from the store",
        );
        expect(JSON.stringify(error.details)).not.toContain(secretTitle);
      });

      it("rolls back the caller's earlier writes in the refused transaction", async () => {
        const store = await createStore();
        const { a } = await seed(store);
        const anchor = await anchorNow(store);
        await store.nodes.Doc.update(a.id, { title: "a2" });

        const error = await rejectionOf(
          store.transaction(async (tx) => {
            await tx.nodes.Note.create({ body: "must be rolled back" });
            await tx.assertUnchangedSince(anchor, [{ node: a }]);
            await tx.nodes.Note.create({ body: "never reached" });
          }),
        );

        expect(error).toBeInstanceOf(ReadSetChangedError);
        expect(
          await store.nodes.Note.find({}),
          "a refused fence must leave none of the transaction's writes behind",
        ).toEqual([]);
      });

      it("still refuses a change that was later reversed", async () => {
        const store = await createStore();
        const { a } = await seed(store);
        const anchor = await anchorNow(store);
        await store.nodes.Doc.update(a.id, { title: "temporary" });
        await store.nodes.Doc.update(a.id, { title: "a" });
        await expectRefused(
          store,
          anchor,
          [{ node: a }],
          "update followed by the reversing update",
        );
      });
    });

    describe("unverifiable anchors", () => {
      it("refuses an anchor minted before store.clear()", async () => {
        const store = await createStore();
        const { a } = await seed(store);
        const anchor = await anchorNow(store);
        await store.clear();
        const error = await rejectionOf(
          assertFence(store, anchor, [{ node: a }]),
        );
        expect(
          error,
          "the clear rotated the origin; the anchor can no longer be proven",
        ).toBeInstanceOf(ReadSetUnverifiableError);
      });

      it("refuses a garbage anchor", async () => {
        const store = await createStore();
        const { a } = await seed(store);
        const error = await rejectionOf(
          assertFence(store, "not-an-anchor" as EngineRevision, [{ node: a }]),
        );
        expect(error).toBeInstanceOf(ReadSetUnverifiableError);
      });

      it("refuses an empty scope list on an unprovable anchor", async () => {
        const store = await createStore();
        await seed(store);
        const error = await rejectionOf(
          assertFence(store, "not-an-anchor" as EngineRevision, []),
        );
        expect(error).toBeInstanceOf(ReadSetUnverifiableError);
      });
    });

    describe("scope validation and refusals", () => {
      it("rejects an unknown node kind in a node scope", async () => {
        const store = await createStore();
        const { a } = await seed(store);
        const anchor = await anchorNow(store);
        const error = await rejectionOf(
          assertFence(store, anchor, [
            { node: { kind: "Ghost", id: a.id } },
          ] as never),
        );
        expect(error).toBeInstanceOf(KindNotFoundError);
      });

      it("rejects an unknown kind in nodeKind, edgeKind and edgesAt", async () => {
        const store = await createStore();
        const { a } = await seed(store);
        const anchor = await anchorNow(store);
        const unknownScopes = [
          { nodeKind: "Ghost" },
          { edgeKind: "ghosts" },
          { edgesAt: a, direction: "out", kind: "ghosts" },
        ] as unknown as readonly Scope[];
        for (const scope of unknownScopes) {
          const error = await rejectionOf(assertFence(store, anchor, [scope]));
          expect(
            error,
            `scope ${JSON.stringify(scope)} must name a registered kind`,
          ).toBeInstanceOf(KindNotFoundError);
        }
      });

      it("refuses a scope carrying a key its target does not define", async () => {
        const store = await createStore();
        const { a } = await seed(store);
        const anchor = await anchorNow(store);
        await store.nodes.Doc.update(a.id, { title: "a2" });
        const error = await rejectionOf(
          assertFence(store, anchor, [
            { node: a, direction: "in", kind: "x" },
          ] as unknown as readonly Scope[]),
        );
        expect(error).toBeInstanceOf(ConfigurationError);
        expect((error as ConfigurationError).details["code"]).toBe(
          "READ_SET_SCOPE_INVALID",
        );
      });

      it("refuses a scope that is not an object", async () => {
        const store = await createStore();
        await seed(store);
        const anchor = await anchorNow(store);
        const malformedScopes = [
          // eslint-disable-next-line unicorn/no-null -- a null scope is the case under test
          null,
          "node",
          7,
          ["node"],
        ] as unknown as readonly Scope[];
        for (const scope of malformedScopes) {
          const error = await rejectionOf(assertFence(store, anchor, [scope]));
          expect(
            error,
            `scope ${JSON.stringify(scope)} must be refused as invalid`,
          ).toBeInstanceOf(ConfigurationError);
          expect((error as ConfigurationError).details["code"]).toBe(
            "READ_SET_SCOPE_INVALID",
          );
        }
      });

      it("refuses a read-only transaction, because the fence takes the write lock", async () => {
        const store = await createStore();
        await seed(store);
        const anchor = await anchorNow(store);
        const error = await rejectionOf(
          store.transaction(
            async (tx) => {
              await tx.assertUnchangedSince(anchor, []);
            },
            { accessMode: "read_only" },
          ),
        );
        expect(error).toBeInstanceOf(UnsupportedBackendCapabilityError);
        expect(
          (error as UnsupportedBackendCapabilityError).details,
        ).toMatchObject({ operation: "tx.assertUnchangedSince()" });
      });
    });

    describe("identity writes", () => {
      it("does not refuse the fence for an identity assertion in the span, while changesSince stays unbounded", async () => {
        const store = await flavor.createWithIdentity(context);
        const document = await store.nodes.Doc.create({
          title: "identity doc",
        });
        const note = await store.nodes.Note.create({ body: "identity note" });
        const anchor = requireDefined(
          await store.lineageRevisionNow(),
          "the lineage store must mint an anchor",
        );

        await store.identity.assertSame(document, note);

        await store.transaction(async (tx) => {
          await tx.assertUnchangedSince(anchor, [
            { node: document },
            { node: note },
            { nodeKind: "Doc" },
            { graph: true },
          ]);
        });
        expect(
          await store.changesSince(anchor),
          "the public key delta cannot name an identity write and must keep refusing",
        ).toEqual({ kind: "unbounded" });
      });
    });

    describe("reported key caps", () => {
      it("reports at most the first 100 keys of a scope in (kind, id) order and flags the truncation", async () => {
        const store = await createStore();
        await seed(store);
        const anchor = await anchorNow(store);
        const total = REPORTED_KEYS_LIMIT + 5;
        await store.nodes.Doc.bulkCreate(
          // Created in reverse so a first-100 answer cannot come from insertion order.
          Array.from({ length: total }, (_, index) => ({
            props: { title: `capped ${index}` },
            id: paddedId(total - 1 - index),
          })),
        );

        const error = await expectRefused(
          store,
          anchor,
          [{ nodeKind: "Doc" }],
          "more changed rows than the reported-keys cap",
        );

        const [change] = error.details.changes;
        expect(change?.nodesTruncated).toBe(true);
        expect(change?.edgesTruncated).toBe(false);
        expect(change?.edges).toEqual([]);
        expect(change?.nodes).toEqual(
          Array.from({ length: REPORTED_KEYS_LIMIT }, (_, index) => ({
            kind: "Doc",
            id: paddedId(index),
          })),
        );
      });

      it("does not flag a scope whose changed keys exactly fill the cap", async () => {
        const store = await createStore();
        await seed(store);
        const anchor = await anchorNow(store);
        await store.nodes.Doc.bulkCreate(
          Array.from({ length: REPORTED_KEYS_LIMIT }, (_, index) => ({
            props: { title: `exact ${index}` },
            id: paddedId(index),
          })),
        );

        const error = await expectRefused(
          store,
          anchor,
          [{ nodeKind: "Doc" }],
          "exactly as many changed rows as the cap",
        );

        const [change] = error.details.changes;
        expect(change?.nodes).toHaveLength(REPORTED_KEYS_LIMIT);
        expect(change?.nodesTruncated).toBe(false);
      });
    });

    describe("many scopes", () => {
      it("answers a call with hundreds of scopes and reports the right indexes", async () => {
        const store = await createStore();
        const ids = Array.from(
          { length: MANY_SCOPES },
          (_, index) => `scoped-${String(index).padStart(4, "0")}`,
        );
        await store.nodes.Doc.bulkCreate(
          ids.map((id) => ({ props: { title: id }, id })),
        );
        const anchor = await anchorNow(store);
        const changedIndexes = [3, 150, MANY_SCOPES - 1];
        for (const index of changedIndexes) {
          await store.nodes.Doc.update(
            asNodeId<typeof Document>(requireDefined(ids[index])),
            { title: "changed" },
          );
        }

        const scopes: readonly Scope[] = ids.map((id) => ({
          node: { kind: "Doc" as const, id: asNodeId<typeof Document>(id) },
        }));
        const error = await expectRefused(
          store,
          anchor,
          scopes,
          "three changed scopes among hundreds",
        );

        expect(error.details.changes.map((change) => change.index)).toEqual(
          changedIndexes,
        );
        await expectPasses(
          store,
          await anchorNow(store),
          scopes,
          "hundreds of unchanged scopes",
        );
      });
    });

    describe("hard-deleted edge neighbourhoods", () => {
      it("refuses an edgesAt scope at the hard-deleted edge's own endpoint", async () => {
        const store = await createStore();
        const { a, b } = await seed(store);
        const edge = await store.edges.cites.create(a, b, { weight: 1 });
        const anchor = await anchorNow(store);
        await store.edges.cites.hardDelete(edge.id);
        await expectRefused(
          store,
          anchor,
          [{ edgesAt: a, direction: "out", kind: "cites" }],
          "hard-deleted edge at its own endpoint",
        );
      });

      async function hardDeleteElsewhere() {
        const store = await createStore();
        const { a, b, c } = await seed(store);
        const elsewhere = await store.edges.cites.create(b, c, { weight: 1 });
        const anchor = await anchorNow(store);
        await store.edges.cites.hardDelete(elsewhere.id);

        const scopes: readonly Scope[] = [
          { edgesAt: a, direction: "both", kind: "cites" },
        ];
        if (flavor.exactNeighbourhoods) {
          await expectPasses(
            store,
            anchor,
            scopes,
            "hard-deleted edge at a different node on the exact source",
          );
        } else {
          await expectRefused(
            store,
            anchor,
            scopes,
            "hard-deleted edge on the journal source",
          );
        }
      }
      it.runIf(flavor.exactNeighbourhoods)(
        "answers exactly: a hard-deleted edge at a different node does not refuse",
        hardDeleteElsewhere,
      );
      it.runIf(!flavor.exactNeighbourhoods)(
        "conservatively refuses: a hard-deleted edge of that kind at a different node still refuses",
        hardDeleteElsewhere,
      );
    });
  });

  describe("read-set fence: revision without recorded evidence", () => {
    it("refuses as unverifiable when a revision-tracking-only writer advanced the clock behind a history store", async () => {
      const historyStore = await context.createHistoryStore(readSetGraph);
      const { a } = await seed(historyStore);
      const anchor = await anchorNow(historyStore);

      const [trackingOnlyStore] = await createStoreWithSchema(
        readSetGraph,
        context.getBackend(),
        { revisionTracking: true },
      );
      await trackingOnlyStore.nodes.Doc.create({
        title: "no recorded evidence",
      });

      const error = await rejectionOf(
        assertFence(historyStore, anchor, [{ node: a }]),
      );
      expect(
        error,
        "a revision with no recorded row cannot be proven out of scope",
      ).toBeInstanceOf(ReadSetUnverifiableError);
    });
  });

  describe("read-set fence: backend-declared lineage", () => {
    type EngineDelta = Awaited<
      ReturnType<NonNullable<GraphBackend["lineage"]>["changesSince"]>
    >;

    function declareLineage(delta: () => EngineDelta): GraphBackend {
      return deriveBackend(context.getBackend(), {
        lineage: {
          revision: () =>
            Promise.resolve("declared-revision" as EngineRevision),
          changesSince: () => Promise.resolve(delta()),
        },
      });
    }

    async function storeOver(backend: GraphBackend): Promise<FenceStore> {
      const [store] = await createStoreWithSchema(readSetGraph, backend, {
        revisionTracking: true,
      });
      return store;
    }

    const ANCHOR = "declared-revision" as EngineRevision;

    it("answers from the backend's own key delta: refuses an in-scope key and passes an out-of-scope one", async () => {
      let delta: EngineDelta = {
        kind: "keys",
        nodes: [{ kind: "Doc", id: "declared-1" }],
        edges: [],
      };
      const store = await storeOver(declareLineage(() => delta));

      const error = await expectRefused(
        store,
        ANCHOR,
        [{ nodeKind: "Doc" }],
        "declared delta names a Doc",
      );
      expect(error.details.changes[0]?.nodes).toEqual([
        { kind: "Doc", id: "declared-1" },
      ]);
      await expectPasses(
        store,
        ANCHOR,
        [{ nodeKind: "Note" }],
        "declared delta names no Note",
      );

      delta = { kind: "keys", nodes: [], edges: [] };
      await expectPasses(
        store,
        ANCHOR,
        [{ graph: true }],
        "declared delta is empty",
      );
    });

    it("refuses as unverifiable when the backend's delta is unbounded", async () => {
      const store = await storeOver(
        declareLineage(() => ({ kind: "unbounded" })),
      );
      const error = await rejectionOf(
        assertFence(store, ANCHOR, [{ nodeKind: "Doc" }]),
      );
      expect(error).toBeInstanceOf(ReadSetUnverifiableError);
    });

    it("refuses with the graph write fence capability when no writer of the store takes the fence", async () => {
      const [store] = await createStoreWithSchema(
        PLAIN_STORE_GRAPH,
        declareLineage(() => ({ kind: "keys", nodes: [], edges: [] })),
      );
      const error = await rejectionOf(
        store.transaction(async (tx) => {
          await tx.assertUnchangedSince(ANCHOR, []);
        }),
      );
      expect(error).toBeInstanceOf(UnsupportedBackendCapabilityError);
      expect(
        (error as UnsupportedBackendCapabilityError).details,
      ).toMatchObject({
        operation: "tx.assertUnchangedSince()",
        capability: "graphWriteFence",
      });
    });
  });

  describe("read-set fence: store without a lineage source", () => {
    it("refuses with the lineage capability", async () => {
      const store = await context.createStore(PLAIN_STORE_GRAPH);
      const error = await rejectionOf(
        store.transaction(async (tx) => {
          await tx.assertUnchangedSince("anchor" as EngineRevision, []);
        }),
      );
      expect(error).toBeInstanceOf(UnsupportedBackendCapabilityError);
      expect(
        (error as UnsupportedBackendCapabilityError).details,
      ).toMatchObject({
        operation: "tx.assertUnchangedSince()",
        capability: "lineage",
      });
    });
  });
}
