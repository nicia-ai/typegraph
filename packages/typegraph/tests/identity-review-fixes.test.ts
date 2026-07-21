import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type AdapterStore,
  asNodeId,
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { IdentityContradictionError, ValidationError } from "../src/errors";
import { asIdentityAssertionId } from "../src/identity";
import {
  type IdentityTransferAssertion,
  UnionFind,
} from "../src/identity/service";
import { disjointWith } from "../src/ontology";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
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
  revisionsAdvanced,
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
  id: "identity_review_fixes",
  nodes: {
    Person: { type: Person },
    Author: { type: Author },
    Company: { type: Company },
  },
  edges: { knows: { type: knows, from: [Person, Author], to: [Person] } },
  ontology: [disjointWith(Person, Company)],
  identity: { sameIdAcrossKinds: "fold" },
});

type Ref = Readonly<{ kind: string; id: string }>;

function orderPair(left: Ref, right: Ref): readonly [Ref, Ref] {
  const kindOrder =
    left.kind < right.kind ? -1
    : left.kind > right.kind ? 1
    : 0;
  const order =
    kindOrder === 0 ?
      left.id < right.id ? -1
      : left.id > right.id ? 1
      : 0
    : kindOrder;
  return order <= 0 ? [left, right] : [right, left];
}

function transfer(
  id: string,
  relation: "same" | "different",
  first: Ref,
  second: Ref,
  validFrom: string,
  validTo?: string,
): IdentityTransferAssertion {
  const [a, b] = orderPair(first, second);
  return {
    id,
    relation,
    a,
    b,
    validFrom,
    ...(validTo === undefined ? {} : { validTo }),
  };
}

