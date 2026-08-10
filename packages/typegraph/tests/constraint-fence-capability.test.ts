/**
 * A declared constraint is enforced or REFUSED — never accepted and dropped.
 *
 * Constrained writes take the per-graph write fence so a probe and the write it
 * authorizes commit under one mutual exclusion (see
 * {@link file://../src/store/constraints.ts}). Both halves of that fence are
 * TRANSACTION-SCOPED constructs — SQLite's `BEGIN IMMEDIATE`, PostgreSQL's
 * `pg_advisory_xact_lock` — so a backend that reports `transactions: false`
 * (Cloudflare D1, `drizzle-orm/neon-http`, any `transactionMode: "none"` SQLite
 * driver) can supply neither.
 *
 * The tempting shape is to let those writes through unfenced and say so in the
 * docs. That is the accepted-and-ignored failure: the caller declared
 * `cardinality: "one"`, the store said yes, and the store then enforces it only
 * when nothing races — which is exactly the state #428 and #436 recorded as
 * defects on PostgreSQL. So the write is refused with a typed capability error
 * naming BOTH the missing capability and the constraint class that needed it.
 *
 * The other half is just as load-bearing: an UNCONSTRAINED write asserts
 * nothing the engine has to serialize, so it keeps working on those backends
 * exactly as before. A fix that refused those would be a capability regression
 * dressed up as correctness.
 *
 * The backend here is a genuine `transactionMode: "none"` SQLite backend rather
 * than a capability-flag override, so the closure-scoped mode inside the backend
 * observes "none" — the production code path for D1 / Durable Objects (same
 * construction as `no-transactions-fallthrough.test.ts`).
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  disjointWith,
  type GraphBackend,
  subClassOf,
} from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import {
  FORMAT_VERSION,
  importGraph,
  type ImportOptions,
} from "../src/interchange";
import { matchingObject } from "./test-utils";

const FENCE_CODE = "CONSTRAINT_WRITE_FENCE_UNSUPPORTED";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
/**
 * A disjoint PAIR of their own, deliberately not `Person`: the edge endpoints
 * must stay UNCONSTRAINED so the control cases can seed them on this backend.
 */
const Ghost = defineNode("Ghost", {
  schema: z.object({ name: z.string() }),
});
const Spirit = defineNode("Spirit", {
  schema: z.object({ name: z.string() }),
});

const Worker = defineNode("Worker", {
  schema: z.object({ name: z.string(), email: z.string() }),
});
const Employee = defineNode("Employee", {
  schema: z.object({ name: z.string(), email: z.string() }),
});
const Contractor = defineNode("Contractor", {
  schema: z.object({ name: z.string(), email: z.string() }),
});

/** No shared scope, no disjointness: backed by the uniques PK, so unfenced. */
const Account = defineNode("Account", {
  schema: z.object({ email: z.string() }),
});

const knows = defineEdge("knows", { schema: z.object({}) });
const reportsTo = defineEdge("reportsTo", { schema: z.object({}) });

