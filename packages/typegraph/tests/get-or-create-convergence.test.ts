/**
 * `getOrCreateByEndpoints` converges on ONE edge per match key.
 *
 * Nothing in the schema backs that promise: the edges table is unique on
 * `(graph_id, id)` only, and the match key may include `matchOn` prop values, so
 * there is no key to conflict on. The promise therefore rests entirely on the
 * lookup that decides "create" and the INSERT it authorizes being one
 * indivisible step. They were not: the lookup ran outside any transaction, the
 * insert opened its own, and at cardinality `many` a competing winner in
 * between raised nothing at all — both callers inserted, both were told
 * `created`, and the collection quietly held two edges where the API promises
 * one (#428).
 *
 * The create leg now re-runs that lookup INSIDE its own fenced transaction and
 * reports a race instead of inserting, and the caller re-dispatches onto the
 * winner's edge. These tests drive the race deterministically: a competing edge
 * is committed immediately after the dispatcher's lookup returns, which is
 * exactly the window a concurrent writer occupies.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DatabaseOperationError,
  defineEdge,
  defineGraph,
  defineNode,
  UniquenessError,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import {
  type EdgeRow,
  type FindEdgesByKindParams,
  type GraphBackend,
} from "../src/backend/types";
import { createStore } from "../src/store";
import { type OperationHookContext } from "../src/store/types";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.string().default("2024") }),
});

const annotated = defineEdge("annotated", {
  schema: z.object({ label: z.object({ value: z.string().optional() }) }),
});

const reportsTo = defineEdge("reportsTo", { schema: z.object({}) });

const graph = defineGraph({
  id: "get_or_create_convergence",
  nodes: { Person: { type: Person } },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
    annotated: { type: annotated, from: [Person], to: [Person] },
  },
});

const Account = defineNode("Account", {
  schema: z.object({ email: z.string() }),
});

const uniqueGraph = defineGraph({
  id: "get_or_create_convergence_unique",
  nodes: {
    Account: {
      type: Account,
      unique: [
        {
          name: "email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

/** Cardinality `one`: the only constraint a bulk batch can lose a race to. */
const cardinalGraph = defineGraph({
  id: "get_or_create_convergence_cardinal",
  nodes: { Person: { type: Person } },
  edges: {
    reportsTo: {
      type: reportsTo,
      from: [Person],
      to: [Person],
      cardinality: "one",
    },
  },
});

/**
 * Commits a competing edge right after the Nth top-level endpoint lookup
 * returns — the observation the caller's create decision is made from.
 *
 * The interception is on the TOP-LEVEL backend, so the create leg's own
 * in-transaction lookup (the convergence guard) is not intercepted and sees the
 * competitor as ordinary committed state. `afterCall` selects which lookup to
 * follow. In return mode the initial root probe is also the dispatcher read on
 * a no-match path, so racing that decision uses `afterCall: 1`.
 */
function racingBackend(
  base: GraphBackend,
  afterCall: number,
  commitCompetitor: () => Promise<void>,
): GraphBackend {
  let calls = 0;
  let raced = false;
  return deriveBackend(base, {
    findEdgesByKind: async (params: FindEdgesByKindParams) => {
      const rows = await base.findEdgesByKind(params);
      calls += 1;
      if (!raced && calls === afterCall) {
        raced = true;
        await commitCompetitor();
      }
      return rows;
    },
  });
}

/**
 * Models a cache-backed root handle such as Hyperdrive: root reads can lag a
 * committed edge, while a transaction-scoped handle reads its own snapshot.
 * The wrapper deliberately returns an empty root result, but delegates the
 * transaction target to the real backend so a match-key read can observe the
 * edge that is already committed (or was written earlier in that transaction).
 */
function staleRootReadBackend(
  base: GraphBackend,
  onTransactionRead: () => void,
): GraphBackend {
  return deriveBackend(base, {
    findEdgesByKind: () => Promise.resolve([]),
    transaction: (fn, options) =>
      base.transaction(
        (target) =>
          fn(
            deriveBackend(target, {
              findEdgesByKind: async (params) => {
                onTransactionRead();
                return target.findEdgesByKind(params);
              },
            }),
          ),
        options,
      ),
  });
}

