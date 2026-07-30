import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  type TransactionBackend,
} from "../src";
import { type IdentityTransferAssertion } from "../src/identity/service";
import {
  exportGraph,
  importGraph,
  importGraphStream,
} from "../src/interchange";
import {
  type GraphData,
  type GraphDataHeader,
  type GraphInterchangeChunk,
} from "../src/interchange/types";
import { disjointWith } from "../src/ontology";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql, type SqlFragment } from "../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../src/query/sql-intent";
import { storeRuntime } from "../src/store/runtime-port";
import { requireDefined } from "../src/utils/presence";
import {
  createInitializedStore,
  createTestBackend,
  matchingArray,
  matchingObject,
} from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Author = defineNode("Author", {
  schema: z.object({ penName: z.string() }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows", { schema: z.object({}) });

const graph = defineGraph({
  id: "identity_import_hardening",
  nodes: {
    Person: { type: Person },
    Author: { type: Author },
    Company: { type: Company },
  },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
  ontology: [disjointWith(Person, Company)],
  identity: { sameIdAcrossKinds: "fold" },
});

const HOUR_MS = 60 * 60 * 1000;
const IDENTITY_PROFILE = "typegraph-identity-v1";
const CANONICAL_TIMESTAMP = "2024-01-01T00:00:00.000Z";

type Ref = Readonly<{ kind: string; id: string }>;

/** Narrows an asymmetric matcher so it enters a typed object as `unknown`. */
function matchingString(substring: string): unknown {
  return expect.stringContaining(substring);
}

async function* chunkStream(
  chunks: readonly GraphInterchangeChunk[],
): AsyncIterable<GraphInterchangeChunk> {
  for (const chunk of chunks) {
    await Promise.resolve();
    yield chunk;
  }
}

function isoAt(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Orders endpoints by code point, as the interchange format requires. */
function orderPair(left: Ref, right: Ref): readonly [Ref, Ref] {
  const byKind =
    left.kind < right.kind ? -1
    : left.kind > right.kind ? 1
    : 0;
  const order =
    byKind === 0 ?
      left.id < right.id ? -1
      : left.id > right.id ? 1
      : 0
    : byKind;
  return order <= 0 ? [left, right] : [right, left];
}

function transfer(
  id: string,
  first: Ref,
  second: Ref,
  validFrom: string,
  validTo?: string,
): IdentityTransferAssertion {
  const [a, b] = orderPair(first, second);
  return {
    id,
    relation: "same",
    a,
    b,
    validFrom,
    ...(validTo === undefined ? {} : { validTo }),
  };
}

/**
 * The identity read API takes graph-typed refs, so the created nodes are
 * returned alongside the plain refs the interchange format speaks in.
 */
async function seedPair<TNativeTransaction>(
  store: Awaited<
    ReturnType<typeof createInitializedStore<typeof graph, TNativeTransaction>>
  >,
) {
  const person = await store.nodes.Person.create(
    { name: "Alice" },
    { id: "alice" },
  );
  const author = await store.nodes.Author.create(
    { penName: "A." },
    { id: "author" },
  );
  return {
    person,
    author,
    personRef: { kind: "Person", id: person.id } satisfies Ref,
    authorRef: { kind: "Author", id: author.id } satisfies Ref,
  };
}

// ============================================================
// Finding 1 — archival window bounds
// ============================================================

describe("archival identity import window bounds", () => {
  it("rejects an archival assertion whose validTo is in the future", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const { person, personRef, authorRef } = await seedPair(store);

    await expect(
      storeRuntime(store).importIdentityAssertionsAtTarget(
        store.backend,
        [
          transfer(
            "wedge",
            personRef,
            authorRef,
            isoAt(-HOUR_MS),
            isoAt(HOUR_MS),
          ),
        ],
        "archival",
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      details: matchingObject({
        issues: matchingArray([
          expect.objectContaining({ code: "IDENTITY_IMPORT_FUTURE_VALID_TO" }),
        ]),
      }),
    });

    // The rejected row is exactly the one that used to wedge the store: the
    // snapshot filter would have reported it current with no closure behind it.
    expect(await store.identity.membersOf(person)).toEqual([personRef]);
    await expect(
      storeRuntime(store).validateIdentity(),
    ).resolves.toBeUndefined();
  });

  it("rejects an archival open assertion whose validFrom is in the future", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const { person, personRef, authorRef } = await seedPair(store);

    await expect(
      storeRuntime(store).importIdentityAssertionsAtTarget(
        store.backend,
        [transfer("ahead", personRef, authorRef, isoAt(HOUR_MS))],
        "archival",
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      details: matchingObject({
        issues: matchingArray([
          expect.objectContaining({
            code: "IDENTITY_IMPORT_FUTURE_VALID_FROM",
          }),
        ]),
      }),
    });

    expect(await store.identity.membersOf(person)).toEqual([personRef]);
    await expect(
      storeRuntime(store).validateIdentity(),
    ).resolves.toBeUndefined();
  });

  it("accepts an ended archival assertion that lies entirely in the past", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const { person, author, personRef, authorRef } = await seedPair(store);

    const summary = await storeRuntime(store).importIdentityAssertionsAtTarget(
      store.backend,
      [
        transfer(
          "historical",
          personRef,
          authorRef,
          isoAt(-2 * HOUR_MS),
          isoAt(-HOUR_MS),
        ),
      ],
      "archival",
    );

    expect(summary).toEqual({ created: 1, skipped: 0 });
    // Ended in the past, so it is history, not current truth.
    expect(await store.identity.membersOf(person)).toEqual([personRef]);
    expect(await store.identity.areSame(person, author)).toBe(false);
    await expect(
      storeRuntime(store).validateIdentity(),
    ).resolves.toBeUndefined();
  });

  it("accepts a zero-width archival window in the past", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const { personRef, authorRef } = await seedPair(store);
    const instant = isoAt(-HOUR_MS);

    const summary = await storeRuntime(store).importIdentityAssertionsAtTarget(
      store.backend,
      [transfer("zero-width", personRef, authorRef, instant, instant)],
      "archival",
    );

    expect(summary).toEqual({ created: 1, skipped: 0 });
    await expect(
      storeRuntime(store).validateIdentity(),
    ).resolves.toBeUndefined();
  });

  it("round-trips the store's own archival export, retraction window included", async () => {
    const source = await createInitializedStore(graph, createTestBackend());
    const alice = await source.nodes.Person.create(
      { name: "Alice" },
      { id: "alice" },
    );
    const author = await source.nodes.Author.create(
      { penName: "A." },
      { id: "author" },
    );
    const bob = await source.nodes.Person.create(
      { name: "Bob" },
      { id: "bob" },
    );

    // One retracted assertion (its clamped window is what archival import must
    // still accept) and one still-open assertion.
    const retracted = await source.identity.assertSame(alice, author);
    await source.identity.retractAssertion(retracted.assertion.id);
    await source.identity.assertSame(alice, bob);

    const archive = await exportGraph(source, {
      identityMode: "archival",
      includeDeleted: true,
    });
    expect(archive.identity?.assertions).toHaveLength(2);

    const target = await createInitializedStore(graph, createTestBackend());
    const result = await importGraph(target, archive, { onConflict: "skip" });

    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.identity).toEqual({ created: 2, skipped: 0 });
    await expect(
      storeRuntime(target).validateIdentity(),
    ).resolves.toBeUndefined();
    const restored = await exportGraph(target, {
      identityMode: "archival",
      includeDeleted: true,
    });
    expect(restored.identity).toEqual(archive.identity);
  });
});

