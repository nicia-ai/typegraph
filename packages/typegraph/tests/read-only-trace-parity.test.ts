/**
 * Statement-trace parity with main for the read-only write gate.
 *
 * A read-only `store.transaction` opens a read-only scope, and the backend
 * objects over its transaction refuse their write members inside it
 * (`src/backend/read-only-write-gate.ts`): the transaction's own backend and
 * everything derived from it, and every adoption of its native handle. That
 * gate may change nothing else: not what runs outside a read-only scope, and
 * not any call another flow makes on the root backend, or on a Store over it,
 * while a read-only transaction is open, whatever the root's connection runs
 * meanwhile. This file proves it with a fixed script of interleavings
 * (cells): owned read-only and read-write transactions, root writes and reads
 * issued concurrently from other flows, a second Store on the same backend,
 * Store members called from another flow on an untracked and a tracked Store,
 * every root write member called from another flow, and backends adopted or
 * built over the transaction's native handle, on each driver lane this
 * repository runs in process (better-sqlite3, libSQL with the current client
 * and with 0.17, PGlite). Each cell records every statement the driver was
 * asked to run, the caller's own markers, the outcome of every call and the
 * rows left behind.
 *
 * `__fixtures__/read-only-trace-parity.main.json` is that record taken on
 * main's `src` (rerun with `TRACE_PARITY_RECORD=1` on main's sources to
 * refresh it; `TRACE_PARITY_OUT` redirects a recording elsewhere). Every cell
 * must equal it, except the cells {@link DIVERGENT_CELLS} names: each is a
 * refusal on one of the two routes above, and must differ from main in
 * exactly the outcomes stated there.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { PGlite } from "@electric-sql/pglite";
import { createClient } from "@libsql/client";
import Database from "better-sqlite3";
import { drizzle as drizzleBetterSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { createClient as createClient017 } from "libsql-client-017";
import { describe, expect, it } from "vitest";

import { asNodeId, createAdapterStoreWithSchema } from "../src";
import { createPostgresBackend } from "../src/backend/postgres";
import { createSqliteBackend } from "../src/backend/sqlite";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import type {
  AdapterBackend,
  IdentityTableNames,
  TransactionBackend,
} from "../src/backend/types";
import { TypeGraphError } from "../src/errors";
import { parseSerializedSchema } from "../src/schema";
import { requireDefined } from "../src/utils/presence";
import {
  type BackendMemberFixture,
  WRITE_MEMBER_ARGUMENTS,
} from "./backends/integration/backend-member-arguments";
import {
  buildGraph,
  seed,
} from "./backends/integration/read-only-transaction-writes";
import {
  type EventSink,
  recordLibsqlClient,
  recordPgliteDriver,
  recordSqliteDriver,
} from "./helpers/write-shape-recorder";

const LANES = ["better-sqlite3", "libsql", "libsql-0.17", "pglite"] as const;
type Lane = (typeof LANES)[number];

const GRAPH_ID = "ro_parity";
const OTHER_GRAPH_ID = "ro_parity_other";
const TRACKED_GRAPH_ID = "ro_parity_tracked";

/**
 * The row count at which a Store's bulk write refreshes planner statistics
 * in these cells: small, so a `bulkCreate` cell reaches the refresh.
 */
const AUTO_REFRESH_STATISTICS = 3;

/** What one cell observed: the driver trace, each call's outcome, the rows. */
type CellRecord = Readonly<{
  trace: readonly string[];
  outcomes: Readonly<Record<string, string>>;
  /** The calls that settled before a held transaction's callback was released. */
  settledInsideSpan: readonly string[];
  rows: readonly string[];
}>;

type LaneRecord = Readonly<Record<string, CellRecord>>;

type RotStore = Awaited<
  ReturnType<
    typeof createAdapterStoreWithSchema<ReturnType<typeof buildGraph>, unknown>
  >
>[0];

/** One lane's connection, its backend and two Stores over it. */
type Harness = Readonly<{
  lane: Lane;
  backend: AdapterBackend<unknown>;
  store: RotStore;
  otherStore: RotStore;
  /** A Store with `revisionTracking: true` on a graph of its own. */
  trackedStore: RotStore;
  /** Records a caller-side event (`-- caller …`) in the trace. */
  mark: (label: string) => void;
  /** Every statement the driver ran since recording began, normalized. */
  trace: () => readonly string[];
  close: () => Promise<void>;
}>;

