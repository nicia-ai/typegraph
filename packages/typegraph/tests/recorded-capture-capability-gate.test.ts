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
});
