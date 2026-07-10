/**
 * `createSerialExecutionAdapter` — the per-connection statement queue that
 * transaction-scoped backends wrap their execution adapter in.
 *
 * A pinned Postgres connection carries exactly one statement at a time.
 * node-postgres used to hide that behind `Client._queryQueue`; it deprecated
 * the behavior in 8.22 and removes it in pg@9, so the queue has to live here.
 * These tests pin the three properties the deprecation notice asks for:
 * mutual exclusion, submission-order execution, and no poisoning after a
 * statement fails.
 */
import { type SQL, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createSerialExecutionAdapter } from "../src/backend/drizzle/execution/statement-queue";
import {
  type CompiledSqlQuery,
  type SqlExecutionAdapter,
} from "../src/backend/drizzle/execution/types";
import { TransactionClosedError } from "../src/errors";

/** Labels the probe adapter reads back off a `SQL` it was handed. */
const STATEMENT_LABELS = new WeakMap<SQL, string>();

function statement(label: string): SQL {
  const query = sql.raw(label);
  STATEMENT_LABELS.set(query, label);
  return query;
}

function labelOf(query: SQL): string {
  const label = STATEMENT_LABELS.get(query);
  if (label === undefined) throw new Error("unlabelled statement");
  return label;
}

type Trace = Readonly<{
  /** Every `execute`/`executeCompiled`/`prepare().execute` label, in start order. */
  started: string[];
  /** Labels of statements that completed, in completion order. */
  finished: string[];
  /** Highest number of statements simultaneously in flight. */
  maxInFlight: number;
}>;

/**
 * A fake adapter whose statements resolve on an explicit deferred, so a test
 * can hold one "on the wire" and observe whether a second reaches the
 * connection while it is open.
 */
function createProbeAdapter(): Readonly<{
  adapter: SqlExecutionAdapter;
  trace: Trace;
  /** Resolves the pending statement labelled `label`. */
  settle: (label: string, error?: Error) => void;
}> {
  const trace = { started: [], finished: [], maxInFlight: 0 } as {
    started: string[];
    finished: string[];
    maxInFlight: number;
  };
  const pending = new Map<
    string,
    Readonly<{ resolve: () => void; reject: (error: Error) => void }>
  >();
  let inFlight = 0;

  function run(label: string): Promise<readonly never[]> {
    trace.started.push(label);
    inFlight += 1;
    trace.maxInFlight = Math.max(trace.maxInFlight, inFlight);
    return new Promise<readonly never[]>((resolve, reject) => {
      pending.set(label, {
        resolve: () => {
          inFlight -= 1;
          trace.finished.push(label);
          resolve([]);
        },
        reject: (error: Error) => {
          inFlight -= 1;
          trace.finished.push(label);
          reject(error);
        },
      });
    });
  }

  const adapter: SqlExecutionAdapter = {
    compile(query: SQL): CompiledSqlQuery {
      return { sql: labelOf(query), params: [] };
    },
    execute<TRow>(query: SQL): Promise<readonly TRow[]> {
      return run(labelOf(query));
    },
    executeCompiled<TRow>(
      compiledQuery: CompiledSqlQuery,
    ): Promise<readonly TRow[]> {
      return run(compiledQuery.sql);
    },
    prepare(sqlText: string) {
      return {
        execute<TRow>(): Promise<readonly TRow[]> {
          return run(sqlText);
        },
      };
    },
  };

  return {
    adapter,
    trace,
    settle(label: string, error?: Error): void {
      const deferred = pending.get(label);
      if (deferred === undefined) {
        throw new Error(`no pending statement labelled "${label}"`);
      }
      pending.delete(label);
      if (error) deferred.reject(error);
      else deferred.resolve();
    },
  };
}

