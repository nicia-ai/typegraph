/**
 * Recorded-time capture closes intervals with `UPDATE … RETURNING` on its hot
 * path (`closeOpenReturning`). A backend that
 * cannot run RETURNING would otherwise pass construction and fail mid-flush with
 * a raw SQL syntax error — after the live row is already written. These tests
 * pin that the gate refuses such a backend up front, with a clear capability
 * error, the moment `{ history: true }` is requested.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineGraph, defineNode } from "../src";
import type { GraphBackend } from "../src/backend/types";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "recorded-capability-gate",
  nodes: { Person: { type: Person } },
  edges: {},
});

function backendWithReturning(returning?: boolean): GraphBackend {
  const base = createTestBackend();
  // Drop the base flag so each case controls `returning` explicitly — omitting
  // it is the "undeclared" case the gate must treat as supported.
  const { returning: _baseReturning, ...capabilities } = base.capabilities;
  return {
    ...base,
    capabilities:
      returning === undefined ? capabilities : { ...capabilities, returning },
  };
}

function postgresLikeBackend(): GraphBackend {
  return { ...backendWithReturning(true), dialect: "postgres" };
}

function backendWithoutTransactions(): GraphBackend {
  const base = createTestBackend();
  return {
    ...base,
    capabilities: { ...base.capabilities, transactions: false },
  };
}

function backendWithoutExecuteStatement(): GraphBackend {
  const base = createTestBackend();
  const { executeStatement: _executeStatement, ...withoutExecuteStatement } =
    base;
  return withoutExecuteStatement;
}

function backendWithoutTableNames(): GraphBackend {
  const base = createTestBackend();
  const { tableNames: _tableNames, ...withoutTableNames } = base;
  return withoutTableNames;
}

function backendWithoutRevisionOriginsTableBootstrap(): GraphBackend {
  const base = createTestBackend();
  const {
    ensureRevisionOriginsTable: _ensureRevisionOriginsTable,
    ...withoutRevisionOriginsTableBootstrap
  } = base;
  return withoutRevisionOriginsTableBootstrap;
}

describe("recorded-time capture capability gate", () => {
  it("refuses { history: true } when the backend declares no RETURNING support", () => {
    expect(() =>
      createStore(graph, backendWithReturning(false), { history: true }),
    ).toThrow(/RETURNING/u);
  });

  it("accepts a backend that declares RETURNING support", () => {
    expect(() =>
      createStore(graph, backendWithReturning(true), { history: true }),
    ).not.toThrow();
  });

  it("accepts a backend that leaves RETURNING support undeclared (defaults to supported)", () => {
    expect(() =>
      createStore(graph, backendWithReturning(), { history: true }),
    ).not.toThrow();
  });

  it("does not gate on RETURNING when history capture is disabled", () => {
    expect(() => createStore(graph, backendWithReturning(false))).not.toThrow();
  });

  it("refuses revision tracking without transactions", () => {
    expect(() =>
      createStore(graph, backendWithoutTransactions(), {
        revisionTracking: true,
      }),
    ).toThrow("requires a backend with transaction support");
  });

  it("refuses revision tracking without executeStatement", () => {
    expect(() =>
      createStore(graph, backendWithoutExecuteStatement(), {
        revisionTracking: true,
      }),
    ).toThrow("requires a backend that supports executeStatement");
  });

  it("refuses revision tracking without table names", () => {
    expect(() =>
      createStore(graph, backendWithoutTableNames(), {
        revisionTracking: true,
      }),
    ).toThrow("requires a backend that exposes tableNames");
  });

  it("refuses revision tracking without revision-origin table bootstrap", () => {
    expect(() =>
      createStore(graph, backendWithoutRevisionOriginsTableBootstrap(), {
        revisionTracking: true,
      }),
    ).toThrow("requires a backend that can bootstrap revision origins");
  });

  it("names the revision-anchor contract when it guards tx.sql", async () => {
    const store = createStore(graph, createTestBackend(), {
      revisionTracking: true,
    });

    await expect(
      store.transaction((tx) => {
        const sqlHandle = tx.sql as unknown as Readonly<{ insert: unknown }>;
        void sqlHandle.insert;
        return Promise.resolve();
      }),
    ).rejects.toThrow(
      "tx.sql is not available when revision tracking is enabled",
    );
  });

  it("retries revision-origin bootstrap after a transient failure", async () => {
    const base = createTestBackend();
    const ensureRevisionOriginsTable = base.ensureRevisionOriginsTable;
    if (ensureRevisionOriginsTable === undefined) {
      throw new Error("Test backend must bootstrap revision origins");
    }
    let bootstrapAttempts = 0;
    const backend: GraphBackend = {
      ...base,
      async ensureRevisionOriginsTable(): Promise<void> {
        bootstrapAttempts++;
        if (bootstrapAttempts === 1) {
          throw new Error("transient revision-origin DDL failure");
        }
        await ensureRevisionOriginsTable();
      },
    };
    const store = createStore(graph, backend, { revisionTracking: true });

    await expect(store.revisionOriginNow()).rejects.toThrow(
      "transient revision-origin DDL failure",
    );
    await expect(store.revisionOriginNow()).resolves.toEqual(
      expect.any(String),
    );
    expect(bootstrapAttempts).toBe(2);
  });

  it("refuses PostgreSQL snapshot isolation for history capture transactions", async () => {
    const store = createStore(graph, postgresLikeBackend(), { history: true });

    await expect(
      store.transaction(() => Promise.resolve("repeatable"), {
        isolationLevel: "repeatable_read",
      }),
    ).rejects.toThrow("requires read_committed isolation");
    await expect(
      store.transaction(() => Promise.resolve("serializable"), {
        isolationLevel: "serializable",
      }),
    ).rejects.toThrow("requires read_committed isolation");
  });

  it("allows snapshot isolation for read-only history transactions", async () => {
    const store = createStore(graph, postgresLikeBackend(), { history: true });

    await expect(
      store.transaction(() => Promise.resolve("snapshot"), {
        accessMode: "read_only",
        isolationLevel: "repeatable_read",
      }),
    ).resolves.toBe("snapshot");
  });
});
