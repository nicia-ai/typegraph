/**
 * A STORE update asserts every component its verdict read — the same rule the
 * interchange import legs follow (see `interchange-update-verdict-fence.test.
 * ts`), one layer out.
 *
 * `store.nodes.X.update` / `store.edges.X.update` probe the row, validate the
 * caller's validity window against that row's `valid_from`
 * (`assertWritableValidityWindow`), and then write. Those are two statements,
 * and under PostgreSQL READ COMMITTED a concurrent hard-delete + recreate
 * re-resolves the key between them — so a window judged against one bound could
 * be applied to a row carrying another, persisting `valid_to < valid_from` or
 * silently dropping a stated `validFrom`.
 *
 * Two halves, and both are load-bearing:
 *
 *  - the fence itself: the bound the verdict read is carried into the UPDATE's
 *    own `WHERE`, so the racing write matches nothing;
 *  - the scope of the fence: it is emitted ONLY when the verdict actually read
 *    the bound. A plain `update({ props })` names no window, reads no bound,
 *    and must stay unfenced — predicating it on a value the caller never
 *    claimed would refuse writes that are legitimate, which is the same mistake
 *    in the opposite direction.
 *
 * Both halves are one decision, made once: `assertWritableValidityWindow`
 * returns the `expectedValidFrom` predicate itself
 * (`ValidityWindowVerdict.storedLowerBoundFence`), and the store and import
 * legs spread what it hands them. Import previously spelled its own — always
 * asserting — and got the second half wrong for props-only documents.
 *
 * The race is reproduced deterministically with the round-8 lying-probe idiom:
 * the probe reports a `valid_from` the database does not hold, so the caller's
 * window passes a verdict computed against a bound that is not there.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { asNodeId, defineEdge, defineGraph, defineNode } from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { type GraphBackend, rowPropsToObject } from "../src/backend/types";
import { DatabaseOperationError, ValidationError } from "../src/errors";
import { buildKindRegistry } from "../src/registry";
import { createStore } from "../src/store";
import {
  applyNodeResurrect,
  createNodeWriteContext,
} from "../src/store/operations/node-write-pipeline";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), email: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ note: z.string() }),
});

const graph = defineGraph({
  id: "store_update_verdict_fence",
  nodes: {
    Person: {
      type: Person,
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
  edges: {
    knows: { type: knows, from: [Person], to: [Person], cardinality: "many" },
  },
});

const NODE_ID = "person-a";
const NODE_REF = asNodeId<typeof Person>(NODE_ID);
const OTHER_ID = "person-b";

/** Ordered and canonical; `LATE` is what the rows really carry. */
const EARLY_BOUND = "2020-01-01T00:00:00.000Z";
const MIDDLE_BOUND = "2021-01-01T00:00:00.000Z";
const FUTURE_BOUND = "2090-01-01T00:00:00.000Z";

/**
 * Makes the in-transaction node/edge probe report `spoofed` as the row's
 * `valid_from` — a deterministic stand-in for a concurrent hard-delete +
 * recreate landing between the probe and the write.
 *
 * `probes` bounds HOW MANY reads lie, and choosing it is the whole experiment:
 *
 *  - `1` is a single concurrent recreate. The first attempt is judged against a
 *    bound that is not there, its write matches nothing, and the convergence
 *    retry then sees the truth — so the outcome is whatever the caller's window
 *    really deserves against the real row.
 *  - `Infinity` is a peer that keeps replacing the row. Every attempt is judged
 *    against a lie, so the update exhausts its attempts and reports contention.
 *
 * Counted per method, so an edge experiment is not disturbed by the node reads
 * around it.
 */
function spoofProbedValidFrom(
  backend: GraphBackend,
  spoofed: string | undefined,
  probes = Number.POSITIVE_INFINITY,
): void {
  const runTransaction = backend.transaction;
  const remaining = { getNode: probes, getEdge: probes };
  const spoof = <T extends { valid_from: string | undefined }>(
    method: "getNode" | "getEdge",
    row: T,
  ): T => {
    if (remaining[method] <= 0) return row;
    remaining[method] -= 1;
    return { ...row, valid_from: spoofed };
  };
  vi.spyOn(backend, "transaction").mockImplementation((run, options) =>
    runTransaction(async (target) => {
      const readNode = target.getNode;
      const readEdge = target.getEdge;
      return run({
        ...target,
        getNode: async (graphId, kind, id) => {
          const row = await readNode(graphId, kind, id);
          return row === undefined ? row : spoof("getNode", row);
        },
        getEdge: async (graphId, id) => {
          const row = await readEdge(graphId, id);
          return row === undefined ? row : spoof("getEdge", row);
        },
      });
    }, options),
  );
}

