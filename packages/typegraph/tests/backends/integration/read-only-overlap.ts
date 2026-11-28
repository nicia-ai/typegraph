/**
 * Calls that overlap on a Store over a caller's transaction, on every
 * backend that can build one (`createPostgresTransactionBackend(tx.sql)`,
 * `createSqliteBackend(tx.sql)` over libSQL's transaction object).
 *
 * Every unit such a Store opens is a savepoint of the caller's transaction.
 * TypeGraph's own read-only units (an export's snapshot, the confirm read of
 * `getOrCreateByEndpoints`, the iterative algorithms) and a read-only
 * `store.transaction` the caller asked for issue the statements they issue on
 * main, with no savepoint or access-mode statement of their own, so a call
 * overlapping one of them on the same transaction cannot lose a savepoint to
 * its release. Each case below fulfils on main, leaves the caller's
 * transaction usable, and persists every write that reported success; it must
 * do the same here.
 *
 * A read-only `store.transaction` is enforced on a caller's transaction by
 * its read-only scope alone (the Store's refusals and the backend's write
 * gate), never by the engine's access mode, which stays the caller's: a write
 * that reaches a write member while the scope is open is refused before any
 * statement, and an algorithm's working table, which writes only temporary
 * rows, runs as on main.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createAdapterStore,
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import { createPostgresTransactionBackend } from "../../../src/backend/postgres";
import { createSqliteBackend } from "../../../src/backend/sqlite";
import type { AdapterBackend } from "../../../src/backend/types";
import { UnsupportedBackendCapabilityError } from "../../../src/errors";
import { exportGraph } from "../../../src/interchange";
import { type IntegrationTestContext } from "./test-context";

// Self-contained, so the file runs unchanged on main's sources.
const RovPerson = defineNode("RovPerson", {
  schema: z.object({ name: z.string() }),
});
const RovTeam = defineNode("RovTeam", {
  schema: z.object({ name: z.string() }),
});
const rovKnows = defineEdge("rovKnows", { schema: z.object({}) });

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      RovPerson: { type: RovPerson },
      RovTeam: { type: RovTeam },
    },
    edges: {
      rovKnows: { type: rovKnows, from: [RovPerson], to: [RovPerson] },
    },
  });
}

type RovGraph = ReturnType<typeof buildGraph>;

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `read_only_overlap_${graphIdCounter}`;
}

type OverStore = ReturnType<typeof createAdapterStore<RovGraph, unknown>>;

const READ_ONLY = { accessMode: "read_only" } as const;

/**
 * How a SQLite Store refuses a Store-level call awaited inside its own
 * transaction, which holds the backend's serialized execution slot.
 */
const SQLITE_SLOT_REFUSAL =
  "rejected: ConfigurationError CONFIGURATION_ERROR: This operation was awaited from inside a transaction running on the same sqlite backend and would deadlock: the transaction holds the backend's serialized execution slot until it completes, so the operation could never run.";

const P1 = asNodeId("p1");
const P2 = asNodeId("p2");

function person(id: string): never {
  return { kind: "RovPerson", id } as never;
}

/**
 * A settled call: `"fulfilled"`, the read-only refusal, or the rejection's
 * TypeGraph code, else SQLSTATE or driver code on its cause chain, else its
 * class.
 */
function settle(pending: Promise<unknown>): Promise<string> {
  return pending.then(
    () => "fulfilled",
    (error: unknown) => `rejected: ${describeRejection(error)}`,
  );
}

function describeRejection(error: unknown): string {
  if (
    error instanceof UnsupportedBackendCapabilityError &&
    error.details["capability"] === "write transaction access"
  ) {
    return "refused as read-only";
  }
  const name = error instanceof Error ? error.constructor.name : typeof error;
  const codes: string[] = [];
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    const details = (current as Readonly<{ details?: unknown }>).details;
    const code =
      (current as Readonly<{ code?: unknown }>).code ??
      (typeof details === "object" && details !== null ?
        (details as Readonly<{ code?: unknown }>).code
      : undefined);
    if (typeof code === "string") codes.push(code);
    current = (current as Readonly<{ cause?: unknown }>).cause;
  }
  return codes.length === 0 ? name : `${name} ${codes.join(" <- ")}`;
}

