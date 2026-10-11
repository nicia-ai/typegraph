/**
 * Who retries when the per-graph write fence refuses a stale snapshot.
 *
 * A write that makes a lock-only decision advances the graph's fence row, so
 * a session at a snapshot isolation whose snapshot predates another decider's
 * commit fails there with a serialization failure. What happens next depends
 * on who owns the transaction:
 *
 * - a write the STORE opened is replayed whole through `runRetriedUnit` — a
 *   new transaction is a new snapshot — within `OPTIMISTIC_RETRY_ATTEMPTS`;
 * - a write inside a transaction the CALLER owns is not: the caller's earlier
 *   reads are part of the unit, so the refusal propagates as a
 *   `TransactionConflictError` for the caller to re-run from the top;
 * - a serialized engine takes no keyed acquisition, so it is never a retried
 *   unit and pays nothing for one;
 * - a write that names no constraint decides nothing under the fence and never
 *   advances the fence row, so it is not a retried unit either.
 *
 * Two real connections cannot overlap in-process, so the refusal is injected
 * at the acquisition statement itself. `tests/backends/postgres/
 * mixed-isolation-fence.test.ts` drives the same decision with a genuine
 * stale snapshot on a server.
 *
 * MUTATION CHECK: answering `false` from `opensKeyedFenceTransaction` fails
 * the four store-owned cases (one transaction is opened and the conflict
 * propagates) — verified and reverted. Rethrowing the driver error unchanged
 * from `acquiringGraphWriteFence` fails the caller-owned case's in-callback
 * assertion — verified and reverted. Opening the bulk get-or-create's
 * transaction with `backend.transaction` directly fails its case — verified
 * and reverted. Dropping the `fenceReason !== undefined` term from
 * `ownsSnapshotFencedUnit` fails the unconstrained case — verified and
 * reverted.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
  TransactionConflictError,
} from "../src";
import { OPTIMISTIC_RETRY_ATTEMPTS } from "../src/backend/capabilities/retried-unit";
import { deriveBackend } from "../src/backend/derive-backend";
import { generateVectorlessPostgresMigrationSQL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import type { GraphBackend } from "../src/backend/types";
import { renderPostgres } from "../src/query/sql-fragment";
import { type CompiledRowsSql } from "../src/query/sql-intent";
import { createTestBackend } from "./test-utils";

const Task = defineNode("Task", { schema: z.object({ name: z.string() }) });
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });

const graph = defineGraph({
  id: "snapshot-fence-retry",
  nodes: { Task: { type: Task } },
  edges: {
    dependsOn: { type: dependsOn, from: [Task], to: [Task], acyclic: true },
  },
});

const Assembly = defineNode("Assembly", {
  schema: z.object({ name: z.string() }),
});
const Component = defineNode("Component", {
  schema: z.object({ slug: z.string() }),
});
const containedIn = defineEdge("containedIn", { schema: z.object({}) });

const compositionGraph = defineGraph({
  id: "snapshot-fence-retry-composition",
  nodes: {
    Assembly: { type: Assembly },
    Component: {
      type: Component,
      unique: [
        {
          name: "component_slug",
          fields: ["slug"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    containedIn: {
      type: containedIn,
      from: [Component],
      to: [Assembly],
      cardinality: "one",
    },
  },
  ontology: [
    partOf(Component, Assembly, { via: containedIn, partSide: "from" }),
  ],
});

const SERIALIZATION_FAILURE_SQL_STATE = "40001";

/** The shape a driver reports a stale-snapshot row update with. */
function serializationFailure(): Error {
  return Object.assign(
    new Error("could not serialize access due to concurrent update"),
    { code: SERIALIZATION_FAILURE_SQL_STATE },
  );
}

type Instrumented = Readonly<{
  backend: GraphBackend;
  transactionsOpened: () => number;
}>;

/**
 * Counts the transactions `backend` opens and fails the first `refusals`
 * statements `isRefused` selects, as a stale snapshot would.
 */
function refusing(
  backend: GraphBackend,
  refusals: number,
  isRefused: (query: CompiledRowsSql) => boolean,
): Instrumented {
  let opened = 0;
  let remaining = refusals;
  return {
    backend: deriveBackend(backend, {
      transaction: (run, options) => {
        opened += 1;
        return backend.transaction(
          (transaction) =>
            run(
              deriveBackend(transaction, {
                execute: <T>(query: CompiledRowsSql) => {
                  if (remaining > 0 && isRefused(query)) {
                    remaining -= 1;
                    return Promise.reject<readonly T[]>(serializationFailure());
                  }
                  return transaction.execute<T>(query);
                },
              }),
            ),
          options,
        );
      },
    }),
    transactionsOpened: () => opened,
  };
}

/** The statement text, for selecting which statement to refuse. */
function statementText(query: CompiledRowsSql): string {
  return renderPostgres(query).sql;
}

function isFenceAcquisition(query: CompiledRowsSql): boolean {
  return statementText(query).includes("pg_advisory_xact_lock");
}

