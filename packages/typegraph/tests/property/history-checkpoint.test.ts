/**
 * Checkpoint-equivalence property test for recorded-time history (F1a).
 *
 * For a random valid sequence of mutations on one node, the captured
 * history plus the current row must reconstruct the complete version chain:
 * every capturing op records exactly one pre-image, in chronological order,
 * with the correct op taxonomy. This is the net that catches any unlogged
 * write path — if a mutation failed to capture, the reconstructed chain
 * would have a gap and the assertion would fail.
 *
 * Runs on both dialects: better-sqlite3 (fresh in-memory DB per run) and
 * in-process PGlite (shared engine, data reset per run).
 */
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createStore,
  createStoreWithSchema,
  type GraphBackend,
} from "../../src";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import { integrationTestGraph } from "../backends/integration/fixtures";
import {
  setupSharedPgliteEngine,
  type SharedPgliteEngine,
} from "../backends/postgres/pglite-correctness-harness";

type OpIntent =
  | Readonly<{ type: "update"; age: number }>
  | Readonly<{ type: "delete" }>
  | Readonly<{ type: "restore"; age: number }>;

const opIntentArb: fc.Arbitrary<OpIntent> = fc.oneof(
  fc.record({
    type: fc.constant("update" as const),
    age: fc.integer({ min: 0, max: 1000 }),
  }),
  fc.record({ type: fc.constant("delete" as const) }),
  fc.record({
    type: fc.constant("restore" as const),
    age: fc.integer({ min: 0, max: 1000 }),
  }),
);

type ExpectedVersion = Readonly<{ age: number; deleted: boolean; op: string }>;

type HistoryStore = ReturnType<typeof createStore<typeof integrationTestGraph>>;

/**
 * Drives a random op sequence on one node, modelling the pre-image each
 * capturing op should record, then asserts the recorded history (reversed
 * to chronological order) reproduces exactly that chain.
 */
async function checkSequence(
  store: HistoryStore,
  intents: readonly OpIntent[],
): Promise<void> {
  const created = await store.nodes.Person.create({ name: "P", age: 0 });
  const id = created.id;

  let deleted = false;
  let age = 0;
  const expected: ExpectedVersion[] = [];

  for (const intent of intents) {
    if (intent.type === "update" && !deleted) {
      expected.push({ age, deleted, op: "update" });
      await store.nodes.Person.update(id, { age: intent.age });
      age = intent.age;
    } else if (intent.type === "delete" && !deleted) {
      expected.push({ age, deleted, op: "delete" });
      await store.nodes.Person.delete(id);
      deleted = true;
    } else if (intent.type === "restore" && deleted) {
      // The captured pre-image is the tombstoned row (deleted = true).
      expected.push({ age, deleted, op: "restore" });
      await store.nodes.Person.upsertById(id, { name: "P", age: intent.age });
      deleted = false;
      age = intent.age;
    }
    // Any other (intent, state) pair is a no-op and captures nothing.
  }

  // history() is newest-first; reverse to chronological capture order.
  const recorded = await store.nodes.Person.history(id);
  const chronological = recorded.toReversed();
  expect(chronological).toHaveLength(expected.length);
  for (const [index, want] of expected.entries()) {
    const got = chronological[index]!;
    expect(got.op).toBe(want.op);
    expect(got.image.age).toBe(want.age);
    expect(got.image.meta.deletedAt !== undefined).toBe(want.deleted);
  }

  // The current row reflects the final logical state.
  const current = await store.nodes.Person.getById(id, {
    temporalMode: "includeTombstones",
  });
  expect(current).toBeDefined();
  if (deleted) {
    expect(current?.meta.deletedAt).toBeDefined();
  } else {
    expect(current?.age).toBe(age);
    expect(current?.meta.deletedAt).toBeUndefined();
  }
}

describe("history checkpoint equivalence — SQLite", () => {
  it("reconstructs the full version chain for random op sequences", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opIntentArb, { minLength: 1, maxLength: 10 }),
        async (intents) => {
          const { backend } = createLocalSqliteBackend();
          try {
            const [store] = await createStoreWithSchema(
              integrationTestGraph,
              backend,
              { history: true },
            );
            await checkSequence(store, intents);
          } finally {
            await backend.close();
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("history checkpoint equivalence — PGlite", () => {
  let engine: SharedPgliteEngine;

  beforeAll(async () => {
    engine = await setupSharedPgliteEngine();
  });

  afterAll(async () => {
    await engine.dispose();
  });

  it("reconstructs the full version chain for random op sequences", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opIntentArb, { minLength: 1, maxLength: 8 }),
        async (intents) => {
          await engine.resetData();
          const backend: GraphBackend = engine.makeBackend();
          const store = createStore(integrationTestGraph, backend, {
            history: true,
          });
          await checkSequence(store, intents);
        },
      ),
      { numRuns: 8 },
    );
  });
});