/**
 * Makes the UNIQUES probe report a tombstone for a key whose node row is live —
 * the staleness the bulk `getOrCreateByConstraint` path used to take its
 * resurrect decision from. Wrapped at `transaction()` for the same reason as
 * {@link spoofProbedValidFrom}: the bulk path probes through the
 * transaction-scoped backend.
 */
function staleTombstone<T extends { deleted_at: string | undefined }>(
  row: T,
): T {
  return { ...row, deleted_at: "2020-01-01T00:00:00.000Z" };
}

function spoofProbedUniqueTombstone(backend: GraphBackend): void {
  const runTransaction = backend.transaction;
  vi.spyOn(backend, "transaction").mockImplementation((run, options) =>
    runTransaction(async (target) => {
      const readUnique = target.checkUnique;
      const readUniqueBatch = target.checkUniqueBatch;
      return run({
        ...target,
        checkUnique: async (params) => {
          const row = await readUnique(params);
          return row === undefined ? row : staleTombstone(row);
        },
        ...(readUniqueBatch === undefined ?
          {}
        : {
            checkUniqueBatch: async (params) => {
              const rows = await readUniqueBatch(params);
              return rows.map((row) => staleTombstone(row));
            },
          }),
      });
    }, options),
  );
}

describe("store update verdict fence", () => {
  const openDatabases: Database.Database[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const database of openDatabases.splice(0)) database.close();
  });

  function newStore(): Readonly<{
    backend: GraphBackend;
    store: ReturnType<typeof createStore<typeof graph>>;
  }> {
    const database = new Database(":memory:");
    openDatabases.push(database);
    for (const statement of generateSqliteDDL()) database.exec(statement);
    const backend = createSqliteBackend(drizzle(database));
    return { backend, store: createStore(graph, backend) };
  }

  async function seed(): Promise<
    Readonly<{
      backend: GraphBackend;
      store: ReturnType<typeof createStore<typeof graph>>;
      edgeId: Awaited<
        ReturnType<
          ReturnType<
            typeof createStore<typeof graph>
          >["edges"]["knows"]["create"]
        >
      >["id"];
      storedBound: string;
    }>
  > {
    const { backend, store } = newStore();
    await store.nodes.Person.create(
      { name: "Alice", email: "alice@example.com" },
      { id: NODE_ID },
    );
    await store.nodes.Person.create(
      { name: "Bob", email: "bob@example.com" },
      { id: OTHER_ID },
    );
    const edge = await store.edges.knows.create(
      { kind: "Person", id: NODE_ID },
      { kind: "Person", id: OTHER_ID },
      { note: "original" },
    );
    const row = await backend.getNode(graph.id, "Person", NODE_ID);
    const storedBound = row?.valid_from;
    if (storedBound === undefined) {
      throw new Error("The seeded node has no stored lower bound.");
    }
    return { backend, store, edgeId: edge.id, storedBound };
  }

  // eslint-disable-next-line unicorn/consistent-function-scoping -- reads this suite's fixed fixture id
  async function nodeRow(backend: GraphBackend) {
    const row = await backend.getNode(graph.id, "Person", NODE_ID);
    if (row === undefined) throw new Error("The node disappeared.");
    return row;
  }

  // eslint-disable-next-line unicorn/consistent-function-scoping -- reads this suite's graph id
  async function edgeRow(backend: GraphBackend, id: string) {
    const row = await backend.getEdge(graph.id, id);
    if (row === undefined) throw new Error("The edge disappeared.");
    return row;
  }

  // ==========================================================
  // The fence
  // ==========================================================

  it("refuses a NODE update whose bound moved between the probe and the write", async () => {
    const { backend, store, storedBound } = await seed();
    // The probe reports a bound EARLIER than the row holds, so `validTo` reads
    // as a valid end against it. Against the row's real bound it is a window of
    // negative width — exactly the write this fence exists to stop. Without the
    // fence that inverted window lands; with it, the statement matches nothing
    // and the retry re-judges against the truth and refuses.
    spoofProbedValidFrom(backend, EARLY_BOUND, 1);

    await expect(
      store.nodes.Person.update(NODE_REF, {}, { validTo: MIDDLE_BOUND }),
    ).rejects.toThrow(ValidationError);

    const row = await nodeRow(backend);
    expect(row.valid_from).toBe(storedBound);
    expect(row.valid_to).toBeUndefined();
  });

  it("refuses an EDGE update whose bound moved between the probe and the write", async () => {
    const { backend, store, edgeId } = await seed();
    const before = await edgeRow(backend, edgeId);
    spoofProbedValidFrom(backend, EARLY_BOUND, 1);

    await expect(
      store.edges.knows.update(edgeId, {}, { validTo: MIDDLE_BOUND }),
    ).rejects.toThrow(ValidationError);

    const after = await edgeRow(backend, edgeId);
    expect(after.valid_from).toBe(before.valid_from);
    expect(after.valid_to).toBeUndefined();
  });

  it("refuses a stated validFrom judged against a bound the row no longer has", async () => {
    // The OTHER verdict the row's bound feeds: a live row's lower bound is
    // immutable, so a stated `validFrom` is legal only when it RESTATES the
    // stored one. `update()` does not accept a lower bound at all — `upsertById`
    // is the surface that does — so this is where that branch is reachable.
    // Spoofing the probe makes the caller's restatement agree with a bound the
    // database does not hold.
    const { backend, store, storedBound } = await seed();
    spoofProbedValidFrom(backend, EARLY_BOUND, 1);

    await expect(
      store.nodes.Person.upsertById(
        NODE_REF,
        { name: "Alice", email: "alice@example.com" },
        { validFrom: EARLY_BOUND },
      ),
    ).rejects.toThrow(ValidationError);

    const afterUpsert = await nodeRow(backend);
    expect(afterUpsert.valid_from).toBe(storedBound);
  });

  it("reports contention when the row is replaced on every attempt", async () => {
    // A peer that keeps recreating the row: every attempt is judged against a
    // bound that is gone by the time its write runs. The update stops after its
    // bounded attempts and says so, rather than livelocking or reporting the
    // node as missing — it is right there.
    const { backend, store, storedBound } = await seed();
    spoofProbedValidFrom(backend, EARLY_BOUND);

    await expect(
      store.nodes.Person.update(NODE_REF, {}, { validTo: FUTURE_BOUND }),
    ).rejects.toThrow(/could not be applied to a stable row/);

    const row = await nodeRow(backend);
    expect(row.valid_from).toBe(storedBound);
    expect(row.valid_to).toBeUndefined();
  });

  // ==========================================================
  // The scope of the fence
  // ==========================================================

  it("does NOT fence an update that states no window", async () => {
    // The verdict never reads the row's bound here, so there is nothing to
    // assert — and asserting anyway would refuse a legitimate write. This is
    // the case that makes the fence conditional rather than blanket.
    const { backend, store, edgeId } = await seed();
    spoofProbedValidFrom(backend, EARLY_BOUND);

    const updated = await store.nodes.Person.update(NODE_REF, {
      name: "Alice Updated",
    });
    const updatedEdge = await store.edges.knows.update(edgeId, {
      note: "rewritten",
    });
    expect(updatedEdge.note).toBe("rewritten");

    expect(updated.name).toBe("Alice Updated");
    const afterUpdate = await nodeRow(backend);
    expect(rowPropsToObject(afterUpdate.props)["name"]).toBe("Alice Updated");
  });

  it("converges on the row that is really there when the window still fits", async () => {
    // The bound moved, but the caller's `validTo` is still above the bound the
    // row actually carries. Refusing would be a lie about a row sitting right
    // there, so the update re-reads, re-judges, and applies. The spoof is
    // switched off after the first probe, which is exactly what a single
    // concurrent recreate looks like.
    const { backend, store, storedBound } = await seed();
    spoofProbedValidFrom(backend, EARLY_BOUND, 1);

    const updated = await store.nodes.Person.update(
      NODE_REF,
      { name: "Converged" },
      { validTo: FUTURE_BOUND },
    );

    expect(updated.name).toBe("Converged");
    const row = await nodeRow(backend);
    expect(row.valid_from).toBe(storedBound);
    expect(row.valid_to).toBe(FUTURE_BOUND);
  });

  // ==========================================================
  // Sidecar atomicity
  // ==========================================================

  it("leaves NO uniqueness mutation behind when a node update matches zero rows", async () => {
    // Uniqueness, fulltext and embedding sync all run WITH a node update. The
    // primary write's rowcount gates them, so a refused update must not move
    // this node's email reservation: the old key stays held and the new one
    // stays free.
    const { backend, store } = await seed();
    spoofProbedValidFrom(backend, EARLY_BOUND, 1);

    await expect(
      store.nodes.Person.update(
        NODE_REF,
        { email: "moved@example.com" },
        { validTo: MIDDLE_BOUND },
      ),
    ).rejects.toThrow(ValidationError);
    vi.restoreAllMocks();

    // The OLD key is still reserved for this node.
    await expect(
      store.nodes.Person.create({ name: "Clone", email: "alice@example.com" }),
    ).rejects.toThrow(/unique/i);
    // The NEW key was never claimed.
    const created = await store.nodes.Person.create({
      name: "Mover",
      email: "moved@example.com",
    });
    expect(created.email).toBe("moved@example.com");
  });

  it("leaves NO uniqueness reservation behind when a RESURRECT matches zero rows", async () => {
    // `applyNodeResurrect` (the provenance reopen path) re-checks and
    // re-INSERTS the node's uniqueness entries, and its UPDATE carries
    // `deleted_at IS NOT NULL`. A peer that revived the tombstone first makes
    // that UPDATE match nothing — and the reservations must not already be in
    // the table, because the peer's revival is what owns them. Reserving before
    // the gate left this loser holding a key for a revival it never performed,
    // which then blocks every later create of that value.
    const { backend, store } = newStore();
    const created = await store.nodes.Person.create(
      { name: "Alice", email: "alice@example.com" },
      { id: NODE_ID },
    );
    await store.nodes.Person.delete(created.id);
    const tombstone = await backend.getNode(graph.id, "Person", NODE_ID);
    if (tombstone?.deleted_at === undefined) {
      throw new Error("The fixture needs a tombstoned row.");
    }

    // The peer: an UPDATE that matches nothing, exactly as the tombstone
    // predicate answers once someone else has revived the row.
    const losingBackend: GraphBackend = {
      ...backend,
      updateNode: () => {
        throw new DatabaseOperationError(
          "Update node failed: no row returned",
          {
            operation: "update",
            entity: "node",
            reason: "no_row_returned",
          },
        );
      },
    };

    await expect(
      applyNodeResurrect(
        createNodeWriteContext(graph.id, buildKindRegistry(graph), {} as never),
        {
          existing: tombstone as Parameters<
            typeof applyNodeResurrect
          >[1]["existing"],
          schema: Person.schema,
          uniqueConstraints: graph.nodes.Person.unique,
        },
        losingBackend,
      ),
    ).rejects.toThrow(DatabaseOperationError);

    // The key is still free: the losing resurrect reserved nothing.
    const reserved = await backend.checkUnique({
      graphId: graph.id,
      nodeKind: "Person",
      constraintName: "email",
      key: "alice@example.com",
    });
    expect(reserved).toBeUndefined();
  });

  // ==========================================================
  // One decision, one owner
  // ==========================================================

  it("reads `is this a resurrect` from the NODE row in the bulk constraint path", async () => {
    // The single-item `getOrCreateByConstraint` has always taken that decision
    // from the node row it is about to write; the bulk path took it from the
    // uniques row its batch probe captured earlier. Two owners for one decision,
    // and the uniques copy is the staler: the batch's own creates run between
    // the probe and the read, and a peer can revive the node in that window.
    //
    // Reproduced by making the uniques probe report a tombstone for a key whose
    // node row is live. The write must follow the ROW — an ordinary update — not
    // the uniques row's stale `deleted_at`, which would resurrect a node that
    // was never deleted and report it as such.
    const { backend, store } = newStore();
    await store.nodes.Person.create(
      { name: "Alice", email: "alice@example.com" },
      { id: NODE_ID },
    );

    spoofProbedUniqueTombstone(backend);

    const results = await store.nodes.Person.bulkGetOrCreateByConstraint(
      "email",
      [{ props: { name: "Alice Again", email: "alice@example.com" } }],
    );

    // The row is live, so there is nothing to resurrect and — without
    // `ifExists: "update"` — nothing to write: the honest answer is "found".
    // Taking the uniques row's word for it reported `resurrected` and ran a
    // `clearDeleted` write against a node that was never deleted.
    expect(results[0]?.action).toBe("found");
    const row = await nodeRow(backend);
    expect(row.deleted_at).toBeUndefined();
    expect(rowPropsToObject(row.props)["name"]).toBe("Alice");
    expect(row.version).toBe(1);
  });
});
