import { describe, expect, it } from "vitest";

import { asEdgeId, asNodeId, type EdgeId, type NodeId } from "../../../src";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { STORE_RUNTIME } from "../../../src/store/runtime-port";
import {
  type HistoryIntegrationStore,
  type IntegrationStore,
  integrationTestGraph,
} from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

/**
 * Repeated ids in one `bulkUpsertById` batch, for an id whose row does NOT
 * exist yet.
 *
 * The batch is contractually equivalent to the same items applied as sequential
 * `upsertById` calls: the first item creates, every later copy updates over the
 * value the earlier item wrote. The create branch used to skip registering its
 * id in the batch-local pending map, so a repeated new id queued two creates and
 * the batch threw "Node already exists" (issue #401).
 *
 * These cases run against every backend because they are query/write semantics,
 * not backend wiring. Both coalescing states are covered: the defect was in the
 * create/update bucketing, which runs with `coalesceUnchangedUpserts` off as
 * well.
 */
function personId(
  id: string,
): NodeId<typeof integrationTestGraph.nodes.Person.type> {
  return asNodeId(id);
}

function knowsId(
  id: string,
): EdgeId<typeof integrationTestGraph.edges.knows.type> {
  return asEdgeId(id);
}

type PersonShape = Readonly<{ name?: string; age?: number }>;

/** The row state the sequential-equivalence oracle compares. */
type ComparableNode = Readonly<{
  name: string | undefined;
  age: number | undefined;
  version: number;
  deletedAt: string | undefined;
  validTo: string | undefined;
}>;

async function readComparableNode(
  store: IntegrationStore | HistoryIntegrationStore,
  id: string,
): Promise<ComparableNode> {
  const node = await store.nodes.Person.getById(personId(id));
  if (node === undefined) {
    throw new Error(`expected Person "${id}" to exist`);
  }
  const shape = node as PersonShape;
  return {
    name: shape.name,
    age: shape.age,
    version: node.meta.version,
    deletedAt: node.meta.deletedAt,
    validTo: node.meta.validTo,
  };
}

type RecordedRow = Readonly<{ op: string; version: unknown; props: unknown }>;

/** One captured revision, reduced to the fields these cases assert. */
type RecordedRevision = Readonly<{
  op: string;
  version: number;
  props: unknown;
}>;

/**
 * The recorded revisions captured for a node id, oldest first. Capture is
 * per-transaction: every write a single transaction makes to one row collapses
 * into ONE revision holding that transaction's final state, so a repeated id is
 * one revision — not one per item.
 */
async function readRecordedRevisions(
  store: HistoryIntegrationStore,
  kind: string,
  id: string,
): Promise<RecordedRevision[]> {
  const backend = store[STORE_RUNTIME].backend;
  const table = createSqlSchema(backend.tableNames).recordedNodesTable;
  const rows = await backend.execute<RecordedRow>(
    asCompiledRowsSql(sql`
      SELECT op, version, props
      FROM ${table}
      WHERE graph_id = ${store.graphId}
        AND kind = ${kind}
        AND id = ${id}
      ORDER BY recorded_from ASC
    `),
  );
  return rows.map((row) => ({
    op: row.op,
    version: Number(row.version),
    props: parseRecordedProps(row.props),
  }));
}

/** SQLite stores props as JSON text; a Postgres driver returns parsed jsonb. */
function parseRecordedProps(props: unknown): unknown {
  return typeof props === "string" ? (JSON.parse(props) as unknown) : props;
}

export function registerBulkUpsertRepeatedIdIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("bulkUpsertById with repeated ids", () => {
    describe("with coalescing off (default)", () => {
      it("creates once then updates for a repeated NEW id, matching sequential upserts", async () => {
        const store = context.getStore();

        // Pre-fix this threw NodeAlreadyExistsError: both items queued a create.
        const results = await store.nodes.Person.bulkUpsertById([
          { id: "rep-new", props: { name: "A", age: 1 } },
          { id: "rep-new", props: { name: "B" } },
        ]);

        // Each position returns the row as of its own item.
        expect(results).toHaveLength(2);
        expect((results[0] as PersonShape).name).toBe("A");
        expect(results[0]?.meta.version).toBe(1);
        expect((results[1] as PersonShape).name).toBe("B");
        expect(results[1]?.meta.version).toBe(2);

        // The second copy is an update, so it MERGES over the queued create:
        // `age` survives because the second item omits it. A second create (or a
        // replace) would have dropped it.
        const batched = await readComparableNode(store, "rep-new");
        expect(batched).toEqual({
          name: "B",
          age: 1,
          version: 2,
          deletedAt: undefined,
          validTo: undefined,
        });

        // Sequential-equivalence oracle: the same items applied one at a time.
        await store.nodes.Person.upsertById("rep-seq", { name: "A", age: 1 });
        await store.nodes.Person.upsertById("rep-seq", { name: "B" });
        expect(batched).toEqual(await readComparableNode(store, "rep-seq"));
      });

      it("applies three copies of a new id in order", async () => {
        const store = context.getStore();

        const results = await store.nodes.Person.bulkUpsertById([
          { id: "rep3", props: { name: "A", age: 1 } },
          { id: "rep3", props: { name: "B", age: 2 } },
          { id: "rep3", props: { name: "C" } },
        ]);

        expect(results.map((node) => (node as PersonShape).name)).toEqual([
          "A",
          "B",
          "C",
        ]);

        const batched = await readComparableNode(store, "rep3");
        expect(batched).toEqual({
          name: "C",
          age: 2,
          version: 3,
          deletedAt: undefined,
          validTo: undefined,
        });

        await store.nodes.Person.upsertById("rep3-seq", { name: "A", age: 1 });
        await store.nodes.Person.upsertById("rep3-seq", { name: "B", age: 2 });
        await store.nodes.Person.upsertById("rep3-seq", { name: "C" });
        expect(batched).toEqual(await readComparableNode(store, "rep3-seq"));
      });

      it("mixes a repeated new id with an existing id in one batch, preserving order", async () => {
        const store = context.getStore();
        await store.nodes.Person.upsertById("mix-existing", {
          name: "Seed",
          age: 9,
        });

        const results = await store.nodes.Person.bulkUpsertById([
          { id: "mix-new", props: { name: "New1" } },
          { id: "mix-existing", props: { name: "Updated" } },
          { id: "mix-new", props: { name: "New2" } },
          { id: "mix-other", props: { name: "Other" } },
        ]);

        expect(results.map((node) => node.id)).toEqual([
          "mix-new",
          "mix-existing",
          "mix-new",
          "mix-other",
        ]);
        expect(results.map((node) => (node as PersonShape).name)).toEqual([
          "New1",
          "Updated",
          "New2",
          "Other",
        ]);

        expect(await readComparableNode(store, "mix-new")).toEqual({
          name: "New2",
          age: undefined,
          version: 2,
          deletedAt: undefined,
          validTo: undefined,
        });
        expect(await readComparableNode(store, "mix-existing")).toEqual({
          name: "Updated",
          age: 9,
          version: 2,
          deletedAt: undefined,
          validTo: undefined,
        });
        expect(await readComparableNode(store, "mix-other")).toEqual({
          name: "Other",
          age: undefined,
          version: 1,
          deletedAt: undefined,
          validTo: undefined,
        });
      });

      it("keeps the working path working for a repeated id whose row exists", async () => {
        const store = context.getStore();
        const seed = await store.nodes.Person.upsertById("rep-existing", {
          name: "Seed",
          age: 5,
        });
        expect(seed.meta.version).toBe(1);

        // Two updates over an existing row: the pre-fix path already handled
        // this, and it must stay unchanged.
        await store.nodes.Person.bulkUpsertById([
          { id: "rep-existing", props: { name: "B" } },
          { id: "rep-existing", props: { name: "A" } },
        ]);

        expect(await readComparableNode(store, "rep-existing")).toEqual({
          name: "A",
          age: 5,
          version: 3,
          deletedAt: undefined,
          validTo: undefined,
        });
      });

      it("carries a repeated new id's validTo through the later copy", async () => {
        const store = context.getStore();
        const validTo = "2099-01-01T00:00:00.000Z";

        await store.nodes.Person.bulkUpsertById([
          { id: "rep-window", props: { name: "A" } },
          { id: "rep-window", props: { name: "B" }, validTo },
        ]);

        const batched = await readComparableNode(store, "rep-window");
        expect(batched.validTo).toBe(validTo);

        // The lower bound comes from the CREATED row, not from the second item:
        // an update to a live row never rewrites validFrom, so the window stays
        // ordered exactly as the sequential pair produces it.
        await store.nodes.Person.upsertById("rep-window-seq", { name: "A" });
        await store.nodes.Person.upsertById(
          "rep-window-seq",
          { name: "B" },
          { validTo },
        );
        expect(batched).toEqual(
          await readComparableNode(store, "rep-window-seq"),
        );
      });

      it("creates once and updates for a repeated NEW edge id, last-write-wins", async () => {
        const store = context.getStore();
        const [alice, bob] = await store.nodes.Person.bulkCreate([
          { props: { name: "A" }, id: "rep-e-alice" },
          { props: { name: "B" }, id: "rep-e-bob" },
        ]);
        if (alice === undefined || bob === undefined) {
          throw new Error("expected both people to be created");
        }

        // Pre-fix this threw EdgeAlreadyExistsError.
        const results = await store.edges.knows.bulkUpsertById([
          { id: knowsId("rep-e"), from: alice, to: bob, props: { since: "A" } },
          { id: knowsId("rep-e"), from: alice, to: bob, props: { since: "B" } },
        ]);

        expect(
          results.map((edge) => (edge as { since?: string }).since),
        ).toEqual(["A", "B"]);

        const final = await store.edges.knows.getById(knowsId("rep-e"));
        expect((final as { since?: string }).since).toBe("B");
        // The create's endpoints stand: an update never repoints an edge.
        expect(final?.fromId).toBe("rep-e-alice");
        expect(final?.toId).toBe("rep-e-bob");

        // Sequential equivalence: the same items as two single-item batches.
        await store.edges.knows.bulkUpsertById([
          {
            id: knowsId("rep-e-seq"),
            from: alice,
            to: bob,
            props: { since: "A" },
          },
        ]);
        await store.edges.knows.bulkUpsertById([
          {
            id: knowsId("rep-e-seq"),
            from: alice,
            to: bob,
            props: { since: "B" },
          },
        ]);
        const sequential = await store.edges.knows.getById(
          knowsId("rep-e-seq"),
        );
        expect((sequential as { since?: string }).since).toBe("B");
      });
    });

    describe("with coalescing on", () => {
      it("creates once and coalesces a value-identical copy of a new id", async () => {
        const store = await context.createStore(integrationTestGraph, {
          coalesceUnchangedUpserts: true,
        });

        const results = await store.nodes.Person.bulkUpsertById([
          { id: "coal-new", props: { name: "A", age: 1 } },
          { id: "coal-new", props: { name: "A", age: 1 } },
        ]);

        // One create, no update: the second copy resolves to the create's
        // result — the same object — and the row stays at version 1.
        expect(results[1]).toBe(results[0]);
        expect(results[0]?.meta.version).toBe(1);
        expect(await readComparableNode(store, "coal-new")).toEqual({
          name: "A",
          age: 1,
          version: 1,
          deletedAt: undefined,
          validTo: undefined,
        });
      });

      it("coalesces only the copies that match the running value", async () => {
        const store = await context.createStore(integrationTestGraph, {
          coalesceUnchangedUpserts: true,
        });

        // create A, coalesce A, update B, coalesce B → one create, one update.
        const results = await store.nodes.Person.bulkUpsertById([
          { id: "coal-run", props: { name: "A" } },
          { id: "coal-run", props: { name: "A" } },
          { id: "coal-run", props: { name: "B" } },
          { id: "coal-run", props: { name: "B" } },
        ]);

        expect(results.map((node) => (node as PersonShape).name)).toEqual([
          "A",
          "A",
          "B",
          "B",
        ]);
        expect(results[1]).toBe(results[0]);
        expect(results[3]).toBe(results[2]);
        expect(await readComparableNode(store, "coal-run")).toEqual({
          name: "B",
          age: undefined,
          version: 2,
          deletedAt: undefined,
          validTo: undefined,
        });
      });

      it("coalesces a value-identical copy of a new edge id", async () => {
        const store = await context.createStore(integrationTestGraph, {
          coalesceUnchangedUpserts: true,
        });
        const [alice, bob] = await store.nodes.Person.bulkCreate([
          { props: { name: "A" }, id: "coal-e-alice" },
          { props: { name: "B" }, id: "coal-e-bob" },
        ]);
        if (alice === undefined || bob === undefined) {
          throw new Error("expected both people to be created");
        }

        const results = await store.edges.knows.bulkUpsertById([
          {
            id: knowsId("coal-e"),
            from: alice,
            to: bob,
            props: { since: "2020" },
          },
          {
            id: knowsId("coal-e"),
            from: alice,
            to: bob,
            props: { since: "2020" },
          },
        ]);

        // Edges carry no version counter; the coalesced copy resolving to the
        // create's own result object is the signal that no update ran.
        expect(results[1]).toBe(results[0]);
        const final = await store.edges.knows.getById(knowsId("coal-e"));
        expect((final as { since?: string }).since).toBe("2020");
        expect(final?.meta.updatedAt).toBe(results[0]?.meta.updatedAt);
      });
    });

    describe("with history capture", () => {
      it("records a repeated new id as one created revision holding the final state", async () => {
        const store = await context.createHistoryStore(integrationTestGraph);

        await store.nodes.Person.bulkUpsertById([
          { id: "hist-rep", props: { name: "A", age: 1 } },
          { id: "hist-rep", props: { name: "B" } },
        ]);

        // The batch runs in one transaction, and capture is per-transaction, so
        // the create and the update over it collapse into ONE revision: op
        // "create" (the row did not exist before this transaction) holding the
        // final merged state at the final version. Two creates — the defect's
        // shape — could not produce this: they threw before capture.
        expect(
          await readRecordedRevisions(store, "Person", "hist-rep"),
        ).toEqual([{ op: "create", version: 2, props: { name: "B", age: 1 } }]);

        // Same collapse for a repeated id whose row already existed: the two
        // updates in one transaction become one "update" revision. The new
        // create path plugs into that machinery unchanged.
        await store.nodes.Person.upsertById("hist-existing", { name: "S" });
        await store.nodes.Person.bulkUpsertById([
          { id: "hist-existing", props: { name: "B" } },
          { id: "hist-existing", props: { name: "A" } },
        ]);
        expect(
          await readRecordedRevisions(store, "Person", "hist-existing"),
        ).toEqual([
          { op: "create", version: 1, props: { name: "S" } },
          { op: "update", version: 3, props: { name: "A" } },
        ]);

        // The sequential oracle spans two transactions, so it captures two
        // revisions — same final state, one revision per transaction.
        await store.nodes.Person.upsertById("hist-seq", { name: "A", age: 1 });
        await store.nodes.Person.upsertById("hist-seq", { name: "B" });
        expect(
          await readRecordedRevisions(store, "Person", "hist-seq"),
        ).toEqual([
          { op: "create", version: 1, props: { name: "A", age: 1 } },
          { op: "update", version: 2, props: { name: "B", age: 1 } },
        ]);
      });
    });
  });
}