async function countAssertionsTouching<TNativeTransaction>(
  store: AdapterStore<typeof graph, TNativeTransaction>,
  ref: Ref,
): Promise<number> {
  const schema = createSqlSchema(store.backend.tableNames);
  const rows = await store.backend.execute<{ total: number }>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS total
      FROM ${schema.identityAssertionsTable}
      WHERE graph_id = ${store.graphId}
        AND (
          (a_kind = ${ref.kind} AND a_id = ${ref.id})
          OR (b_kind = ${ref.kind} AND b_id = ${ref.id})
        )
    `),
  );
  return requireDefined(rows[0]).total;
}

describe("identity review fixes", () => {
  it("#1 captures merge-created assertions in recorded history", async () => {
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
      {
        history: true,
      },
    );
    const person = await store.nodes.Person.create({ name: "Alice" });
    const author = await store.nodes.Author.create({ penName: "A." });

    await store.applyIdentityMergeAtTarget(
      storeRuntime(store).backend,
      [],
      [
        transfer(
          "merge-same-1",
          "same",
          { kind: "Person", id: person.id },
          { kind: "Author", id: author.id },
          new Date().toISOString(),
        ),
      ],
    );

    const schema = createSqlSchema(store.backend.tableNames);
    const rows = await store.backend.execute<{ op: string }>(
      asCompiledRowsSql(sql`
        SELECT op
        FROM ${schema.recordedIdentityAssertionsTable}
        WHERE graph_id = ${store.graphId} AND id = ${"merge-same-1"}
      `),
    );
    expect(rows.map((row) => row.op)).toContain("create");
  });

  it("#2 rejects [same, different] on one pair and persists nothing", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const a = await store.nodes.Person.create({ name: "A" }, { id: "aaa" });
    const b = await store.nodes.Person.create({ name: "B" }, { id: "bbb" });
    const now = new Date().toISOString();
    const aRef = { kind: "Person", id: a.id };
    const bRef = { kind: "Person", id: b.id };

    await expect(
      store.applyIdentityMergeAtTarget(
        store.backend,
        [],
        [
          transfer("s1", "same", aRef, bRef, now),
          transfer("d1", "different", aRef, bRef, now),
        ],
      ),
    ).rejects.toBeInstanceOf(IdentityContradictionError);

    expect(await countAssertionsTouching(store, aRef)).toBe(0);
    expect(await store.identity.areSame(a, b)).toBe(false);
  });

  it("#3 retraction + new different on same pair succeeds", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const a = await store.nodes.Person.create({ name: "A" }, { id: "aaa" });
    const b = await store.nodes.Person.create({ name: "B" }, { id: "bbb" });
    const aRef = { kind: "Person", id: a.id };
    const bRef = { kind: "Person", id: b.id };
    const existing = await store.identity.assertSame(a, b);

    await expect(
      store.applyIdentityMergeAtTarget(
        store.backend,
        [existing.id],
        [transfer("d1", "different", aRef, bRef, new Date().toISOString())],
      ),
    ).resolves.toBeUndefined();

    expect(await store.identity.areSame(a, b)).toBe(false);
    expect(await store.identity.areDifferent(a, b)).toBe(true);
  });

  it("#4 hard delete removes ended assertions left by a prior soft delete", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const a = await store.nodes.Person.create({ name: "A" }, { id: "aaa" });
    const b = await store.nodes.Person.create({ name: "B" }, { id: "bbb" });
    const aRef = { kind: "Person", id: a.id };
    await store.identity.assertSame(a, b);

    await store.nodes.Person.delete(a.id);
    // Soft delete ended (but did not remove) the assertion row.
    expect(await countAssertionsTouching(store, aRef)).toBe(1);

    await store.nodes.Person.hardDelete(a.id);
    expect(await countAssertionsTouching(store, aRef)).toBe(0);
  });

  it("#5a rejects a future-dated validFrom on a state merge", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const a = await store.nodes.Person.create({ name: "A" }, { id: "aaa" });
    const b = await store.nodes.Person.create({ name: "B" }, { id: "bbb" });
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await expect(
      store.applyIdentityMergeAtTarget(
        store.backend,
        [],
        [
          transfer(
            "s1",
            "same",
            { kind: "Person", id: a.id },
            { kind: "Person", id: b.id },
            future,
          ),
        ],
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
  });

  it("#5b rejects a negative window but accepts a zero-width archival window", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const a = await store.nodes.Person.create({ name: "A" }, { id: "aaa" });
    const b = await store.nodes.Person.create({ name: "B" }, { id: "bbb" });
    const aRef = { kind: "Person", id: a.id };
    const bRef = { kind: "Person", id: b.id };

    await expect(
      store.importIdentityAssertionsAtTarget(
        store.backend,
        [
          transfer(
            "neg",
            "same",
            aRef,
            bRef,
            "2026-06-01T00:00:00.001Z",
            "2026-06-01T00:00:00.000Z",
          ),
        ],
        "archival",
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      details: matchingObject({
        issues: matchingArray([
          expect.objectContaining({ code: "IDENTITY_IMPORT_INVALID_WINDOW" }),
        ]),
      }),
    });

    // A zero-width window is what a same-instant retraction / skew clamp emits;
    // archival re-import must accept it so the store's own output round-trips.
    const summary = await store.importIdentityAssertionsAtTarget(
      store.backend,
      [
        transfer(
          "zero",
          "same",
          aRef,
          bRef,
          "2026-06-01T00:00:00.000Z",
          "2026-06-01T00:00:00.000Z",
        ),
      ],
      "archival",
    );
    expect(summary.created).toBe(1);
  });

  it("#6 includeEnded conducts node visibility but not through a retracted assertion", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const a = await store.nodes.Person.create({ name: "A" }, { id: "aaa" });
    const b = await store.nodes.Person.create({ name: "B" }, { id: "bbb" });

    await store.identity.assertSame(a, b);
    await store.identity.retractSameAssertion(a, b);
    await store.identity.assertDifferent(a, b);

    const view = store.view({ mode: "includeEnded" });
    expect(await view.identity.areSame(a, b)).toBe(false);
    expect(await view.identity.areDifferent(a, b)).toBe(true);
  });

  it("#7 UnionFind handles a deep adversarial chain without overflow", () => {
    const unionFind = new UnionFind();
    const chainLength = 60_000;
    // Each new ref is code-point-smaller, the ordering that made the old
    // root-by-code-point linking build an O(N) parent chain.
    let previous = { kind: "Person", id: `z${"z".repeat(6)}` };
    unionFind.add(previous);
    for (let index = 0; index < chainLength; index += 1) {
      const next = {
        kind: "Person",
        id: `id-${String(chainLength - index).padStart(7, "0")}`,
      };
      unionFind.union(previous, next);
      previous = next;
    }
    const [anyMember] = unionFind.components().values();
    expect(requireDefined(anyMember).length).toBe(chainLength + 1);
  });

  it("#8 bulkAssertSame detects a different-assertion spanning the batch", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const p1 = await store.nodes.Person.create({ name: "One" }, { id: "p1" });
    const p2 = await store.nodes.Person.create({ name: "Two" }, { id: "p2" });
    const p3 = await store.nodes.Person.create({ name: "Three" }, { id: "p3" });
    await store.identity.assertDifferent(p1, p3);

    await expect(
      store.identity.bulkAssertSame([
        { a: p1, b: p2 },
        { a: p2, b: p3 },
      ]),
    ).rejects.toBeInstanceOf(IdentityContradictionError);
  });

  it("#9a bulkCreate folds same-id nodes across kinds via the batched probe", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    await store.nodes.Person.bulkCreate([{ props: { name: "X" }, id: "x" }]);
    await store.nodes.Author.bulkCreate([
      { props: { penName: "X." }, id: "x" },
    ]);

    expect(
      await store.identity.areSame(
        { kind: "Person", id: "x" },
        { kind: "Author", id: "x" },
      ),
    ).toBe(true);
  });

  it("#9b bulkCreate resurrects a soft-deleted id via the batched partition", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    await store.nodes.Person.create({ name: "Y" }, { id: "y" });
    await store.nodes.Person.delete(asNodeId("y"));

    await store.nodes.Person.bulkCreate([
      { props: { name: "Y-again" }, id: "y" },
    ]);

    const revived = await store.nodes.Person.getById(asNodeId("y"));
    expect(revived?.name).toBe("Y-again");
  });

  it("#12 batches recorded rows for a bulk assertion flush", async () => {
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
      {
        history: true,
      },
    );
    const p1 = await store.nodes.Person.create({ name: "One" }, { id: "p1" });
    const p2 = await store.nodes.Person.create({ name: "Two" }, { id: "p2" });
    const p3 = await store.nodes.Person.create({ name: "Three" }, { id: "p3" });
    await store.identity.bulkAssertSame([
      { a: p1, b: p2 },
      { a: p2, b: p3 },
    ]);

    const schema = createSqlSchema(store.backend.tableNames);
    const rows = await store.backend.execute<{ op: string }>(
      asCompiledRowsSql(sql`
        SELECT op
        FROM ${schema.recordedIdentityAssertionsTable}
        WHERE graph_id = ${store.graphId} AND op = ${"create"}
      `),
    );
    expect(rows.length).toBe(2);
  });

  it("#13 clamps a clock-skewed retraction to valid_from", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const store = await createInitializedStore(graph, createTestBackend());
      const a = await store.nodes.Person.create({ name: "A" }, { id: "aaa" });
      const b = await store.nodes.Person.create({ name: "B" }, { id: "bbb" });
      vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
      const assertion = await store.identity.assertSame(a, b);
      // Clock jumps backward before the retraction.
      vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
      await store.identity.retractAssertion(assertion.id);

      const schema = createSqlSchema(store.backend.tableNames);
      const rows = await store.backend.execute<{
        valid_from: string;
        valid_to: string;
      }>(
        asCompiledRowsSql(sql`
          SELECT valid_from, valid_to
          FROM ${schema.identityAssertionsTable}
          WHERE graph_id = ${store.graphId} AND id = ${assertion.id}
        `),
      );
      const row = requireDefined(rows[0]);
      expect(row.valid_to >= row.valid_from).toBe(true);
      expect(row.valid_to).toBe(row.valid_from);
    } finally {
      vi.useRealTimers();
    }
  });

  it("#17 asIdentityAssertionId brands non-empty ids and rejects empty", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const a = await store.nodes.Person.create({ name: "A" }, { id: "aaa" });
    const b = await store.nodes.Person.create({ name: "B" }, { id: "bbb" });
    const assertion = await store.identity.assertSame(a, b);

    expect(() => asIdentityAssertionId("")).toThrow(ValidationError);

    await expect(
      store.identity.retractAssertion(asIdentityAssertionId(assertion.id)),
    ).resolves.toMatchObject({ id: assertion.id });
    expect(await store.identity.areSame(a, b)).toBe(false);
  });

  it("#18 no-op identity mutations do not advance the revision clock", async () => {
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
      {
        revisionTracking: true,
      },
    );
    const a = await store.nodes.Person.create({ name: "A" }, { id: "aaa" });
    const b = await store.nodes.Person.create({ name: "B" }, { id: "bbb" });
    const assertion = await store.identity.assertSame(a, b);
    const before = await store.revisionNow();
    expect(before).toBeDefined();

    // No-op: retract an id that is not currently open.
    await store.identity.retractAssertion(
      asIdentityAssertionId("does-not-exist"),
    );
    expect(await store.revisionNow()).toBe(before);

    // No-op: idempotent reassert of the already-current pair.
    await store.identity.assertSame(a, b);
    expect(await store.revisionNow()).toBe(before);

    // Real change advances exactly once.
    await store.identity.retractAssertion(assertion.id);
    expect(revisionsAdvanced(before, await store.revisionNow())).toBe(1);
  });

  it("#closure validateIdentity detects a stale materialized closure", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const a = await store.nodes.Person.create({ name: "A" }, { id: "aaa" });
    const b = await store.nodes.Person.create({ name: "B" }, { id: "bbb" });
    await store.identity.assertSame(a, b);

    // A consistent materialized closure verifies cleanly.
    await expect(store.validateIdentity()).resolves.toBeUndefined();

    // Corrupt the materialized closure out from under the engine.
    const schema = createSqlSchema(store.backend.tableNames);
    const { executeStatement } = store.backend;
    if (executeStatement === undefined) {
      throw new Error("test backend must execute statements");
    }
    await executeStatement(
      asCompiledStatementSql(sql`
        DELETE FROM ${schema.identityClosureTable}
        WHERE graph_id = ${store.graphId}
      `),
    );

    await expect(store.validateIdentity()).rejects.toMatchObject({
      name: "ConfigurationError",
      details: matchingObject({
        code: "IDENTITY_SCHEMA_CONTRADICTION",
      }),
    });
  });

  it("#19 receipt pins identity write intent, not persisted effect", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const a = await store.nodes.Person.create({ name: "A" }, { id: "aaa" });
    const b = await store.nodes.Person.create({ name: "B" }, { id: "bbb" });
    await store.identity.assertSame(a, b);

    const outcome = await store.transactionWithReceipt(async (tx) => {
      // Empty bulk records nothing.
      await tx.identity.bulkAssertSame([]);
      // Idempotent reassert still counts as one intent.
      await tx.identity.assertSame(a, b);
      // Retracting a nonexistent id still counts as one intent.
      await tx.identity.retractAssertion(asIdentityAssertionId("missing"));
      // Duplicate ids in one bulk call count by input length.
      await tx.identity.bulkRetractAssertions([
        asIdentityAssertionId("missing"),
        asIdentityAssertionId("missing"),
      ]);
    });

    expect(outcome.receipt.writes.identity).toMatchObject({
      sameAssertions: 1,
      retractions: 3,
      total: 4,
    });
  });
});
