import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

import {
  type AnySqliteDatabase,
  createSqliteExecutionAdapter,
  ORDERED_AGGREGATE_PROBE_SQL,
} from "../src/backend/drizzle/execution/sqlite-execution";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { POSTGRES_CAPABILITIES } from "../src/backend/types";
import { createTestDatabase } from "./test-utils";

describe("ordered aggregate capability", () => {
  it("earns support from a successful synchronous SQLite prepare probe", () => {
    const adapter = createSqliteExecutionAdapter(createTestDatabase());

    expect(adapter.profile.orderedAggregates).toBe(true);
  });

  it("stays unsupported when the synchronous SQLite probe fails", () => {
    const db = {
      $client: {
        prepare(): never {
          throw new Error("unsupported syntax");
        },
      },
      get: () => ({ __typegraph_sync_probe__: 1 }),
    } as unknown as AnySqliteDatabase;

    const adapter = createSqliteExecutionAdapter(db, {
      profileHints: { isSync: true },
    });

    expect(adapter.profile.orderedAggregates).toBe(false);
  });

  it("does not infer support for an asynchronous SQLite connection", () => {
    const adapter = createSqliteExecutionAdapter(createTestDatabase(), {
      profileHints: { isSync: false },
    });

    expect(adapter.profile.orderedAggregates).toBe(false);
  });

  it("declares the result of the bundled asynchronous libSQL probe", async () => {
    const client = createClient({ url: "file::memory:" });
    try {
      const supported = await client
        .execute(ORDERED_AGGREGATE_PROBE_SQL)
        .then(() => true)
        .catch(() => false);
      const { backend } = await createLibsqlBackend(client);

      expect(backend.capabilities.orderedAggregates).toBe(supported);
    } finally {
      client.close();
    }
  });

  it("lets explicit SQLite declarations override the detected capability", () => {
    const db = createTestDatabase();
    const disabled = createSqliteBackend(db, {
      capabilities: { orderedAggregates: false },
    });
    const enabled = createSqliteBackend(db, {
      executionProfile: { isSync: false },
      capabilities: { orderedAggregates: true },
    });

    expect(disabled.capabilities.orderedAggregates).toBe(false);
    expect(enabled.capabilities.orderedAggregates).toBe(true);
  });

  it("declares support for bundled PostgreSQL", () => {
    expect(POSTGRES_CAPABILITIES.orderedAggregates).toBe(true);
  });
});
