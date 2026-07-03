/**
 * Per-driver bound-parameter budget detection.
 *
 * SQLite's classic compiled-in ceiling was 999 bound parameters; SQLite
 * 3.32.0 raised the default `SQLITE_MAX_VARIABLE_NUMBER` to 32,766 and
 * better-sqlite3 compiles it in explicitly. Cloudflare D1 caps statements at
 * ~100 bound parameters. The backend must detect the real budget per driver
 * (batch chunk math derives from it) instead of assuming the historic 999:
 * too low wastes ~33× round trips on bulk inserts; too high breaks D1.
 */
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineGraph, defineNode } from "../../../src";
import { computeSqliteBatchChunkSizes } from "../../../src/backend/drizzle/sqlite";
import { createLibsqlBackend } from "../../../src/backend/sqlite/libsql";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import {
  SQLITE_MAX_BIND_PARAMETERS,
  wrapWithManagedClose,
} from "../../../src/backend/types";
import { createTestBackend } from "../../test-utils";

const MODERN_BETTER_SQLITE3_BUDGET = 32_766;

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), index: z.number() }),
});

const graph = defineGraph({
  id: "bind-budget",
  nodes: { Person: { type: Person } },
  edges: {},
});

describe("SQLite bind-parameter budget detection", () => {
  it("detects better-sqlite3's compiled-in 32,766 budget", () => {
    const backend = createTestBackend();
    expect(backend.capabilities.maxBindParameters).toBe(
      MODERN_BETTER_SQLITE3_BUDGET,
    );
  });

  it("keeps the conservative 999 floor for async drivers (libsql)", async () => {
    const client = createClient({ url: ":memory:" });
    const { backend } = await createLibsqlBackend(client);
    const managed = wrapWithManagedClose(backend, () => {
      client.close();
    });
    try {
      expect(managed.capabilities.maxBindParameters).toBe(
        SQLITE_MAX_BIND_PARAMETERS,
      );
    } finally {
      await managed.close();
    }
  });

  it("honors an explicit capabilities override", async () => {
    const { backend } = createLocalSqliteBackend({
      capabilities: { maxBindParameters: 45 },
    });
    try {
      expect(backend.capabilities.maxBindParameters).toBe(45);

      // Batch chunk math derives from the override: 45 params → 5-row node
      // insert chunks, so 30 creates must span multiple chunks and still
      // round-trip intact.
      const store = createStore(graph, backend);
      const created = await store.nodes.Person.bulkCreate(
        Array.from({ length: 30 }, (_, index) => ({
          props: { name: `person-${index}`, index },
        })),
      );
      expect(created).toHaveLength(30);
    } finally {
      await backend.close();
    }
  });

  it("bulk-creates beyond the historic 999-parameter budget in one call", async () => {
    // 1,000 rows × 9 insert params = 9,000 bound parameters — impossible in
    // a single chunk under the old 999 ceiling, comfortably one chunk under
    // the detected better-sqlite3 budget.
    const backend = createTestBackend();
    const store = createStore(graph, backend);

    const created = await store.nodes.Person.bulkCreate(
      Array.from({ length: 1000 }, (_, index) => ({
        props: { name: `person-${index}`, index },
      })),
    );

    expect(created).toHaveLength(1000);
    const last = await store.nodes.Person.getById(created[999]!.id);
    expect(last?.index).toBe(999);
  });
});

describe("computeSqliteBatchChunkSizes", () => {
  it("reproduces the historic chunk sizes at the 999 floor", () => {
    expect(computeSqliteBatchChunkSizes(999)).toEqual({
      checkUniqueBatchChunkSize: 996,
      edgeInsertBatchSize: 83,
      getEdgesChunkSize: 998,
      getNodesChunkSize: 997,
      nodeInsertBatchSize: 111,
    });
  });

  it("scales chunk sizes with the modern budget", () => {
    expect(computeSqliteBatchChunkSizes(MODERN_BETTER_SQLITE3_BUDGET)).toEqual({
      checkUniqueBatchChunkSize: 32_763,
      edgeInsertBatchSize: 2730,
      getEdgesChunkSize: 32_765,
      getNodesChunkSize: 32_764,
      nodeInsertBatchSize: 3640,
    });
  });

  it("never returns a chunk size below one", () => {
    expect(computeSqliteBatchChunkSizes(1)).toEqual({
      checkUniqueBatchChunkSize: 1,
      edgeInsertBatchSize: 1,
      getEdgesChunkSize: 1,
      getNodesChunkSize: 1,
      nodeInsertBatchSize: 1,
    });
  });
});