// ============================================================
// Finding 2 — importGraph records identity failures
// ============================================================

function documentAssertingOverNodes(
  invalidNodeId: string,
  validNodeId: string,
): GraphData {
  return {
    formatVersion: "2.0",
    exportedAt: CANONICAL_TIMESTAMP,
    source: { type: "external" },
    nodes: [
      // Fails schema validation: `name` must be a string.
      { kind: "Person", id: invalidNodeId, properties: { name: 42 } },
      { kind: "Person", id: validNodeId, properties: { name: "Valid" } },
    ],
    edges: [],
    identity: {
      profile: IDENTITY_PROFILE,
      mode: "state",
      assertions: [
        {
          id: "assertion-over-missing",
          relation: "same",
          ...(() => {
            const [a, b] = orderPair(
              { kind: "Person", id: invalidNodeId },
              { kind: "Person", id: validNodeId },
            );
            return { a, b };
          })(),
          validFrom: CANONICAL_TIMESTAMP,
        },
      ],
    },
  };
}

describe("importGraph identity failure reporting", () => {
  it("records an identity failure in result.errors instead of throwing", async () => {
    const store = await createInitializedStore(graph, createTestBackend());

    const result = await importGraph(
      store,
      documentAssertingOverNodes("rejected", "kept"),
      { onConflict: "skip" },
    );

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(2);
    // The node failure and the identity failure are distinguishable by
    // entityType, and the identity entry is keyed by the assertion, not by a
    // node standing in for it.
    expect(result.errors).toEqual(
      matchingArray([
        expect.objectContaining({
          entityType: "node",
          kind: "Person",
          id: "rejected",
        }),
        expect.objectContaining({
          entityType: "identity",
          kind: "same",
          id: "assertion-over-missing",
          error: matchingString("identity.assertions[assertion-over-missing]"),
        }),
      ]),
    );

    // The valid node work still committed; only the identity section was skipped.
    expect(result.nodes.created).toBe(1);
    expect(await store.nodes.Person.getById("kept" as never)).toBeDefined();
    expect(
      await store.nodes.Person.getById("rejected" as never),
    ).toBeUndefined();
    expect(result.identity).toEqual({ created: 0, skipped: 0 });
    await expect(
      storeRuntime(store).validateIdentity(),
    ).resolves.toBeUndefined();
  });

  it("records an assertion id that already identifies different truth", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const first = await store.nodes.Person.create(
      { name: "First" },
      { id: "first" },
    );
    const second = await store.nodes.Person.create(
      { name: "Second" },
      { id: "second" },
    );
    const third = await store.nodes.Person.create(
      { name: "Third" },
      { id: "third" },
    );
    const existing = await store.identity.assertSame(first, second);

    const [a, b] = orderPair(
      { kind: "Person", id: first.id },
      { kind: "Person", id: third.id },
    );
    const result = await importGraph(
      store,
      {
        formatVersion: "2.0",
        exportedAt: CANONICAL_TIMESTAMP,
        source: { type: "external" },
        nodes: [],
        edges: [],
        identity: {
          profile: IDENTITY_PROFILE,
          mode: "state",
          assertions: [
            {
              id: existing.assertion.id,
              relation: "same",
              a,
              b,
              validFrom: CANONICAL_TIMESTAMP,
            },
          ],
        },
      },
      { onConflict: "skip" },
    );

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        entityType: "identity",
        kind: "same",
        id: existing.assertion.id,
        error: matchingString("already identifies different truth"),
      }),
    ]);
  });

  it("records a contradiction against the target graph's ontology", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const person = await store.nodes.Person.create(
      { name: "Alice" },
      { id: "alice" },
    );
    const company = await store.nodes.Company.create(
      { name: "Acme" },
      { id: "acme" },
    );
    const [a, b] = orderPair(
      { kind: "Person", id: person.id },
      { kind: "Company", id: company.id },
    );

    const result = await importGraph(
      store,
      {
        formatVersion: "2.0",
        exportedAt: CANONICAL_TIMESTAMP,
        source: { type: "external" },
        nodes: [],
        edges: [],
        identity: {
          profile: IDENTITY_PROFILE,
          mode: "state",
          assertions: [
            {
              id: "disjoint-merge",
              relation: "same",
              a,
              b,
              validFrom: CANONICAL_TIMESTAMP,
            },
          ],
        },
      },
      { onConflict: "skip" },
    );

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        entityType: "identity",
        kind: "same",
        id: "disjoint-merge",
        error: matchingString("Identity contradiction"),
      }),
    ]);
    expect(await store.identity.areSame(person, company)).toBe(false);
    await expect(
      storeRuntime(store).validateIdentity(),
    ).resolves.toBeUndefined();
  });

  it("names identity assertions in the stream ordering error", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const header: GraphDataHeader = {
      formatVersion: "2.0",
      exportedAt: CANONICAL_TIMESTAMP,
      source: { type: "external" },
      identity: { profile: IDENTITY_PROFILE, mode: "state" },
    };
    await expect(
      importGraphStream(
        store,
        chunkStream([
          { type: "header", header },
          { type: "identity", assertions: [] },
          {
            type: "nodes",
            nodes: [
              { kind: "Person", id: "late", properties: { name: "Late" } },
            ],
          },
        ]),
        { onConflict: "skip" },
      ),
    ).rejects.toThrow(
      "Graph interchange stream cannot emit nodes after identity assertions.",
    );
  });
});

