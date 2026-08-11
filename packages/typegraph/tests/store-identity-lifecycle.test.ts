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
import { type GraphBackend } from "../src/backend/types";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../src/query/sql-intent";
import { getActiveSchema, migrateSchema } from "../src/schema";
import { storeRuntime } from "../src/store/runtime-port";

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

/**
 * Reads the assertion ledger directly. `identityAssertionRowsByIds` answers an
 * empty map for an identity-disabled Store, which is exactly the state these
 * tests need to observe — so they go to the table.
 */
async function rawAssertionIds(
  backend: GraphBackend,
): Promise<readonly string[]> {
  const schema = createSqlSchema(backend.tableNames);
  const rows = await backend.execute<Readonly<{ id: string }>>(
    asCompiledRowsSql(sql`
      SELECT id
      FROM ${schema.identityAssertionsTable}
      WHERE graph_id = ${GRAPH_ID}
      ORDER BY id
    `),
  );
  return rows.map((row) => row.id);
}

/** Plants a ledger row the public API cannot produce (an unregistered kind). */
async function insertRawAssertion(
  backend: GraphBackend,
  assertion: Readonly<{
    id: string;
    a: Readonly<{ kind: string; id: string }>;
    b: Readonly<{ kind: string; id: string }>;
  }>,
): Promise<void> {
  const executeStatement = backend.executeStatement;
  if (executeStatement === undefined) {
    throw new Error("backend must support statement execution");
  }
  const schema = createSqlSchema(backend.tableNames);
  const now = new Date().toISOString();
  await executeStatement(
    asCompiledStatementSql(sql`
      INSERT INTO ${schema.identityAssertionsTable}
        (graph_id, id, rel, a_kind, a_id, b_kind, b_id,
         valid_from, created_at, updated_at)
      VALUES (
        ${GRAPH_ID}, ${assertion.id}, ${"same"},
        ${assertion.a.kind}, ${assertion.a.id},
        ${assertion.b.kind}, ${assertion.b.id},
        ${now}, ${now}, ${now}
      )
    `),
  );
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

  it("cascades a dropped kind through the assertion ledger", async () => {
    // The closure rebuild silently FILTERS assertions touching unregistered
    // kinds, so a kind-dropping migration that skipped the cascade would
    // leave the Author assertion current as an orphan — invisible to closure
    // and live-endpoint reads, yet visible to raw ledger reads and merge
    // staging, where a later "no-op" merge would end it.
    const { backend } = createLocalSqliteBackend();
    const [store] = await createStoreWithSchema(ignoreGraph, backend);
    await store.nodes.Person.create({ name: "Alice" }, { id: "alice" });
    await store.nodes.Author.create({ penName: "A." }, { id: "alias" });
    const asserted = await store.identity.assertSame(alice, {
      kind: "Author",
      id: "alias",
    });

    const personOnlyGraph = defineGraph({
      id: GRAPH_ID,
      nodes: { Person: { type: Person } },
      edges: {},
      identity: { sameIdAcrossKinds: "ignore" },
    });
    await migrateSchema(
      backend,
      personOnlyGraph,
      await activeVersion(backend),
      { discardDroppedKindRows: true },
    );

    const [migrated] = await createStoreWithSchema(personOnlyGraph, backend);
    const rows = await storeRuntime(migrated).identityAssertionRowsByIds([
      asserted.assertion.id,
    ]);
    expect(rows.size).toBe(0);
    await migrated.close();
  });
});

/**
 * Turning identity off retains the assertion ledger deliberately. So "the
 * target schema has no identity profile" is not evidence that there is nothing
 * to cascade — and every lifecycle verb that drops a node kind has to cascade
 * it anyway, or the rows survive as current orphans: filtered out of the
 * closure the next enablement builds, yet still visible to raw ledger reads and
 * to merge staging, where a later "no-op" merge stages them as retractions.
 */