/** The caller's native handle a transaction context exposes as `tx.sql`. */
function nativeHandle(tx: object): unknown {
  return (tx as Readonly<{ sql?: unknown }>).sql;
}

/** Two people and the one `rovKnows` edge (p1 → p2) every case finds. */
async function seed(store: OverStore): Promise<void> {
  await store.nodes.RovPerson.create({ name: "p1" }, { id: "p1" });
  await store.nodes.RovPerson.create({ name: "p2" }, { id: "p2" });
  await store.edges.rovKnows.create(person("p1"), person("p2"), {});
}

/** Two reads through a read-only unit's own context. */
function readOnlyUnit(over: OverStore): Promise<unknown> {
  return over.transaction(async (tx) => {
    await tx.nodes.RovTeam.find();
    await tx.nodes.RovTeam.find();
  }, READ_ONLY);
}

function createTeam(over: OverStore, id: string): Promise<unknown> {
  return over.nodes.RovTeam.create({ name: id }, { id });
}

/** The edge (p1 → p2) {@link seed} creates: found, never created. */
function getOrCreateFound(over: OverStore): Promise<unknown> {
  return over.edges.rovKnows.getOrCreateByEndpoints(
    person("p1"),
    person("p2"),
    {},
  );
}

/** Stands in for a resolver until the promise's executor has run. */
function notYetResolvable(): void {
  // The executor replaces it synchronously.
}

/** A promise and the function that resolves it. */
function signal(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  const handle: { resolve: () => void } = { resolve: notYetResolvable };
  const promise = new Promise<void>((resolve) => {
    handle.resolve = resolve;
  });
  return {
    promise,
    resolve: () => {
      handle.resolve();
    },
  };
}

type Overlap = Readonly<{
  name: string;
  calls: readonly ((over: OverStore) => Promise<unknown>)[];
  /** The teams the caller's transaction commits besides its own. */
  teams: readonly string[];
}>;

/**
 * The overlaps on which the read-only savepoint of an earlier round lost the
 * caller's transaction: one unit's `RELEASE` ended another's savepoint, the
 * transaction was left aborted, and its `COMMIT` persisted nothing.
 */
const OVERLAPS: readonly Overlap[] = [
  {
    name: "an export and a shortest path",
    calls: [
      (over) => exportGraph(over),
      (over) => over.algorithms.shortestPath(P1, P2, { edges: ["rovKnows"] }),
    ],
    teams: [],
  },
  {
    name: "three get-or-create calls that each find their edge",
    calls: [
      (over) => getOrCreateFound(over),
      (over) => getOrCreateFound(over),
      (over) => getOrCreateFound(over),
    ],
    teams: [],
  },
  {
    name: "a get-or-create that finds its edge and a create",
    calls: [
      (over) => getOrCreateFound(over),
      (over) => createTeam(over, "overlap"),
    ],
    teams: ["overlap"],
  },
  {
    name: "a caller-requested read-only unit and a create",
    calls: [
      (over) => readOnlyUnit(over),
      (over) => createTeam(over, "overlap"),
    ],
    teams: ["overlap"],
  },
];