// ============================================================
// Finding 3 — disjointness detection over kind sets
// ============================================================

describe("disjoint-kind contradiction detection", () => {
  it("detects a disjoint kind reached only through a multi-member class", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const author = await store.nodes.Author.create(
      { penName: "M." },
      { id: "mmm" },
    );
    const person = await store.nodes.Person.create(
      { name: "N" },
      { id: "nnn" },
    );
    const company = await store.nodes.Company.create(
      { name: "Z" },
      { id: "zzz" },
    );
    // The Author member is scanned first and is NOT disjoint with Company; the
    // conflict is only reachable through the class's second kind.
    await store.identity.assertSame(author, person);

    await expect(
      store.identity.assertSame(person, company),
    ).rejects.toMatchObject({
      name: "IdentityContradictionError",
      details: matchingObject({
        reason: "disjoint-kinds",
        conflictingKinds: ["Company", "Person"],
      }),
    });

    // Argument order is normalized before the class lookup, so the reported
    // pair is identical in the other direction.
    await expect(
      store.identity.assertSame(company, person),
    ).rejects.toMatchObject({
      name: "IdentityContradictionError",
      details: matchingObject({
        reason: "disjoint-kinds",
        conflictingKinds: ["Company", "Person"],
      }),
    });

    expect(await store.identity.areDifferent(person, company)).toBe(true);
    expect(await store.identity.areDifferent(author, company)).toBe(true);
  });

  it("reports the disjoint kinds inside a stored multi-member class", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    await store.nodes.Author.create({ penName: "M." }, { id: "mmm" });
    await store.nodes.Person.create({ name: "N" }, { id: "nnn" });
    await store.nodes.Company.create({ name: "Z" }, { id: "zzz" });

    // Write the contradiction straight into the ledger, past the assert-time
    // validation, so snapshot verification is the thing under test.
    const schema = createSqlSchema(store.backend.tableNames);
    const executeStatement = requireDefined(
      store.backend.executeStatement,
      "test backend must execute statements",
    );
    const rows: readonly (readonly [string, Ref, Ref])[] = [
      ["m-n", { kind: "Author", id: "mmm" }, { kind: "Person", id: "nnn" }],
      ["n-z", { kind: "Company", id: "zzz" }, { kind: "Person", id: "nnn" }],
    ];
    for (const [id, a, b] of rows) {
      await executeStatement(
        asCompiledStatementSql(sql`
          INSERT INTO ${schema.identityAssertionsTable} (
            graph_id, id, rel, a_kind, a_id, b_kind, b_id,
            valid_from, valid_to, created_at, updated_at, deleted_at
          ) VALUES (
            ${store.graphId}, ${id}, 'same', ${a.kind}, ${a.id},
            ${b.kind}, ${b.id}, ${CANONICAL_TIMESTAMP}, NULL,
            ${CANONICAL_TIMESTAMP}, ${CANONICAL_TIMESTAMP}, NULL
          )
        `),
      );
    }

    await expect(storeRuntime(store).validateIdentity()).rejects.toMatchObject({
      name: "ConfigurationError",
      details: matchingObject({
        code: "IDENTITY_SCHEMA_CONTRADICTION",
        conflictingKinds: ["Company", "Person"],
      }),
    });
  });
});