/** Lets every already-queued microtask drain before assertions. */
async function drainMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createSerialExecutionAdapter", () => {
  it("holds a second statement until the first settles", async () => {
    const probe = createProbeAdapter();
    const serial = createSerialExecutionAdapter(probe.adapter);

    const first = serial.execute(statement("a"));
    const second = serial.execute(statement("b"));
    await drainMicrotasks();

    expect(probe.trace.started).toEqual(["a"]);

    probe.settle("a");
    await first;
    await drainMicrotasks();

    expect(probe.trace.started).toEqual(["a", "b"]);
    probe.settle("b");
    await second;
    expect(probe.trace.maxInFlight).toBe(1);
  });

  it("keeps `Promise.all` submission order — the write pipeline's shape", async () => {
    const probe = createProbeAdapter();
    const serial = createSerialExecutionAdapter(probe.adapter);

    const all = Promise.all([
      serial.execute(statement("embeddings")),
      serial.execute(statement("fulltext")),
    ]);

    await drainMicrotasks();
    expect(probe.trace.started).toEqual(["embeddings"]);
    probe.settle("embeddings");

    await drainMicrotasks();
    expect(probe.trace.started).toEqual(["embeddings", "fulltext"]);
    probe.settle("fulltext");

    await all;
    expect(probe.trace.finished).toEqual(["embeddings", "fulltext"]);
    expect(probe.trace.maxInFlight).toBe(1);
  });

  it("serializes across execute, executeCompiled, and prepared statements", async () => {
    const probe = createProbeAdapter();
    const serial = createSerialExecutionAdapter(probe.adapter);

    const prepared = serial.prepare?.("prepared");
    expect(prepared).toBeDefined();

    const running = Promise.all([
      serial.execute(statement("execute")),
      serial.executeCompiled?.({ sql: "compiled", params: [] }),
      prepared?.execute([]),
    ]);

    for (const label of ["execute", "compiled", "prepared"]) {
      await drainMicrotasks();
      expect(probe.trace.started.at(-1)).toBe(label);
      probe.settle(label);
    }

    await running;
    expect(probe.trace.maxInFlight).toBe(1);
  });

  it("does not strand the queue when a statement rejects", async () => {
    const probe = createProbeAdapter();
    const serial = createSerialExecutionAdapter(probe.adapter);

    const failing = serial.execute(statement("boom"));
    const following = serial.execute(statement("survivor"));

    await drainMicrotasks();
    probe.settle("boom", new Error("statement failed"));
    await expect(failing).rejects.toThrow("statement failed");

    await drainMicrotasks();
    expect(probe.trace.started).toEqual(["boom", "survivor"]);
    probe.settle("survivor");
    await expect(following).resolves.toEqual([]);
  });

  it("omits executeCompiled and prepare when the wrapped adapter lacks them", () => {
    const bare: SqlExecutionAdapter = {
      compile: () => ({ sql: "", params: [] }),
      execute: () => Promise.resolve([]),
    };
    const serial = createSerialExecutionAdapter(bare);

    // A Drizzle transaction carries no `$client`, so the Postgres adapter
    // falls back to the session path and exposes neither member. The wrapper
    // must not synthesize them — `executeRaw` presence is derived from this.
    expect(serial.executeCompiled).toBeUndefined();
    expect(serial.prepare).toBeUndefined();
    expect(Object.hasOwn(serial, "executeCompiled")).toBe(false);
    expect(Object.hasOwn(serial, "prepare")).toBe(false);
  });

  it("drainAndClose waits for the statement on the wire", async () => {
    const probe = createProbeAdapter();
    const serial = createSerialExecutionAdapter(probe.adapter);

    const running = serial.execute(statement("on-the-wire"));
    await drainMicrotasks();

    let drained = false;
    const draining = serial.drainAndClose().then(() => {
      drained = true;
    });

    await drainMicrotasks();
    expect(drained).toBe(false);

    probe.settle("on-the-wire");
    await running;
    await draining;
    expect(drained).toBe(true);
  });

  it("drainAndClose refuses statements an orphaned caller issues afterwards", async () => {
    const probe = createProbeAdapter();
    const serial = createSerialExecutionAdapter(probe.adapter);

    await serial.drainAndClose();

    // Exactly the shape a `Promise.all` sibling takes after its peer rejected:
    // it resumes, issues its next statement, and must be turned away rather
    // than land on a connection the pool has already reclaimed.
    await expect(serial.execute(statement("orphan"))).rejects.toThrow(
      TransactionClosedError,
    );
    expect(probe.trace.started).toEqual([]);
  });

  it("drainAndClose closes before draining, so a resumed statement cannot slip in", async () => {
    const probe = createProbeAdapter();
    const serial = createSerialExecutionAdapter(probe.adapter);

    // An orphan that enqueues its successor the moment its predecessor settles.
    const orphan = serial
      .execute(statement("first"))
      .then(() => serial.execute(statement("second")));

    await drainMicrotasks();
    const draining = serial.drainAndClose();
    probe.settle("first");

    await draining;
    await expect(orphan).rejects.toThrow(TransactionClosedError);
    expect(probe.trace.started).toEqual(["first"]);
  });

  it("drainAndClose is idempotent", async () => {
    const probe = createProbeAdapter();
    const serial = createSerialExecutionAdapter(probe.adapter);

    await serial.drainAndClose();
    await expect(serial.drainAndClose()).resolves.toBeUndefined();
  });

  it("leaves compile synchronous and unqueued", async () => {
    const probe = createProbeAdapter();
    const serial = createSerialExecutionAdapter(probe.adapter);

    // A statement is parked on the wire; compile must not wait behind it.
    const parked = serial.execute(statement("parked"));
    await drainMicrotasks();

    expect(serial.compile(statement("compiled-while-busy"))).toEqual({
      sql: "compiled-while-busy",
      params: [],
    });

    probe.settle("parked");
    await parked;
  });
});
