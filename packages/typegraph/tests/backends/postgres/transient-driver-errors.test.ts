import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { createStoreWithSchema, defineGraph } from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { createPostgresBackend } from "../../../src/backend/postgres";
import {
  captureStoreOperationTarget,
  operateStore,
} from "../../../src/graph-merge";
import { isTransientDatabaseError } from "../../../src/utils/sql-errors";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const enabled = process.env["POSTGRES_URL"] !== undefined;
let connectionString: string | undefined;
beforeAll(async () => {
  if (enabled)
    connectionString = await provisionPostgresTestDatabase(import.meta.url);
});

/** Replay the actual driver error through the PostgreSQL Store's transaction boundary. */
async function assertStoreRetryable(
  error: unknown,
  retryable = true,
): Promise<void> {
  if (!enabled) return;
  const pool = new Pool({ connectionString });
  const backend = createPostgresBackend(drizzle(pool));
  let armed = false;
  try {
    const graph = defineGraph({
      id: "pg_transport_retry",
      nodes: {},
      edges: {},
    });
    const [store] = await createStoreWithSchema(
      graph,
      deriveBackend(backend, {
        async transaction(callback, options) {
          if (armed) throw error;
          return backend.transaction(callback, options);
        },
      }),
      { history: true },
    );
    const request = {
      target: await captureStoreOperationTarget(store),
      idempotencyKey: "retry-driver-error",
      metadata: {},
      mutation: {},
    };
    armed = true;
    expect(
      await operateStore(store, request, () =>
        Promise.reject(
          new Error("failed acquisition must not invoke mutation"),
        ),
      ),
    ).toMatchObject({
      success: false,
      error: {
        name: "StoreOperationError",
        retryable,
        attemptOutcome: "not-committed",
      },
    });
  } finally {
    await backend.close();
    await pool.end();
  }
}

describe("node-postgres transient errors", () => {
  it("does not retry the driver's intentionally closed-client refusal", async () => {
    const client = new Client();
    await client.end();
    const error: unknown = await client
      .query("SELECT 1")
      .catch((error_: unknown) => error_);
    expect(error).toMatchObject({
      message: "Client was closed and is not queryable",
    });
    expect(isTransientDatabaseError(error)).toBe(false);
    await assertStoreRetryable(error, false);
  });

  it.skipIf(!enabled)(
    "recognizes a terminated in-flight connection",
    async () => {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        const pending = client
          .query("SELECT pg_sleep(30)")
          .catch((error_: unknown) => error_);
        await client.end();
        const error: unknown = await pending;
        expect(error).toMatchObject({ message: "Connection terminated" });
        expect(isTransientDatabaseError(error)).toBe(true);
        await assertStoreRetryable(error);
      } finally {
        await client.end();
      }
    },
  );

  it.skipIf(!enabled)(
    "recognizes a real pool acquisition timeout",
    async () => {
      const pool = new Pool({
        connectionString,
        max: 1,
        connectionTimeoutMillis: 1000,
      });
      const held = await pool.connect();
      try {
        const error: unknown = await pool
          .query("SELECT 1")
          .catch((error_: unknown) => error_);
        expect(error).toMatchObject({
          message: "timeout exceeded when trying to connect",
        });
        expect(isTransientDatabaseError(error)).toBe(true);
        await assertStoreRetryable(error);
      } finally {
        held.release();
        await pool.end();
      }
    },
  );
  it.skipIf(!enabled)(
    "recognizes the codeless refusal after a server-terminated idle client",
    async () => {
      const client = new Client({ connectionString });
      const controller = new Client({ connectionString });
      await client.connect();
      await controller.connect();
      try {
        const pid = await client.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const disconnected = new Promise<Error>((resolve) => {
          client.on("error", resolve);
        });
        await controller.query("SELECT pg_terminate_backend($1)", [
          pid.rows[0]?.pid,
        ]);
        await disconnected;
        const error: unknown = await client
          .query("SELECT 1")
          .catch((error_: unknown) => error_);
        expect(error).toMatchObject({
          message:
            "Client has encountered a connection error and is not queryable",
        });
        expect(isTransientDatabaseError(error)).toBe(true);
        await assertStoreRetryable(error);
      } finally {
        await client.end();
        await controller.end();
      }
    },
  );
});