/**
 * Carries a transaction-discovered match back from the create guard, then
 * makes the selected row's match key move during its update re-read.
 * `movesBeforeStable` controls whether a later retry can settle.
 */
function movingMatchKeyBackend(
  base: GraphBackend,
  matchedRow: EdgeRow,
  movesBeforeStable: number,
  onMovedRead: () => void,
): GraphBackend {
  let movedReads = 0;
  return deriveBackend(base, {
    findEdgesByKind: () => Promise.resolve([]),
    transaction: (fn, options) =>
      base.transaction(
        (target) =>
          fn(
            deriveBackend(target, {
              findEdgesByKind: () => Promise.resolve([matchedRow]),
              getEdge: async (graphId, id) => {
                const row = await target.getEdge(graphId, id);
                if (row === undefined || movedReads >= movesBeforeStable) {
                  return row;
                }
                movedReads += 1;
                onMovedRead();
                return { ...row, props: { since: "moved" } };
              },
            }),
          ),
        options,
      ),
  });
}

/** Makes a transaction-carried match disappear from its recovery read. */
function disappearingMatchBackend(
  base: GraphBackend,
  matchedRow: EdgeRow,
  disappearancesBeforeStable: number,
  onDisappearedRead: () => void,
): GraphBackend {
  let disappearedReads = 0;
  return deriveBackend(base, {
    findEdgesByKind: () => Promise.resolve([]),
    transaction: (fn, options) =>
      base.transaction(
        (target) =>
          fn(
            deriveBackend(target, {
              findEdgesByKind: () => Promise.resolve([matchedRow]),
              getEdge: (graphId, id) => {
                if (disappearedReads >= disappearancesBeforeStable) {
                  return target.getEdge(graphId, id);
                }
                disappearedReads += 1;
                onDisappearedRead();
                return Promise.resolve(undefined);
              },
            }),
          ),
        options,
      ),
  });
}