/** Arms no fault: the recorder only records. */
function noFault(): undefined {
  return;
}

/**
 * A statement's text with whitespace collapsed and per-call random values
 * (PostgreSQL's commit-outcome marker, generated names) replaced.
 */
function normalize(text: string): string {
  return text
    .replaceAll(/\s+/g, " ")
    .replaceAll(/'[0-9a-f]{32}'/g, "'<marker>'")
    .replaceAll(/_[0-9a-f]{8,}\b/g, "_<id>")
    .trim();
}

type Log = Readonly<{
  sink: EventSink;
  mark: (label: string) => void;
  start: () => void;
  trace: () => readonly string[];
}>;

function createLog(): Log {
  const entries: string[] = [];
  const state = { recording: false };
  return {
    sink: (event) => {
      if (!state.recording) return;
      if (event.source === "sql") entries.push(normalize(event.text));
      else if (event.source === "exchange") entries.push(`-- ${event.line}`);
    },
    mark: (label) => {
      if (state.recording) entries.push(`-- caller ${label}`);
    },
    start: () => {
      state.recording = true;
    },
    trace: () => [...entries],
  };
}

type Connection = Readonly<{
  backend: AdapterBackend<unknown>;
  close: () => Promise<void>;
}>;

async function openConnection(lane: Lane, log: Log): Promise<Connection> {
  switch (lane) {
    case "better-sqlite3": {
      const client = new Database(":memory:");
      recordSqliteDriver(client, log.sink, noFault);
      const backend = createSqliteBackend(
        drizzleBetterSqlite(client),
      ) as AdapterBackend<unknown>;
      return {
        backend,
        close: () => {
          client.close();
          return Promise.resolve();
        },
      };
    }
    case "libsql":
    case "libsql-0.17": {
      const directory = mkdtempSync(
        path.join(tmpdir(), "typegraph-ro-parity-"),
      );
      const url = `file:${path.join(directory, "graph.db")}`;
      const client =
        lane === "libsql" ? createClient({ url }) : createClient017({ url });
      recordLibsqlClient(client, log.sink, noFault);
      const { backend } = await createLibsqlBackend(client);
      return {
        backend: backend as AdapterBackend<unknown>,
        close: () => {
          client.close();
          rmSync(directory, { recursive: true, force: true });
          return Promise.resolve();
        },
      };
    }
    case "pglite": {
      const client = await PGlite.create();
      recordPgliteDriver(client, log.sink, noFault);
      const backend = createPostgresBackend(
        drizzlePglite(client),
      ) as AdapterBackend<unknown>;
      return { backend, close: () => client.close() };
    }
  }
}

async function openHarness(lane: Lane): Promise<Harness> {
  const log = createLog();
  const { backend, close } = await openConnection(lane, log);
  await requireDefined(backend.bootstrapTables)();
  const [store] = await createAdapterStoreWithSchema(
    buildGraph(GRAPH_ID),
    backend,
    { autoRefreshStatistics: AUTO_REFRESH_STATISTICS },
  );
  const [otherStore] = await createAdapterStoreWithSchema(
    buildGraph(OTHER_GRAPH_ID),
    backend,
  );
  const [trackedStore] = await createAdapterStoreWithSchema(
    buildGraph(TRACKED_GRAPH_ID),
    backend,
    {
      revisionTracking: true,
      autoRefreshStatistics: AUTO_REFRESH_STATISTICS,
    },
  );
  await seed(store);
  await seed(trackedStore);
  log.start();
  return {
    lane,
    backend,
    store,
    otherStore,
    trackedStore: trackedStore as unknown as RotStore,
    mark: log.mark,
    trace: log.trace,
    close,
  };
}

/**
 * A settled call as `"fulfilled"`, its TypeGraph error class and code, or
 * `"untyped: "` and the first line of the driver's message.
 */
