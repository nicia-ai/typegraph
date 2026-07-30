/**
 * Lifecycle operations that move a Store's schema version must leave the
 * identity surface working — and must never leave it working against a schema
 * version that is no longer active.
 *
 * Two review findings on PR #268:
 *
 *  - `store.identity` memoizes one facade per Store. `clear()` resets the Store
 *    to the unversioned lifecycle (`createStore` semantics), so a facade that
 *    captured the pre-clear schema version fails every later write with
 *    `StaleVersionError` while plain node writes succeed.
 *
 *  - The explicit `migrateSchema()` path — the one the `MigrationError` message
 *    points operators at — committed identity-affecting schema versions without
 *    the closure preflight that `createStoreWithSchema` and `Store.evolve()`
 *    run, so a profile flip or a first enablement could become active over a
 *    stale or never-built closure.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineGraphExtension,
  defineNode,
  StaleVersionError,
} from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { getActiveSchema, migrateSchema } from "../src/schema";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Author = defineNode("Author", {
  schema: z.object({ penName: z.string() }),
});

const GRAPH_ID = "identity_lifecycle";

const nodes = { Person: { type: Person }, Author: { type: Author } } as const;

const foldGraph = defineGraph({
  id: GRAPH_ID,
  nodes,
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

const ignoreGraph = defineGraph({
  id: GRAPH_ID,
  nodes,
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});

const disabledGraph = defineGraph({
  id: GRAPH_ID,
  nodes,
  edges: {},
});

const alice = { kind: "Person", id: "alice" } as const;
const aliceAuthor = { kind: "Author", id: "alice" } as const;

async function activeVersion(
  backend: Parameters<typeof getActiveSchema>[0],
): Promise<number> {
  const row = await getActiveSchema(backend, GRAPH_ID);
  return row?.version ?? 0;
}

describe("identity across Store lifecycle operations", () => {
  it("keeps identity writes working after clear() resets the schema version", async () => {
    const { backend } = createLocalSqliteBackend();
    const [store] = await createStoreWithSchema(foldGraph, backend);
    const first = await store.nodes.Person.create({ name: "Alice" });
    const second = await store.nodes.Person.create({ name: "Alicia" });
    await store.identity.assertSame(first, second);

    await store.clear();

    // The facade was built before `clear()`; the schema version it writes
    // against must follow the Store, not the moment of first access.
    const rebuiltFirst = await store.nodes.Person.create({ name: "Alice" });
    const rebuiltSecond = await store.nodes.Person.create({ name: "Alicia" });
    const result = await store.identity.assertSame(rebuiltFirst, rebuiltSecond);

    expect(result.action).toBe("created");
    await store.close();
  });

  it("answers identity reads after clear()", async () => {
    const { backend } = createLocalSqliteBackend();
    const [store] = await createStoreWithSchema(foldGraph, backend);
    const before = await store.nodes.Person.create({ name: "Alice" });
    await store.identity.assertSame(
      before,
      await store.nodes.Person.create({ name: "Alicia" }),
    );

    await store.clear();

    const first = await store.nodes.Person.create({ name: "Alice" });
    const second = await store.nodes.Person.create({ name: "Alicia" });
    expect(await store.identity.areSame(first, second)).toBe(false);
    expect(await store.identity.membersOf(first)).toEqual([
      { kind: "Person", id: first.id },
    ]);

    await store.identity.assertSame(first, second);
    expect(await store.identity.areSame(first, second)).toBe(true);
    // The pre-clear assertion is gone with the rest of the graph data.
    expect(await store.identity.assertionsOf(before)).toEqual([]);

    await store.close();
  });

  it("writes identity through the Store returned by evolve(), not the captured one", async () => {
    const { backend } = createLocalSqliteBackend();
    const [store] = await createStoreWithSchema(foldGraph, backend);
    const first = await store.nodes.Person.create({ name: "Alice" });
    const second = await store.nodes.Person.create({ name: "Alicia" });

    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Publisher: { properties: { name: { type: "string" } } } },
      }),
    );

    // Documented contract: a Store is an immutable schema snapshot, so the
    // pre-evolve handle stays pinned to the old version and its managed writes
    // are fenced — identity writes included.
    await expect(store.identity.assertSame(first, second)).rejects.toThrow(
      StaleVersionError,
    );
    const result = await evolved.identity.assertSame(first, second);
    expect(result.action).toBe("created");

    await evolved.close();
  });
});

describe("migrateSchema() identity preflight", () => {
  it("rebuilds the closure when an explicit migration flips the identity profile", async () => {
    const { backend } = createLocalSqliteBackend();
    const [store] = await createStoreWithSchema(ignoreGraph, backend);
    await store.nodes.Person.create({ name: "Alice" }, { id: "alice" });
    await store.nodes.Author.create({ penName: "A." }, { id: "alice" });
    expect(await store.identity.areSame(alice, aliceAuthor)).toBe(false);

    // The profile flip is a breaking change, so `createStoreWithSchema` refuses
    // it and points here. This commit must carry the closure rebuild with it.
    const version = await migrateSchema(
      backend,
      foldGraph,
      await activeVersion(backend),
    );
    expect(version).toBe(2);

    const [folded] = await createStoreWithSchema(foldGraph, backend);
    expect(await folded.identity.areSame(alice, aliceAuthor)).toBe(true);

    // ...and the reverse flip un-folds them again.
    await migrateSchema(backend, ignoreGraph, await activeVersion(backend));
    const [ignored] = await createStoreWithSchema(ignoreGraph, backend);
    expect(await ignored.identity.areSame(alice, aliceAuthor)).toBe(false);

    await ignored.close();
  });

  it("builds the closure when an explicit migration enables identity", async () => {
    const { backend } = createLocalSqliteBackend();
    const [store] = await createStoreWithSchema(disabledGraph, backend);
    await store.nodes.Person.create({ name: "Alice" }, { id: "alice" });
    await store.nodes.Author.create({ penName: "A." }, { id: "alice" });

    await migrateSchema(backend, foldGraph, await activeVersion(backend));

    // The fold scan ran inside the commit: same-id nodes across kinds are one
    // equivalence set, without any later `rebuildIdentityClosure()` repair.
    const [enabled] = await createStoreWithSchema(foldGraph, backend);
    expect(await enabled.identity.areSame(alice, aliceAuthor)).toBe(true);
    expect(await enabled.identity.membersOf(alice)).toEqual(
      expect.arrayContaining([
        { kind: "Person", id: "alice" },
        { kind: "Author", id: "alice" },
      ]),
    );

    await enabled.close();
  });
});
