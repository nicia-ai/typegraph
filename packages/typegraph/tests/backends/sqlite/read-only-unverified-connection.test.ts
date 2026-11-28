/**
 * A read-only transaction's native handle adopted again on a driver that
 * reports no transaction state.
 *
 * `@libsql/client` before 0.18 (like sql.js and Durable Object storage)
 * frames a TypeGraph transaction as raw BEGIN/COMMIT on its one connection,
 * hands the callback that connection's database handle as `tx.sql`, and
 * cannot say whether a transaction is open on it. Nothing proves which
 * transaction an adoption of that handle runs in, so the adoption gets a
 * native transaction state of its own (`native-transaction-handle.ts`). It
 * still must not write inside a transaction TypeGraph opened read-only: on
 * one connection every statement during that transaction's span runs in it,
 * so the adoption reads the read-only scope of the unverified engine
 * transaction running on its connection and is refused.
 */
import { createClient } from "libsql-client-017";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
} from "../../../src";
import { createLibsqlBackend } from "../../../src/backend/sqlite/libsql";
import { UnsupportedBackendCapabilityError } from "../../../src/errors-entry";
import type { AdapterStore } from "../../../src/store";
import { requireDefined } from "../../../src/utils/presence";

const Note = defineNode("UnverifiedNote", {
  schema: z.object({ body: z.string() }),
});

let graphCounter = 0;
function buildGraph() {
  graphCounter += 1;
  return defineGraph({
    id: `read_only_unverified_${graphCounter}`,
    nodes: { UnverifiedNote: { type: Note } },
    edges: {},
  });
}

type NoteStore = AdapterStore<ReturnType<typeof buildGraph>, unknown>;

async function openStores(count: number): Promise<{
  stores: readonly NoteStore[];
  close: () => Promise<void>;
}> {
  const client = createClient({ url: "file::memory:" });
  const { backend } = await createLibsqlBackend(client);
  const stores: NoteStore[] = [];
  for (let index = 0; index < count; index += 1) {
    const [store] = await createAdapterStoreWithSchema(buildGraph(), backend);
    stores.push(store as unknown as NoteStore);
  }
  return {
    stores,
    close: async () => {
      await backend.close();
      client.close();
    },
  };
}

function nativeHandle(tx: object): unknown {
  return requireDefined((tx as Readonly<{ sql?: unknown }>).sql);
}

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectReadOnlyRefusal(
  error: unknown,
  operation: string,
  graphId: string,
): void {
  expect(error).toBeInstanceOf(UnsupportedBackendCapabilityError);
  expect((error as UnsupportedBackendCapabilityError).details).toEqual({
    operation,
    capability: "write transaction access",
    graphId,
    accessMode: "read_only",
  });
}

describe("a read-only transaction's handle adopted again on @libsql/client 0.17", () => {
  it("refuses a write through store.withTransaction(tx.sql), and through a second binding of it", async () => {
    const {
      stores: [store, otherStore],
      close,
    } = await openStores(2);
    try {
      const first = requireDefined(store);
      const second = requireDefined(otherStore);
      let direct: unknown;
      let secondBinding: unknown;
      let recorded: unknown;
      await first.transaction(
        async (tx) => {
          direct = await rejectionOf(
            first
              .withTransaction(nativeHandle(tx))
              .nodes.UnverifiedNote.create({ body: "direct" }),
          );
          secondBinding = await rejectionOf(
            second
              .withTransaction(nativeHandle(tx))
              .nodes.UnverifiedNote.create({ body: "second" }),
          );
          recorded = await rejectionOf(
            first.withRecordedTransaction(nativeHandle(tx), async (adopted) => {
              await adopted.nodes.UnverifiedNote.create({ body: "recorded" });
            }),
          );
          // Still usable after every refusal.
          await tx.nodes.UnverifiedNote.find();
        },
        { accessMode: "read_only" },
      );
      expectReadOnlyRefusal(
        direct,
        "tx.nodes.UnverifiedNote.create()",
        first.graphId,
      );
      expectReadOnlyRefusal(
        secondBinding,
        "tx.nodes.UnverifiedNote.create()",
        second.graphId,
      );
      expectReadOnlyRefusal(
        recorded,
        "tx.nodes.UnverifiedNote.create()",
        first.graphId,
      );
      expect(await first.nodes.UnverifiedNote.find()).toEqual([]);
      expect(await second.nodes.UnverifiedNote.find()).toEqual([]);
    } finally {
      await close();
    }
  });

  it("keeps an adoption writable inside a read-write transaction and after the read-only one ended", async () => {
    const {
      stores: [store],
      close,
    } = await openStores(1);
    try {
      const only = requireDefined(store);
      let retained: unknown;
      await only.transaction(
        async (tx) => {
          retained = nativeHandle(tx);
          await tx.nodes.UnverifiedNote.find();
        },
        { accessMode: "read_only" },
      );
      await only.transaction(async (tx) => {
        await only
          .withTransaction(nativeHandle(tx))
          .nodes.UnverifiedNote.create({ body: "inside read-write" });
      });
      // The handle is the connection's: once the read-only span has ended,
      // an adoption outside any transaction writes in autocommit.
      await only
        .withTransaction(retained)
        .nodes.UnverifiedNote.create({ body: "after the span" });
      const notes = await only.nodes.UnverifiedNote.find();
      const bodies = notes.map((note) => note.body);
      expect(bodies.toSorted()).toEqual([
        "after the span",
        "inside read-write",
      ]);
    } finally {
      await close();
    }
  });
});
