/**
 * Statement-trace parity with main for every interleaving outside the
 * transaction view's own rule.
 *
 * A transaction's view (`src/backend/drizzle/execution/transaction-view.ts`)
 * closes when TypeGraph ends the transaction it opened: a statement arriving
 * through the view afterwards is refused with `TransactionClosedError`, and
 * statements admitted before the end settle before TypeGraph's COMMIT or
 * ROLLBACK. Nothing else about statement ordering, queueing or error classes
 * may change. This file proves it: a fixed script of interleavings (cells)
 * runs through transactions TypeGraph owns, transactions a caller owns and
 * TypeGraph adopted, and (better-sqlite3) a caller's synchronous transaction,
 * on each driver lane this repository runs in process (better-sqlite3,
 * libSQL, PGlite). Each cell records every statement the driver was asked to
 * run, the caller's own transaction boundaries, the outcome of every call
 * and the rows left behind.
 *
 * `__fixtures__/transaction-view-trace-parity.main.json` is that record taken
 * on main's `src` (rerun with `TRACE_PARITY_RECORD=1` on main's sources to
 * refresh it; `TRACE_PARITY_OUT` redirects a recording elsewhere, to
 * compare another revision). Every cell must equal it, except the cells
 * {@link DIVERGENT_CELLS} names, each of which is one of the view's own
 * rules and must differ from main in exactly the way stated there.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { PGlite } from "@electric-sql/pglite";
import { createClient } from "@libsql/client";
import Database from "better-sqlite3";
import { drizzle as drizzleBetterSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";

import { createPostgresBackend } from "../src/backend/postgres";
import { createSqliteBackend } from "../src/backend/sqlite";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import type {
  AdapterBackend,
  InsertNodeParams,
  TransactionBackend,
  TrustedImportSession,
} from "../src/backend/types";
import { TypeGraphError } from "../src/errors";
import { sql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import { requireDefined } from "../src/utils/presence";
import {
  type EventSink,
  recordLibsqlClient,
  recordPgliteDriver,
  recordSqliteDriver,
} from "./helpers/write-shape-recorder";

const LANES = ["better-sqlite3", "libsql", "pglite"] as const;
type Lane = (typeof LANES)[number];

const GRAPH_ID = "trace_parity";

/** What one cell observed: the driver trace, each call's outcome, the rows. */
type CellRecord = Readonly<{
  trace: readonly string[];
  outcomes: Readonly<Record<string, string>>;
  rows: readonly string[];
}>;

type LaneRecord = Readonly<Record<string, CellRecord>>;

/** One lane's connection, its backend, and the means to drive a caller's own transaction. */
type Harness = Readonly<{
  lane: Lane;
  backend: AdapterBackend<unknown>;
  /** Records a caller-side event (`-- caller …`) in the trace. */
  mark: (label: string) => void;
  /**
   * Runs `fn` inside a transaction the caller opened on the connection, on a
   * backend TypeGraph adopted for it; rejects (after rolling back) when `fn`
   * rejects.
   */
  inCallerTransaction: (
    fn: (adopted: TransactionBackend) => Promise<void>,
  ) => Promise<void>;
  /**
   * better-sqlite3 only: runs `fn` synchronously inside the driver's own
   * synchronous transaction, on a backend adopted for it.
   */
  inSynchronousCallerTransaction:
    ((fn: (adopted: TransactionBackend) => void) => void) | undefined;
  /** Every statement the driver ran since the harness opened, normalized. */
  trace: () => readonly string[];
  close: () => Promise<void>;
}>;

/**
 * A statement's text with whitespace collapsed and PostgreSQL's random
 * per-transaction marker value replaced.
 */
/** Arms no fault: the recorder only records. */
function noFault(): undefined {
  return;
}

/** Ends a cell once its tracked calls settled; their outcomes are recorded. */
function settled(): void {
  // Nothing to add: `track` recorded each outcome.
}

function normalize(text: string): string {
  return text
    .replaceAll(/\s+/g, " ")
    .replaceAll(/'[0-9a-f]{32}'/g, "'<marker>'")
    .trim();
}