describe("getOrCreateByEndpoints convergence", () => {
  let raw: GraphBackend;

  beforeEach(() => {
    ({ backend: raw } = createLocalSqliteBackend());
  });

  it("reuses a negative root probe before the fenced create check", async () => {
    const setup = createStore(graph, raw);
    const alice = await setup.nodes.Person.create({ name: "Alice" });
    const bob = await setup.nodes.Person.create({ name: "Bob" });
    let endpointReads = 0;

    const counted = deriveBackend(raw, {
      findEdgesByKind: async (params) => {
        endpointReads += 1;
        return raw.findEdgesByKind(params);
      },
      transaction: (fn, options) =>
        raw.transaction(
          (target) =>
            fn(
              deriveBackend(target, {
                findEdgesByKind: async (params) => {
                  endpointReads += 1;
                  return target.findEdgesByKind(params);
                },
              }),
            ),
          options,
        ),
    });

    const result = await createStore(
      graph,
      counted,
    ).edges.knows.getOrCreateByEndpoints(alice, bob, { since: "2024" });

    expect(result.action).toBe("created");
    // One root dispatcher read plus the create transaction's authoritative
    // convergence read. Before the optimization this was three.
    expect(endpointReads).toBe(2);
  });

  it("resolves to the competitor's edge instead of inserting a second one", async () => {
    const setup = createStore(graph, raw);
    const alice = await setup.nodes.Person.create({ name: "Alice" });
    const bob = await setup.nodes.Person.create({ name: "Bob" });

    const competitor = createStore(graph, raw);
    let competitorEdgeId: string | undefined;
    const store = createStore(
      graph,
      racingBackend(raw, 1, async () => {
        const competitorEdge = await competitor.edges.knows.create(alice, bob, {
          since: "winner",
        });
        competitorEdgeId = competitorEdge.id;
      }),
    );

    const result = await store.edges.knows.getOrCreateByEndpoints(alice, bob, {
      since: "winner",
    });

    expect(result.action).toBe("found");
    expect(result.edge.since).toBe("winner");
    // The winner has a different generated id. A found convergence result is
    // authoritative even though its row identity cannot equal the losing
    // create plan's generated id.
    expect(result.edge.id).toBe(competitorEdgeId);
    // The contract, stated as the observable it protects: ONE edge per match
    // key. Before the guard this read returned two.
    expect(await setup.edges.knows.findFrom(alice)).toHaveLength(1);
  });

  it("converges on the matchOn key, not merely on the endpoint pair", async () => {
    const setup = createStore(graph, raw);
    const alice = await setup.nodes.Person.create({ name: "Alice" });
    const bob = await setup.nodes.Person.create({ name: "Bob" });

    const competitor = createStore(graph, raw);
    const store = createStore(
      graph,
      racingBackend(raw, 1, async () => {
        await competitor.edges.knows.create(alice, bob, { since: "2020" });
      }),
    );

    const result = await store.edges.knows.getOrCreateByEndpoints(
      alice,
      bob,
      { since: "2020" },
      { matchOn: ["since"] },
    );

    expect(result.action).toBe("found");
    expect(result.edge.since).toBe("2020");
    expect(await setup.edges.knows.findFrom(alice)).toHaveLength(1);
  });

  it("still creates when the competitor's edge carries a DIFFERENT match key", async () => {
    const setup = createStore(graph, raw);
    const alice = await setup.nodes.Person.create({ name: "Alice" });
    const bob = await setup.nodes.Person.create({ name: "Bob" });

    const competitor = createStore(graph, raw);
    const store = createStore(
      graph,
      racingBackend(raw, 1, async () => {
        await competitor.edges.knows.create(alice, bob, { since: "1999" });
      }),
    );

    // A different `since` is a different match key, so the guard must NOT
    // collapse the two: converging on the endpoint pair alone would silently
    // drop this caller's edge.
    const result = await store.edges.knows.getOrCreateByEndpoints(
      alice,
      bob,
      { since: "2024" },
      { matchOn: ["since"] },
    );

    expect(result.action).toBe("created");
    expect(await setup.edges.knows.findFrom(alice)).toHaveLength(2);
  });

  it("retries the bulk path on a cardinality conflict instead of failing the batch", async () => {
    // The bulk path runs its whole partition-and-write inside one transaction,
    // so the only way a competitor reaches it is through a constraint verdict.
    // That verdict is injected here — one cardinality probe reports a rival
    // edge, exactly as a winner that committed just before the batch would
    // have. The single-item path has always retried this; the batch used to
    // fail outright, which is the asymmetry #428 records.
    const setup = createStore(cardinalGraph, raw);
    const alice = await setup.nodes.Person.create({ name: "Alice" });
    const bob = await setup.nodes.Person.create({ name: "Bob" });

    let reported = false;
    const store = createStore(
      cardinalGraph,
      deriveBackend(raw, {
        transaction: (fn, options) =>
          raw.transaction(
            (target) =>
              fn({
                ...target,
                countEdgesFrom: async (params) => {
                  if (reported) return target.countEdgesFrom(params);
                  reported = true;
                  return 1;
                },
              }),
            options,
          ),
      }),
    );

    const results = await store.edges.reportsTo.bulkGetOrCreateByEndpoints([
      { from: alice, to: bob, props: {} },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe("created");
    expect(reported).toBe(true);
    expect(await setup.edges.reportsTo.findFrom(alice)).toHaveLength(1);
  });

  it("retries the node bulk constraint path instead of failing the batch", async () => {
    // The node analogue, and the second half of the same asymmetry:
    // `getOrCreateByConstraint` retried on `UniquenessError` while its bulk
    // form did not, so a winner that reserved the key first failed the whole
    // batch. The uniques reservation is where that loss surfaces, so that is
    // where the conflict is injected.
    let reported = false;
    const store = createStore(
      uniqueGraph,
      deriveBackend(raw, {
        transaction: (fn, options) =>
          raw.transaction(
            (target) =>
              fn({
                ...target,
                insertUniqueBatch: async (entries) => {
                  if (reported) return target.insertUniqueBatch?.(entries);
                  reported = true;
                  throw new UniquenessError({
                    constraintName: "email",
                    kind: "Account",
                    existingId: "winner",
                    newId: "loser",
                    fields: ["email"],
                  });
                },
              }),
            options,
          ),
      }),
    );

    const results = await store.nodes.Account.bulkGetOrCreateByConstraint(
      "email",
      [{ props: { email: "a@example.com" } }],
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe("created");
    expect(reported).toBe(true);
  });

  it("reports the raced attempt as an error, never as a create that happened", async () => {
    // A losing attempt writes NOTHING, so it must not be reported as a
    // completed create. `onOperationEnd` means "this operation did what it
    // said"; firing it for a generated id that no row carries makes every
    // hook-based audit trail wrong, and the same "did it write" signal is what
    // gates the revision clock. Both read the body's outcome, so the abort has
    // to travel as a failure, not as a value.
    const setup = createStore(graph, raw);
    const alice = await setup.nodes.Person.create({ name: "Alice" });
    const bob = await setup.nodes.Person.create({ name: "Bob" });

    const ends: string[] = [];
    const errors: string[] = [];
    const competitor = createStore(graph, raw);
    const store = createStore(
      graph,
      racingBackend(raw, 1, async () => {
        await competitor.edges.knows.create(alice, bob, { since: "winner" });
      }),
      {
        hooks: {
          onOperationEnd: (context) => {
            ends.push(`${context.operation}:${context.kind}`);
          },
          onError: (context) => {
            // `onError` is typed on the base HookContext; the operation fields
            // are present for an operation-scoped failure like this one.
            const scoped = context as Partial<OperationHookContext>;
            errors.push(`${String(scoped.operation)}:${String(scoped.kind)}`);
          },
        },
      },
    );

    const result = await store.edges.knows.getOrCreateByEndpoints(alice, bob, {
      since: "winner",
    });

    expect(result.action).toBe("found");
    // No create ever completed on this store: the only attempt aborted.
    expect(ends.filter((entry) => entry === "create:knows")).toEqual([]);
    // And the abort was reported, rather than silently swallowed.
    expect(errors).toContain("create:knows");
  });

  it("does not advance the revision clock for a raced no-op", async () => {
    // The clock is the durable "something changed here" anchor. Advancing it
    // for an attempt that wrote nothing invalidates every `base@V` token a
    // consumer holds, for no change at all.
    //
    // A plain before/after comparison cannot say WHICH call moved it — the
    // competitor's create is inside the same window and legitimately does. So
    // the anchor is read at the instant the competitor commits, from inside the
    // injection itself: everything after that point is the raced attempt and
    // the re-dispatch, and neither may move it.
    const setup = createStore(graph, raw, { revisionTracking: true });
    const alice = await setup.nodes.Person.create({ name: "Alice" });
    const bob = await setup.nodes.Person.create({ name: "Bob" });

    const competitor = createStore(graph, raw, { revisionTracking: true });
    let afterCompetitor: string | undefined;
    const store = createStore(
      graph,
      racingBackend(raw, 1, async () => {
        await competitor.edges.knows.create(alice, bob, { since: "winner" });
        afterCompetitor = await competitor.revisionNow();
      }),
      { revisionTracking: true },
    );

    const result = await store.edges.knows.getOrCreateByEndpoints(alice, bob, {
      since: "winner",
    });

    expect(result.action).toBe("found");
    expect(afterCompetitor).toBeDefined();
    expect(await setup.revisionNow()).toBe(afterCompetitor);
  });

  it("uses the transaction-carried row instead of a false competing-writer error", async () => {
    // The root dispatcher is allowed to be stale, but the transaction read is
    // authoritative. A row found there is carried with the convergence signal
    // and returned directly; re-dispatching through the stale root would turn
    // an honest found result into a false terminal competing-writer error.
    const setup = createStore(graph, raw);
    const alice = await setup.nodes.Person.create({ name: "Alice" });
    const bob = await setup.nodes.Person.create({ name: "Bob" });
    const phantom = requireDefined(
      await raw.insertEdge({
        graphId: graph.id,
        id: "phantom",
        kind: "knows",
        fromKind: "Person",
        fromId: alice.id,
        toKind: "Person",
        toId: bob.id,
        props: { since: "phantom" },
      }),
    );

    let attempts = 0;
    const store = createStore(
      graph,
      deriveBackend(raw, {
        // The dispatcher reads through the top level and must see NOTHING.
        findEdgesByKind: () => Promise.resolve([]),
        transaction: (fn, options) =>
          raw.transaction(
            (target) =>
              fn(
                deriveBackend(target, {
                  // The guard reads through the transaction and sees the
                  // authoritative row, so the create attempt carries it back.
                  findEdgesByKind: () => {
                    attempts += 1;
                    return Promise.resolve([phantom]);
                  },
                }),
              ),
            options,
          ),
      }),
    );

    const result = await store.edges.knows.getOrCreateByEndpoints(alice, bob, {
      since: "x",
    });
    expect(result.action).toBe("found");
    expect(result.edge.id).toBe(phantom.id);
    // One authoritative transaction read settled the operation; no retry loop
    // or root-cache re-dispatch was needed.
    expect(attempts).toBe(1);
  });

  it("retries when a transaction-carried match key moves before update", async () => {
    const setup = createStore(graph, raw);
    const alice = await setup.nodes.Person.create({ name: "Alice" });
    const bob = await setup.nodes.Person.create({ name: "Bob" });
    const matchedRow = requireDefined(
      await raw.insertEdge({
        graphId: graph.id,
        id: "moving-once",
        kind: "knows",
        fromKind: "Person",
        fromId: alice.id,
        toKind: "Person",
        toId: bob.id,
        props: { since: "requested" },
      }),
    );
    let movedReads = 0;
    const store = createStore(
      graph,
      movingMatchKeyBackend(raw, matchedRow, 1, () => {
        movedReads += 1;
      }),
    );

    const result = await store.edges.knows.getOrCreateByEndpoints(
      alice,
      bob,
      { since: "requested" },
      { ifExists: "update", matchOn: ["since"] },
    );

    expect(result.action).toBe("updated");
    expect(result.edge.id).toBe(matchedRow.id);
    expect(movedReads).toBe(1);
  });

  it("retries when a transaction-carried match disappears before recovery", async () => {
    const setup = createStore(graph, raw);
    const alice = await setup.nodes.Person.create({ name: "Alice" });
    const bob = await setup.nodes.Person.create({ name: "Bob" });
    const matchedRow = requireDefined(
      await raw.insertEdge({
        graphId: graph.id,
        id: "disappearing-once",
        kind: "knows",
        fromKind: "Person",
        fromId: alice.id,
        toKind: "Person",
        toId: bob.id,
        props: { since: "requested" },
      }),
    );
    let disappearedReads = 0;
    const store = createStore(
      graph,
      disappearingMatchBackend(raw, matchedRow, 1, () => {
        disappearedReads += 1;
      }),
    );

    const result = await store.edges.knows.getOrCreateByEndpoints(
      alice,
      bob,
      { since: "requested" },
      { ifExists: "update", matchOn: ["since"] },
    );

    expect(result.action).toBe("updated");
    expect(result.edge.id).toBe(matchedRow.id);
    expect(disappearedReads).toBe(1);
  });

  it("reports an unstable match key after exhausting the retry budget", async () => {
    const setup = createStore(graph, raw);
    const alice = await setup.nodes.Person.create({ name: "Alice" });
    const bob = await setup.nodes.Person.create({ name: "Bob" });
    const matchedRow = requireDefined(
      await raw.insertEdge({
        graphId: graph.id,
        id: "always-moving",
        kind: "knows",
        fromKind: "Person",
        fromId: alice.id,
        toKind: "Person",
        toId: bob.id,
        props: { since: "requested" },
      }),
    );
    let movedReads = 0;
    const store = createStore(
      graph,
      movingMatchKeyBackend(raw, matchedRow, Number.POSITIVE_INFINITY, () => {
        movedReads += 1;
      }),
    );

    const attempt = store.edges.knows.getOrCreateByEndpoints(
      alice,
      bob,
      { since: "requested" },
      { ifExists: "update", matchOn: ["since"] },
    );

    const error: unknown = await attempt.catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(DatabaseOperationError);
    if (!(error instanceof DatabaseOperationError)) {
      throw new Error("Expected DatabaseOperationError");
    }
    expect(error.code).toBe("DATABASE_OPERATION_ERROR");
    expect(error.message).toContain(
      "could not resolve a stable matching edge after 3 attempts",
    );
    expect(movedReads).toBe(3);
  });

  it("resolves a stale root read from the transaction match-key read", async () => {
    const setup = createStore(graph, raw);
    const alice = await setup.nodes.Person.create({ name: "Alice" });
    const bob = await setup.nodes.Person.create({ name: "Bob" });
    const winner = await setup.edges.knows.create(alice, bob, {
      since: "winner",
    });

    let transactionReads = 0;
    const store = createStore(
      graph,
      staleRootReadBackend(raw, () => {
        transactionReads += 1;
      }),
    );

    const result = await store.edges.knows.getOrCreateByEndpoints(alice, bob, {
      since: "winner",
    });

    expect(result.action).toBe("found");
    expect(result.edge.id).toBe(winner.id);
    expect(transactionReads).toBeGreaterThan(0);
    // The stale root never supplied the match; the transaction-scoped read
    // did. A retry-loop "competing writer" diagnostic would be false here.
    await expect(setup.edges.knows.findFrom(alice)).resolves.toHaveLength(1);
  });

  it("retains an authoritative stale-positive disproof without repeating reads", async () => {
    const setup = createStore(graph, raw);
    const alice = await setup.nodes.Person.create({ name: "Alice" });
    const bob = await setup.nodes.Person.create({ name: "Bob" });
    const staleRow = requireDefined(
      await raw.insertEdge({
        graphId: graph.id,
        id: "stale-positive",
        kind: "knows",
        fromKind: "Person",
        fromId: alice.id,
        toKind: "Person",
        toId: bob.id,
        props: { since: "requested" },
      }),
    );
    await raw.hardDeleteEdge({ graphId: graph.id, id: staleRow.id });

    let rootReads = 0;
    let transactionReads = 0;
    const store = createStore(
      graph,
      deriveBackend(raw, {
        findEdgesByKind: () => {
          rootReads += 1;
          return Promise.resolve([staleRow]);
        },
        transaction: (fn, options) =>
          raw.transaction(
            (target) =>
              fn(
                deriveBackend(target, {
                  findEdgesByKind: async (params) => {
                    transactionReads += 1;
                    return target.findEdgesByKind(params);
                  },
                }),
              ),
            options,
          ),
      }),
    );

    const result = await store.edges.knows.getOrCreateByEndpoints(alice, bob, {
      since: "requested",
    });

    expect(result.action).toBe("created");
    expect(result.edge.id).not.toBe(staleRow.id);
    // One root hint, one transaction disproof, then the create transaction's
    // convergence read. Repeating the dispatcher would make these 2 and 3.
    expect(rootReads).toBe(1);
    expect(transactionReads).toBe(2);
  });

  it("leaves the uncontended paths on their existing verdicts", async () => {
    const store = createStore(graph, raw);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    const created = await store.edges.knows.getOrCreateByEndpoints(alice, bob, {
      since: "2024",
    });
    expect(created.action).toBe("created");

    const found = await store.edges.knows.getOrCreateByEndpoints(alice, bob, {
      since: "2024",
    });
    expect(found.action).toBe("found");
    expect(found.edge.id).toBe(created.edge.id);

    await store.edges.knows.delete(created.edge.id);
    const resurrected = await store.edges.knows.getOrCreateByEndpoints(
      alice,
      bob,
      { since: "2024" },
    );
    expect(resurrected.action).toBe("resurrected");
    expect(resurrected.edge.id).toBe(created.edge.id);
  });

  it("matches the JSON-persisted form of validated properties", async () => {
    const store = createStore(graph, raw);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    const props = { label: { value: undefined } };

    const created = await store.edges.annotated.getOrCreateByEndpoints(
      alice,
      bob,
      props,
      { matchOn: ["label"] },
    );
    const found = await store.edges.annotated.getOrCreateByEndpoints(
      alice,
      bob,
      props,
      { matchOn: ["label"] },
    );

    expect(created.action).toBe("created");
    expect(found.action).toBe("found");
    expect(found.edge.id).toBe(created.edge.id);
  });
});
