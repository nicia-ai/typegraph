/**
 * The scope of a generated write timestamp: one backend batch call.
 *
 * `bulkCreate` issues ONE `insertNodesBatch` call, and every row it generates a
 * timestamp for shares that call's single `nowIso()` — even across the
 * bind-budget chunks the driver splits the call into. Two rows created by one
 * call cannot get different `created_at` values just because a chunk boundary
 * fell between them.
 *
 * The boundary is the *call*, not the operation:
 *  - `create()` is one call per row, so sequential creates get distinct
 *    timestamps.
 *  - `importGraph()` drives one backend call per `batchSize` slice, so its
 *    slices get distinct timestamps — it is NOT one instant.
 *
 * These tests pin all three so none drifts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "../src";
import * as rowMappers from "../src/backend/row-mappers";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend } from "../src/backend/types";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
} from "../src/interchange";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "bulk-write-timestamps",
  nodes: { Person: { type: Person } },
  edges: {},
});

/**
 * Enough rows that, at the two-rows-per-chunk bind budget below, the insert
 * issues on the order of a thousand statements and takes several milliseconds.
 *
 * That matters: `created_at` has millisecond precision, so a handful of chunks
 * completing inside one millisecond would sample the same instant even if the
 * clock were read per chunk. Only a write that straddles millisecond boundaries
 * can tell "sampled once per call" apart from "sampled once per chunk".
 */
const ROW_COUNT = 2000;

/** ~2 rows per chunk once the per-row column count is divided out. */
const TINY_BIND_BUDGET = 24;

async function waitForNextMillisecond(): Promise<void> {
  const start = Date.now();
  while (Date.now() === start) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("bulk write timestamps", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("gives every row of one bulkCreate the same created_at, across chunk boundaries", async () => {
    // A tiny bind budget guarantees the rows span many chunks. The chunk sizes
    // are derived at backend construction, so the override has to go there —
    // patching `capabilities` on an existing backend would leave the batch
    // config untouched and quietly make this test vacuous.
    const { backend: chunked } = createLocalSqliteBackend({
      capabilities: { maxBindParameters: TINY_BIND_BUDGET },
    });
    const store = createStore(graph, chunked);

    const created = await store.nodes.Person.bulkCreate(
      Array.from({ length: ROW_COUNT }, (_, index) => ({
        props: { name: `p${index}` },
      })),
    );
    expect(created).toHaveLength(ROW_COUNT);

    const rows = await store.nodes.Person.find();
    const instants = new Set(rows.map((row) => row.meta.createdAt));
    expect(instants.size).toBe(1);

    // valid_from shares the same instant: one write, one point in valid time.
    const validFroms = new Set(rows.map((row) => row.meta.validFrom));
    expect(validFroms.size).toBe(1);
    expect([...validFroms][0]).toBe([...instants][0]);

    await chunked.close();
  });

  it("still gives sequential create() calls distinct created_at values", async () => {
    const store = createStore(graph, backend);

    await store.nodes.Person.create({ name: "first" });
    await waitForNextMillisecond();
    await store.nodes.Person.create({ name: "second" });

    const rows = await store.nodes.Person.find();
    const instants = new Set(rows.map((row) => row.meta.createdAt));
    expect(instants.size).toBe(2);
  });

  it("samples a fresh timestamp per importGraph batch, not once for the whole import", async () => {
    // A monotonic fake clock (one tick per read) makes "one sample per batch"
    // observable without depending on wall-clock timing: distinct instants can
    // only appear if the import re-reads the clock per batch.
    let tick = 0;
    const clock = vi
      .spyOn(rowMappers, "nowIso")
      .mockImplementation(
        () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`,
      );

    try {
      // Construct the backend AFTER installing the spy. The operation backend
      // captures `nowIso` at construction, so the `beforeEach` backend would
      // have closed over the real clock and ignored the fake one — leaving the
      // test dependent on wall-clock timing instead of the batch count.
      const spiedBackend = createTestBackend();
      const [store] = await createStoreWithSchema(graph, spiedBackend);

      // batchSize 1 forces one backend call per node → one nowIso() read each.
      const nodes: GraphData["nodes"] = [];
      for (let index = 0; index < 3; index += 1) {
        nodes.push({
          kind: "Person",
          id: `p-${index}`,
          properties: { name: `person-${index}` },
        });
      }

      await importGraph(
        store,
        {
          formatVersion: FORMAT_VERSION,
          exportedAt: "2026-01-01T00:00:00.000Z",
          source: { type: "external", description: "batch-timestamp test" },
          nodes,
          edges: [],
        },
        { batchSize: 1, onConflict: "error" },
      );

      const rows = await store.nodes.Person.find();
      expect(rows).toHaveLength(3);
      // Three batches, three distinct created_at instants — NOT one. A
      // whole-import single sample would collapse these to one value.
      const instants = new Set(rows.map((row) => row.meta.createdAt));
      expect(instants.size).toBe(3);
    } finally {
      clock.mockRestore();
    }
  });
});
