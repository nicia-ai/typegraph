/**
 * Kind-scoped edge writes carry their own identity predicate.
 *
 * Edge ids are graph-global while collections are kind-scoped, so every
 * collection write asserts a kind before it writes. That assertion used to be a
 * READ — a gate outside the transaction plus a re-read inside it — and the
 * statement it authorized was keyed on `(graph_id, id)` alone. Two statements,
 * one predicate spread across them: on PostgreSQL READ COMMITTED a concurrent
 * `hardDelete(id)` + `create({ id, kind: other })` committing in between
 * re-points the id, and the write lands on an edge no verdict was ever computed
 * for. The re-read narrowed that window; it could not close it, because a read
 * and a later write are never one statement.
 *
 * The fix moves the predicate INTO the write: `UPDATE`/`DELETE ... WHERE
 * graph_id = ? AND id = ? AND kind = ?`. The row the statement resolves and the
 * row it mutates are then the same resolution, so the window has no interior.
 *
 * These tests inject the substitution at the ONE point that still matters —
 * between the verdict and the write statement — by swapping the row through the
 * write transaction's own target immediately before the write method runs. That
 * is precisely the interleaving the issue describes, made deterministic: no
 * second connection is needed to prove the statement refuses the wrong row,
 * only that the wrong row is there when the statement runs.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { asEdgeId, defineEdge, defineGraph, defineNode } from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { type GraphBackend } from "../src/backend/types";
import { createStore } from "../src/store";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ note: z.string().default("") }),
});
const likes = defineEdge("likes", {
  schema: z.object({ note: z.string().default("") }),
});

const graph = defineGraph({
  id: "edge_write_self_verification",
  nodes: { Person: { type: Person, onDelete: "cascade" } },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
    likes: { type: likes, from: [Person], to: [Person] },
  },
});

const EDGE_ID = "contended-edge";
const KNOWS_ID = asEdgeId<typeof knows>(EDGE_ID);
const LIKES_ID = asEdgeId<typeof likes>(EDGE_ID);

type EdgeWriteMethod = "deleteEdge" | "hardDeleteEdge" | "updateEdge";

/**
 * Substitutes the edge behind `EDGE_ID` — hard delete, then recreate under the
 * OTHER kind — immediately before the named write method runs, through the
 * transaction's own target so the substitution is committed state as far as the
 * write statement is concerned.
 *
 * One-shot, and interception is on the transaction target rather than the outer
 * backend because that is what the write runs against.
 */
function substitutingBackend(
  base: GraphBackend,
  method: EdgeWriteMethod,
  endpoints: Readonly<{ fromId: string; toId: string }>,
  substitute?: Readonly<{ kind: string; fromId: string; toId: string }>,
): GraphBackend {
  // Default: the OTHER kind, same endpoints — the cross-kind substitution.
  const replacement = substitute ?? {
    kind: "likes",
    fromId: endpoints.fromId,
    toId: endpoints.toId,
  };
  return deriveBackend(base, {
    transaction: (fn, options) =>
      base.transaction(async (transactionTarget) => {
        let substituted = false;
        const proxied = new Proxy(transactionTarget, {
          get(source, property, receiver) {
            const value: unknown = Reflect.get(source, property, receiver);
            if (property !== method || typeof value !== "function")
              return value;
            const original = value as (...args: unknown[]) => Promise<unknown>;
            return async (...args: unknown[]) => {
              if (!substituted) {
                substituted = true;
                await source.hardDeleteEdge({
                  graphId: graph.id,
                  id: EDGE_ID,
                });
                await source.insertEdge({
                  graphId: graph.id,
                  id: EDGE_ID,
                  kind: replacement.kind,
                  fromKind: "Person",
                  fromId: replacement.fromId,
                  toKind: "Person",
                  toId: replacement.toId,
                  props: { note: "substituted" },
                });
              }
              return original.apply(source, args);
            };
          },
        });
        return fn(proxied);
      }, options),
  });
}