function createLog(): Readonly<{
  sink: EventSink;
  mark: (label: string) => void;
  trace: () => readonly string[];
}> {
  const entries: string[] = [];
  return {
    sink: (event) => {
      if (event.source === "sql") entries.push(normalize(event.text));
      else if (event.source === "exchange") entries.push(`-- ${event.line}`);
    },
    mark: (label) => {
      entries.push(`-- caller ${label}`);
    },
    trace: () => [...entries],
  };
}

async function openHarness(lane: Lane): Promise<Harness> {
  const log = createLog();
  switch (lane) {
    case "better-sqlite3": {
      const client = new Database(":memory:");
      const db = drizzleBetterSqlite(client);
      const backend = createSqliteBackend(db) as AdapterBackend<unknown>;
      await requireDefined(backend.bootstrapTables)();
      recordSqliteDriver(client, log.sink, noFault);
      return {
        lane,
        backend,
        mark: log.mark,
        async inCallerTransaction(fn) {
          log.mark("BEGIN");
          client.exec("BEGIN IMMEDIATE");
          try {
            await fn(backend.adoptTransaction(db));
          } catch (error) {
            log.mark("ROLLBACK");
            client.exec("ROLLBACK");
            throw error;
          }
          log.mark("COMMIT");
          client.exec("COMMIT");
        },
        inSynchronousCallerTransaction(fn) {
          db.transaction((tx) => {
            log.mark("transaction callback starts");
            try {
              fn(backend.adoptTransaction(tx));
            } finally {
              log.mark("transaction callback exits");
            }
          });
        },
        trace: log.trace,
        close: () => {
          client.close();
          return Promise.resolve();
        },
      };
    }
    case "libsql": {
      const directory = mkdtempSync(path.join(tmpdir(), "typegraph-parity-"));
      const client = createClient({
        url: `file:${path.join(directory, "graph.db")}`,
      });
      const { backend } = await createLibsqlBackend(client);
      await requireDefined(backend.bootstrapTables)();
      recordLibsqlClient(client, log.sink, noFault);
      const db = drizzleLibsql(client);
      return {
        lane,
        backend: backend as AdapterBackend<unknown>,
        mark: log.mark,
        async inCallerTransaction(fn) {
          log.mark("BEGIN");
          await db.transaction(async (tx) => {
            await fn(backend.adoptTransaction(tx));
            log.mark("callback returns");
          });
        },
        inSynchronousCallerTransaction: undefined,
        trace: log.trace,
        close: () => {
          client.close();
          rmSync(directory, { recursive: true, force: true });
          return Promise.resolve();
        },
      };
    }
    case "pglite": {
      const client = await PGlite.create();
      const db = drizzlePglite(client);
      const backend = createPostgresBackend(db) as AdapterBackend<unknown>;
      await requireDefined(backend.bootstrapTables)();
      recordPgliteDriver(client, log.sink, noFault);
      return {
        lane,
        backend,
        mark: log.mark,
        async inCallerTransaction(fn) {
          log.mark("BEGIN");
          await db.transaction(async (tx) => {
            await fn(backend.adoptTransaction(tx));
            log.mark("callback returns");
          });
        },
        inSynchronousCallerTransaction: undefined,
        trace: log.trace,
        close: () => client.close(),
      };
    }
  }
}

function node(id: string): InsertNodeParams {
  return { graphId: GRAPH_ID, kind: "Item", id, props: { label: id } };
}

/**
 * A settled call as `"fulfilled"`, its TypeGraph error class, or
 * `"untyped: "` and the first line of the driver's message (the rest carries
 * the statement text and its parameters).
 */
function describeOutcome(error: unknown): string {
  if (error instanceof TypeGraphError) return error.name;
  return `untyped: ${String(error).split("\n")[0]?.trim() ?? ""}`;
}