describe("a stale-snapshot refusal at the per-graph write fence", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  async function postgresBackend(): Promise<GraphBackend> {
    client = await PGlite.create();
    await client.exec(generateVectorlessPostgresMigrationSQL());
    return createPostgresBackend(drizzlePglite(client), { vector: false });
  }

  it("replays a write the store owns, in a new transaction", async () => {
    const instrumented = refusing(
      await postgresBackend(),
      1,
      isFenceAcquisition,
    );
    const store = createStore(graph, instrumented.backend);
    const a = await store.nodes.Task.create({ name: "a" });
    const b = await store.nodes.Task.create({ name: "b" });
    const openedBefore = instrumented.transactionsOpened();

    await expect(store.edges.dependsOn.create(a, b)).resolves.toBeDefined();

    expect(instrumented.transactionsOpened() - openedBefore).toBe(2);
    expect(await store.edges.dependsOn.find({})).toHaveLength(1);
  });

  it("replays a bulk upsert whole: the collection opened its transaction, so the store owns it", async () => {
    const instrumented = refusing(
      await postgresBackend(),
      1,
      isFenceAcquisition,
    );
    const store = createStore(graph, instrumented.backend);
    const a = await store.nodes.Task.create({ name: "a" });
    const b = await store.nodes.Task.create({ name: "b" });
    const openedBefore = instrumented.transactionsOpened();

    await expect(
      store.edges.dependsOn.bulkUpsertById([
        { id: asEdgeId<typeof dependsOn>("a-to-b"), from: a, to: b, props: {} },
      ]),
    ).resolves.toHaveLength(1);

    expect(instrumented.transactionsOpened() - openedBefore).toBe(2);
    expect(await store.edges.dependsOn.find({})).toHaveLength(1);
  });

  it("replays a bulk get-or-create whose leg attaches a composition part: the collection opened its transaction", async () => {
    const backend = await postgresBackend();
    const whole = await createStore(
      compositionGraph,
      backend,
    ).nodes.Assembly.create({ name: "whole" });
    const instrumented = refusing(backend, 1, isFenceAcquisition);
    const store = createStore(compositionGraph, instrumented.backend);
    const openedBefore = instrumented.transactionsOpened();

    const results = await store.nodes.Component.bulkGetOrCreateByConstraint(
      "component_slug",
      [{ props: { slug: "bolt" } }],
      { partOf: { whole: { kind: "Assembly", id: whole.id } } },
    );

    expect(results.map((result) => result.action)).toEqual(["created"]);
    expect(instrumented.transactionsOpened() - openedBefore).toBe(2);
    expect(await store.edges.containedIn.find({})).toHaveLength(1);
  });

  it("takes one attempt for a write that names no constraint: it decides nothing under the fence", async () => {
    const instrumented = refusing(
      await postgresBackend(),
      1,
      isFenceAcquisition,
    );
    // The store captures revisions, so the write takes the fence — for its
    // clock, with no decision behind it and no fence-row write to be refused.
    const store = createStore(graph, instrumented.backend, {
      revisionTracking: true,
    });
    const openedBefore = instrumented.transactionsOpened();

    await expect(store.nodes.Task.create({ name: "a" })).rejects.toMatchObject({
      cause: { code: SERIALIZATION_FAILURE_SQL_STATE },
    });

    expect(instrumented.transactionsOpened() - openedBefore).toBe(1);
  });

  it("gives up on a store-owned write with one typed conflict once its attempts are spent", async () => {
    const instrumented = refusing(
      await postgresBackend(),
      Number.POSITIVE_INFINITY,
      isFenceAcquisition,
    );
    const store = createStore(graph, instrumented.backend);
    const a = await store.nodes.Task.create({ name: "a" });
    const b = await store.nodes.Task.create({ name: "b" });
    const openedBefore = instrumented.transactionsOpened();

    const attempt = store.edges.dependsOn.create(a, b);
    await expect(attempt).rejects.toBeInstanceOf(TransactionConflictError);
    await expect(attempt).rejects.toMatchObject({
      details: { attempts: OPTIMISTIC_RETRY_ATTEMPTS },
      cause: { code: SERIALIZATION_FAILURE_SQL_STATE },
    });

    expect(instrumented.transactionsOpened() - openedBefore).toBe(
      OPTIMISTIC_RETRY_ATTEMPTS,
    );
  });

  it("propagates a typed conflict, unreplayed, from a transaction the caller owns", async () => {
    const instrumented = refusing(
      await postgresBackend(),
      1,
      isFenceAcquisition,
    );
    const store = createStore(graph, instrumented.backend);
    const a = await store.nodes.Task.create({ name: "a" });
    const b = await store.nodes.Task.create({ name: "b" });
    const openedBefore = instrumented.transactionsOpened();

    let conflictSeenInside: unknown;
    const attempt = store.transaction(async (tx) => {
      try {
        await tx.edges.dependsOn.create(a, b);
      } catch (error) {
        conflictSeenInside = error;
        throw error;
      }
    });
    await expect(attempt).rejects.toBeInstanceOf(TransactionConflictError);

    // Typed at the fence itself, not only once it reaches the transaction's
    // owner: the caller's callback sees the same error family.
    expect(conflictSeenInside).toBeInstanceOf(TransactionConflictError);
    expect(instrumented.transactionsOpened() - openedBefore).toBe(1);
    expect(await store.edges.dependsOn.find({})).toEqual([]);
  });

  it("is never retried on a serialized engine, which takes no keyed acquisition", async () => {
    const instrumented = refusing(createTestBackend(), 1, (query) =>
      statementText(query).includes("typegraph_edges"),
    );
    const store = createStore(graph, instrumented.backend);
    const a = await store.nodes.Task.create({ name: "a" });
    const b = await store.nodes.Task.create({ name: "b" });
    const openedBefore = instrumented.transactionsOpened();

    await expect(store.edges.dependsOn.create(a, b)).rejects.toMatchObject({
      code: SERIALIZATION_FAILURE_SQL_STATE,
    });

    expect(instrumented.transactionsOpened() - openedBefore).toBe(1);
  });
});
