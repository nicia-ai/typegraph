import { describe, expect, it, vi } from "vitest";

import {
  asEdgeId,
  asNodeId,
  createStoreWithSchema,
  type EdgeId,
  type GraphBackend,
  type Node,
  type NodeId,
  type Store,
  ValidationError,
} from "../../../src";
import {
  type TransactionBackend,
  type TransactionOptions,
} from "../../../src/backend/types";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { STORE_RUNTIME } from "../../../src/store/runtime-port";
import { canonicalizeDatabaseTimestamp } from "../../../src/utils/date";
import { requireDefined } from "../../../src/utils/presence";
import { withZonedValidityWindowText } from "../../test-utils";
import {
  type HistoryIntegrationStore,
  type IntegrationStore,
  integrationTestGraph,
} from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

// Postgres returns COUNT(*) as a string/bigint, SQLite as a number, so the
// value is genuinely not statically a number — Number(...) is a real coercion.
type CountRow = Readonly<{ cnt: unknown }>;

/**
 * Creates a fresh store on the shared backend with
 * `coalesceUnchangedUpserts` enabled, plus any extra options.
 */
async function createCoalesceStore(
  context: IntegrationTestContext,
  extra?: Readonly<{ history?: true; revisionTracking?: true }>,
): Promise<HistoryIntegrationStore | IntegrationStore> {
  if (extra?.history === true) {
    return context.createHistoryStore(integrationTestGraph, {
      coalesceUnchangedUpserts: true,
      ...(extra.revisionTracking === true && { revisionTracking: true }),
    });
  }
  return context.createStore(integrationTestGraph, {
    coalesceUnchangedUpserts: true,
    ...(extra?.revisionTracking === true && { revisionTracking: true }),
  });
}

function personId(
  id: string,
): NodeId<typeof integrationTestGraph.nodes.Person.type> {
  return asNodeId(id);
}

type PersonNode = Node<typeof integrationTestGraph.nodes.Person.type>;

/** Any store over the integration graph — history, backend-bearing, or plain. */
type CoalesceTestStore = Store<typeof integrationTestGraph>;

function knowsId(
  id: string,
): EdgeId<typeof integrationTestGraph.edges.knows.type> {
  return asEdgeId(id);
}

/**
 * Total recorded history rows (open and closed) captured for a node id — the
 * count the issue predicts grows by one per re-delivery on the write path and
 * stays flat when coalesced.
 */
