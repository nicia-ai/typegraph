/**
 * Recorded-time history capture — backend-level contract tests (F1a)
 * that don't fit the cross-backend integration suite:
 *
 * 1. **Byte-identical SQL when history is off.** The mutation path must
 *    emit the exact same statement with capture disabled, and add a
 *    capture (never alter the mutation) when enabled.
 * 2. **Best-effort capture on non-transactional backends.** A SQLite
 *    backend forced to `transactionMode: "none"` declares
 *    `capabilities.history: "best-effort"` and still records history
 *    (mutation-first, capture-second).
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineGraph, defineNode } from "../src";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), age: z.number() }),
});

const graph = defineGraph({
  id: "history_capture_test",
  nodes: { Person: { type: Person } },
  edges: {},
});

/**
 * A better-sqlite3 connection whose every prepared SQL string is recorded,
 * so a test can assert exactly which statements a mutation emits.
 */
function recordingBackend(): {
  backend: ReturnType<typeof createSqliteBackend>;
  sql: string[];
} {
  const native = new Database(":memory:");
  const sql: string[] = [];
  const originalPrepare = native.prepare.bind(native);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (native as any).prepare = (text: string) => {
    sql.push(text);
    return originalPrepare(text);
  };
  const backend = createSqliteBackend(drizzle(native), {
    executionProfile: { isSync: true, transactionMode: "sql" },
  });
  return { backend, sql };
}

function updateStatements(sql: readonly string[]): string[] {
  return sql.filter((text) => /update\s+"typegraph_nodes"/i.test(text));
}

function historyInserts(sql: readonly string[]): string[] {
  return sql.filter((text) =>
    /insert\s+into\s+"typegraph_node_history"/i.test(text),
  );
}

describe("history capture — byte-identical SQL when off", () => {
  it("emits the plain UPDATE and no capture when history is off", async () => {
    const { backend, sql } = recordingBackend();
    await backend.bootstrapTables!();
    const store = createStore(graph, backend); // history off
    const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });

    sql.length = 0;
    await store.nodes.Person.update(alice.id, { age: 31 });

    const updates = updateStatements(sql);
    expect(updates).toHaveLength(1);
    // No capture statement, and no transaction framing around the single op.
    expect(historyInserts(sql)).toHaveLength(0);
    expect(sql.some((text) => /^\s*begin/i.test(text))).toBe(false);
    await backend.close();
  });

  it("adds a capture but leaves the UPDATE statement byte-identical when on", async () => {
    // Off run — capture the exact UPDATE text.
    const off = recordingBackend();
    await off.backend.bootstrapTables!();
    const offStore = createStore(graph, off.backend);
    const offAlice = await offStore.nodes.Person.create({
      name: "Alice",
      age: 30,
    });
    off.sql.length = 0;
    await offStore.nodes.Person.update(offAlice.id, { age: 31 });
    const offUpdate = updateStatements(off.sql)[0];
    await off.backend.close();

    // On run — same UPDATE text, plus a history capture and tx framing.
    const on = recordingBackend();
    await on.backend.bootstrapTables!();
    const onStore = createStore(graph, on.backend, { history: true });
    const onAlice = await onStore.nodes.Person.create({
      name: "Alice",
      age: 30,
    });
    on.sql.length = 0;
    await onStore.nodes.Person.update(onAlice.id, { age: 31 });
    const onUpdate = updateStatements(on.sql)[0];

    // The mutation statement itself is unchanged — history only adds around it.
    expect(onUpdate).toBe(offUpdate);
    expect(historyInserts(on.sql)).toHaveLength(1);
    expect(on.sql.some((text) => /^\s*begin/i.test(text))).toBe(true);
    expect(on.sql.some((text) => /^\s*commit/i.test(text))).toBe(true);
    await on.backend.close();
  });
});

describe("history capture — best-effort on non-transactional backends", () => {
  it("declares best-effort and still captures (mutation-first)", async () => {
    const native = new Database(":memory:");
    const backend = createSqliteBackend(drizzle(native), {
      executionProfile: { transactionMode: "none" },
    });

    expect(backend.capabilities.transactions).toBe(false);
    expect(backend.capabilities.history).toBe("best-effort");

    // No schema commit is possible without transactions; bootstrap the
    // tables directly (DDL needs no transaction) and attach a sync store.
    await backend.bootstrapTables!();
    const store = createStore(graph, backend, { history: true });

    const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
    await store.nodes.Person.update(alice.id, { age: 31 });

    const history = await store.nodes.Person.history(alice.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.op).toBe("update");
    expect(history[0]?.image.age).toBe(30);

    await store.nodes.Person.delete(alice.id);
    const afterDelete = await store.nodes.Person.history(alice.id);
    expect(afterDelete.map((entry) => entry.op)).toEqual(["delete", "update"]);

    await backend.close();
  });
});