/** Collects each named call's outcome as it settles. */
function createOutcomes(): Readonly<{
  track: (name: string, pending: Promise<unknown>) => Promise<void>;
  record: () => Readonly<Record<string, string>>;
}> {
  const outcomes: Record<string, string> = {};
  return {
    track: (name, pending) =>
      pending.then(
        () => {
          outcomes[name] = "fulfilled";
        },
        (error: unknown) => {
          outcomes[name] = describeOutcome(error);
        },
      ),
    record: () =>
      Object.fromEntries(
        Object.entries(outcomes).toSorted(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
  };
}

type CellContext = Readonly<{
  harness: Harness;
  track: (name: string, pending: Promise<unknown>) => Promise<void>;
}>;

/** One interleaving; `undefined` when the lane cannot express it. */
type Cell = (context: CellContext) => Promise<void> | undefined;

const ABORT = "the callback fails";

/** The fixed script. Every cell runs on a fresh connection. */
const CELLS: Readonly<Record<string, Cell>> = {
  "owned: two writes, commit": ({ harness, track }) =>
    track(
      "transaction",
      harness.backend.transaction(async (tx) => {
        await track("a1", tx.insertNode(node("a1")));
        await track("a2", tx.insertNode(node("a2")));
      }),
    ),

  "owned: a write, then the callback rejects": ({ harness, track }) =>
    track(
      "transaction",
      harness.backend.transaction(async (tx) => {
        await track("a1", tx.insertNode(node("a1")));
        throw new Error(ABORT);
      }),
    ),

  "owned: two writes submitted in one turn, commit": ({ harness, track }) =>
    track(
      "transaction",
      harness.backend.transaction(async (tx) => {
        await Promise.all([
          track("a1", tx.insertNode(node("a1"))),
          track("a2", tx.insertNode(node("a2"))),
        ]);
      }),
    ),

  "owned: a write the callback leaves running, commit": async ({
    harness,
    track,
  }) => {
    let left: Promise<void> = Promise.resolve();
    await track(
      "transaction",
      harness.backend.transaction((tx) => {
        left = track("left running", tx.insertNode(node("a1")));
        return Promise.resolve();
      }),
    );
    await left;
  },

  "owned: a Promise.all whose sibling rejects leaves a write running": async ({
    harness,
    track,
  }) => {
    let orphan: Promise<void> = Promise.resolve();
    await track(
      "transaction",
      harness.backend.transaction(async (tx) => {
        await tx.insertNode(node("a1"));
        orphan = track("orphan", tx.insertNode(node("orphan")));
        // A duplicate id: the statement fails.
        await Promise.all([tx.insertNode(node("a1")), orphan]);
      }),
    );
    await orphan;
  },

  "owned: a kept backend writes after commit": async ({ harness, track }) => {
    let kept: TransactionBackend | undefined;
    await track(
      "transaction",
      harness.backend.transaction((tx) => {
        kept = tx;
        return Promise.resolve();
      }),
    );
    await track("late", requireDefined(kept).insertNode(node("late")));
  },

  "owned: a kept backend writes inside the next transaction": async ({
    harness,
    track,
  }) => {
    let kept: TransactionBackend | undefined;
    await track(
      "first",
      harness.backend.transaction((tx) => {
        kept = tx;
        return Promise.resolve();
      }),
    );
    await track(
      "second",
      harness.backend.transaction(async (tx) => {
        await track("late", requireDefined(kept).insertNode(node("late")));
        await track("b1", tx.insertNode(node("b1")));
        throw new Error(ABORT);
      }),
    );
  },

  "owned: the callback keeps its backend and throws synchronously": async ({
    harness,
    track,
  }) => {
    let kept: TransactionBackend | undefined;
    await track(
      "transaction",
      harness.backend.transaction((tx) => {
        kept = tx;
        throw new Error(ABORT);
      }),
    );
    await track("late", requireDefined(kept).insertNode(node("late")));
  },

  "two views: A1, A2 through the transaction, B1 through an adoption of its native handle":
    async ({ harness, track }) => {
      await track(
        "transaction",
        harness.backend.transactionWithNative(async (tx, native) => {
          const adopted = harness.backend.adoptTransaction(native);
          const first = track("A1", tx.insertNode(node("a1")));
          const second = track("A2", tx.insertNode(node("a2")));
          const count = adopted
            .execute<{ count: number | string }>(
              asCompiledRowsSql(
                sql`SELECT COUNT(*) AS count FROM ${sql.identifier(requireDefined(harness.backend.tableNames).nodes)} WHERE graph_id = ${GRAPH_ID}`,
              ),
            )
            .then((rows) => {
              harness.mark(`B1 counted ${String(rows[0]?.count)}`);
            });
          await Promise.all([first, second, track("B1", count)]);
        }),
      );
    },

  "adopted: two writes in one turn, the caller commits": ({ harness, track }) =>
    track(
      "caller transaction",
      harness.inCallerTransaction(async (adopted) => {
        await Promise.all([
          track("a1", adopted.insertNode(node("a1"))),
          track("a2", adopted.insertNode(node("a2"))),
        ]);
      }),
    ),

  "adopted: a write, then the caller rolls back": ({ harness, track }) =>
    track(
      "caller transaction",
      harness.inCallerTransaction(async (adopted) => {
        await track("a1", adopted.insertNode(node("a1")));
        throw new Error(ABORT);
      }),
    ),

  "adopted: a kept adoption writes after the caller committed": async ({
    harness,
    track,
  }) => {
    let kept: TransactionBackend | undefined;
    await track(
      "caller transaction",
      harness.inCallerTransaction((adopted) => {
        kept = adopted;
        return Promise.resolve();
      }),
    );
    await track("late", requireDefined(kept).insertNode(node("late")));
  },

  "synchronous caller transaction: two adopted writes, then the callback throws":
    ({ harness, track }) => {
      const run = harness.inSynchronousCallerTransaction;
      if (run === undefined) return;
      const pending: Promise<void>[] = [];
      try {
        run((adopted) => {
          pending.push(
            track("w1", adopted.insertNode(node("w1"))),
            track("w2", adopted.insertNode(node("w2"))),
          );
          throw new Error(ABORT);
        });
      } catch (error) {
        harness.mark(`transaction threw: ${describeOutcome(error)}`);
      }
      return Promise.all(pending).then(settled);
    },

  "synchronous caller transaction: two adopted writes, then the callback returns":
    ({ harness, track }) => {
      const run = harness.inSynchronousCallerTransaction;
      if (run === undefined) return;
      const pending: Promise<void>[] = [];
      run((adopted) => {
        pending.push(
          track("w1", adopted.insertNode(node("w1"))),
          track("w2", adopted.insertNode(node("w2"))),
        );
      });
      return Promise.all(pending).then(settled);
    },

  "trusted import: a kept session's batches after the import committed": ({
    harness,
    track,
  }) => {
    const trustedImport = harness.backend.trustedImport;
    if (trustedImport === undefined) return;
    return (async () => {
      let kept: TrustedImportSession | undefined;
      await track(
        "import",
        trustedImport(async (session) => {
          kept = session;
          await track("i1", session.insertNodes([node("i1")]));
        }),
      );
      const session = requireDefined(kept);
      await track("late batch", session.insertNodes([node("late")]));
      await track("late empty batch", session.insertNodes([]));
    })();
  },

  "engine: a statement's trigger ends the transaction, the callback writes on":
    ({ harness, track }) => {
      if (harness.lane === "pglite") return;
      return (async () => {
        const executeDdl = requireDefined(harness.backend.executeDdl);
        await executeDdl(
          `CREATE TRIGGER tg_parity_rollback BEFORE INSERT ON "${requireDefined(harness.backend.tableNames).nodes}"
           WHEN NEW.id = 'engine-rollback'
           BEGIN SELECT RAISE(ROLLBACK, 'engine ended the transaction'); END`,
        );
        await track(
          "transaction",
          harness.backend.transaction(async (tx) => {
            await track("a1", tx.insertNode(node("a1")));
            await track("failing", tx.insertNode(node("engine-rollback")));
            await track("later", tx.insertNode(node("later")));
          }),
        );
      })();
    },
};

/**
 * The cells that differ from main, each by one of the view's own rules. For
 * each, `branch` states the outcomes this branch produces; main's are in the
 * fixture. Every other cell equals main's record exactly.
 */
const DIVERGENT_CELLS: Readonly<
  Record<
    string,
    Readonly<{
      rule: string;
      lanes: readonly Lane[];
      branch: Readonly<Record<string, string>>;
    }>
  >
> = {
  "owned: a kept backend writes after commit": {
    rule: "(1a) a statement after TypeGraph committed is refused and never reaches the connection",
    // PostgreSQL's statement queue already refused it on main.
    lanes: ["better-sqlite3", "libsql"],
    branch: { late: "TransactionClosedError", transaction: "fulfilled" },
  },
  "owned: a kept backend writes inside the next transaction": {
    rule: "(1a) a statement after TypeGraph committed is refused, also while the next transaction is open",
    // PostgreSQL's statement queue already refused it on main.
    lanes: ["better-sqlite3", "libsql"],
    branch: {
      b1: "fulfilled",
      first: "fulfilled",
      late: "TransactionClosedError",
      second: "Error",
    },
  },
  "owned: the callback keeps its backend and throws synchronously": {
    rule: "(1c) a synchronous throw closes the view like a rejection; (1a) the later write is refused",
    // PostgreSQL's statement queue already refused it on main.
    lanes: ["better-sqlite3", "libsql"],
    branch: { late: "TransactionClosedError", transaction: "Error" },
  },
  "trusted import: a kept session's batches after the import committed": {
    rule: "(1d) trusted import runs through the view, empty batches included",
    lanes: ["better-sqlite3", "pglite"],
    branch: {
      i1: "fulfilled",
      import: "fulfilled",
      "late batch": "TransactionClosedError",
      "late empty batch": "TransactionClosedError",
    },
  },
};

/** A plain `Error` (the callback's own) as the outcome table records it. */
function normalizeOutcome(outcome: string): string {
  return outcome === `untyped: Error: ${ABORT}` ? "Error" : outcome;
}

async function runCell(
  lane: Lane,
  cell: Cell,
): Promise<CellRecord | undefined> {
  const harness = await openHarness(lane);
  try {
    const outcomes = createOutcomes();
    const done = cell({ harness, track: outcomes.track });
    if (done === undefined) return undefined;
    await done;
    const trace = harness.trace();
    const rows = await harness.backend.execute<{ id: string }>(
      asCompiledRowsSql(
        sql`SELECT id FROM ${sql.identifier(requireDefined(harness.backend.tableNames).nodes)} WHERE graph_id = ${GRAPH_ID} ORDER BY id`,
      ),
    );
    return {
      trace,
      outcomes: Object.fromEntries(
        Object.entries(outcomes.record()).map(([name, outcome]) => [
          name,
          normalizeOutcome(outcome),
        ]),
      ),
      rows: rows.map((row) => row.id),
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
  "transaction-view-trace-parity.main.json",
);

const RECORDING = process.env["TRACE_PARITY_RECORD"] === "1";

/** Where a recording run writes; the fixture unless redirected. */
const RECORDING_PATH = process.env["TRACE_PARITY_OUT"] ?? FIXTURE_PATH;

function readMainFixture(): Readonly<Record<Lane, LaneRecord>> {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Readonly<
    Record<Lane, LaneRecord>
  >;
}

describe("transaction statement traces match main outside the view's own rules", () => {
  if (RECORDING) {
    it("records main's traces", async () => {
      const recorded: Partial<Record<Lane, LaneRecord>> = {};
      for (const lane of LANES) recorded[lane] = await recordLane(lane);
      writeFileSync(
        RECORDING_PATH,
        `${JSON.stringify(recorded, undefined, 2)}\n`,
      );
    }, 600_000);
    return;
  }

  it.each(LANES)(
    "%s: every cell equals main's, except the view's own divergences",
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
    240_000,
  );
});