describe("identity ledger cascade while identity is disabled", () => {
  const disabledPersonOnlyGraph = defineGraph({
    id: GRAPH_ID,
    nodes: { Person: { type: Person } },
    edges: {},
  });
  const enabledPersonOnlyGraph = defineGraph({
    id: GRAPH_ID,
    nodes: { Person: { type: Person } },
    edges: {},
    identity: { sameIdAcrossKinds: "ignore" },
  });

  it("cascades a kind dropped by migrateSchema while identity is off", async () => {
    const { backend } = createLocalSqliteBackend();
    const [store] = await createStoreWithSchema(ignoreGraph, backend);
    await store.nodes.Person.create({ name: "Alice" }, { id: "alice" });
    await store.nodes.Author.create({ penName: "A." }, { id: "alias" });
    const asserted = await store.identity.assertSame(alice, {
      kind: "Author",
      id: "alias",
    });

    // Identity off. The ledger row is retained on purpose — re-enabling later
    // is meant to find the graph's identity truth still there.
    await migrateSchema(backend, disabledGraph, await activeVersion(backend));
    expect(await rawAssertionIds(backend)).toEqual([asserted.assertion.id]);

    // Author goes away while identity is still off. The commit carries no
    // closure rebuild (there is no profile), but it must still take the row.
    await migrateSchema(
      backend,
      disabledPersonOnlyGraph,
      await activeVersion(backend),
      { discardDroppedKindRows: true },
    );
    expect(await rawAssertionIds(backend)).toEqual([]);

    // Re-enabling without Author therefore adopts nothing.
    await migrateSchema(
      backend,
      enabledPersonOnlyGraph,
      await activeVersion(backend),
    );
    const [reenabled] = await createStoreWithSchema(
      enabledPersonOnlyGraph,
      backend,
    );
    const rows = await storeRuntime(reenabled).identityAssertionRowsByIds([
      asserted.assertion.id,
    ]);
    expect(rows.size).toBe(0);
    await reenabled.close();
  });

  it("cascades a kind dropped by removeKinds() while identity is off", async () => {
    const { backend } = createLocalSqliteBackend();
    const [store] = await createStoreWithSchema(
      enabledPersonOnlyGraph,
      backend,
    );
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const person = await evolved.nodes.Person.create({ name: "Alice" });
    const tag = await evolved
      .getNodeCollectionOrThrow("Tag")
      .create({ label: "author" });
    const asserted = await evolved.identity.assertSame(person, tag);

    await migrateSchema(
      backend,
      disabledPersonOnlyGraph,
      await activeVersion(backend),
    );
    expect(await rawAssertionIds(backend)).toEqual([asserted.assertion.id]);

    // The extension kind folds back in when the disabled Store opens, so
    // removeKinds still owns Tag — and still owns Tag's assertions.
    const [disabled] = await createStoreWithSchema(
      disabledPersonOnlyGraph,
      backend,
    );
    const removed = await disabled.removeKinds(["Tag"]);
    expect(await rawAssertionIds(backend)).toEqual([]);
    await removed.close();
  });

  it("purges assertions naming unregistered kinds when identity is enabled", async () => {
    const { backend } = createLocalSqliteBackend();
    const [store] = await createStoreWithSchema(ignoreGraph, backend);
    await store.nodes.Person.create({ name: "Alice" }, { id: "alice" });
    await migrateSchema(backend, disabledGraph, await activeVersion(backend));

    // A database that already contains a stray: an assertion naming a kind the
    // schema does not register. The enablement rebuild filters it, so without
    // an explicit purge it would be adopted as an invisible current row.
    await insertRawAssertion(backend, {
      id: "orphan-assertion",
      a: alice,
      b: { kind: "Ghost", id: "ghost" },
    });
    expect(await rawAssertionIds(backend)).toEqual(["orphan-assertion"]);

    await migrateSchema(backend, ignoreGraph, await activeVersion(backend));

    expect(await rawAssertionIds(backend)).toEqual([]);
    const [enabled] = await createStoreWithSchema(ignoreGraph, backend);
    expect(await enabled.identity.membersOf(alice)).toEqual([
      { kind: "Person", id: "alice" },
    ]);
    await enabled.close();
  });
});
