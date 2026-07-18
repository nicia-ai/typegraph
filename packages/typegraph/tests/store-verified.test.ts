/**
 * `createVerifiedStore` / `assertSchemaCurrent` — the runtime
 * counterpart of `createStoreWithSchema` for the "Database roles &
 * least privilege" deployment model. SELECT-only attach with a
 * verification gate: throws `ConfigurationError` when no schema has
 * been initialized, `MigrationError` when the persisted schema is
 * behind the code graph by **any** change (safe or breaking), and
 * `StoreNotInitializedError` when the schema is current but the
 * runtime-contribution markers are missing.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStore,
  createStoreWithSchema,
  createVerifiedStore,
  defineGraph,
  defineNode,
  MigrationError,
  searchable,
  StoreNotInitializedError,
} from "../src";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { tables as defaultTables } from "../src/backend/sqlite";
import { assertSchemaCurrent } from "../src/schema";

const PersonV1 = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const PersonV2 = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string().optional(), // additive — safe auto-migration
  }),
});

const PersonV3Breaking = defineNode("Person", {
  schema: z.object({
    fullName: z.string(), // required-field rename — breaking
  }),
});

const GRAPH_ID = "store-verified-test";

function graphV1() {
  return defineGraph({
    id: GRAPH_ID,
    nodes: { Person: { type: PersonV1 } },
    edges: {},
  });
}

function graphV2Safe() {
  return defineGraph({
    id: GRAPH_ID,
    nodes: { Person: { type: PersonV2 } },
    edges: {},
  });
}

function graphV3Breaking() {
  return defineGraph({
    id: GRAPH_ID,
    nodes: { Person: { type: PersonV3Breaking } },
    edges: {},
  });
}

function freshBackend(sqlite: Database.Database) {
  return createSqliteBackend(drizzle(sqlite), {
    executionProfile: { isSync: true },
    tables: defaultTables,
  });
}

describe("createVerifiedStore", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
  });

  afterEach(() => {
    sqlite.close();
  });

  it("attaches and returns unchanged when the database is current", async () => {
    const bootBackend = freshBackend(sqlite);
    await createStoreWithSchema(graphV1(), bootBackend);

    const runtimeBackend = freshBackend(sqlite);
    const [store, result] = await createVerifiedStore(
      graphV1(),
      runtimeBackend,
    );

    expect(result.status).toBe("unchanged");
    expect(store.graphId).toBe(GRAPH_ID);
  });

  it("throws ConfigurationError on a fresh database without bootstrapping tables", async () => {
    const backend = freshBackend(sqlite);
    const bootstrapSpy = vi.spyOn(backend, "bootstrapTables");
    const ensureRuntimeSpy = vi.spyOn(backend, "ensureRuntimeContributions");

    await expect(createVerifiedStore(graphV1(), backend)).rejects.toThrow(
      ConfigurationError,
    );

    // Zero-DDL: the runtime path must not bootstrap or materialize.
    expect(bootstrapSpy).not.toHaveBeenCalled();
    expect(ensureRuntimeSpy).not.toHaveBeenCalled();

    // And it really did not run DDL: schema_versions does not exist.
    expect(() => sqlite.prepare(`SELECT 1 FROM schema_versions`).all()).toThrow(
      /no such table/,
    );
  });

  it("throws MigrationError when the database is behind by a safe pending change", async () => {
    const bootBackend = freshBackend(sqlite);
    await createStoreWithSchema(graphV1(), bootBackend);

    const runtimeBackend = freshBackend(sqlite);
    await expect(
      createVerifiedStore(graphV2Safe(), runtimeBackend),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof MigrationError &&
        error.message.includes("safe auto-migration"),
    );
  });

  it("throws MigrationError when the database is behind by a breaking change", async () => {
    const bootBackend = freshBackend(sqlite);
    await createStoreWithSchema(graphV1(), bootBackend);

    const runtimeBackend = freshBackend(sqlite);
    await expect(
      createVerifiedStore(graphV3Breaking(), runtimeBackend),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof MigrationError &&
        error.message.includes("breaking change"),
    );
  });

  it("throws StoreNotInitializedError when schema is current but contribution markers are absent", async () => {
    const FtNode = defineNode("Doc", {
      schema: z.object({ title: searchable({ language: "english" }) }),
    });
    const ftGraph = defineGraph({
      id: GRAPH_ID,
      nodes: { Doc: { type: FtNode } },
      edges: {},
    });

    const bootBackend = freshBackend(sqlite);
    await createStoreWithSchema(ftGraph, bootBackend);

    // Drop the durable contribution marker — schema row stays current.
    sqlite.exec(`DELETE FROM typegraph_contribution_materializations`);

    const runtimeBackend = freshBackend(sqlite);
    await expect(
      createVerifiedStore(ftGraph, runtimeBackend),
    ).rejects.toBeInstanceOf(StoreNotInitializedError);
  });

  it("does not invoke any DDL/materialization backend method on a successful verify", async () => {
    const bootBackend = freshBackend(sqlite);
    await createStoreWithSchema(graphV1(), bootBackend);

    const runtimeBackend = freshBackend(sqlite);
    const bootstrapSpy = vi.spyOn(runtimeBackend, "bootstrapTables");
    const ensureRuntimeSpy = vi.spyOn(
      runtimeBackend,
      "ensureRuntimeContributions",
    );
    const ensureFulltextSpy = vi.spyOn(runtimeBackend, "ensureFulltextTable");

    await createVerifiedStore(graphV1(), runtimeBackend);

    expect(bootstrapSpy).not.toHaveBeenCalled();
    expect(ensureRuntimeSpy).not.toHaveBeenCalled();
    expect(ensureFulltextSpy).not.toHaveBeenCalled();
  });

  it("createStore (no verification) silently attaches against a behind database", async () => {
    // Sanity check that the verification gate is what catches drift —
    // createStore itself does not, by design.
    const bootBackend = freshBackend(sqlite);
    await createStoreWithSchema(graphV1(), bootBackend);

    const runtimeBackend = freshBackend(sqlite);
    const store = createStore(graphV2Safe(), runtimeBackend);
    expect(store.graphId).toBe(GRAPH_ID);
  });
});

describe("assertSchemaCurrent", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
  });

  afterEach(() => {
    sqlite.close();
  });

  it("returns unchanged when the database is current", async () => {
    const bootBackend = freshBackend(sqlite);
    await createStoreWithSchema(graphV1(), bootBackend);

    const runtimeBackend = freshBackend(sqlite);
    const result = await assertSchemaCurrent(runtimeBackend, graphV1());
    expect(result).toMatchObject({ status: "unchanged", version: 1 });
  });

  it("throws MigrationError on drift", async () => {
    const bootBackend = freshBackend(sqlite);
    await createStoreWithSchema(graphV1(), bootBackend);

    const runtimeBackend = freshBackend(sqlite);
    await expect(
      assertSchemaCurrent(runtimeBackend, graphV2Safe()),
    ).rejects.toThrow(MigrationError);
  });
});
