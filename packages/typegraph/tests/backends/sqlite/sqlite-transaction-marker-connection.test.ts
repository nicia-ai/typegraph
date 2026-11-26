/**
 * A better-sqlite3 transaction shares the root's contribution-marker cache
 * only when it runs on the root's own connection.
 *
 * A caller can adopt a transaction on a second connection to the same WAL
 * database (`adoptTransaction` over a Drizzle database of another
 * `Database`). A deferred transaction there keeps the snapshot it pinned, so
 * a marker another connection recorded afterwards is visible to the root's
 * connection but not to the transaction, nor is the storage it attests. A
 * check answered by the root (or its cache) would authorize the transaction
 * to use storage it cannot see; the transaction's marker reads therefore run
 * on its own connection, as a libSQL transaction's do
 * (`libsql-transaction-marker-snapshot.test.ts`).
 *
 * better-sqlite3-specific wiring: the shared suite's better-sqlite3 lane is
 * one in-memory connection.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type BetterSqlite3Client from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import type { GraphBackend } from "../../../src/backend/types";
import { TypeGraphError } from "../../../src/errors";
import { requireDefined } from "../../../src/utils/presence";

const GRAPH_ID = "marker_connection";

/** A vector slot no schema declares, so only `createVectorIndex` provisions it. */
function slotParams(backend: GraphBackend) {
  return {
    graphId: GRAPH_ID,
    nodeKind: "Doc",
    fieldPath: "embedding",
    dimensions: 3,
    metric: "cosine",
    indexType:
      requireDefined(backend.capabilities.vector).indexTypes[0] ?? "none",
  } as const;
}

/** A failure as its error class, or `"untyped driver error"`. */
function outcomeOf(pending: Promise<unknown>): Promise<string> {
  return pending.then(
    () => "fulfilled",
    (error: unknown) =>
      error instanceof TypeGraphError ? error.name : "untyped driver error",
  );
}

describe("a better-sqlite3 transaction on another connection", () => {
  it("checks contribution markers against its own snapshot, not the root's cache", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "typegraph-marker-connection-"),
    );
    const databasePath = path.join(directory, "graph.db");
    const root = createLocalSqliteBackend({ path: databasePath });
    const provisioner = createLocalSqliteBackend({ path: databasePath });
    const caller = createLocalSqliteBackend({ path: databasePath });
    try {
      const params = slotParams(root.backend);
      const deleteParams = { ...params, nodeId: "d1" };
      const callerClient = (
        caller.db as unknown as Readonly<{
          $client: BetterSqlite3Client.Database;
        }>
      ).$client;
      /** A vector write through a caller's adopted deferred transaction. */
      async function writeThroughAdopted(
        beforeWrite: () => Promise<void>,
      ): Promise<string> {
        callerClient.prepare("BEGIN DEFERRED").run();
        try {
          // Pin the deferred transaction's snapshot.
          callerClient.prepare("SELECT COUNT(*) FROM sqlite_master").get();
          await beforeWrite();
          const tx = root.backend.adoptTransaction(caller.db);
          return await outcomeOf(
            requireDefined(tx.deleteEmbedding)(deleteParams),
          );
        } finally {
          callerClient.prepare("ROLLBACK").run();
        }
      }

      // Another connection provisions the slot after the snapshot was
      // pinned: the transaction sees neither its marker nor its storage.
      const olderSnapshot = await writeThroughAdopted(async () => {
        await requireDefined(provisioner.backend.createVectorIndex)(params);
      });
      // A snapshot taken after the provisioning sees both.
      const laterSnapshot = await writeThroughAdopted(() => Promise.resolve());
      expect({ olderSnapshot, laterSnapshot }).toEqual({
        olderSnapshot: "StoreNotInitializedError",
        laterSnapshot: "fulfilled",
      });
    } finally {
      await root.backend.close();
      await provisioner.backend.close();
      await caller.backend.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
