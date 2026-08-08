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

import { defineEdge, defineGraph, defineNode, UniquenessError } from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import {
  type FindEdgesByKindParams,
  type GraphBackend,
} from "../src/backend/types";
import { createStore } from "../src/store";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.string().default("2024") }),
});

const reportsTo = defineEdge("reportsTo", { schema: z.object({}) });

const graph = defineGraph({
  id: "get_or_create_convergence",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
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
 * follow: with `ifExists: "return"` the first is the found-fast-path probe and
 * the second is the dispatcher's, so racing the dispatcher means `afterCall: 2`.
 */
function racingBackend(
  base: GraphBackend,
  afterCall: number,
  commitCompetitor: () => Promise<void>,
): GraphBackend {
  let calls = 0;
  let raced = false;
  return {
    ...base,
    findEdgesByKind: async (params: FindEdgesByKindParams) => {
      const rows = await base.findEdgesByKind(params);
      calls += 1;
      if (!raced && calls === afterCall) {
        raced = true;
        await commitCompetitor();
      }
      return rows;
    },
  };
}

describe("getOrCreateByEndpoints convergence", () => {
  let raw: GraphBackend;

  beforeEach(() => {
    ({ backend: raw } = createLocalSqliteBackend());
  });

  it("resolves to the competitor's edge instead of inserting a second one", async () => {
    const setup = createStore(graph, raw);
    const alice = await setup.nodes.Person.create({ name: "Alice" });
    const bob = await setup.nodes.Person.create({ name: "Bob" });

    const competitor = createStore(graph, raw);
    const store = createStore(
      graph,
      racingBackend(raw, 2, async () => {
        await competitor.edges.knows.create(alice, bob, { since: "winner" });
      }),
    );

    const result = await store.edges.knows.getOrCreateByEndpoints(alice, bob, {
      since: "winner",
    });

    expect(result.action).toBe("found");
    expect(result.edge.since).toBe("winner");
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
      racingBackend(raw, 2, async () => {
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
      racingBackend(raw, 2, async () => {
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
    const store = createStore(cardinalGraph, {
      ...raw,
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
    } satisfies GraphBackend);

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
    const store = createStore(uniqueGraph, {
      ...raw,
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
    } satisfies GraphBackend);

    const results = await store.nodes.Account.bulkGetOrCreateByConstraint(
      "email",
      [{ props: { email: "a@example.com" } }],
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe("created");
    expect(reported).toBe(true);
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
});