// ============================================================
// Finding 4 — identity-free deletes skip the closure repair
// ============================================================

type ClosureCounts = Readonly<{
  /** Statements naming the materialized closure table. */
  closureStatements: number;
  /** Closure rewrites (the expensive half of a closure repair). */
  closureDeletes: number;
}>;

// Table names arrive as identifier chunks, not literal SQL text.
function fragmentText(compiled: SqlFragment): string {
  return compiled.chunks
    .map((chunk) =>
      chunk.kind === "text" || chunk.kind === "identifier" ? chunk.value : "",
    )
    .join(" ");
}

/** Reads the closure table name out of the backend's own resolved schema. */
function closureTableName(backend: GraphBackend): string {
  const schema = createSqlSchema(backend.tableNames);
  for (const chunk of schema.identityClosureTable.chunks) {
    if (chunk.kind === "identifier") return chunk.value;
  }
  throw new Error("Closure table fragment carries no identifier chunk.");
}

function closureCountingBackend(): Readonly<{
  backend: GraphBackend;
  counts: ClosureCounts;
  reset: () => void;
}> {
  const base = createTestBackend();
  const closureTable = closureTableName(base);
  const counts = { closureStatements: 0, closureDeletes: 0 };

  function count(compiled: SqlFragment): void {
    const text = fragmentText(compiled);
    if (!text.includes(closureTable)) return;
    counts.closureStatements += 1;
    if (text.includes("DELETE FROM")) counts.closureDeletes += 1;
  }

  // A Proxy rather than a spread: transaction targets carry methods on a
  // prototype that spreading would drop.
  function countStatements<T extends GraphBackend | TransactionBackend>(
    target: T,
  ): T {
    return new Proxy(target, {
      get(source, property, receiver) {
        const value: unknown = Reflect.get(source, property, receiver);
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        if (property !== "execute" && property !== "executeStatement") {
          return value;
        }
        return (...args: unknown[]) => {
          count(args[0] as SqlFragment);
          return method.apply(source, args);
        };
      },
    });
  }

  const backend: GraphBackend = countStatements({
    ...base,
    transaction: (fn, options) =>
      base.transaction((tx) => fn(countStatements(tx)), options),
  } satisfies GraphBackend);

  return {
    backend,
    counts,
    reset: () => {
      counts.closureStatements = 0;
      counts.closureDeletes = 0;
    },
  };
}

