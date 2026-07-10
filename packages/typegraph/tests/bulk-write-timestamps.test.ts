/**
 * A batched write stamps ONE instant, across every bind-budget chunk.
 *
 * `bulkCreate` splits its rows into chunks sized by the connection's bind
 * budget. That split is an implementation detail of the driver, and it must
 * stay one: two rows created by the same call cannot be given different
 * `created_at` values just because a chunk boundary fell between them.
 *
 * The sequential `create()` path samples the clock per row, so the same rows
 * inserted one at a time get distinct timestamps. That difference is intended —
 * one logical write, one point in valid time — and is documented in the
 * changelog. These tests pin both halves so neither drifts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineGraph, defineNode } from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend } from "../src/backend/types";
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
});