export function registerReadOnlyOverlapIntegrationTests(
  context: IntegrationTestContext,
): void {
  /** As `backendOverTransaction` in `read-only-transaction-writes.ts`. */
  function backendOverTransaction(handle: unknown): AdapterBackend<unknown> {
    return context.driver === "libsql" ?
        (createSqliteBackend(handle as never, {
          executionProfile: { isSync: false, transactionMode: "drizzle" },
        }) as AdapterBackend<unknown>)
      : (createPostgresTransactionBackend(
          handle as never,
        ) as AdapterBackend<unknown>);
  }

  type Observed = Readonly<{
    calls: readonly string[];
    usableAfter: string;
    commit: string;
    teams: readonly string[];
  }>;

  /**
   * Runs `calls` concurrently on a Store over the caller's read-write
   * transaction, after a write of the caller's own, and reports each call's
   * outcome, whether the transaction still runs a statement, its commit, and
   * the teams it persisted.
   */
  async function overCallersTransaction(
    calls: (over: OverStore) => readonly Promise<unknown>[],
  ): Promise<Observed> {
    const graph = buildGraph(nextGraphId());
    const [store] = await createAdapterStoreWithSchema(
      graph,
      context.getBackend(),
    );
    await seed(store);
    const observed: { calls: readonly string[]; usableAfter: string } = {
      calls: [],
      usableAfter: "not reached",
    };
    const commit = await settle(
      store.transaction(async (tx) => {
        const over = createAdapterStore(
          graph,
          backendOverTransaction(nativeHandle(tx)),
        );
        await createTeam(over, "own");
        observed.calls = await Promise.all(
          calls(over).map((pending) => settle(pending)),
        );
        observed.usableAfter = await settle(over.nodes.RovTeam.count());
      }),
    );
    const persisted = await store.nodes.RovTeam.find();
    const teams = persisted.map((node) => String(node.id)).toSorted();
    return { ...observed, commit, teams };
  }

  // better-sqlite3 hands `tx.sql` out as the database itself, not a
  // transaction object, so there is no backend over its transaction to build.
  describe.runIf(context.driver !== "better-sqlite3")(
    "calls overlapping on a Store over a caller's transaction",
    () => {
      for (const overlap of OVERLAPS) {
        it(`${overlap.name}: every call fulfils, the transaction stays usable and commits every write`, async () => {
          const observed = await overCallersTransaction((over) =>
            overlap.calls.map((call) => call(over)),
          );
          expect(observed).toEqual({
            calls: overlap.calls.map(() => "fulfilled"),
            usableAfter: "fulfilled",
            commit: "fulfilled",
            teams: ["own", ...overlap.teams].toSorted(),
          });
        });
      }

      it("a read-write unit whose write runs while a caller-requested read-only unit's scope is open: the write is refused before any statement, and the transaction stays usable and commits", async () => {
        const opened = signal();
        const scopeOpen = opened.promise;
        const released = signal();
        const release = released.promise;
        const observed = await overCallersTransaction((over) => [
          over.transaction(async (tx) => {
            await tx.nodes.RovTeam.find();
            opened.resolve();
            await release;
          }, READ_ONLY),
          (async () => {
            await scopeOpen;
            try {
              await over.transaction(async (tx) => {
                await tx.nodes.RovTeam.create({ name: "late" }, { id: "late" });
              });
            } finally {
              released.resolve();
            }
          })(),
        ]);
        expect(observed).toEqual({
          calls: ["fulfilled", "rejected: refused as read-only"],
          usableAfter: "fulfilled",
          commit: "fulfilled",
          teams: ["own"],
        });
      });

      it("runs the iterative algorithms inside a caller-requested read-only unit as main does", async () => {
        const ALGORITHMS: Readonly<
          Record<string, (over: OverStore) => Promise<unknown>>
        > = {
          pageRank: (over) =>
            over.algorithms.pageRank({
              edges: ["rovKnows"],
              nodeKinds: ["RovPerson"],
            }),
          weaklyConnectedComponents: (over) =>
            over.algorithms.weaklyConnectedComponents({
              edges: ["rovKnows"],
              nodeKinds: ["RovPerson"],
            }),
          reachable: (over) =>
            over.algorithms.reachable(P1, { edges: ["rovKnows"] }),
          shortestPath: (over) =>
            over.algorithms.shortestPath(P1, P2, { edges: ["rovKnows"] }),
        };
        const outcomes: Record<string, string> = {};
        const observed = await overCallersTransaction((over) => [
          (async () => {
            for (const [name, run] of Object.entries(ALGORITHMS)) {
              outcomes[name] = await over
                .transaction(() => run(over), READ_ONLY)
                .then(
                  () => "fulfilled",
                  (error: unknown) =>
                    `rejected: ${describeRejection(error)}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
          })(),
        ]);
        // PostgreSQL runs each algorithm in a savepoint of the read-only
        // unit's, on the caller's read-write transaction, so its working table
        // is created as on main. A SQLite Store holds its serialized execution
        // slot for the unit, so a Store-level call awaited inside it is
        // refused as a deadlock, read-only or not, on main alike.
        const outcome =
          context.getBackend().dialect === "postgres" ?
            "fulfilled"
          : SQLITE_SLOT_REFUSAL;
        expect({ ...observed, outcomes }).toEqual({
          calls: ["fulfilled"],
          usableAfter: "fulfilled",
          commit: "fulfilled",
          teams: ["own"],
          outcomes: Object.fromEntries(
            Object.keys(ALGORITHMS).map((name) => [name, outcome]),
          ),
        });
      });
    },
  );
}
