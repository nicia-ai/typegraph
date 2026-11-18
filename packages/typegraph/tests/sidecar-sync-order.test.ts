/**
 * Node write sidecar order.
 *
 * Every node write refreshes two derived sidecars: embeddings, then fulltext.
 * The two syncs must reach the connection one after the other in that fixed
 * order. Issuing them concurrently buys nothing (a transaction's single
 * connection serializes the statements) and makes the statement order depend
 * on cache state, which is what made the engine-profile parity capture flaky.
 *
 * Each sidecar write here yields to the event loop before it completes, so a
 * concurrent fan-out would start the second sync while the first is still in
 * flight. The log therefore pins "no overlap" as well as "embeddings first".
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  embedding,
  searchable,
} from "../src";
import {
  deriveBackend,
  type ExactBackendOverlay,
} from "../src/backend/derive-backend";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend, TransactionBackend } from "../src/backend/types";

const Document = defineNode("Doc", {
  schema: z.object({
    title: searchable(),
    embedding: embedding(4),
  }),
});

const graph = defineGraph({
  id: "sidecar_sync_order",
  nodes: { Doc: { type: Document } },
  edges: {},
});

const EMBEDDING_WRITES = ["upsertEmbedding", "upsertEmbeddingBatch"] as const;
const FULLTEXT_WRITES = ["upsertFulltext", "upsertFulltextBatch"] as const;
const SIDECAR_WRITES = [...EMBEDDING_WRITES, ...FULLTEXT_WRITES] as const;

type Sidecar = "embedding" | "fulltext";
type SidecarEvent = `${"start" | "end"}:${Sidecar}`;

const ONE_WRITE_PER_SIDECAR: readonly SidecarEvent[] = [
  "start:embedding",
  "end:embedding",
  "start:fulltext",
  "end:fulltext",
];

function sidecarOf(method: (typeof SIDECAR_WRITES)[number]): Sidecar {
  return (EMBEDDING_WRITES as readonly string[]).includes(method) ?
      "embedding"
    : "fulltext";
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function withSidecarLog(backend: GraphBackend): {
  backend: GraphBackend;
  events: SidecarEvent[];
} {
  const events: SidecarEvent[] = [];

  function wrapMethods<T extends GraphBackend | TransactionBackend>(
    target: T,
  ): T {
    const overrides: Record<string, unknown> = {};
    for (const method of SIDECAR_WRITES) {
      const original = (target as Record<string, unknown>)[method];
      if (typeof original !== "function") continue;
      const sidecar = sidecarOf(method);
      overrides[method] = async (...args: unknown[]) => {
        events.push(`start:${sidecar}`);
        await yieldToEventLoop();
        const result = await (original as (...a: unknown[]) => unknown).apply(
          target,
          args,
        );
        events.push(`end:${sidecar}`);
        return result;
      };
    }
    return deriveBackend<T, Partial<T>>(
      target,
      overrides as ExactBackendOverlay<T, Partial<T>>,
    );
  }

  const logged: GraphBackend = deriveBackend(wrapMethods(backend), {
    transaction: (fn, options) =>
      backend.transaction((target) => fn(wrapMethods(target)), options),
  });
  return { backend: logged, events };
}

type LoggedStore = Awaited<
  ReturnType<typeof createStoreWithSchema<typeof graph>>
>[0];

async function withLoggedStore(
  context: Readonly<{ skip: () => never }>,
  run: (store: LoggedStore, events: SidecarEvent[]) => Promise<void>,
): Promise<void> {
  const { backend: raw } = createLocalSqliteBackend();
  try {
    if (raw.capabilities.vector === undefined) context.skip();
    const { backend, events } = withSidecarLog(raw);
    const [store] = await createStoreWithSchema(graph, backend);
    events.length = 0;
    await run(store, events);
  } finally {
    await raw.close();
  }
}

describe("node write sidecar order", () => {
  it("create syncs embeddings, then fulltext, without overlap", async (context) => {
    await withLoggedStore(context, async (store, events) => {
      await store.nodes.Doc.create({ title: "a", embedding: [1, 2, 3, 4] });
      expect(events).toEqual(ONE_WRITE_PER_SIDECAR);
    });
  });

  it("update syncs embeddings, then fulltext, without overlap", async (context) => {
    await withLoggedStore(context, async (store, events) => {
      const document = await store.nodes.Doc.create({
        title: "a",
        embedding: [1, 2, 3, 4],
      });
      events.length = 0;
      await store.nodes.Doc.update(document.id, { title: "b" });
      expect(events).toEqual(ONE_WRITE_PER_SIDECAR);
    });
  });

  it("resurrecting a deleted id syncs embeddings, then fulltext, without overlap", async (context) => {
    await withLoggedStore(context, async (store, events) => {
      const document = await store.nodes.Doc.create({
        title: "a",
        embedding: [1, 2, 3, 4],
      });
      await store.nodes.Doc.delete(document.id);
      events.length = 0;
      await store.nodes.Doc.create(
        { title: "again", embedding: [4, 3, 2, 1] },
        { id: document.id },
      );
      expect(events).toEqual(ONE_WRITE_PER_SIDECAR);
    });
  });

  it("bulkCreate syncs embeddings, then fulltext, without overlap", async (context) => {
    await withLoggedStore(context, async (store, events) => {
      await store.nodes.Doc.bulkCreate([
        { props: { title: "a", embedding: [1, 2, 3, 4] } },
        { props: { title: "b", embedding: [4, 3, 2, 1] } },
      ]);
      expect(events).toEqual(ONE_WRITE_PER_SIDECAR);
    });
  });
});