describe("kind-scoped edge writes carry their own identity predicate", () => {
  let raw: GraphBackend;

  beforeEach(() => {
    ({ backend: raw } = createLocalSqliteBackend());
  });

  async function seed(
    backendFor: (
      endpoints: Readonly<{ fromId: string; toId: string }>,
    ) => GraphBackend,
  ): Promise<
    Readonly<{ store: ReturnType<typeof createStore<typeof graph>> }>
  > {
    const setup = createStore(graph, raw);
    const alice = await setup.nodes.Person.create({ name: "Alice" });
    const bob = await setup.nodes.Person.create({ name: "Bob" });
    await setup.edges.knows.create(
      alice,
      bob,
      { note: "original" },
      {
        id: EDGE_ID,
      },
    );
    return {
      store: createStore(graph, backendFor({ fromId: alice.id, toId: bob.id })),
    };
  }

  it("does not tombstone another kind's edge that took the id before the DELETE", async () => {
    const { store } = await seed((endpoints) =>
      substitutingBackend(raw, "deleteEdge", endpoints),
    );

    await store.edges.knows.delete(KNOWS_ID);

    // The substituted `likes` edge is untouched: the soft delete resolved zero
    // rows because its WHERE names kind = 'knows'.
    const survivor = await store.edges.likes.getById(LIKES_ID);
    expect(survivor).toBeDefined();
    expect(survivor?.note).toBe("substituted");
  });

  it("does not destroy another kind's edge that took the id before the hard DELETE", async () => {
    const { store } = await seed((endpoints) =>
      substitutingBackend(raw, "hardDeleteEdge", endpoints),
    );

    await store.edges.knows.hardDelete(KNOWS_ID);

    const survivor = await store.edges.likes.getById(LIKES_ID);
    expect(survivor).toBeDefined();
    expect(survivor?.note).toBe("substituted");
  });

  it("refuses — and writes nothing — when another kind takes the id before the UPDATE", async () => {
    const { store } = await seed((endpoints) =>
      substitutingBackend(raw, "updateEdge", endpoints),
    );

    // Without the kind in its WHERE the UPDATE would have SUCCEEDED, writing
    // the caller's props onto the `likes` edge and reporting success. Refusing
    // is the observable difference; the identity verdict is re-derived on the
    // failure path from the same single owner the gate uses.
    await expect(
      store.edges.knows.update(KNOWS_ID, { note: "caller" }),
    ).rejects.toThrow(/belongs to likes/u);

    // The refusal aborts the transaction, so the substitution rolls back with
    // it — and nothing anywhere carries the caller's props.
    expect(await store.edges.likes.getById(LIKES_ID)).toBeUndefined();
    const original = await store.edges.knows.getById(KNOWS_ID);
    expect(original?.note).toBe("original");
  });

  it("refuses a SAME-KIND substitution that moved the endpoints an upsert asserted", async () => {
    // The case a kind-only predicate cannot see. `getOrCreateByEndpoints`
    // resolves an edge BY its endpoints, so its update asserts them; a
    // competitor that hard-deletes and recreates the id under the SAME kind
    // pointing at a different node satisfies `kind = 'knows'` and would have
    // been written to. Carrying the endpoints into the same WHERE is what makes
    // the write land only on a row satisfying everything it asserted.
    const setup = createStore(graph, raw);
    const alice = await setup.nodes.Person.create({ name: "Alice" });
    const bob = await setup.nodes.Person.create({ name: "Bob" });
    const carol = await setup.nodes.Person.create({ name: "Carol" });
    await setup.edges.knows.create(
      alice,
      bob,
      { note: "original" },
      {
        id: EDGE_ID,
      },
    );

    const store = createStore(
      graph,
      substitutingBackend(
        raw,
        "updateEdge",
        { fromId: alice.id, toId: bob.id },
        // Same kind, DIFFERENT target endpoint.
        { kind: "knows", fromId: alice.id, toId: carol.id },
      ),
    );

    await expect(
      store.edges.knows.getOrCreateByEndpoints(
        alice,
        bob,
        { note: "caller" },
        { ifExists: "update" },
      ),
    ).rejects.toThrow(/belongs to knows/u);
  });

  it("still refuses a cross-collection write on the ordinary path", async () => {
    const store = createStore(graph, raw);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    const edge = await store.edges.knows.create(alice, bob, {});

    await expect(
      store.edges.likes.delete(asEdgeId<typeof likes>(edge.id)),
    ).rejects.toThrow(/belongs to knows/u);
    await expect(
      store.edges.likes.hardDelete(asEdgeId<typeof likes>(edge.id)),
    ).rejects.toThrow(/belongs to knows/u);
    await expect(
      store.edges.likes.update(asEdgeId<typeof likes>(edge.id), { note: "x" }),
    ).rejects.toThrow(/belongs to knows/u);

    expect(await store.edges.knows.getById(edge.id)).toBeDefined();
  });

  it("keeps the node delete cascade kind-blind", async () => {
    const store = createStore(graph, raw);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    await store.edges.knows.create(alice, bob, {});
    await store.edges.likes.create(alice, bob, {});

    // The cascade removes every connected edge WHATEVER its kind, so it states
    // no expected kind. A kind predicate leaking into it would strand edges.
    await store.nodes.Person.delete(alice.id);

    expect(await store.edges.knows.findFrom(alice)).toHaveLength(0);
    expect(await store.edges.likes.findFrom(alice)).toHaveLength(0);
  });
});