function describeOutcome(error: unknown): string {
  if (error instanceof TypeGraphError) {
    const code = error.details["code"];
    return typeof code === "string" ? `${error.name} ${code}` : error.name;
  }
  return `untyped: ${String(error).split("\n")[0]?.trim() ?? ""}`;
}

/**
 * Whether a held transaction's callback is running: set by {@link whileHeld}
 * from the callback beginning to its release.
 */
interface Span {
  inside: boolean;
}

/**
 * Collects each named call's outcome as it settles, and the calls that
 * settled while a held transaction's callback was still running.
 */
function createOutcomes(span: Span): Readonly<{
  track: (name: string, pending: Promise<unknown>) => Promise<void>;
  record: () => Readonly<Record<string, string>>;
  settledInsideSpan: () => readonly string[];
}> {
  const outcomes: Record<string, string> = {};
  const inside: string[] = [];
  const settle = (name: string, outcome: string): void => {
    if (span.inside) inside.push(name);
    outcomes[name] = outcome;
  };
  return {
    track: (name, pending) =>
      pending.then(
        () => {
          settle(name, "fulfilled");
        },
        (error: unknown) => {
          settle(name, describeOutcome(error));
        },
      ),
    record: () =>
      Object.fromEntries(
        Object.entries(outcomes).toSorted(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    settledInsideSpan: () => inside.toSorted(),
  };
}

type CellContext = Readonly<{
  harness: Harness;
  track: (name: string, pending: Promise<unknown>) => Promise<void>;
  span: Span;
}>;

/** One interleaving; `undefined` when the lane cannot express it. */
type Cell = (context: CellContext) => Promise<void> | undefined;

/** Lets other work run for a few event-loop turns. */
async function otherWorkRuns(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
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

const BEGUN = "transaction callback begun";
const RELEASED = "transaction callback released";

/**
 * Runs `others` from outside a transaction `store` opens with `accessMode`,
 * while its callback awaits: the callback begins, `others` starts its calls,
 * other work runs, the callback is released, and every call settles. The
 * transaction's own native handle is passed to `others`.
 */
async function whileHeld(
  { harness, track, span }: CellContext,
  accessMode: "read_only" | "read_write",
  others: (handle: unknown) => readonly Promise<void>[],
): Promise<void> {
  const released = signal();
  const begun = signal();
  let handle: unknown;
  const transaction = track(
    "held transaction",
    harness.store.transaction(
      async (tx) => {
        handle = (tx as Readonly<{ sql?: unknown }>).sql;
        harness.mark(BEGUN);
        span.inside = true;
        begun.resolve();
        await released.promise;
      },
      { accessMode },
    ),
  );
  await begun.promise;
  const pending = others(handle);
  await otherWorkRuns();
  harness.mark(RELEASED);
  span.inside = false;
  released.resolve();
  await transaction;
  await Promise.all(pending);
}

/** The write context `store.withTransaction(tx.sql)` builds. */
function adoptedContext(store: RotStore, tx: object): Pick<RotStore, "nodes"> {
  const adopting = store as unknown as Readonly<{
    withTransaction: (externalTx: unknown) => Pick<RotStore, "nodes">;
  }>;
  return adopting.withTransaction((tx as Readonly<{ sql?: unknown }>).sql);
}

function team(id: string) {
  return { name: id };
}

/** What a member's argument builder reads, as the root backend sees it. */
async function memberFixture(
  harness: Harness,
  nativeTransaction: unknown,
): Promise<BackendMemberFixture> {
  const active = requireDefined(
    await harness.backend.getActiveSchema(GRAPH_ID),
  );
  const names = requireDefined(
    harness.backend.tableNames,
  ) as unknown as IdentityTableNames;
  return {
    graphId: GRAPH_ID,
    schemaVersion: active.version,
    schemaHash: active.schema_hash,
    schemaDoc: parseSerializedSchema(active.schema_doc),
    identityTableNames: {
      identityAssertions: names.identityAssertions,
      recordedIdentityAssertions: names.recordedIdentityAssertions,
      identityClosure: names.identityClosure,
      identitySeparation: names.identitySeparation,
      identityTransitions: names.identityTransitions,
      identityTransitionRetention: names.identityTransitionRetention,
    },
    nativeTransaction,
    commandSession: "root",
  };
}

/** Calls `member` of `target` with `args`; a command port's `execute`. */
function callMember(
  target: object,
  member: string,
  args: readonly unknown[],
): Promise<unknown> {
  return Promise.resolve().then(() => {
    const value: unknown = Reflect.get(target, member);
    if (member === "commands") {
      const port = value as Readonly<{
        execute: (...portArguments: readonly unknown[]) => unknown;
      }>;
      return port.execute(...args);
    }
    return Reflect.apply(
      value as (...a: readonly unknown[]) => unknown,
      target,
      [...args],
    );
  });
}

/** Every write member a backend can carry, as the argument table names them. */
const WRITE_MEMBERS = Object.keys(WRITE_MEMBER_ARGUMENTS).toSorted();

/** Prefix of a cell that calls one root write member from another flow. */
const ROOT_MEMBER_CELL = "read-only held: root backend.";

function rootMemberCell(member: string): Cell {
  return (context) => {
    const { harness, track } = context;
    if (Reflect.get(harness.backend, member) === undefined) return;
    // Read before the transaction holds the connection: a root read from
    // another flow waits behind it.
    return memberFixture(harness, undefined).then((fixture) =>
      whileHeld(context, "read_only", (handle) => {
        const args = (
          WRITE_MEMBER_ARGUMENTS[
            member as keyof typeof WRITE_MEMBER_ARGUMENTS
          ] as (f: BackendMemberFixture) => unknown
        )({ ...fixture, nativeTransaction: handle });
        if (!Array.isArray(args)) return [];
        return [track(member, callMember(harness.backend, member, args))];
      }),
    );
  };
}

/**
 * A backend built over the native handle `handle` a transaction hands its
 * callback: `createPostgresBackend` (a transaction backend over a
 * transaction object) on PGlite, `createSqliteBackend` elsewhere (over
 * libSQL's transaction object, or over the database handle better-sqlite3 and
 * libSQL 0.17 hand the callback).
 */
function backendBuiltOver(
  lane: Lane,
  handle: unknown,
): AdapterBackend<unknown> {
  switch (lane) {
    case "pglite": {
      return createPostgresBackend(handle as never) as AdapterBackend<unknown>;
    }
    case "better-sqlite3": {
      return createSqliteBackend(handle as never) as AdapterBackend<unknown>;
    }
    case "libsql":
    case "libsql-0.17": {
      return createSqliteBackend(handle as never, {
        executionProfile: { isSync: false, transactionMode: "drizzle" },
      }) as AdapterBackend<unknown>;
    }
  }
}

/** Prefix of a cell that calls one Store member from another flow. */
const STORE_CALL_CELL = "read-only held: ";

/**
 * The Store members a caller reaches the root backend through from another
 * flow, each called on an untracked and on a tracked Store while a
 * read-only transaction is held. None is this gate's: each must equal main.
 */
const STORE_CALLS: readonly (readonly [
  string,
  (store: RotStore) => Promise<unknown>,
])[] = [
  ["allocationOwner()", (store) => store.allocationOwner()],
  ["clear()", (store) => store.clear()],
  ["create()", (store) => store.nodes.RotTeam.create(team("s"), { id: "s" })],
  [
    "bulkCreate()",
    (store) =>
      store.nodes.RotTeam.bulkCreate(
        ["b1", "b2", "b3", "b4"].map((id) => ({ props: team(id), id })),
      ),
  ],
  ["refreshStatistics()", (store) => store.refreshStatistics()],
  ["materializeIndexes()", (store) => store.materializeIndexes()],
];

/** The fixed script. Every cell runs on a fresh connection. */
const CELLS: Readonly<Record<string, Cell>> = {
  "read-write: two writes through the context, commit": ({ harness, track }) =>
    track(
      "transaction",
      harness.store.transaction(async (tx) => {
        await tx.nodes.RotTeam.create(team("a1"), { id: "a1" });
        await tx.nodes.RotTeam.create(team("a2"), { id: "a2" });
      }),
    ),

  "read-only: reads through the context, commit": ({ harness, track }) =>
    track(
      "transaction",
      harness.store.transaction(
        async (tx) => {
          await tx.nodes.RotTeam.find();
          await tx.nodes.RotPerson.getById(asNodeId("p1"));
        },
        { accessMode: "read_only" },
      ),
    ),

  "read-only: a write through the context is refused": ({ harness, track }) =>
    track(
      "transaction",
      harness.store.transaction(
        async (tx) => {
          await track("write", tx.nodes.RotTeam.create(team("w"), { id: "w" }));
        },
        { accessMode: "read_only" },
      ),
    ),

  "read-only: a write through a Store adopted over tx.sql": ({
    harness,
    track,
  }) =>
    track(
      "transaction",
      harness.store.transaction(
        async (tx) => {
          const adopted = adoptedContext(harness.store, tx);
          await track(
            "adopted write",
            adopted.nodes.RotTeam.create(team("w"), { id: "w" }),
          );
        },
        { accessMode: "read_only" },
      ),
    ),

  "read-write: a write through a Store adopted over tx.sql": ({
    harness,
    track,
  }) =>
    track(
      "transaction",
      harness.store.transaction(async (tx) => {
        const adopted = adoptedContext(harness.store, tx);
        await track(
          "adopted write",
          adopted.nodes.RotTeam.create(team("w"), { id: "w" }),
        );
      }),
    ),

  "read-write: a write through a backend adopted over tx.sql": ({
    harness,
    track,
  }) =>
    track(
      "transaction",
      harness.store.transaction(async (tx) => {
        const adopted: TransactionBackend = harness.backend.adoptTransaction(
          (tx as Readonly<{ sql?: unknown }>).sql,
        );
        await track(
          "adopted insertNode",
          adopted.insertNode({
            graphId: GRAPH_ID,
            kind: "RotTeam",
            id: "w",
            props: team("w"),
          }),
        );
      }),
    ),

  "read-only: the root store writes from inside the callback": ({
    harness,
    track,
  }) => {
    // PGlite runs one transaction at a time: a root write from inside the
    // callback waits for the transaction that awaits it.
    if (harness.lane === "pglite") return;
    return track(
      "transaction",
      harness.store.transaction(
        async () => {
          await track(
            "root write",
            harness.store.nodes.RotTeam.create(team("w"), { id: "w" }),
          );
        },
        { accessMode: "read_only" },
      ),
    );
  },

  "read-only: root refreshStatistics() from inside the callback": ({
    harness,
    track,
  }) => {
    if (harness.lane === "pglite") return;
    return track(
      "transaction",
      harness.store.transaction(
        async () => {
          await track("refreshStatistics", harness.store.refreshStatistics());
        },
        { accessMode: "read_only" },
      ),
    );
  },

  "read-only held: the root store creates from another flow": (context) =>
    whileHeld(context, "read_only", () => [
      context.track(
        "root create",
        context.harness.store.nodes.RotTeam.create(team("q"), { id: "q" }),
      ),
    ]),

  "read-only held: a root read-write transaction from another flow": (
    context,
  ) =>
    whileHeld(context, "read_only", () => [
      context.track(
        "root transaction",
        context.harness.store.transaction(async (tx) => {
          await tx.nodes.RotTeam.create(team("q"), { id: "q" });
        }),
      ),
    ]),

  "read-only held: a second read-only transaction from another flow": (
    context,
  ) =>
    whileHeld(context, "read_only", () => [
      context.track(
        "second read-only transaction",
        context.harness.store.transaction(
          async (tx) => {
            await tx.nodes.RotTeam.find();
          },
          { accessMode: "read_only" },
        ),
      ),
    ]),

  "read-only held: the root store reads from another flow": (context) =>
    whileHeld(context, "read_only", () => [
      context.track("root read", context.harness.store.nodes.RotTeam.find()),
    ]),

  "read-only held: a second Store on another graph creates from another flow": (
    context,
  ) =>
    whileHeld(context, "read_only", () => [
      context.track(
        "other store create",
        context.harness.otherStore.nodes.RotTeam.create(team("o"), { id: "o" }),
      ),
    ]),

  "read-only held: root store.refreshStatistics() from another flow": (
    context,
  ) =>
    whileHeld(context, "read_only", () => [
      context.track(
        "refreshStatistics",
        context.harness.store.refreshStatistics(),
      ),
    ]),

  "read-write held: the root store creates from another flow": (context) =>
    whileHeld(context, "read_write", () => [
      context.track(
        "root create",
        context.harness.store.nodes.RotTeam.create(team("q"), { id: "q" }),
      ),
    ]),

  "read-write held: root store.refreshStatistics() from another flow": (
    context,
  ) =>
    whileHeld(context, "read_write", () => [
      context.track(
        "refreshStatistics",
        context.harness.store.refreshStatistics(),
      ),
    ]),

  "read-only: a write through a backend adopted over tx.sql": ({
    harness,
    track,
  }) =>
    track(
      "transaction",
      harness.store.transaction(
        async (tx) => {
          const adopted: TransactionBackend = harness.backend.adoptTransaction(
            (tx as Readonly<{ sql?: unknown }>).sql,
          );
          await track(
            "adopted insertNode",
            adopted.insertNode({
              graphId: GRAPH_ID,
              kind: "RotTeam",
              id: "w",
              props: team("w"),
            }),
          );
        },
        { accessMode: "read_only" },
      ),
    ),

  "read-only: a write through a backend built over tx.sql": ({
    harness,
    track,
  }) =>
    track(
      "transaction",
      harness.store.transaction(
        async (tx) => {
          const built = backendBuiltOver(
            harness.lane,
            (tx as Readonly<{ sql?: unknown }>).sql,
          );
          await track(
            "built insertNode",
            built.insertNode({
              graphId: GRAPH_ID,
              kind: "RotTeam",
              id: "w",
              props: team("w"),
            }),
          );
        },
        { accessMode: "read_only" },
      ),
    ),

  ...Object.fromEntries(
    STORE_CALLS.flatMap(([call, invoke]) =>
      (["untracked", "tracked"] as const).map((label): [string, Cell] => [
        `${STORE_CALL_CELL}${label} store.${call} from another flow`,
        (context) =>
          whileHeld(context, "read_only", () => [
            context.track(
              `${label} ${call}`,
              invoke(
                label === "tracked" ?
                  context.harness.trackedStore
                : context.harness.store,
              ),
            ),
          ]),
      ]),
    ),
  ),

  ...Object.fromEntries(
    WRITE_MEMBERS.map((member) => [
      `${ROOT_MEMBER_CELL}${member}() from another flow`,
      rootMemberCell(member),
    ]),
  ),
};

/** What the gate refuses: the read-only refusal's outcome. */
const REFUSED = "UnsupportedBackendCapabilityError";

/** The route a claimed refusal is on. */
type Route =
  | "the transaction's own backend, or one derived from it"
  | "an adoption of the transaction's native handle";

type Divergence = Readonly<{
  route: Route;
  lanes: readonly Lane[];
  /** The outcomes this branch produces; main's are in the fixture. */
  branch: Readonly<Record<string, string>>;
}>;

/**
 * The cells that differ from main, each a refusal on one of the two routes
 * this change claims. Every other cell equals main's record exactly: every
 * call another flow makes on the root backend or a Store over it, whatever
 * its connection runs meanwhile, included.
 */
const DIVERGENT_CELLS: Readonly<Record<string, Divergence>> = {
  "read-only: a write through a Store adopted over tx.sql": {
    route: "an adoption of the transaction's native handle",
    lanes: ["better-sqlite3", "libsql", "libsql-0.17", "pglite"],
    branch: { "adopted write": REFUSED, transaction: "fulfilled" },
  },
  "read-only: a write through a backend adopted over tx.sql": {
    route: "an adoption of the transaction's native handle",
    lanes: ["better-sqlite3", "libsql", "libsql-0.17", "pglite"],
    branch: { "adopted insertNode": REFUSED, transaction: "fulfilled" },
  },
  // The root member adopts the handle it is given, the transaction's own:
  // an adoption, refused before its first statement. On main better-sqlite3
  // ran its fence inside the read-only transaction and PGlite's engine
  // refused it, aborting the transaction. libSQL's root has no such member.
  [`${ROOT_MEMBER_CELL}adoptSchemaWriteTransaction() from another flow`]: {
    route: "an adoption of the transaction's native handle",
    lanes: ["better-sqlite3", "pglite"],
    branch: {
      adoptSchemaWriteTransaction: REFUSED,
      "held transaction": "fulfilled",
    },
  },
  // libSQL 0.17 hands the callback its one connection's database handle and
  // reports no transaction state, so nothing proves a backend built over it
  // runs in the transaction: it is a root backend there, as on main.
  "read-only: a write through a backend built over tx.sql": {
    route: "an adoption of the transaction's native handle",
    lanes: ["better-sqlite3", "libsql", "pglite"],
    branch: { "built insertNode": REFUSED, transaction: "fulfilled" },
  },
};

async function runCell(
  lane: Lane,
  cell: Cell,
): Promise<CellRecord | undefined> {
  const harness = await openHarness(lane);
  try {
    const span: Span = { inside: false };
    const outcomes = createOutcomes(span);
    const done = cell({ harness, track: outcomes.track, span });
    if (done === undefined) return undefined;
    await done;
    const trace = harness.trace();
    const rowsOf = (store: RotStore, prefix: string) =>
      store.nodes.RotTeam.find().then(
        (teams) => teams.map((node) => `${prefix}${node.id}`).toSorted(),
        (error: unknown) => [`${prefix}unreadable: ${describeOutcome(error)}`],
      );
    const rows = [
      ...(await rowsOf(harness.store, "")),
      ...(await rowsOf(harness.trackedStore, "tracked:")),
    ];
    return {
      trace,
      outcomes: outcomes.record(),
      settledInsideSpan: outcomes.settledInsideSpan(),
      rows,
    };
  } finally {
    await harness.close();
  }
}

async function recordLane(lane: Lane): Promise<LaneRecord> {
  const record: Record<string, CellRecord> = {};
  for (const [name, cell] of Object.entries(CELLS)) {
    const cellRecord = await runCell(lane, cell);
    if (cellRecord !== undefined) record[name] = cellRecord;
  }
  return record;
}

const FIXTURE_PATH = path.join(
  import.meta.dirname,
  "__fixtures__",
  "read-only-trace-parity.main.json",
);

const RECORDING = process.env["TRACE_PARITY_RECORD"] === "1";

/** Where a recording run writes; the fixture unless redirected. */
const RECORDING_PATH = process.env["TRACE_PARITY_OUT"] ?? FIXTURE_PATH;

function readMainFixture(): Readonly<Record<Lane, LaneRecord>> {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Readonly<
    Record<Lane, LaneRecord>
  >;
}

describe("read-only gate: statement traces match main outside the refusals it claims", () => {
  if (RECORDING) {
    it("records main's traces", async () => {
      const recorded: Partial<Record<Lane, LaneRecord>> = {};
      for (const lane of LANES) recorded[lane] = await recordLane(lane);
      writeFileSync(
        RECORDING_PATH,
        `${JSON.stringify(recorded, undefined, 2)}\n`,
      );
    }, 1_800_000);
    return;
  }

  it.each(LANES)(
    "%s: every cell equals main's, except the refusals this change claims",
    async (lane) => {
      const main = readMainFixture()[lane];
      const branch = await recordLane(lane);
      expect(Object.keys(branch)).toEqual(Object.keys(main));
      const divergent = new Set(
        Object.entries(DIVERGENT_CELLS)
          .filter(([, divergence]) => divergence.lanes.includes(lane))
          .map(([name]) => name),
      );
      // A divergent cell is observed as whether it differs from main and
      // the outcomes it produced; every other cell as its whole record.
      const observed = Object.fromEntries(
        Object.entries(branch).map(([name, record]) => [
          name,
          divergent.has(name) ?
            {
              differsFromMain: !isDeepStrictEqual(record, main[name]),
              outcomes: record.outcomes,
            }
          : record,
        ]),
      );
      const expected = Object.fromEntries(
        Object.entries(main).map(([name, record]) => [
          name,
          divergent.has(name) ?
            {
              differsFromMain: true,
              outcomes: requireDefined(DIVERGENT_CELLS[name]).branch,
            }
          : record,
        ]),
      );
      expect(observed).toEqual(expected);
    },
    900_000,
  );
});
