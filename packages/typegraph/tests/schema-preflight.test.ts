/**
 * Pre-flighting a schema proposal without touching a privileged, migration
 * gated path — and classifying a commit failure without matching message text.
 *
 * Covers the structured outcomes of the schema-commit surface: the
 * `MigrationError` discriminant + attached diff, the pure
 * `identical | additive | incompatible` classifier, and the store-handle
 * pre-flight (`schemaChanges` / `requiresMigration`).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  MigrationError,
} from "../src";
import {
  assertSchemaCurrent,
  classifySchemaChanges,
  getSchemaChanges,
  requiresMigration,
} from "../src/schema";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

/** Adding an optional property is backwards compatible. */
const PersonAdditive = defineNode("Person", {
  schema: z.object({ name: z.string(), nickname: z.string().optional() }),
});

/** Adding a *required* property is a breaking change. */
const PersonBreaking = defineNode("Person", {
  schema: z.object({ name: z.string(), age: z.number() }),
});

const GRAPH_ID = "schema_preflight";

const baseGraph = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: Person } },
  edges: {},
});

const additiveGraph = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: PersonAdditive } },
  edges: {},
});

const breakingGraph = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: PersonBreaking } },
  edges: {},
});

describe("classifySchemaChanges", () => {
  it("classifies an unchanged graph as identical", async () => {
    const backend = createTestBackend();
    await createStoreWithSchema(baseGraph, backend);

    const diff = requireDefined(await getSchemaChanges(backend, baseGraph));
    expect(classifySchemaChanges(diff)).toBe("identical");
  });

  it("classifies an added optional property as additive", async () => {
    const backend = createTestBackend();
    await createStoreWithSchema(baseGraph, backend);

    const diff = requireDefined(await getSchemaChanges(backend, additiveGraph));
    expect(classifySchemaChanges(diff)).toBe("additive");
    expect(diff.hasBreakingChanges).toBe(false);
  });

  it("classifies an added required property as incompatible", async () => {
    const backend = createTestBackend();
    await createStoreWithSchema(baseGraph, backend);

    const diff = requireDefined(await getSchemaChanges(backend, breakingGraph));
    expect(classifySchemaChanges(diff)).toBe("incompatible");
    expect(diff.hasBreakingChanges).toBe(true);
  });
});

describe("requiresMigration pre-flight", () => {
  it("is false when the committed schema matches the graph", async () => {
    const backend = createTestBackend();
    await createStoreWithSchema(baseGraph, backend);

    expect(await requiresMigration(backend, baseGraph)).toBe(false);
  });

  it("is true for a pending change, safe or breaking", async () => {
    const backend = createTestBackend();
    await createStoreWithSchema(baseGraph, backend);

    expect(await requiresMigration(backend, additiveGraph)).toBe(true);
    expect(await requiresMigration(backend, breakingGraph)).toBe(true);
  });

  it("is true when no schema has been committed yet", async () => {
    const backend = createTestBackend();
    // Nothing committed — the privileged bootstrap is still required.
    expect(await requiresMigration(backend, baseGraph)).toBe(true);
  });
});

describe("store-handle pre-flight", () => {
  it("reports no pending migration for a caught-up store", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    expect(await store.requiresMigration()).toBe(false);
    const diff = requireDefined(await store.schemaChanges());
    expect(diff.hasChanges).toBe(false);
  });

  it("detects the privileged wall before a write hits it", async () => {
    const backend = createTestBackend();
    await createStoreWithSchema(baseGraph, backend);

    // A runtime holding a graph ahead of the database: the DML handle can see
    // it needs the privileged path without attempting a commit.
    const ahead = createStore(breakingGraph, backend);
    expect(await ahead.requiresMigration()).toBe(true);

    const diff = requireDefined(await ahead.schemaChanges());
    expect(classifySchemaChanges(diff)).toBe("incompatible");
  });
});

describe("MigrationError discriminant", () => {
  it("classifies a schema-behind failure without matching the message", async () => {
    const backend = createTestBackend();
    await createStoreWithSchema(baseGraph, backend);

    // The least-privilege verification path refuses to migrate.
    let thrown: unknown;
    try {
      await assertSchemaCurrent(backend, breakingGraph);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MigrationError);
    const migrationError = thrown as MigrationError;
    expect(migrationError.details.reason).toBe("schema-behind");
    expect(migrationError.details.graphId).toBe(GRAPH_ID);

    // The attached diff carries the additive-vs-incompatible decision, so a
    // caller never has to re-query or read the sentence.
    const diff = requireDefined(migrationError.details.diff);
    expect(diff.hasBreakingChanges).toBe(true);
    expect(classifySchemaChanges(diff)).toBe("incompatible");
  });

  it("distinguishes an additive schema-behind failure from a breaking one", async () => {
    const backend = createTestBackend();
    await createStoreWithSchema(baseGraph, backend);

    let thrown: unknown;
    try {
      await assertSchemaCurrent(backend, additiveGraph);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MigrationError);
    const migrationError = thrown as MigrationError;
    // Same reason as the breaking case — the diff is what separates them.
    expect(migrationError.details.reason).toBe("schema-behind");
    const diff = requireDefined(migrationError.details.diff);
    expect(diff.hasBreakingChanges).toBe(false);
    expect(classifySchemaChanges(diff)).toBe("additive");
  });
});