const SHARED_SCOPE_UNIQUE = {
  name: "staff_email",
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const graph = defineGraph({
  id: "constraint_fence_capability",
  nodes: {
    Person: { type: Person },
    Ghost: { type: Ghost },
    Spirit: { type: Spirit },
    Worker: { type: Worker, unique: [SHARED_SCOPE_UNIQUE] },
    Employee: { type: Employee, unique: [SHARED_SCOPE_UNIQUE] },
    Contractor: { type: Contractor, unique: [SHARED_SCOPE_UNIQUE] },
    Account: {
      type: Account,
      unique: [
        {
          name: "own_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
    reportsTo: {
      type: reportsTo,
      from: [Person],
      to: [Person],
      cardinality: "one",
    },
  },
  ontology: [
    subClassOf(Employee, Worker),
    subClassOf(Contractor, Worker),
    disjointWith(Ghost, Spirit),
  ],
});

/** A graph declaring nothing: no unique, no disjointness, no cardinality. */
const Drifter = defineNode("Drifter", {
  schema: z.object({ name: z.string() }),
});
const wanders = defineEdge("wanders", { schema: z.object({}) });

const unconstrainedGraph = defineGraph({
  id: "constraint_fence_capability_unconstrained",
  nodes: { Drifter: { type: Drifter } },
  edges: { wanders: { type: wanders, from: [Drifter], to: [Drifter] } },
});

/**
 * A graph whose ONLY declared hazard is disjointness: no unique constraint on
 * either kind, and no edge at all. `graphOwesClaims` folds `nodeClaimSites`
 * (uniqueness) and `edgeWriteNeedsConstraintFence`; a disjoint pair owes
 * neither, because `nodeClaimEntries` writes no disjointness reservation yet
 * (that arm lands later, alongside import's per-row disjointness probe). This
 * graph is what isolates that from the graph fixture above, which cannot
 * distinguish the two hazards because `Worker`'s shared-scope uniqueness would
 * trip the same refusal on its own.
 */
const Wraith = defineNode("Wraith", { schema: z.object({ name: z.string() }) });
const Phantom = defineNode("Phantom", {
  schema: z.object({ name: z.string() }),
});

const disjointOnlyGraph = defineGraph({
  id: "constraint_fence_capability_disjoint_only",
  nodes: { Wraith: { type: Wraith }, Phantom: { type: Phantom } },
  edges: {},
  ontology: [disjointWith(Wraith, Phantom)],
});

const IMPORT_OPTIONS: ImportOptions = {
  onConflict: "error",
  refreshStatistics: false,
};

/** Asserts the typed refusal, including WHICH constraint class needed a fence. */
function expectFenceRefusal(constraint: string): unknown {
  return expect.objectContaining({
    name: "ConfigurationError",
    details: matchingObject({ code: FENCE_CODE, constraint }),
  });
}

describe("constrained writes on a backend that cannot fence them", () => {
  let sqlite: Database.Database;
  let backend: GraphBackend;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    for (const statement of generateSqliteDDL()) sqlite.exec(statement);
    backend = createSqliteBackend(db, {
      executionProfile: { transactionMode: "none", isSync: true },
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  /** Every live claim row's owner, read past the store so nothing is inferred. */
  function liveClaimOwners(): readonly unknown[] {
    return sqlite
      .prepare(
        "SELECT concrete_kind, node_id FROM typegraph_node_uniques WHERE deleted_at IS NULL ORDER BY node_id",
      )
      .all();
  }

  it("refuses an edge create whose cardinality it cannot enforce", async () => {
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    await expect(store.edges.reportsTo.create(alice, bob, {})).rejects.toThrow(
      expectFenceRefusal("edgeCardinality"),
    );
  });

  it("refuses a node create whose disjointness it cannot enforce", async () => {
    const store = createStore(graph, backend);

    await expect(
      store.nodes.Spirit.create({ name: "Casper" }, { id: "shared-id" }),
    ).rejects.toThrow(expectFenceRefusal("nodeDisjointness"));
  });

  it("refuses a node create whose shared uniqueness scope it cannot enforce", async () => {
    const store = createStore(graph, backend);

    await expect(
      store.nodes.Employee.create({ name: "E", email: "e@example.com" }),
    ).rejects.toThrow(expectFenceRefusal("nodeUniquenessScope"));
  });

  it("refuses a shared-scope node UPDATE too", async () => {
    // The scope probe runs on update as well as create, so refusing only the
    // create would leave the same hole open one API call later.
    const store = createStore(graph, backend);

    await expect(
      store.nodes.Employee.update("whoever" as never, {
        email: "e2@example.com",
      }),
    ).rejects.toThrow(expectFenceRefusal("nodeUniquenessScope"));
  });

  it("refuses an UPDATE whose own-kind claim precedes the row it gates", async () => {
    // T2, the other half of the pair T4 opens. Same kind, same backend, same
    // single `scope: "kind"` constraint — and the opposite verdict, decided
    // only by the claim's PLACEMENT. A transition claims the new key BEFORE the
    // gated row write for every scope (that is the only sequence in which a
    // refused write leaves zero net effect), so an update reserves a row with
    // nothing to undo it here: no transaction, no rollback, and no repair path
    // for a reservation that outlives a write that never landed. The reason is
    // `nodeUniquenessClaim` rather than `nodeUniquenessScope` because the scope
    // is not the problem — the reservation row is.
    const store = createStore(graph, backend);
    // The create is accepted (T4), which is what makes this update reachable.
    const account = await store.nodes.Account.create({
      email: "t2-before@example.com",
    });

    await expect(
      store.nodes.Account.update(account.id, { email: "t2-after@example.com" }),
    ).rejects.toThrow(expectFenceRefusal("nodeUniquenessClaim"));

    // Refused BEFORE its first claim statement: the new key holds no
    // reservation, and the old one is untouched.
    expect(liveClaimOwners()).toEqual([
      { concrete_kind: "Account", node_id: account.id },
    ]);
    expect(
      sqlite
        .prepare(
          "SELECT count(*) AS total FROM typegraph_node_uniques WHERE key LIKE '%t2-after%'",
        )
        .get(),
    ).toEqual({ total: 0 });
  });

  it("refuses an import into a graph whose kinds owe a claim before their row", async () => {
    // T1. An import writes claims like every other writer, but it takes no
    // per-graph lock and declares no `fencesConstraintProbe`, so nothing else
    // in the stack would refuse it — it would write reservations with no
    // transaction to undo them. The refusal is up front, before chunk 1, so a
    // streamed import cannot commit k-1 chunks and then fail.
    const store = createStore(graph, backend);

    await expect(
      importGraph(
        store,
        {
          formatVersion: FORMAT_VERSION,
          exportedAt: new Date().toISOString(),
          source: { type: "external", description: "fence capability" },
          nodes: [
            { kind: "Person", id: "t1-person", properties: { name: "P" } },
          ],
          edges: [],
        },
        IMPORT_OPTIONS,
      ),
    ).rejects.toThrow(expectFenceRefusal("nodeUniquenessScope"));

    // Nothing was written: not the unconstrained row it led with, not a claim.
    expect(
      sqlite.prepare("SELECT count(*) AS total FROM typegraph_nodes").get(),
    ).toEqual({ total: 0 });
    expect(liveClaimOwners()).toEqual([]);
  });

  it("imports into a graph whose only hazard is a disjoint partner, which owes no claim yet", async () => {
    // The counterpart to T1: `graphOwesClaims` folds `nodeClaimSites`
    // (uniqueness) and `edgeWriteNeedsConstraintFence` — it never consults
    // `registry.getDisjointKinds`, because no claim precedes a disjoint
    // create's row yet (`nodeClaimEntries` writes no disjointness reservation
    // yet). `disjointOnlyGraph` has no unique constraint and no edge at all,
    // so it isolates that from `graph`, whose `Worker` shared-scope uniqueness
    // would refuse the import on its own and mask this case. The store's OWN
    // create refuses a disjoint pair on this backend
    // ("refuses a node create whose disjointness it cannot enforce", above) —
    // it is only import's up-front graph-level fold that does not, and this
    // pins that scope so the doc comment on `importGraph` cannot drift from it
    // unnoticed.
    const store = createStore(disjointOnlyGraph, backend);
    for (const statement of generateSqliteDDL()) {
      try {
        sqlite.exec(statement);
      } catch {
        // The tables already exist from the shared fixture; the graph id is
        // what separates the two graphs' rows.
      }
    }

    const imported = await importGraph(
      store,
      {
        formatVersion: FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        source: { type: "external", description: "fence capability" },
        nodes: [
          {
            kind: "Wraith",
            id: "disjoint-only-wraith",
            properties: { name: "W" },
          },
        ],
        edges: [],
      },
      IMPORT_OPTIONS,
    );
    expect(imported.nodes.created).toBe(1);
  });

  it("refuses getOrCreateByEndpoints, whose convergence no key backs", async () => {
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    await expect(
      store.edges.knows.getOrCreateByEndpoints(alice, bob, {}),
    ).rejects.toThrow(expectFenceRefusal("edgeMatchKeyConvergence"));
  });

  it("refuses the bulk getOrCreateByEndpoints path on the same grounds", async () => {
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    await expect(
      store.edges.knows.bulkGetOrCreateByEndpoints([
        { from: alice, to: bob, props: {} },
      ]),
    ).rejects.toThrow(expectFenceRefusal("edgeMatchKeyConvergence"));
  });

  it("refuses a constrained edge BATCH create", async () => {
    // One transaction, so one constrained member makes the whole batch
    // constrained — and there is no transaction here to make it one.
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    await expect(
      store.edges.reportsTo.bulkCreate([{ from: alice, to: bob, props: {} }]),
    ).rejects.toThrow(expectFenceRefusal("edgeCardinality"));
  });

  /** Seeds a tombstoned edge without going through a refused write path. */
  async function seedTombstonedEdge(
    kind: string,
    id: string,
    fromId: string,
    toId: string,
  ): Promise<void> {
    await backend.insertEdge({
      graphId: graph.id,
      id,
      kind,
      fromKind: "Person",
      fromId,
      toKind: "Person",
      toId,
      props: {},
    });
    await backend.deleteEdge({ graphId: graph.id, id, kind });
  }

  it("refuses the RESURRECT leg on its own cardinality grounds", async () => {
    // Reviving a tombstone re-admits the edge to the population cardinality
    // constrains, so the resurrect leg is a constrained write in its own right —
    // and it reports `edgeCardinality`, not the convergence reason, because it
    // is the cardinality re-check that cannot be fenced here. A fix that only
    // covered the create leg would leave this one accepted and unenforced.
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create(
      { name: "Alice" },
      { id: "res-alice" },
    );
    const bob = await store.nodes.Person.create(
      { name: "Bob" },
      { id: "res-bob" },
    );
    await seedTombstonedEdge("reportsTo", "res-edge", alice.id, bob.id);

    await expect(
      store.edges.reportsTo.getOrCreateByEndpoints(alice, bob, {}),
    ).rejects.toThrow(expectFenceRefusal("edgeCardinality"));
  });

  describe("unconstrained writes on the same backend keep working", () => {
    it("resurrects a cardinality-many edge, which is an id-keyed UPDATE", async () => {
      // The precision check on the previous case: a `many` resurrection
      // re-derives no cardinality verdict, and the UPDATE it performs is keyed
      // by the edges primary key — nothing here needs serializing, so nothing
      // is refused.
      const store = createStore(graph, backend);
      const alice = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "rez-alice" },
      );
      const bob = await store.nodes.Person.create(
        { name: "Bob" },
        { id: "rez-bob" },
      );
      await seedTombstonedEdge("knows", "rez-edge", alice.id, bob.id);

      const result = await store.edges.knows.getOrCreateByEndpoints(
        alice,
        bob,
        {},
      );
      expect(result.action).toBe("resurrected");
      expect(result.edge.id).toBe("rez-edge");
    });

    it("creates a node with no disjointness and no shared-scope unique", async () => {
      const store = createStore(graph, backend);
      const created = await store.nodes.Person.create({ name: "P" });
      expect(created.name).toBe("P");
    });

    it("creates a node whose unique is scoped to its own kind", async () => {
      // T4, the guard against OVER-refusing. Two reasons this create is
      // accepted, and the second is the one that keeps it accepted now that
      // claims can precede their rows: the uniques primary key IS the fence for
      // a `kind` scope, so nothing here depends on serialization; and that
      // claim's PLACEMENT is post-insert, so this write opens no window in
      // which a live reservation could outlive a row that never landed. The
      // refusal is keyed on the pre-insert group precisely so this case stays
      // green — its sibling below (the same kind's UPDATE, whose claim precedes
      // its row) is refused, and only the placement separates them.
      const store = createStore(graph, backend);
      const created = await store.nodes.Account.create({
        email: "own@example.com",
      });
      expect(created.email).toBe("own@example.com");

      // The reservation landed: the create was fenced by its own key, not
      // silently unfenced.
      expect(liveClaimOwners()).toEqual([
        { concrete_kind: "Account", node_id: created.id },
      ]);
    });

    it("creates into, and imports into, a graph that owes no claim at all", async () => {
      // T3, the guard that the refusal is about what a write OWES and not about
      // the operation. Nothing in this graph declares a unique constraint, a
      // disjoint partner or a non-`many` cardinality, so no claim precedes any
      // row and both the store write and the import keep working — which is
      // what "unconstrained writes are untouched" has to mean for import too.
      const store = createStore(unconstrainedGraph, backend);
      for (const statement of generateSqliteDDL()) {
        try {
          sqlite.exec(statement);
        } catch {
          // The tables already exist from the shared fixture; the graph id is
          // what separates the two graphs' rows.
        }
      }

      const created = await store.nodes.Drifter.create({ name: "D" });
      expect(created.name).toBe("D");

      const imported = await importGraph(
        store,
        {
          formatVersion: FORMAT_VERSION,
          exportedAt: new Date().toISOString(),
          source: { type: "external", description: "fence capability" },
          nodes: [
            { kind: "Drifter", id: "t3-drifter", properties: { name: "T" } },
          ],
          edges: [],
        },
        IMPORT_OPTIONS,
      );
      expect(imported.nodes.created).toBe(1);
    });

    it("creates, updates and deletes a cardinality-many edge", async () => {
      const store = createStore(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      const edge = await store.edges.knows.create(alice, bob, {});
      expect(edge.id).toBeDefined();
      await store.edges.knows.delete(edge.id);
      expect(await store.edges.knows.getById(edge.id)).toBeUndefined();
    });

    it("deletes a node whose kind participates in a disjointness axiom", async () => {
      // Disjointness is probed only where a node comes into existence. A DELETE
      // re-derives no cross-kind verdict, so it must not be caught by the
      // refusal — over-refusing is as much a defect as under-fencing. The row is
      // seeded through the backend directly because the CREATE is (correctly)
      // refused on this backend.
      const store = createStore(graph, backend);
      await backend.insertNode({
        graphId: graph.id,
        kind: "Ghost",
        id: "deletable",
        props: { name: "Boo" },
      });

      await store.nodes.Ghost.delete("deletable" as never);
      expect(
        await store.nodes.Ghost.getById("deletable" as never),
      ).toBeUndefined();
    });
  });

  it("names the missing capability and a way forward", async () => {
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    const error = await store.edges.reportsTo
      .create(alice, bob, {})
      .catch((error_: unknown) => error_);

    // The refusal has to be actionable: which capability is missing, and what
    // the caller can change if they cannot supply it.
    expect(String(error)).toContain("no transactions");
    const suggestion = (error as { suggestion?: string }).suggestion ?? "";
    expect(suggestion).toContain("transactional backend");
    expect(suggestion).toContain('cardinality: "many"');
  });
});

describe("a transactional backend fences the same writes instead", () => {
  it("accepts every constrained write once transactions exist", async () => {
    // The control: same graph, same operations, a backend that CAN hold the
    // fence. Proves the refusal is about the capability, not about the graph.
    const sqlite = new Database(":memory:");
    try {
      const db = drizzle(sqlite);
      for (const statement of generateSqliteDDL()) sqlite.exec(statement);
      const store = createStore(graph, createSqliteBackend(db));

      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      await store.edges.reportsTo.create(alice, bob, {});
      await store.nodes.Employee.create({ name: "E", email: "e@example.com" });
      await store.nodes.Spirit.create({ name: "Casper" }, { id: "spirit-id" });
      const converged = await store.edges.knows.getOrCreateByEndpoints(
        alice,
        bob,
        {},
      );
      expect(converged.action).toBe("created");
    } finally {
      sqlite.close();
    }
  });
});