describe("deleting a node without identity", () => {
  it("skips the closure repair and leaves identity state untouched", async () => {
    const { backend, counts, reset } = closureCountingBackend();
    const store = await createInitializedStore(graph, backend);

    const alice = await store.nodes.Person.create(
      { name: "Alice" },
      { id: "alice" },
    );
    const author = await store.nodes.Author.create(
      { penName: "A." },
      { id: "author" },
    );
    await store.identity.assertSame(alice, author);
    const solo = await store.nodes.Person.create(
      { name: "Solo" },
      { id: "solo" },
    );

    reset();
    await store.nodes.Person.delete(solo.id);

    // One indexed probe, and none of the repair's rewrites.
    expect(counts.closureDeletes).toBe(0);
    expect(counts.closureStatements).toBe(1);

    expect(await store.identity.membersOf(alice)).toEqual([
      { kind: "Author", id: author.id },
      { kind: "Person", id: alice.id },
    ]);
    await expect(
      storeRuntime(store).validateIdentity(),
    ).resolves.toBeUndefined();
  });

  it("still repairs the closure when the deleted node carries identity", async () => {
    const { backend, counts, reset } = closureCountingBackend();
    const store = await createInitializedStore(graph, backend);

    const alice = await store.nodes.Person.create(
      { name: "Alice" },
      { id: "alice" },
    );
    const author = await store.nodes.Author.create(
      { penName: "A." },
      { id: "author" },
    );
    await store.identity.assertSame(alice, author);

    reset();
    await store.nodes.Person.delete(alice.id);

    expect(counts.closureDeletes).toBeGreaterThan(0);
    expect(
      await store.identity.membersOf({ kind: "Author", id: author.id }),
    ).toEqual([{ kind: "Author", id: author.id }]);
    await expect(
      storeRuntime(store).validateIdentity(),
    ).resolves.toBeUndefined();
  });

  it("skips the closure repair for a hard delete with no identity history", async () => {
    const { backend, counts, reset } = closureCountingBackend();
    const store = await createInitializedStore(graph, backend);
    const solo = await store.nodes.Person.create(
      { name: "Solo" },
      { id: "solo" },
    );

    reset();
    await store.nodes.Person.hardDelete(solo.id);

    expect(counts.closureDeletes).toBe(0);
    expect(counts.closureStatements).toBe(1);
    const schema = createSqlSchema(backend.tableNames);
    const remaining = await backend.execute<{ total: number }>(
      asCompiledRowsSql(sql`
        SELECT COUNT(*) AS total
        FROM ${schema.identityClosureTable}
        WHERE graph_id = ${store.graphId}
      `),
    );
    expect(requireDefined(remaining[0]).total).toBe(0);
  });
});
