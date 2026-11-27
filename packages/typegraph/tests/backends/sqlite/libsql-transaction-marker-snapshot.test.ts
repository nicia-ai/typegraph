/**
 * A libSQL transaction checks contribution markers against its own snapshot.
 *
 * A libSQL transaction runs on a connection of its own, so the root backend's
 * marker reads run on another connection, at a later snapshot than a deferred
 * transaction pinned. TypeGraph's own libSQL transactions begin `IMMEDIATE`
 * (Drizzle's libSQL session opens every transaction in write mode), so no
 * other connection can commit inside one; a caller's deferred transaction,
 * adopted with `adoptTransaction`, can hold the older snapshot. A marker another client
 * recorded after that snapshot is visible to the root but not to the
 * transaction, nor is the storage it attests: a check answered by the root
 * (or by the root's cache) would authorize the transaction to write storage
 * it cannot see. The transaction's marker reads therefore run on its own
 * session, with a cache of their own.
 *
 * libSQL-specific wiring: better-sqlite3 runs every transaction on its one
 * connection, and PostgreSQL already binds marker reads to the transaction's
 * session.
 */
import { type Client, createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, describe, expect, it } from "vitest";

import { createLibsqlBackend } from "../../../src/backend/sqlite/libsql";
import type { GraphBackend } from "../../../src/backend/types";
import { TypeGraphError } from "../../../src/errors";
import { requireDefined } from "../../../src/utils/presence";
import { expectObservation } from "../../helpers/known-defect";
import {
  cleanupTemporaryFiles,
  createTemporaryDbPath,
} from "./libsql-temporary-database";

afterEach(cleanupTemporaryFiles);

const GRAPH_ID = "marker_snapshot";

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

describe("a libSQL transaction's contribution-marker check", () => {
  it("reads the transaction's own snapshot, not the root's", async () => {
    const path = createTemporaryDbPath();
    const client = createClient({ url: `file:${path}` });
    const provisionerClient = createClient({ url: `file:${path}` });
    // WAL, so a reader's snapshot does not block the other client's writes.
    await client.execute("PRAGMA journal_mode=WAL");
    const { backend } = await createLibsqlBackend(client);
    const { backend: provisioner } =
      await createLibsqlBackend(provisionerClient);
    try {
      const params = slotParams(backend);
      const deleteParams = { ...params, nodeId: "d1" };
      /** A vector write through a caller's adopted deferred transaction. */
      async function writeThroughAdopted(
        beforeWrite: () => Promise<void>,
      ): Promise<string> {
        const deferred = await client.transaction("deferred");
        try {
          // Pin the deferred transaction's snapshot.
          await deferred.execute("SELECT COUNT(*) FROM sqlite_master");
          await beforeWrite();
          const tx = backend.adoptTransaction(
            drizzle(deferred as unknown as Client),
          );
          return await outcomeOf(
            requireDefined(tx.deleteEmbedding)(deleteParams),
          );
        } finally {
          deferred.close();
        }
      }

      // Another client provisions the slot after the snapshot was pinned:
      // the transaction sees neither its marker nor its storage.
      const olderSnapshot = await writeThroughAdopted(async () => {
        await requireDefined(provisioner.createVectorIndex)(params);
      });
      // A snapshot taken after the provisioning sees both.
      const laterSnapshot = await writeThroughAdopted(() => Promise.resolve());
      expect({ olderSnapshot, laterSnapshot }).toEqual({
        olderSnapshot: "StoreNotInitializedError",
        laterSnapshot: "fulfilled",
      });
    } finally {
      await backend.close();
      await provisioner.close();
      client.close();
      provisionerClient.close();
    }
  });

  // A transaction TypeGraph opens asking for the writer slot on a local
  // client shares the root's marker cache, and a cold check reads on the
  // root client. A single-connection client (`file::memory:`, an embedded
  // replica) lends that one connection to the open transaction, so the read
  // fails. Main reads the same way and fails the same way; the trace-parity
  // fixture records it.
  it("reads a cold marker on the root client, which a single-connection client lends to the transaction (known limit)", async () => {
    const client = createClient({ url: "file::memory:" });
    try {
      const { backend: provisioner } = await createLibsqlBackend(client);
      const params = slotParams(provisioner);
      await requireDefined(provisioner.createVectorIndex)(params);
      // A fresh backend: no marker confirmation is cached.
      const { backend: fresh } = await createLibsqlBackend(client);
      const outcome = await fresh
        .transaction(async (tx) => {
          await requireDefined(tx.deleteEmbedding)({ ...params, nodeId: "d1" });
        })
        .then(
          () => "fulfilled",
          (error: unknown) =>
            String((error as Readonly<{ cause?: unknown }>).cause ?? error)
              .split(":")[1]
              ?.trim(),
        );
      expectObservation({
        lane: { driver: "libsql" },
        observed: outcome,
        correct: "fulfilled",
        defects: [
          {
            label: "single-connection cold marker read",
            on: { driver: ["libsql"] },
            today: "TRANSACTION_ACTIVE",
          },
        ],
      });
    } finally {
      client.close();
    }
  });

  // The same root-client read, on a client with a connection to spare (a
  // WAL file): after the transaction deletes a slot's marker and evicts it,
  // its next vector write re-reads the marker on the root client, which sees
  // the committed marker the transaction deleted, and is authorised by it.
  // Main reads the same way and authorises the same way.
  it("authorises a vector write with a marker the transaction deleted, read on the root client (known limit)", async () => {
    const path = createTemporaryDbPath();
    const client = createClient({ url: `file:${path}` });
    await client.execute("PRAGMA journal_mode=WAL");
    const { backend } = await createLibsqlBackend(client);
    try {
      const params = slotParams(backend);
      await requireDefined(backend.createVectorIndex)(params);
      let afterDelete = "not run";
      await backend.transaction(async (tx) => {
        await (
          tx as unknown as Readonly<{
            deleteSchemaVectorSlotContribution: (
              slot: typeof params,
            ) => Promise<void>;
          }>
        ).deleteSchemaVectorSlotContribution(params);
        afterDelete = await outcomeOf(
          requireDefined(tx.deleteEmbedding)({ ...params, nodeId: "d1" }),
        );
      });
      expectObservation({
        lane: { driver: "libsql" },
        observed: afterDelete,
        correct: "StoreNotInitializedError",
        defects: [
          {
            label: "writer-slot marker read on the root client",
            on: { driver: ["libsql"] },
            today: "fulfilled",
          },
        ],
      });
    } finally {
      await backend.close();
      client.close();
    }
  });
});