async function countRecordedNodeRows(
  store: HistoryIntegrationStore | IntegrationStore,
  kind: string,
  id: string,
): Promise<number> {
  const backend = store[STORE_RUNTIME].backend;
  const table = createSqlSchema(backend.tableNames).recordedNodesTable;
  const rows = await backend.execute<CountRow>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS cnt
      FROM ${table}
      WHERE graph_id = ${store.graphId}
        AND kind = ${kind}
        AND id = ${id}
    `),
  );
  return Number(rows[0]?.cnt ?? 0);
}

type EdgeWriteCounter = Readonly<{
  backend: GraphBackend;
  updates: () => number;
}>;

/**
 * Wraps a backend — and every transaction-scoped backend it hands out — so
 * each `updateEdge` call is counted. Edges carry no version counter, so the
 * duplicate-id probe matrix needs an exact write count that survives the
 * transaction the bulk-upsert path opens.
 */
function withEdgeUpdateCounting(base: GraphBackend): EdgeWriteCounter {
  let updates = 0;
  function countingUpdateEdge(
    target: Pick<GraphBackend, "updateEdge">,
  ): GraphBackend["updateEdge"] {
    return (params) => {
      updates += 1;
      return target.updateEdge(params);
    };
  }
  const backend: GraphBackend = {
    ...base,
    updateEdge: countingUpdateEdge(base),
    transaction: <T>(
      fn: (tx: TransactionBackend) => Promise<T>,
      options?: TransactionOptions,
    ) =>
      base.transaction<T>(
        (txBackend) =>
          fn({ ...txBackend, updateEdge: countingUpdateEdge(txBackend) }),
        options,
      ),
  };
  return { backend, updates: () => updates };
}

/**
 * A future instant and a later one. Every re-stated window in these cases has to
 * be a window the store would accept as a fresh write too, and a bound before the
 * row's own `validFrom` (its creation instant) is refused as inverted.
 */
const WINDOW_END = "2100-06-01T00:00:00.000Z";
const LATER_WINDOW_END = "2100-09-01T00:00:00.000Z";

/**
 * A PAST lower bound, for the cases that name `validFrom` on a CREATE and then
 * read the row back: a row whose window starts in 2100 is not current yet, so a
 * plain `getById` could not see it at all.
 */
const WINDOW_START = "2000-01-01T00:00:00.000Z";

/** Seeds a Person at version 1 whose window ends at {@link WINDOW_END}. */
async function seedWindowedPerson(
  store: CoalesceTestStore,
  id: string,
): Promise<Readonly<{ validFrom: string; version: number }>> {
  const created = await store.nodes.Person.upsertById(
    id,
    { name: "Win", age: 1 },
    { validTo: WINDOW_END },
  );
  expect(created.meta.version).toBe(1);
  return {
    validFrom: requireDefined(created.meta.validFrom),
    version: created.meta.version,
  };
}

/** A coalescing store on a wrapped backend, plus the edge write counter. */
async function createCountingStore(
  base: GraphBackend,
): Promise<Readonly<{ store: CoalesceTestStore; edgeUpdates: () => number }>> {
  const counter = withEdgeUpdateCounting(base);
  const [store] = await createStoreWithSchema(
    integrationTestGraph,
    counter.backend,
    { coalesceUnchangedUpserts: true },
  );
  return { store, edgeUpdates: counter.updates };
}

/** Creates two people and returns them as edge endpoints. */
async function seedEndpoints(
  store: CoalesceTestStore,
  prefix: string,
): Promise<readonly [PersonNode, PersonNode]> {
  const [alice, bob] = await store.nodes.Person.bulkCreate([
    { props: { name: "A" }, id: `${prefix}-a` },
    { props: { name: "B" }, id: `${prefix}-b` },
  ]);
  return [requireDefined(alice), requireDefined(bob)];
}

export function registerCoalesceUpsertIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("coalesceUnchangedUpserts", () => {
    it("coalesces a value-identical upsert: no write, returns the existing node", async () => {
      const store = await createCoalesceStore(context);

      const created = await store.nodes.Person.upsertById("p1", {
        name: "Alice",
        age: 30,
      });
      expect(created.meta.version).toBe(1);

      const replayed = await store.nodes.Person.upsertById("p1", {
        name: "Alice",
        age: 30,
      });

      // No write happened: the returned node is the existing row, its version
      // and updatedAt unchanged.
      expect(replayed.meta.version).toBe(1);
      expect(replayed.meta.updatedAt).toBe(created.meta.updatedAt);
      expect(replayed.meta.validFrom).toBe(created.meta.validFrom);
    });

    it("coalesces regardless of prop key order (canonical comparison)", async () => {
      const store = await createCoalesceStore(context);

      const created = await store.nodes.Person.upsertById("p-order", {
        name: "Zoe",
        age: 20,
        email: "zoe@example.com",
      });

      const replayed = await store.nodes.Person.upsertByIdFromRecord(
        "p-order",
        {
          email: "zoe@example.com",
          age: 20,
          name: "Zoe",
        },
      );

      expect(replayed.meta.version).toBe(created.meta.version);
      expect(replayed.meta.updatedAt).toBe(created.meta.updatedAt);
    });

    it("writes when a prop changes", async () => {
      const store = await createCoalesceStore(context);

      const created = await store.nodes.Person.upsertById("p2", {
        name: "Bob",
        age: 40,
      });

      const changed = await store.nodes.Person.upsertById("p2", {
        name: "Bob",
        age: 41,
      });

      expect(changed.meta.version).toBe(created.meta.version + 1);
      const age = (changed as { age?: number }).age;
      expect(age).toBe(41);
    });

    it("resurrects a soft-deleted row rather than coalescing", async () => {
      const store = await createCoalesceStore(context);

      const created = await store.nodes.Person.upsertById("p3", {
        name: "Carol",
        age: 33,
      });
      await store.nodes.Person.delete(personId("p3"));

      // The upsert props equal the pre-delete stored props, but a soft-deleted
      // row must resurrect — a real write — never coalesce.
      const resurrected = await store.nodes.Person.upsertById("p3", {
        name: "Carol",
        age: 33,
      });

      expect(resurrected.meta.deletedAt).toBeUndefined();
      expect(resurrected.meta.version).toBeGreaterThan(created.meta.version);
      await expect(
        store.nodes.Person.getById(personId("p3")),
      ).resolves.toBeDefined();
    });

    it("writes when an explicit validFrom / validTo override is passed", async () => {
      const store = await createCoalesceStore(context);

      const created = await store.nodes.Person.upsertById("p4", {
        name: "Dana",
        age: 25,
      });

      const overridden = await store.nodes.Person.upsertById(
        "p4",
        { name: "Dana", age: 25 },
        { validFrom: "2020-01-01T00:00:00.000Z" },
      );

      expect(overridden.meta.version).toBe(created.meta.version + 1);
    });

    it("rejects an unrepresentable validTo instead of coalescing it away", async () => {
      const store = await createCoalesceStore(context);

      await store.nodes.Person.upsertById("p4-invalid", {
        name: "Dana",
        age: 25,
      });

      // The coalesce check compares the requested bound with the stored one AS
      // INSTANTS, and an unparseable string has no instant — neither does the
      // open window it is written against. Treating those two absences as equal
      // would report "no window change", coalesce the write, and swallow the
      // ValidationError the write path owes the caller.
      await expect(
        store.nodes.Person.upsertById(
          "p4-invalid",
          { name: "Dana", age: 25 },
          { validTo: "not-a-date" },
        ),
      ).rejects.toThrow(/validTo/);
    });

    it("with the flag OFF, an identical re-upsert still writes (default behavior)", async () => {
      const store = context.getStore();

      const created = await store.nodes.Person.upsertById("p5", {
        name: "Erin",
        age: 50,
      });
      const replayed = await store.nodes.Person.upsertById("p5", {
        name: "Erin",
        age: 50,
      });

      expect(replayed.meta.version).toBe(created.meta.version + 1);
    });

    it("coalesces per-item in a mixed bulk batch, preserving input order", async () => {
      const store = await createCoalesceStore(context);

      await store.nodes.Person.upsertById("b-same", { name: "Same", age: 1 });
      await store.nodes.Person.upsertById("b-change", {
        name: "Change",
        age: 2,
      });

      const results = await store.nodes.Person.bulkUpsertById([
        { id: "b-same", props: { name: "Same", age: 1 } }, // coalesced
        { id: "b-change", props: { name: "Change", age: 3 } }, // written
        { id: "b-new", props: { name: "New", age: 4 } }, // created
      ]);

      expect(results).toHaveLength(3);
      expect(results[0]?.id).toBe("b-same");
      expect(results[0]?.meta.version).toBe(1); // untouched
      expect(results[1]?.id).toBe("b-change");
      expect(results[1]?.meta.version).toBe(2); // real update
      expect((results[1] as { age?: number }).age).toBe(3);
      expect(results[2]?.id).toBe("b-new");
      expect(results[2]?.meta.version).toBe(1); // created
    });

    it("coalesces edge bulkUpsertById symmetrically", async () => {
      const store = await createCoalesceStore(context);

      const [alice, bob] = await store.nodes.Person.bulkCreate([
        { props: { name: "Alice" }, id: "e-alice" },
        { props: { name: "Bob" }, id: "e-bob" },
      ]);
      if (alice === undefined || bob === undefined) {
        throw new Error("expected both people to be created");
      }

      await store.edges.knows.bulkUpsertById([
        {
          id: knowsId("edge-1"),
          from: alice,
          to: bob,
          props: { since: "2020" },
        },
      ]);

      const results = await store.edges.knows.bulkUpsertById([
        {
          id: knowsId("edge-1"),
          from: alice,
          to: bob,
          props: { since: "2020" },
        }, // coalesced
        {
          id: knowsId("edge-2"),
          from: bob,
          to: alice,
          props: { since: "2021" },
        }, // created
      ]);

      const first = await store.edges.knows.getById(knowsId("edge-1"));
      // The coalesced edge kept its original creation timestamp.
      expect(results[0]?.id).toBe("edge-1");
      expect(results[0]?.meta.updatedAt).toBe(first?.meta.updatedAt);
      expect(results[1]?.id).toBe("edge-2");
    });

    it("writes an edge when its props change", async () => {
      const store = await createCoalesceStore(context);
      const [alice, bob] = await store.nodes.Person.bulkCreate([
        { props: { name: "A" }, id: "ec-a" },
        { props: { name: "B" }, id: "ec-b" },
      ]);
      if (alice === undefined || bob === undefined) {
        throw new Error("expected both people");
      }

      await store.edges.knows.bulkUpsertById([
        {
          id: knowsId("ec-edge"),
          from: alice,
          to: bob,
          props: { since: "2020" },
        },
      ]);

      await store.edges.knows.bulkUpsertById([
        {
          id: knowsId("ec-edge"),
          from: alice,
          to: bob,
          props: { since: "2099" },
        },
      ]);
      const after = await store.edges.knows.getById(knowsId("ec-edge"));

      // The persisted value is the proof the write happened: had this
      // coalesced, `after` would be the untouched edge with since = "2020".
      // (Edges carry no version, and updatedAt can collide within a
      // millisecond, so the value change is the reliable signal.)
      expect((after as { since?: string }).since).toBe("2099");
    });

    describe("with history capture", () => {
      it("creates no recorded row and does not advance recordedNow on a coalesced replay", async () => {
        const store = await createCoalesceStore(context, { history: true });

        await store.nodes.Person.upsertById("h1", { name: "Faye", age: 60 });
        const afterFirst = await store.recordedNow();
        const rowsAfterFirst = await countRecordedNodeRows(
          store,
          "Person",
          "h1",
        );
        expect(afterFirst).toBeDefined();

        await store.nodes.Person.upsertById("h1", { name: "Faye", age: 60 });
        const afterReplay = await store.recordedNow();
        const rowsAfterReplay = await countRecordedNodeRows(
          store,
          "Person",
          "h1",
        );

        // No capture: the recorded clock and the row count are unchanged.
        expect(afterReplay).toBe(afterFirst);
        expect(rowsAfterReplay).toBe(rowsAfterFirst);

        // A real change resumes capture.
        await store.nodes.Person.upsertById("h1", { name: "Faye", age: 61 });
        const afterChange = await store.recordedNow();
        const rowsAfterChange = await countRecordedNodeRows(
          store,
          "Person",
          "h1",
        );
        expect(afterChange !== undefined && afterFirst !== undefined).toBe(
          true,
        );
        expect(requireDefined(afterChange) > requireDefined(afterFirst)).toBe(
          true,
        );
        expect(rowsAfterChange).toBeGreaterThan(rowsAfterReplay);
      });
    });

    describe("with revision tracking", () => {
      it("does not advance the revision anchor on a coalesced replay", async () => {
        const store = await createCoalesceStore(context, {
          revisionTracking: true,
        });

        await store.nodes.Person.upsertById("r1", { name: "Gwen", age: 70 });
        const afterFirst = await store.revisionNow();

        await store.nodes.Person.upsertById("r1", { name: "Gwen", age: 70 });
        const afterReplay = await store.revisionNow();
        expect(afterReplay).toBe(afterFirst);

        await store.nodes.Person.upsertById("r1", { name: "Gwen", age: 71 });
        const afterChange = await store.revisionNow();
        expect(afterChange).not.toBe(afterFirst);
      });
    });

    describe("transaction receipt shape (issue #256)", () => {
      it("first delivery captures; identical replay counts one write but records nothing", async () => {
        const store = await createCoalesceStore(context, { history: true });

        const first = await store.transactionWithReceipt(async (tx) =>
          tx.nodes.Person.upsertById("rcpt", { name: "Ivy", age: 80 }),
        );
        expect(first.receipt.writes.total).toBe(1);
        expect(first.receipt.recorded).toBeDefined();

        const replay = await store.transactionWithReceipt(async (tx) =>
          tx.nodes.Person.upsertById("rcpt", { name: "Ivy", age: 80 }),
        );
        // The write intent still completed (dropped-change detection intact),
        // but nothing was captured — the same two-signal shape as a no-op
        // delete, which at-least-once consumers already handle.
        expect(replay.receipt.writes.total).toBe(1);
        expect(replay.receipt.recorded).toBeUndefined();
      });
    });

    describe("post-review fixes (#262)", () => {
      it("preserves last-write-wins for duplicate node ids in one batch", async () => {
        const store = await createCoalesceStore(context);
        await store.nodes.Person.upsertById("dup", { name: "A" });

        // The second item's props equal the once-PREFETCHED row; without
        // batch-local pending state it would coalesce against that stale value
        // and drop the first item's write, leaving "B". Last-write-wins is "A".
        await store.nodes.Person.bulkUpsertById([
          { id: "dup", props: { name: "B" } },
          { id: "dup", props: { name: "A" } },
        ]);

        const final = await store.nodes.Person.getById(personId("dup"));
        expect((final as { name?: string }).name).toBe("A");
      });

      it("coalesces a duplicate against the batch-local pending value", async () => {
        // Each shape is applied to its own id, seeded to version 1 holding "A".
        // A write bumps the node version; a coalesced item does not — so the
        // final version minus the seed's 1 is exactly the number of writes.
        const store = await createCoalesceStore(context);
        const shapes = [
          { id: "p-aa", inputs: ["A", "A"], writes: 0, final: "A" }, // both coalesce
          { id: "p-ba", inputs: ["B", "A"], writes: 2, final: "A" }, // write B, write A
          { id: "p-bb", inputs: ["B", "B"], writes: 1, final: "B" }, // write B, coalesce
          { id: "p-ab", inputs: ["A", "B"], writes: 1, final: "B" }, // coalesce A, write B
        ] as const;

        for (const shape of shapes) {
          const seed = await store.nodes.Person.upsertById(shape.id, {
            name: "A",
          });
          expect(seed.meta.version).toBe(1);

          const results = await store.nodes.Person.bulkUpsertById(
            shape.inputs.map((name) => ({ id: shape.id, props: { name } })),
          );

          const final = await store.nodes.Person.getById(personId(shape.id));
          expect(final?.meta.version).toBe(1 + shape.writes);
          expect((final as { name?: string }).name).toBe(shape.final);
          // Each position returns the row as of its own item — for a coalesced
          // item that is its (matching) input value, so results mirror inputs.
          expect(results).toHaveLength(shape.inputs.length);
          for (const [index, node] of results.entries()) {
            expect((node as { name?: string }).name).toBe(shape.inputs[index]);
          }
        }
      });

      it("preserves last-write-wins for duplicate edge ids in one batch", async () => {
        const store = await createCoalesceStore(context);
        const [alice, bob] = await store.nodes.Person.bulkCreate([
          { props: { name: "A" }, id: "dup-a" },
          { props: { name: "B" }, id: "dup-b" },
        ]);
        if (alice === undefined || bob === undefined) {
          throw new Error("expected both people");
        }
        await store.edges.knows.bulkUpsertById([
          { id: knowsId("dup-e"), from: alice, to: bob, props: { since: "x" } },
        ]);

        await store.edges.knows.bulkUpsertById([
          {
            id: knowsId("dup-e"),
            from: alice,
            to: bob,
            props: { since: "2050" },
          },
          {
            id: knowsId("dup-e"),
            from: alice,
            to: bob,
            props: { since: "2020" },
          },
        ]);

        const final = await store.edges.knows.getById(knowsId("dup-e"));
        expect((final as { since?: string }).since).toBe("2020");
      });

      it("coalesces a value-identical duplicate edge in one batch", async () => {
        const store = await createCoalesceStore(context);
        const [alice, bob] = await store.nodes.Person.bulkCreate([
          { props: { name: "A" }, id: "dupc-a" },
          { props: { name: "B" }, id: "dupc-b" },
        ]);
        if (alice === undefined || bob === undefined) {
          throw new Error("expected both people");
        }
        await store.edges.knows.bulkUpsertById([
          {
            id: knowsId("dupc-e"),
            from: alice,
            to: bob,
            props: { since: "2020" },
          },
        ]);
        const seeded = await store.edges.knows.getById(knowsId("dupc-e"));

        // Both items equal the row; both coalesce, so nothing is written and
        // the edge's updatedAt is unchanged (edges carry no version counter).
        await store.edges.knows.bulkUpsertById([
          {
            id: knowsId("dupc-e"),
            from: alice,
            to: bob,
            props: { since: "2020" },
          },
          {
            id: knowsId("dupc-e"),
            from: alice,
            to: bob,
            props: { since: "2020" },
          },
        ]);

        const after = await store.edges.knows.getById(knowsId("dupc-e"));
        expect(after?.meta.updatedAt).toBe(seeded?.meta.updatedAt);
      });

      it("applies the duplicate-id probe matrix to edges: write counts and per-position results", async () => {
        // Mirrors the node matrix above. Nodes pin write counts via
        // `meta.version`; edges have no version counter, so the count comes
        // from an updateEdge-counting backend wrapper instead.
        const counter = withEdgeUpdateCounting(context.getStore().backend);
        const [store] = await createStoreWithSchema(
          integrationTestGraph,
          counter.backend,
          { coalesceUnchangedUpserts: true },
        );

        const [alice, bob] = await store.nodes.Person.bulkCreate([
          { props: { name: "A" }, id: "matrix-a" },
          { props: { name: "B" }, id: "matrix-b" },
        ]);
        if (alice === undefined || bob === undefined) {
          throw new Error("expected both people");
        }

        const shapes = [
          { id: "e-aa", inputs: ["A", "A"], writes: 0, final: "A" }, // both coalesce
          { id: "e-ba", inputs: ["B", "A"], writes: 2, final: "A" }, // write B, write A
          { id: "e-bb", inputs: ["B", "B"], writes: 1, final: "B" }, // write B, coalesce
          { id: "e-ab", inputs: ["A", "B"], writes: 1, final: "B" }, // coalesce A, write B
        ] as const;

        for (const shape of shapes) {
          // Seed each shape's edge holding "A" (a create, not counted).
          await store.edges.knows.bulkUpsertById([
            {
              id: knowsId(shape.id),
              from: alice,
              to: bob,
              props: { since: "A" },
            },
          ]);

          const updatesBefore = counter.updates();
          const results = await store.edges.knows.bulkUpsertById(
            shape.inputs.map((since) => ({
              id: knowsId(shape.id),
              from: alice,
              to: bob,
              props: { since },
            })),
          );
          expect(counter.updates() - updatesBefore).toBe(shape.writes);

          const final = await store.edges.knows.getById(knowsId(shape.id));
          expect((final as { since?: string }).since).toBe(shape.final);
          // Each position returns the row as of its own item — a coalesced
          // item resolves to its (matching) input value, so results mirror
          // inputs.
          expect(results).toHaveLength(shape.inputs.length);
          for (const [index, edge] of results.entries()) {
            expect((edge as { since?: string }).since).toBe(
              shape.inputs[index],
            );
          }
        }
      });

      it("routes a dirty-check validation error through onError (not the collection layer)", async () => {
        const onError = vi.fn();
        const [store] = await createStoreWithSchema(
          integrationTestGraph,
          context.getStore().backend,
          { coalesceUnchangedUpserts: true, hooks: { onError } },
        );
        await store.nodes.Person.upsertById("bad", { name: "Valid" });

        // `name: 42` fails the Zod schema. The dirty check validates first at
        // the collection layer; the fix makes that throw fall through to the
        // hooked write path so onError still fires, matching flag-off.
        await expect(
          store.nodes.Person.upsertByIdFromRecord("bad", { name: 42 }),
        ).rejects.toThrow();
        expect(onError).toHaveBeenCalledTimes(1);
      });

      it("counts only real mutations toward the statistics-refresh threshold", async () => {
        const [store] = await createStoreWithSchema(
          integrationTestGraph,
          context.getStore().backend,
          { coalesceUnchangedUpserts: true, autoRefreshStatistics: 2 },
        );
        await store.nodes.Person.bulkUpsertById([
          { id: "s1", props: { name: "S1" } },
          { id: "s2", props: { name: "S2" } },
        ]);

        // Count refreshStatistics() calls by overriding the instance method —
        // #maybeRefreshStatisticsAfterBulk invokes it as this.refreshStatistics().
        let refreshCalls = 0;
        const runRefresh = store.refreshStatistics.bind(store);
        (
          store as { refreshStatistics: () => Promise<void> }
        ).refreshStatistics = async () => {
          refreshCalls += 1;
          await runRefresh();
        };

        // All coalesced → zero mutations → below threshold → no refresh.
        await store.nodes.Person.bulkUpsertById([
          { id: "s1", props: { name: "S1" } },
          { id: "s2", props: { name: "S2" } },
        ]);
        expect(refreshCalls).toBe(0);

        // One coalesced + one update + one create = two real mutations → refresh.
        await store.nodes.Person.bulkUpsertById([
          { id: "s1", props: { name: "S1" } },
          { id: "s2", props: { name: "S2-changed" } },
          { id: "s3", props: { name: "S3" } },
        ]);
        expect(refreshCalls).toBe(1);
      });
    });

    /**
     * The bulk paths compare a requested window against the one its target
     * already holds, exactly as `shouldCoalesceUpsert` does for a single item —
     * through the same function, so the two can never drift.
     *
     * Two defects met here. The node bulk path refused to coalesce whenever an
     * item named a bound AT ALL (issue #405), so any caller that re-stated a row
     * together with its own window — what a merge commit and any
     * read-modify-write loop does — rewrote version, history, and revision state
     * for a row that did not change. The edge bulk path did compare, but compared
     * DRIVER TEXT (issue #412), so an identical re-stated window could coalesce on
     * one dialect and write on another, and — on every dialect — a repeated id
     * compared against the once-prefetched row instead of the window the batch had
     * already queued, which could drop a write the sequential path performs.
     */
    describe("bulk window comparison (#405, #412)", () => {
      it("coalesces a bulk item that re-states an unchanged node and its own window", async () => {
        const store = await createCoalesceStore(context);
        const seeded = await seedWindowedPerson(store, "bw-node-same");

        const results = await store.nodes.Person.bulkUpsertById([
          {
            id: "bw-node-same",
            props: { name: "Win", age: 1 },
            validFrom: seeded.validFrom,
            validTo: WINDOW_END,
          },
        ]);

        // Nothing would change, so nothing is written. Pre-fix the presence of a
        // bound alone forced the update and the version reached 2.
        expect(results[0]?.meta.version).toBe(seeded.version);
        const after = await store.nodes.Person.getById(
          personId("bw-node-same"),
        );
        expect(after?.meta.version).toBe(seeded.version);
        expect(canonicalizeDatabaseTimestamp(after?.meta.validTo)).toBe(
          WINDOW_END,
        );
      });

      it("captures no history for a bulk re-statement of a node and its window", async () => {
        const store = await createCoalesceStore(context, { history: true });
        const seeded = await seedWindowedPerson(store, "bw-node-hist");
        const recordedBefore = await countRecordedNodeRows(
          store,
          "Person",
          "bw-node-hist",
        );

        await store.nodes.Person.bulkUpsertById([
          {
            id: "bw-node-hist",
            props: { name: "Win", age: 1 },
            validFrom: seeded.validFrom,
            validTo: WINDOW_END,
          },
        ]);

        expect(
          await countRecordedNodeRows(store, "Person", "bw-node-hist"),
        ).toBe(recordedBefore);
      });

      it("coalesces a bulk item that re-states an unchanged edge and its own window", async () => {
        const { store, edgeUpdates } = await createCountingStore(
          context.getStore().backend,
        );
        const [alice, bob] = await seedEndpoints(store, "bw-edge-same");

        const [seeded] = await store.edges.knows.bulkUpsertById([
          {
            id: knowsId("bw-edge-same"),
            from: alice,
            to: bob,
            props: { since: "2020" },
            validTo: WINDOW_END,
          },
        ]);
        const updatesBefore = edgeUpdates();

        await store.edges.knows.bulkUpsertById([
          {
            id: knowsId("bw-edge-same"),
            from: alice,
            to: bob,
            props: { since: "2020" },
            validFrom: requireDefined(seeded?.meta.validFrom),
            validTo: WINDOW_END,
          },
        ]);

        expect(edgeUpdates()).toBe(updatesBefore);
        const after = await store.edges.knows.getById(knowsId("bw-edge-same"));
        expect(after?.meta.updatedAt).toBe(seeded?.meta.updatedAt);
      });

      it("coalesces a node whose stored window is rendered as an equivalent instant in another text form", async () => {
        const [store] = await createStoreWithSchema(
          integrationTestGraph,
          withZonedValidityWindowText(context.getStore().backend),
          { coalesceUnchangedUpserts: true },
        );
        const seeded = await seedWindowedPerson(store, "bw-zoned-node");

        // The bounds the caller re-states are canonical; the ones the collection
        // reads back are the same instants written `+00:00`. Comparing them as
        // TEXT reports a change that does not exist.
        const results = await store.nodes.Person.bulkUpsertById([
          {
            id: "bw-zoned-node",
            props: { name: "Win", age: 1 },
            validFrom: seeded.validFrom,
            validTo: WINDOW_END,
          },
        ]);

        expect(results[0]?.meta.version).toBe(seeded.version);
      });

      it("coalesces an edge whose stored window is rendered as an equivalent instant in another text form", async () => {
        const { store, edgeUpdates } = await createCountingStore(
          withZonedValidityWindowText(context.getStore().backend),
        );
        const [alice, bob] = await seedEndpoints(store, "bw-zoned-edge");

        const [seeded] = await store.edges.knows.bulkUpsertById([
          {
            id: knowsId("bw-zoned-edge"),
            from: alice,
            to: bob,
            props: { since: "2020" },
            validTo: WINDOW_END,
          },
        ]);
        const updatesBefore = edgeUpdates();

        await store.edges.knows.bulkUpsertById([
          {
            id: knowsId("bw-zoned-edge"),
            from: alice,
            to: bob,
            props: { since: "2020" },
            validFrom: requireDefined(
              canonicalizeDatabaseTimestamp(seeded?.meta.validFrom),
            ),
            validTo: WINDOW_END,
          },
        ]);

        expect(edgeUpdates()).toBe(updatesBefore);
      });

      it("writes when a bulk item moves the window of an otherwise unchanged row", async () => {
        const store = await createCoalesceStore(context);
        const seeded = await seedWindowedPerson(store, "bw-node-move");

        const results = await store.nodes.Person.bulkUpsertById([
          {
            id: "bw-node-move",
            props: { name: "Win", age: 1 },
            validFrom: seeded.validFrom,
            validTo: LATER_WINDOW_END,
          },
        ]);

        expect(results[0]?.meta.version).toBe(seeded.version + 1);
        const after = await store.nodes.Person.getById(
          personId("bw-node-move"),
        );
        expect(canonicalizeDatabaseTimestamp(after?.meta.validTo)).toBe(
          LATER_WINDOW_END,
        );
      });

      it("writes when a bulk edge item moves the window of an otherwise unchanged edge", async () => {
        const { store, edgeUpdates } = await createCountingStore(
          context.getStore().backend,
        );
        const [alice, bob] = await seedEndpoints(store, "bw-edge-move");

        await store.edges.knows.bulkUpsertById([
          {
            id: knowsId("bw-edge-move"),
            from: alice,
            to: bob,
            props: { since: "2020" },
            validTo: WINDOW_END,
          },
        ]);
        const updatesBefore = edgeUpdates();

        await store.edges.knows.bulkUpsertById([
          {
            id: knowsId("bw-edge-move"),
            from: alice,
            to: bob,
            props: { since: "2020" },
            validTo: LATER_WINDOW_END,
          },
        ]);

        expect(edgeUpdates()).toBe(updatesBefore + 1);
        const after = await store.edges.knows.getById(knowsId("bw-edge-move"));
        expect(canonicalizeDatabaseTimestamp(after?.meta.validTo)).toBe(
          LATER_WINDOW_END,
        );
      });

      it("refuses an unrepresentable bound from a bulk item with the single path's own error", async () => {
        const store = await createCoalesceStore(context);
        await seedWindowedPerson(store, "bw-unrepresentable");

        // An unparseable bound has no instant, and neither has an absent one, so
        // canonicalizing both sides would report "no change" and coalesce the
        // write — swallowing the error the caller is owed. The rule that keeps
        // that from happening lives in the shared comparison, so the bulk path
        // must now raise exactly what the single path raises for the same item.
        const item = {
          props: { name: "Win", age: 1 },
          validTo: "not-a-date",
        } as const;
        // A resolved value is not a ValidationError, so a path that fails to
        // reject fails the assertion below just as loudly as a wrong error would.
        const singleError: unknown = await store.nodes.Person.upsertById(
          "bw-unrepresentable",
          item.props,
          {
            validTo: item.validTo,
          },
        ).catch((error: unknown) => error);
        const bulkError: unknown = await store.nodes.Person.bulkUpsertById([
          { id: "bw-unrepresentable", ...item },
        ]).catch((error: unknown) => error);

        expect(singleError).toBeInstanceOf(ValidationError);
        expect(bulkError).toBeInstanceOf(ValidationError);
        expect((bulkError as Error).message).toBe(
          (singleError as Error).message,
        );
      });

      it("refuses an unrepresentable bound from a bulk EDGE item", async () => {
        const store = await createCoalesceStore(context);
        const [alice, bob] = await seedEndpoints(store, "bw-edge-bad");
        await store.edges.knows.bulkUpsertById([
          {
            id: knowsId("bw-edge-bad"),
            from: alice,
            to: bob,
            props: { since: "2020" },
          },
        ]);

        await expect(
          store.edges.knows.bulkUpsertById([
            {
              id: knowsId("bw-edge-bad"),
              from: alice,
              to: bob,
              props: { since: "2020" },
              validTo: "not-a-date",
            },
          ]),
        ).rejects.toThrow(/validTo/);
      });

      it("compares a repeated node id against the window the batch QUEUED, not the prefetched one", async () => {
        const store = await createCoalesceStore(context);
        const seeded = await seedWindowedPerson(store, "bw-node-queued");

        // Item 1 moves the end; item 2 re-states the end the row held BEFORE the
        // batch. Against the queued window that is a change, so it writes — and
        // it must, or the batch would end at item 1's window while the same items
        // applied one at a time end at item 2's.
        await store.nodes.Person.bulkUpsertById([
          {
            id: "bw-node-queued",
            props: { name: "Win", age: 1 },
            validTo: LATER_WINDOW_END,
          },
          {
            id: "bw-node-queued",
            props: { name: "Win", age: 1 },
            validTo: WINDOW_END,
          },
        ]);

        const batched = await store.nodes.Person.getById(
          personId("bw-node-queued"),
        );
        expect(batched?.meta.version).toBe(seeded.version + 2);
        expect(canonicalizeDatabaseTimestamp(batched?.meta.validTo)).toBe(
          WINDOW_END,
        );

        // Sequential-equivalence oracle: the same items, one at a time.
        const sequentialSeed = await seedWindowedPerson(store, "bw-node-seq");
        await store.nodes.Person.upsertById(
          "bw-node-seq",
          { name: "Win", age: 1 },
          { validTo: LATER_WINDOW_END },
        );
        await store.nodes.Person.upsertById(
          "bw-node-seq",
          { name: "Win", age: 1 },
          { validTo: WINDOW_END },
        );
        const sequential = await store.nodes.Person.getById(
          personId("bw-node-seq"),
        );
        expect(sequential?.meta.version).toBe(sequentialSeed.version + 2);
        expect(canonicalizeDatabaseTimestamp(sequential?.meta.validTo)).toBe(
          canonicalizeDatabaseTimestamp(batched?.meta.validTo),
        );
      });

      it("coalesces a repeated node id that re-states the window the batch QUEUED", async () => {
        const store = await createCoalesceStore(context);
        const seeded = await seedWindowedPerson(store, "bw-node-restate");

        // Item 1 moves the end, item 2 re-states item 1's window: one write.
        await store.nodes.Person.bulkUpsertById([
          {
            id: "bw-node-restate",
            props: { name: "Win", age: 1 },
            validTo: LATER_WINDOW_END,
          },
          {
            id: "bw-node-restate",
            props: { name: "Win", age: 1 },
            validTo: LATER_WINDOW_END,
          },
        ]);

        const after = await store.nodes.Person.getById(
          personId("bw-node-restate"),
        );
        expect(after?.meta.version).toBe(seeded.version + 1);
        expect(canonicalizeDatabaseTimestamp(after?.meta.validTo)).toBe(
          LATER_WINDOW_END,
        );
      });

      it("compares a repeated EDGE id against the window the batch QUEUED", async () => {
        const { store, edgeUpdates } = await createCountingStore(
          context.getStore().backend,
        );
        const [alice, bob] = await seedEndpoints(store, "bw-edge-queued");
        const base = {
          from: alice,
          to: bob,
          props: { since: "2020" },
        } as const;

        await store.edges.knows.bulkUpsertById([
          { id: knowsId("bw-edge-queued"), ...base, validTo: WINDOW_END },
        ]);
        const updatesBefore = edgeUpdates();

        await store.edges.knows.bulkUpsertById([
          { id: knowsId("bw-edge-queued"), ...base, validTo: LATER_WINDOW_END },
          { id: knowsId("bw-edge-queued"), ...base, validTo: WINDOW_END },
        ]);

        // Pre-fix the second item compared against the PREFETCHED row, whose end
        // was still WINDOW_END, called it unchanged and coalesced — leaving the
        // edge at item 1's end and silently diverging from the sequential result.
        expect(edgeUpdates()).toBe(updatesBefore + 2);
        const batched = await store.edges.knows.getById(
          knowsId("bw-edge-queued"),
        );
        expect(canonicalizeDatabaseTimestamp(batched?.meta.validTo)).toBe(
          WINDOW_END,
        );

        // Sequential-equivalence oracle: the same items as two batches of one.
        await store.edges.knows.bulkUpsertById([
          { id: knowsId("bw-edge-seq"), ...base, validTo: WINDOW_END },
        ]);
        await store.edges.knows.bulkUpsertById([
          { id: knowsId("bw-edge-seq"), ...base, validTo: LATER_WINDOW_END },
        ]);
        await store.edges.knows.bulkUpsertById([
          { id: knowsId("bw-edge-seq"), ...base, validTo: WINDOW_END },
        ]);
        const sequential = await store.edges.knows.getById(
          knowsId("bw-edge-seq"),
        );
        expect(canonicalizeDatabaseTimestamp(sequential?.meta.validTo)).toBe(
          canonicalizeDatabaseTimestamp(batched?.meta.validTo),
        );
      });

      it("coalesces a repeated NEW id whose later copy re-states the queued CREATE's window", async () => {
        const store = await createCoalesceStore(context);

        // The create names both bounds, so the queued window is fully known and a
        // copy re-stating it changes nothing: one create, no update.
        const results = await store.nodes.Person.bulkUpsertById([
          {
            id: "bw-new-restate",
            props: { name: "Win", age: 1 },
            validFrom: WINDOW_START,
            validTo: WINDOW_END,
          },
          {
            id: "bw-new-restate",
            props: { name: "Win", age: 1 },
            validFrom: WINDOW_START,
            validTo: WINDOW_END,
          },
        ]);

        expect(results[1]).toBe(results[0]);
        expect(results[0]?.meta.version).toBe(1);
        const after = await store.nodes.Person.getById(
          personId("bw-new-restate"),
        );
        expect(after?.meta.version).toBe(1);
        expect(canonicalizeDatabaseTimestamp(after?.meta.validFrom)).toBe(
          WINDOW_START,
        );
      });

      it("writes for a repeated NEW id whose later copy names a lower bound the create left implicit", async () => {
        const store = await createCoalesceStore(context);

        const results = await store.nodes.Person.bulkUpsertById([
          { id: "bw-new-implicit", props: { name: "Win", age: 1 } },
          {
            id: "bw-new-implicit",
            props: { name: "Win", age: 1 },
            validTo: WINDOW_END,
          },
        ]);

        // The create left `validFrom` to the backend's write instant, which the
        // batch cannot know, so a later bound is compared against an unknown and
        // counts as a change. Deliberately conservative: the bulk path may spend a
        // write the sequential path skips, never skip one it makes.
        expect(results[1]).not.toBe(results[0]);
        expect(results[1]?.meta.version).toBe(2);
        const after = await store.nodes.Person.getById(
          personId("bw-new-implicit"),
        );
        expect(canonicalizeDatabaseTimestamp(after?.meta.validTo)).toBe(
          WINDOW_END,
        );
      });
    });
  });
}
