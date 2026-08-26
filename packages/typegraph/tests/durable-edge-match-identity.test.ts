import { PGlite } from "@electric-sql/pglite";
import type Database from "better-sqlite3";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStore,
  createStoreWithSchema,
  createVerifiedStore,
  DatabaseOperationError,
  defineEdge,
  defineEdgeIndex,
  defineGraph,
  defineNode,
  EdgeMatchIdentityConflictError,
  MigrationError,
  ValidationError,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import { projectBackendWithout } from "../src/backend/derive-backend";
import {
  edgeMatchIdentityPairCheckName,
  edgeMatchIdentityUniqueIndexName,
  generatePostgresDDL,
} from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { createSqliteTables } from "../src/backend/sqlite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend, TransactionBackend } from "../src/backend/types";
import {
  type GraphData,
  importGraph,
  ImportOptionsSchema,
} from "../src/interchange";
import {
  getActiveSchema,
  initializeSchema,
  migrateSchema,
} from "../src/schema/manager";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows", {
  schema: z.object({ label: z.string(), note: z.string().optional() }),
});

function durableGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Person: { type: Person } },
    edges: {
      knows: {
        type: knows,
        from: [Person],
        to: [Person],
        matchIdentity: { name: "knows-label", fields: ["label"] },
      },
    },
  });
}

function legacyGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Person: { type: Person } },
    edges: { knows: { type: knows, from: [Person], to: [Person] } },
  });
}

describe("durable edge match identity", () => {
  it("refuses non-scalar identity schemas when the graph is defined", () => {
    const dated = defineEdge("dated", {
      schema: z.object({ occurredAt: z.date() }),
    });

    let error: unknown;
    try {
      defineGraph({
        id: "durable_identity_date_schema",
        nodes: { Person: { type: Person } },
        edges: {
          dated: {
            type: dated,
            from: [Person],
            to: [Person],
            matchIdentity: {
              name: "dated-occurrence",
              fields: ["occurredAt"],
            },
          },
        },
      });
    } catch (error_) {
      error = error_;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    if (!(error instanceof ConfigurationError)) return;
    expect(error.details).toMatchObject({
      code: "EDGE_MATCH_IDENTITY_VALUE_NOT_SCALAR",
      field: "occurredAt",
    });
  });

  it("refuses BigInt literal identity schemas at declaration time", () => {
    const literal = defineEdge("literal", {
      schema: z.object({ value: z.literal(1n) }),
    });

    expect(() =>
      defineGraph({
        id: "durable_identity_bigint_literal_schema",
        nodes: { Person: { type: Person } },
        edges: {
          literal: {
            type: literal,
            from: [Person],
            to: [Person],
            matchIdentity: { name: "literal-value", fields: ["value"] },
          },
        },
      }),
    ).toThrow(ConfigurationError);
  });

  it.each([
    ["optional", z.literal(1n).optional()],
    ["nullable", z.literal(1n).nullable()],
    ["union", z.union([z.string(), z.literal(1n)])],
    ["default", z.literal(1n).default(1n)],
    ["transform", z.string().transform(() => 1n)],
  ])(
    "refuses a non-portable %s identity schema through the typed gate",
    (variant, valueSchema) => {
      const typed = defineEdge(`typed-${variant}`, {
        schema: z.object({ value: valueSchema }),
      });

      let error: unknown;
      try {
        defineGraph({
          id: `durable_identity_${variant}_schema`,
          nodes: { Person: { type: Person } },
          edges: {
            typed: {
              type: typed,
              from: [Person],
              to: [Person],
              matchIdentity: { name: "typed-value", fields: ["value"] },
            },
          },
        });
      } catch (error_) {
        error = error_;
      }
      expect(error).toBeInstanceOf(ConfigurationError);
      if (!(error instanceof ConfigurationError)) return;
      expect(error.details).toMatchObject({
        code: "EDGE_MATCH_IDENTITY_VALUE_NOT_SCALAR",
        field: "value",
      });
    },
  );

  it("accepts the exact portable scalar and wrapper grammar", () => {
    const portable = defineEdge("portable", {
      schema: z.object({
        value: z
          .union([z.string(), z.number(), z.boolean(), z.null()])
          .optional(),
        nullable: z.string().nullable(),
        literal: z.literal("literal"),
        absentLiteral: z.literal(undefined),
        choice: z.enum(["a", "b"]),
        defaulted: z.string().default("default"),
        caught: z.string().catch("fallback"),
        prefaulted: z.string().prefault("input"),
        readonly: z.string().readonly(),
        nonoptional: z.string().optional().nonoptional(),
      }),
    });

    expect(() =>
      defineGraph({
        id: "durable_identity_portable_union_schema",
        nodes: { Person: { type: Person } },
        edges: {
          portable: {
            type: portable,
            from: [Person],
            to: [Person],
            matchIdentity: {
              name: "portable-value",
              fields: [
                "value",
                "nullable",
                "literal",
                "absentLiteral",
                "choice",
                "defaulted",
                "caught",
                "prefaulted",
                "readonly",
                "nonoptional",
              ],
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it("turns malformed schema lookalikes into a typed declaration refusal", () => {
    const malformed = defineEdge("malformed", {
      schema: z.object({ value: z.string() }),
    });
    Reflect.set(malformed.schema.shape, "value", {
      def: {},
      _zod: {},
      parse: () => "value",
    });

    expect(() =>
      defineGraph({
        id: "durable_identity_malformed_schema",
        nodes: { Person: { type: Person } },
        edges: {
          malformed: {
            type: malformed,
            from: [Person],
            to: [Person],
            matchIdentity: { name: "malformed-value", fields: ["value"] },
          },
        },
      }),
    ).toThrow(ConfigurationError);
  });

  it("reports non-JSON endpoint-match properties as a typed validation error", async () => {
    const { backend } = createLocalSqliteBackend();
    const flexible = defineEdge("flexible", {
      schema: z.object({ key: z.string(), metadata: z.any() }),
    });
    const graph = defineGraph({
      id: "endpoint_match_non_json_props",
      nodes: { Person: { type: Person } },
      edges: {
        flexible: { type: flexible, from: [Person], to: [Person] },
      },
    });
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await expect(
        store.edges.flexible.getOrCreateByEndpoints(
          alice,
          bob,
          { key: "friend", metadata: 1n },
          { matchOn: ["key"] },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    } finally {
      await backend.close();
    }
  });

  it("initializes empty durable kinds without the general preflight port", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const narrowed = projectBackendWithout(backend, [
        "commitSchemaVersionWithPreflight",
      ]);
      await expect(
        initializeSchema(
          narrowed,
          durableGraph("durable_identity_empty_without_preflight"),
        ),
      ).resolves.toMatchObject({ version: 1, is_active: true });
    } finally {
      await backend.close();
    }
  });

  it("keeps durable declarations usable across privileged reopens", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graph = durableGraph("durable_identity_activation");
      await initializeSchema(backend, graph);
      await expect(
        createStoreWithSchema(graph, backend),
      ).resolves.toBeDefined();
    } finally {
      await backend.close();
    }
  });

  it("does not publish a safe migration when edge storage adoption fails", async () => {
    const graphId = "durable_identity_adoption_failure";
    const { backend } = createLocalSqliteBackend();
    const upgradedPerson = defineNode("Person", {
      schema: z.object({
        name: z.string(),
        email: z.string().optional(),
      }),
    });
    const upgradedGraph = defineGraph({
      id: graphId,
      nodes: { Person: { type: upgradedPerson } },
      edges: {
        knows: {
          type: knows,
          from: [upgradedPerson],
          to: [upgradedPerson],
        },
      },
    });
    try {
      await createStoreWithSchema(legacyGraph(graphId), backend);
      const failingBackend = deriveBackend(backend, {
        adoptBaseSchema(): Promise<void> {
          return Promise.reject(new Error("edge storage adoption failed"));
        },
      });

      await expect(
        createStoreWithSchema(upgradedGraph, failingBackend),
      ).rejects.toThrow("edge storage adoption failed");
      await expect(getActiveSchema(backend, graphId)).resolves.toMatchObject({
        version: 1,
      });
      await expect(
        createVerifiedStore(upgradedGraph, backend),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof MigrationError &&
          error.details.reason === "schema-behind",
      );
    } finally {
      await backend.close();
    }
  });

  it("activates identity on an empty legacy kind and materializes its key", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graphId = "durable_identity_empty_migration";
      await createStoreWithSchema(legacyGraph(graphId), backend);
      const legacySchema = await backend.getActiveSchema(graphId);
      expect(legacySchema?.version).toBe(1);

      await expect(
        migrateSchema(backend, durableGraph(graphId), 1),
      ).resolves.toBe(2);
      const durableSchema = await backend.getActiveSchema(graphId);
      expect(durableSchema?.version).toBe(2);

      const [store] = await createStoreWithSchema(
        durableGraph(graphId),
        backend,
      );
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await expect(
        store.edges.knows.getOrCreateByEndpoints(alice, bob, {
          label: "friend",
        }),
      ).resolves.toMatchObject({ action: "created" });
    } finally {
      await backend.close();
    }
  });

  it("uses one schema-fenced PostgreSQL command for created and found", async () => {
    const client = await PGlite.create();
    await client.exec(generatePostgresDDL().join("\n\n"));
    const statements: string[] = [];
    const query = client.query.bind(client);
    const querySpy = vi.spyOn(client, "query").mockImplementation((...args) => {
      statements.push(args[0]);
      return query(...args);
    });
    const backend = createPostgresBackend(drizzlePglite(client), {
      vector: false,
    });
    try {
      const [store] = await createStoreWithSchema(
        durableGraph("durable_identity_postgres_rtt"),
        backend,
      );
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      statements.splice(0);
      const created = await store.edges.knows.getOrCreateByEndpoints(
        alice,
        bob,
        { label: "friend" },
      );
      expect(created.action).toBe("created");
      expect(statements).toHaveLength(1);
      expect(statements[0]?.toLowerCase()).toContain("on conflict");
      expect(statements[0]?.toLowerCase()).toContain(
        "typegraph_schema_versions",
      );

      statements.splice(0);
      const found = await store.edges.knows.getOrCreateByEndpoints(alice, bob, {
        label: "friend",
      });
      expect(found).toMatchObject({
        action: "found",
        edge: { id: created.edge.id },
      });
      expect(statements).toHaveLength(1);
    } finally {
      querySpy.mockRestore();
      await client.close();
    }
  });

  it("reports a durable found command as unchanged instead of an error", async () => {
    const { backend } = createLocalSqliteBackend();
    const graph = durableGraph("durable_identity_found_hooks");
    try {
      const [setup] = await createStoreWithSchema(graph, backend);
      const alice = await setup.nodes.Person.create({ name: "Alice" });
      const bob = await setup.nodes.Person.create({ name: "Bob" });
      const incumbent = await setup.edges.knows.create(alice, bob, {
        label: "friend",
      });
      const onError = vi.fn(() => {
        throw new Error("an expected found result must not reach onError");
      });
      const outcomes: string[] = [];
      const store = createStore(graph, backend, {
        hooks: {
          onError,
          onOperationEnd: (context, result) => {
            if (context.entity === "edge") outcomes.push(result.outcome);
          },
        },
      });

      await expect(
        store.edges.knows.getOrCreateByEndpoints(alice, bob, {
          label: "friend",
        }),
      ).resolves.toMatchObject({
        action: "found",
        edge: { id: incumbent.id },
      });
      await expect(
        store.transaction((tx) =>
          tx.edges.knows.getOrCreateByEndpoints(alice, bob, {
            label: "friend",
          }),
        ),
      ).resolves.toMatchObject({ action: "found" });
      const colleague = await store.edges.knows.create(alice, bob, {
        label: "colleague",
      });
      await store.edges.knows.delete(colleague.id);
      const teammate = await store.edges.knows.create(alice, bob, {
        label: "teammate",
      });
      await store.transaction((tx) => tx.edges.knows.delete(teammate.id));
      expect(onError).not.toHaveBeenCalled();
      expect(outcomes).toEqual([
        "unchanged",
        "unchanged",
        "written",
        "unknown",
        "written",
        "unknown",
      ]);
    } finally {
      await backend.close();
    }
  });

  it("keeps the durable owner through resurrection and releases it on hard delete", async () => {
    const client = await PGlite.create();
    await client.exec(generatePostgresDDL().join("\n\n"));
    const backend = createPostgresBackend(drizzlePglite(client), {
      vector: false,
    });
    try {
      const [store] = await createStoreWithSchema(
        durableGraph("durable_identity_pglite_lifecycle"),
        backend,
      );
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const owner = await store.edges.knows.create(
        alice,
        bob,
        { label: "friend", note: "first" },
        { id: "durable-owner" },
      );

      await expect(
        store.edges.knows.create(
          alice,
          bob,
          { label: "friend", note: "conflict" },
          { id: "durable-conflict" },
        ),
      ).rejects.toMatchObject({
        name: "EdgeMatchIdentityConflictError",
        code: "EDGE_MATCH_IDENTITY_CONFLICT",
        details: {
          attempted: [
            {
              id: "durable-conflict",
              identityName: "knows-label",
              kind: "knows",
            },
          ],
        },
      });
      await expect(
        store.edges.knows.create(
          alice,
          bob,
          { label: "friend", note: "same-id" },
          { id: owner.id },
        ),
      ).rejects.toBeInstanceOf(EdgeMatchIdentityConflictError);

      await store.edges.knows.delete(owner.id);
      await expect(
        store.edges.knows.create(
          alice,
          bob,
          { label: "friend", note: "same-id-tombstone" },
          { id: owner.id },
        ),
      ).rejects.toBeInstanceOf(EdgeMatchIdentityConflictError);
      const resurrected = await store.edges.knows.getOrCreateByEndpoints(
        alice,
        bob,
        { label: "friend", note: "revived" },
      );
      expect(resurrected).toMatchObject({
        action: "resurrected",
        edge: { id: owner.id, note: "revived" },
      });

      await store.edges.knows.hardDelete(owner.id);
      const recreated = await store.edges.knows.getOrCreateByEndpoints(
        alice,
        bob,
        { label: "friend" },
      );
      expect(recreated).toMatchObject({ action: "created" });
      expect(recreated.edge.id).not.toBe(owner.id);
    } finally {
      await client.close();
    }
  });

  it("turns an unprovisioned PostgreSQL identity arbiter into a typed refusal", async () => {
    const client = await PGlite.create();
    await client.exec(generatePostgresDDL().join("\n\n"));
    const backend = createPostgresBackend(drizzlePglite(client), {
      vector: false,
    });
    try {
      const [store] = await createStoreWithSchema(
        durableGraph("durable_identity_missing_arbiter"),
        backend,
      );
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await client.exec(
        `DROP INDEX "${edgeMatchIdentityUniqueIndexName("typegraph_edges")}"`,
      );

      await expect(
        store.edges.knows.create(alice, bob, { label: "direct" }),
      ).rejects.toMatchObject({
        details: {
          code: "EDGE_MATCH_IDENTITY_STORAGE_UNAVAILABLE",
          edgeKind: "knows",
        },
      });
      await expect(
        store.edges.knows.getOrCreateByEndpoints(alice, bob, {
          label: "friend",
        }),
      ).rejects.toMatchObject({
        details: {
          code: "EDGE_MATCH_IDENTITY_STORAGE_UNAVAILABLE",
          capability: "durableEdgeMatchIdentity",
          edgeKind: "knows",
          identityName: "knows-label",
        },
      });
    } finally {
      await client.close();
    }
  });

  it("turns missing PostgreSQL identity columns into a typed refusal", async () => {
    const client = await PGlite.create();
    await client.exec(generatePostgresDDL().join("\n\n"));
    const backend = createPostgresBackend(drizzlePglite(client), {
      vector: false,
    });
    try {
      const [store] = await createStoreWithSchema(
        durableGraph("durable_identity_missing_columns"),
        backend,
      );
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await client.exec(
        `DROP INDEX "${edgeMatchIdentityUniqueIndexName("typegraph_edges")}"; ` +
          `ALTER TABLE "typegraph_edges" DROP CONSTRAINT "${edgeMatchIdentityPairCheckName("typegraph_edges")}"; ` +
          `ALTER TABLE "typegraph_edges" DROP COLUMN "match_identity_name"; ` +
          `ALTER TABLE "typegraph_edges" DROP COLUMN "match_identity_key";`,
      );

      await expect(
        store.edges.knows.getOrCreateByEndpoints(alice, bob, {
          label: "friend",
        }),
      ).rejects.toMatchObject({
        details: {
          code: "EDGE_MATCH_IDENTITY_STORAGE_UNAVAILABLE",
          edgeKind: "knows",
          identityName: "knows-label",
        },
      });
    } finally {
      await client.close();
    }
  });

  it("classifies plain edge inserts when legacy storage lacks identity columns", async () => {
    const client = await PGlite.create();
    await client.exec(generatePostgresDDL().join("\n\n"));
    const backend = createPostgresBackend(drizzlePglite(client), {
      vector: false,
    });
    const graphId = "legacy_edge_missing_identity_columns";
    const edge = (id: string) => ({
      graphId,
      id,
      kind: "knows",
      fromKind: "Person",
      fromId: "alice",
      toKind: "Person",
      toId: "bob",
      props: { label: id },
    });
    const expectStorageRefusal = async (operation: Promise<unknown>) => {
      const error = await operation.catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error).toMatchObject({
        code: "CONFIGURATION_ERROR",
        details: {
          code: "EDGE_MATCH_IDENTITY_STORAGE_UNAVAILABLE",
          graphId,
          edgeKind: "knows",
        },
      });
    };

    try {
      await client.exec(
        `DROP INDEX "${edgeMatchIdentityUniqueIndexName("typegraph_edges")}"; ` +
          `ALTER TABLE "typegraph_edges" DROP CONSTRAINT "${edgeMatchIdentityPairCheckName("typegraph_edges")}"; ` +
          `ALTER TABLE "typegraph_edges" DROP COLUMN "match_identity_name"; ` +
          `ALTER TABLE "typegraph_edges" DROP COLUMN "match_identity_key";`,
      );

      await expectStorageRefusal(backend.insertEdge(edge("direct")));

      const insertEdgeNoReturn = backend.insertEdgeNoReturn;
      if (insertEdgeNoReturn === undefined) {
        throw new Error("PostgreSQL backend must support insertEdgeNoReturn");
      }
      await expectStorageRefusal(insertEdgeNoReturn(edge("no-return")));

      const insertEdgesBatch = backend.insertEdgesBatch;
      if (insertEdgesBatch === undefined) {
        throw new Error("PostgreSQL backend must support insertEdgesBatch");
      }
      await expectStorageRefusal(
        insertEdgesBatch([edge("batch-a"), edge("batch-b")]),
      );

      const insertEdgesBatchReturning = backend.insertEdgesBatchReturning;
      if (insertEdgesBatchReturning === undefined) {
        throw new Error(
          "PostgreSQL backend must support insertEdgesBatchReturning",
        );
      }
      await expectStorageRefusal(
        insertEdgesBatchReturning([edge("returning-a")]),
      );
    } finally {
      await client.close();
    }
  });

  it("arbitrates create and found outcomes in one root statement", async () => {
    const { backend, db } = createLocalSqliteBackend();
    const sqlite = (db as typeof db & { $client: Database.Database }).$client;
    const statements: string[] = [];
    const prepare = sqlite.prepare.bind(sqlite);
    const prepareSpy = vi
      .spyOn(sqlite, "prepare")
      .mockImplementation((query) => {
        statements.push(query);
        return prepare(query);
      });
    try {
      const [store] = await createStoreWithSchema(
        durableGraph("durable_identity_rtt"),
        backend,
      );
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      statements.splice(0);
      const created = await store.edges.knows.getOrCreateByEndpoints(
        alice,
        bob,
        { label: "friend" },
      );
      expect(created.action).toBe("created");
      expect(statements).toHaveLength(1);
      expect(statements[0]?.toLowerCase()).toContain("on conflict");
      expect(statements[0]?.toLowerCase()).not.toContain("begin");

      statements.splice(0);
      const found = await store.edges.knows.getOrCreateByEndpoints(alice, bob, {
        label: "friend",
      });
      expect(found).toMatchObject({
        action: "found",
        edge: { id: created.edge.id },
      });
    } finally {
      prepareSpy.mockRestore();
      await backend.close();
    }
  });

  it("returns an existing owner after an endpoint becomes soft-deleted", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graph = durableGraph("durable_identity_deleted_endpoint_found");
      const [store] = await createStoreWithSchema(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const created = await store.edges.knows.create(alice, bob, {
        label: "friend",
      });

      // Use the backend seam deliberately: the public node deletion pipeline
      // cascades to the edge, while this fixture needs the pre-existing live
      // owner with a now-deleted endpoint that the fused predicate guards.
      await backend.deleteNode({
        graphId: graph.id,
        kind: "Person",
        id: alice.id,
      });

      await expect(
        store.edges.knows.getOrCreateByEndpoints(alice, bob, {
          label: "friend",
        }),
      ).resolves.toMatchObject({
        action: "found",
        edge: { id: created.id },
      });
    } finally {
      await backend.close();
    }
  });

  it("owns the identity across every edge mutation", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        durableGraph("durable_identity_mutations"),
        backend,
      );
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const created = await store.edges.knows.getOrCreateByEndpoints(
        alice,
        bob,
        { label: "friend", note: "first" },
      );

      await expect(
        store.edges.knows.create(alice, bob, { label: "friend" }),
      ).rejects.toBeInstanceOf(EdgeMatchIdentityConflictError);
      await expect(
        store.edges.knows.update(created.edge.id, { label: "colleague" }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        store.edges.knows.update(created.edge.id, { note: "updated" }),
      ).resolves.toMatchObject({ label: "friend", note: "updated" });

      await store.edges.knows.delete(created.edge.id);
      const resurrected = await store.edges.knows.getOrCreateByEndpoints(
        alice,
        bob,
        { label: "friend", note: "revived" },
      );
      expect(resurrected).toMatchObject({
        action: "resurrected",
        edge: { id: created.edge.id, note: "revived" },
      });

      await store.edges.knows.hardDelete(created.edge.id);
      const recreated = await store.edges.knows.getOrCreateByEndpoints(
        alice,
        bob,
        { label: "friend" },
      );
      expect(recreated.action).toBe("created");
      expect(recreated.edge.id).not.toBe(created.edge.id);
    } finally {
      await backend.close();
    }
  });

  it("refuses an explicit duplicate durable id, including a tombstone", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graph = durableGraph("durable_identity_duplicate_id");
      const [store] = await createStoreWithSchema(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const owner = await store.edges.knows.create(
        alice,
        bob,
        { label: "friend", note: "owner" },
        { id: "fixed-edge-id" },
      );

      await expect(
        store.edges.knows.create(
          alice,
          bob,
          { label: "friend", note: "different" },
          { id: owner.id },
        ),
      ).rejects.toBeInstanceOf(EdgeMatchIdentityConflictError);
      await expect(store.edges.knows.getById(owner.id)).resolves.toMatchObject({
        note: "owner",
      });

      await store.edges.knows.delete(owner.id);
      await expect(
        store.edges.knows.create(
          alice,
          bob,
          { label: "friend", note: "resurrection-attempt" },
          { id: owner.id },
        ),
      ).rejects.toBeInstanceOf(EdgeMatchIdentityConflictError);
      await expect(
        store.edges.knows.getById(owner.id),
      ).resolves.toBeUndefined();
    } finally {
      await backend.close();
    }
  });

  it("arbitrates constrained durable direct and bulk creates after an index drop", async () => {
    const { backend, db } = createLocalSqliteBackend();
    const sqlite = (db as typeof db & { $client: Database.Database }).$client;
    try {
      const graph = defineGraph({
        id: "durable_identity_constrained_index_drop",
        nodes: { Person: { type: Person } },
        edges: {
          knows: {
            type: knows,
            from: [Person],
            to: [Person],
            cardinality: "one",
            matchIdentity: { name: "knows-label", fields: ["label"] },
          },
        },
      });
      const [store] = await createStoreWithSchema(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const carol = await store.nodes.Person.create({ name: "Carol" });
      await store.edges.knows.create(alice, bob, { label: "friend" });
      sqlite
        .prepare(
          `DROP INDEX "${edgeMatchIdentityUniqueIndexName("typegraph_edges")}"`,
        )
        .run();

      await expect(
        store.edges.knows.create(bob, carol, { label: "friend" }),
      ).rejects.toMatchObject({
        details: { code: "EDGE_MATCH_IDENTITY_STORAGE_UNAVAILABLE" },
      });
      await expect(
        store.edges.knows.bulkCreate([
          { from: bob, to: carol, props: { label: "friend" } },
        ]),
      ).rejects.toMatchObject({
        details: { code: "EDGE_MATCH_IDENTITY_STORAGE_UNAVAILABLE" },
      });
      await expect(store.edges.knows.count()).resolves.toBe(1);
    } finally {
      await backend.close();
    }
  });

  it("keeps constrained durable creates fail-closed on PostgreSQL after an index drop", async () => {
    const client = await PGlite.create();
    await client.exec(generatePostgresDDL().join("\n\n"));
    const backend = createPostgresBackend(drizzlePglite(client), {
      vector: false,
    });
    try {
      const graph = defineGraph({
        id: "durable_identity_constrained_postgres_index_drop",
        nodes: { Person: { type: Person } },
        edges: {
          knows: {
            type: knows,
            from: [Person],
            to: [Person],
            cardinality: "one",
            matchIdentity: { name: "knows-label", fields: ["label"] },
          },
        },
      });
      const [store] = await createStoreWithSchema(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const carol = await store.nodes.Person.create({ name: "Carol" });
      await store.edges.knows.create(alice, bob, { label: "friend" });
      await client.exec(
        `DROP INDEX "${edgeMatchIdentityUniqueIndexName("typegraph_edges")}"`,
      );

      await expect(
        store.edges.knows.create(bob, carol, { label: "friend" }),
      ).rejects.toMatchObject({
        details: { code: "EDGE_MATCH_IDENTITY_STORAGE_UNAVAILABLE" },
      });
      await expect(
        store.edges.knows.bulkCreate([
          { from: bob, to: carol, props: { label: "friend" } },
        ]),
      ).rejects.toMatchObject({
        details: { code: "EDGE_MATCH_IDENTITY_STORAGE_UNAVAILABLE" },
      });
      await expect(store.edges.knows.count()).resolves.toBe(1);
    } finally {
      await client.close();
    }
  });

  it("keeps durable bulk create on one batch command", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graph = durableGraph("durable_identity_bulk_command_count");
      const [setup] = await createStoreWithSchema(graph, backend);
      const alice = await setup.nodes.Person.create({ name: "Alice" });
      const bob = await setup.nodes.Person.create({ name: "Bob" });
      let batchCalls = 0;
      let convergenceCalls = 0;
      function trackedMembers(
        target: Pick<
          typeof backend,
          "commands" | "insertEdgesDurableBatchReturning"
        >,
      ) {
        const insertBatch = target.insertEdgesDurableBatchReturning;
        if (insertBatch === undefined) {
          throw new Error("Expected the bundled durable batch member");
        }
        return {
          insertEdgesDurableBatchReturning: async (
            params: Parameters<typeof insertBatch>[0],
          ) => {
            batchCalls += 1;
            return insertBatch(params);
          },
          commands: {
            session: target.commands.session,
            execute(
              ...args: Parameters<typeof target.commands.execute>
            ): ReturnType<typeof target.commands.execute> {
              if (args[0].kind === "edge.converge-create") {
                convergenceCalls += 1;
              }
              return target.commands.execute(...args);
            },
          },
        };
      }
      const tracked = deriveBackend(backend, {
        ...trackedMembers(backend),
        transaction: (run, options) =>
          backend.transaction(
            (transaction) =>
              run(deriveBackend(transaction, trackedMembers(transaction))),
            options,
          ),
      });

      await createStore(graph, tracked).edges.knows.bulkCreate([
        { from: alice, to: bob, props: { label: "one" } },
        { from: alice, to: bob, props: { label: "two" } },
        { from: alice, to: bob, props: { label: "three" } },
      ]);

      expect(batchCalls).toBe(1);
      expect(convergenceCalls).toBe(0);
    } finally {
      await backend.close();
    }
  });

  it("translates occupied durable bulk ids at both public batch surfaces", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graph = durableGraph("durable_identity_bulk_duplicate_id");
      const [store] = await createStoreWithSchema(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await store.edges.knows.create(
        alice,
        bob,
        { label: "owner" },
        { id: "occupied-bulk-id" },
      );
      await store.edges.knows.create(
        alice,
        bob,
        { label: "owner-no-return" },
        { id: "occupied-bulk-no-return-id" },
      );

      await expect(
        store.edges.knows.bulkCreate([
          {
            id: "occupied-bulk-id",
            from: alice,
            to: bob,
            props: { label: "different" },
          },
        ]),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        store.edges.knows.bulkInsert([
          {
            id: "occupied-bulk-no-return-id",
            from: alice,
            to: bob,
            props: { label: "different-no-return" },
          },
        ]),
      ).rejects.toBeInstanceOf(ValidationError);
    } finally {
      await backend.close();
    }
  });

  it("keeps both durable bulk surfaces honest on the sequential fallback", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graph = durableGraph("durable_identity_bulk_sequential_fallback");
      const [setup] = await createStoreWithSchema(graph, backend);
      const alice = await setup.nodes.Person.create({ name: "Alice" });
      const bob = await setup.nodes.Person.create({ name: "Bob" });
      await setup.edges.knows.create(
        alice,
        bob,
        { label: "occupied" },
        { id: "fallback-occupied-id" },
      );
      await setup.edges.knows.create(
        alice,
        bob,
        { label: "occupied-no-return" },
        { id: "fallback-occupied-no-return-id" },
      );

      let convergenceCalls = 0;
      function withoutDurableBatch(target: GraphBackend): GraphBackend;
      function withoutDurableBatch(
        target: TransactionBackend,
      ): TransactionBackend;
      function withoutDurableBatch(
        target: GraphBackend | TransactionBackend,
      ): GraphBackend | TransactionBackend {
        const projected = projectBackendWithout(target, [
          "insertEdgesDurableBatchReturning",
        ]);
        return deriveBackend(projected, {
          commands: {
            session: target.commands.session,
            execute(
              ...args: Parameters<typeof target.commands.execute>
            ): ReturnType<typeof target.commands.execute> {
              if (args[0].kind === "edge.converge-create") {
                convergenceCalls += 1;
              }
              return target.commands.execute(...args);
            },
          },
        });
      }
      const root = withoutDurableBatch(backend);
      const fallback = deriveBackend(root, {
        transaction: (run, options) =>
          backend.transaction(
            (target) => run(withoutDurableBatch(target)),
            options,
          ),
      });
      const store = createStore(graph, fallback);

      await expect(
        store.edges.knows.bulkCreate([
          { from: alice, to: bob, props: { label: "one" } },
          { from: alice, to: bob, props: { label: "two" } },
        ]),
      ).resolves.toHaveLength(2);
      await expect(
        store.edges.knows.bulkInsert([
          { from: alice, to: bob, props: { label: "three" } },
          { from: alice, to: bob, props: { label: "four" } },
        ]),
      ).resolves.toBeUndefined();
      expect(convergenceCalls).toBe(4);

      await expect(
        store.edges.knows.bulkCreate([
          {
            id: "fallback-occupied-id",
            from: alice,
            to: bob,
            props: { label: "different" },
          },
        ]),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        store.edges.knows.bulkInsert([
          {
            id: "fallback-occupied-no-return-id",
            from: alice,
            to: bob,
            props: { label: "different-no-return" },
          },
        ]),
      ).rejects.toBeInstanceOf(ValidationError);
    } finally {
      await backend.close();
    }
  });

  it("does not relabel an unrelated unique-index violation", async () => {
    const uniqueNote = defineEdgeIndex(knows, {
      fields: ["note"],
      unique: true,
    });
    const graph = defineGraph({
      id: "durable_identity_distinct_unique_index",
      nodes: { Person: { type: Person } },
      edges: {
        knows: {
          type: knows,
          from: [Person],
          to: [Person],
          matchIdentity: { name: "knows-label", fields: ["label"] },
        },
      },
      indexes: [uniqueNote],
    });
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      await store.materializeIndexes();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const carol = await store.nodes.Person.create({ name: "Carol" });
      await store.edges.knows.create(alice, bob, {
        label: "friend",
        note: "shared",
      });

      const collision = store.edges.knows.create(alice, carol, {
        label: "colleague",
        note: "shared",
      });
      await expect(collision).rejects.not.toBeInstanceOf(
        EdgeMatchIdentityConflictError,
      );
    } finally {
      await backend.close();
    }
  });

  it("refuses a call-level match shape that differs from the declaration", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        durableGraph("durable_identity_contract"),
        backend,
      );
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await expect(
        store.edges.knows.getOrCreateByEndpoints(
          alice,
          bob,
          { label: "friend" },
          { matchOn: ["note"] },
        ),
      ).rejects.toThrow("declares match identity fields");
    } finally {
      await backend.close();
    }
  });

  it("refuses to activate an unmaterialized identity on populated kinds", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        legacyGraph("durable_identity_rekey"),
        backend,
      );
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await store.edges.knows.create(alice, bob, { label: "friend" });
      const activeBefore = await backend.getActiveSchema(
        "durable_identity_rekey",
      );

      await expect(
        migrateSchema(backend, durableGraph("durable_identity_rekey"), 1),
      ).rejects.toMatchObject({
        details: {
          reason: "edge-match-identity-rekey",
          edgeKinds: ["knows"],
        },
      });
      const activeAfter = await backend.getActiveSchema(
        "durable_identity_rekey",
      );
      expect(activeAfter).toMatchObject({
        version: activeBefore?.version,
        schema_hash: activeBefore?.schema_hash,
        schema_doc: activeBefore?.schema_doc,
      });
    } finally {
      await backend.close();
    }
  });

  it("refuses first-schema identity adoption over populated unmanaged kinds", async () => {
    const { backend } = createLocalSqliteBackend({
      tables: createSqliteTables({ edges: "legacy_app_edges" }),
    });
    try {
      const graphId = "durable_identity_populated_initial_adoption";
      const store = createStore(legacyGraph(graphId), backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const edge = await store.edges.knows.create(alice, bob, {
        label: "friend",
      });
      await store.edges.knows.delete(edge.id);

      await expect(
        initializeSchema(backend, durableGraph(graphId)),
      ).rejects.toMatchObject({
        details: {
          fromVersion: 0,
          toVersion: 1,
          reason: "edge-match-identity-rekey",
          edgeKinds: ["knows"],
        },
      });
      await expect(backend.getActiveSchema(graphId)).resolves.toBeUndefined();
    } finally {
      await backend.close();
    }
  });

  it("removes a declared identity from a populated kind without a rekey refusal", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graphId = "durable_identity_populated_removal";
      const [store] = await createStoreWithSchema(
        durableGraph(graphId),
        backend,
      );
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await store.edges.knows.create(alice, bob, { label: "friend" });

      await expect(
        migrateSchema(backend, legacyGraph(graphId), 1),
      ).resolves.toBe(2);
      await expect(backend.getActiveSchema(graphId)).resolves.toMatchObject({
        version: 2,
      });
    } finally {
      await backend.close();
    }
  });

  it("persists durable identity through a normal interchange import", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graph = durableGraph("durable_identity_import");
      const [store] = await createStoreWithSchema(graph, backend);
      const data: GraphData = {
        formatVersion: "2.0",
        exportedAt: "2026-01-01T00:00:00.000Z",
        source: { type: "external", description: "durable identity test" },
        nodes: [
          { kind: "Person", id: "alice", properties: { name: "Alice" } },
          { kind: "Person", id: "bob", properties: { name: "Bob" } },
        ],
        edges: [
          {
            kind: "knows",
            id: "knows-1",
            from: { kind: "Person", id: "alice" },
            to: { kind: "Person", id: "bob" },
            properties: { label: "friend" },
          },
        ],
      };

      await expect(
        importGraph(
          store,
          data,
          ImportOptionsSchema.parse({ onConflict: "error" }),
        ),
      ).resolves.toMatchObject({ edges: { created: 1 } });
      const rows = await backend.executeRaw?.<{
        match_identity_key: string | undefined;
        match_identity_name: string | undefined;
      }>(
        "SELECT match_identity_name, match_identity_key FROM typegraph_edges WHERE graph_id = ? AND id = ?",
        [graph.id, "knows-1"],
      );
      expect(rows?.[0]?.match_identity_name).toBe("knows-label");
      expect(typeof rows?.[0]?.match_identity_key).toBe("string");
    } finally {
      await backend.close();
    }
  });

  it("refuses normal import on an incapable durable-identity backend before writes", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graph = durableGraph("durable_identity_import_capability");
      await createStoreWithSchema(graph, backend);
      const incapable = deriveBackend(backend, {
        capabilities: {
          ...backend.capabilities,
          durableEdgeMatchIdentity: false,
        },
      });
      const store = createStore(graph, incapable);
      const data: GraphData = {
        formatVersion: "2.0",
        exportedAt: "2026-01-01T00:00:00.000Z",
        source: { type: "external" },
        nodes: [
          { kind: "Person", id: "alice", properties: { name: "Alice" } },
          { kind: "Person", id: "bob", properties: { name: "Bob" } },
        ],
        edges: [
          {
            kind: "knows",
            id: "knows-1",
            from: { kind: "Person", id: "alice" },
            to: { kind: "Person", id: "bob" },
            properties: { label: "friend" },
          },
        ],
      };

      await expect(
        importGraph(
          store,
          data,
          ImportOptionsSchema.parse({ onConflict: "error" }),
        ),
      ).rejects.toMatchObject({
        details: { capability: "durableEdgeMatchIdentity" },
      });
      const rows = await backend.executeRaw?.<{
        count: number;
      }>("SELECT COUNT(*) AS count FROM typegraph_nodes WHERE graph_id = ?", [
        graph.id,
      ]);
      expect(rows?.[0]?.count).toBe(0);
      const edgeRows = await backend.executeRaw?.<{
        count: number;
      }>("SELECT COUNT(*) AS count FROM typegraph_edges WHERE graph_id = ?", [
        graph.id,
      ]);
      expect(edgeRows?.[0]?.count).toBe(0);
    } finally {
      await backend.close();
    }
  });

  it("reads bulk endpoint candidates as a set instead of per pair", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graph = durableGraph("durable_identity_bulk_reads");
      const [setup] = await createStoreWithSchema(graph, backend);
      const alice = await setup.nodes.Person.create({ name: "Alice" });
      const bob = await setup.nodes.Person.create({ name: "Bob" });
      const carol = await setup.nodes.Person.create({ name: "Carol" });
      const decoy = await setup.nodes.Person.create({ name: "Decoy" });
      await setup.edges.knows.create(alice, bob, { label: "friend" });
      await setup.edges.knows.create(alice, decoy, { label: "decoy" });
      let setReads = 0;
      let setReadRows = 0;
      let singletonReads = 0;
      function countedMembers(target: typeof backend) {
        return {
          findEdgesByHeterogeneousEndpointSet(
            params: Parameters<
              NonNullable<typeof target.findEdgesByHeterogeneousEndpointSet>
            >[0],
          ) {
            setReads += 1;
            const readEndpointSet = target.findEdgesByHeterogeneousEndpointSet;
            if (readEndpointSet === undefined) {
              throw new Error(
                "Built-in backend must expose endpoint set reads",
              );
            }
            return readEndpointSet(params).then((rows) => {
              setReadRows += rows.length;
              return rows;
            });
          },
          findEdgesByKind(
            params: Parameters<typeof target.findEdgesByKind>[0],
          ) {
            singletonReads += 1;
            return target.findEdgesByKind(params);
          },
        };
      }
      const counted = deriveBackend(backend, {
        ...countedMembers(backend),
        transaction: (run, options) =>
          backend.transaction(
            (transaction) =>
              run(
                deriveBackend(
                  transaction,
                  countedMembers(transaction as typeof backend),
                ),
              ),
            options,
          ),
      });
      const store = createStore(graph, counted);

      const results = await store.edges.knows.bulkGetOrCreateByEndpoints([
        { from: alice, to: bob, props: { label: "friend" } },
        { from: alice, to: carol, props: { label: "friend" } },
      ]);

      expect(results).toHaveLength(2);
      expect(setReads).toBe(2);
      // Both the root hint and transaction re-read seek only the two directed
      // pairs. The unrelated edge from the shared hub never crosses the
      // backend boundary for client-side filtering.
      expect(setReadRows).toBe(2);
      expect(singletonReads).toBe(0);
    } finally {
      await backend.close();
    }
  });

  it("refuses an incapable backend before issuing an edge write", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graph = durableGraph("durable_identity_capability");
      const [setup] = await createStoreWithSchema(graph, backend);
      const alice = await setup.nodes.Person.create({ name: "Alice" });
      const bob = await setup.nodes.Person.create({ name: "Bob" });
      let inserts = 0;
      const incapable = deriveBackend(backend, {
        capabilities: {
          ...backend.capabilities,
          durableEdgeMatchIdentity: false,
        },
        insertEdge(params) {
          inserts += 1;
          return backend.insertEdge(params);
        },
      });

      await expect(
        createStore(graph, incapable).edges.knows.create(alice, bob, {
          label: "friend",
        }),
      ).rejects.toMatchObject({
        details: { capability: "durableEdgeMatchIdentity" },
      });
      expect(inserts).toBe(0);
    } finally {
      await backend.close();
    }
  });

  it("fails closed when a custom port refuses durable convergence", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graph = durableGraph("durable_identity_custom_port_refusal");
      await createStoreWithSchema(graph, backend);
      let refusedCommands = 0;
      function refusingCommands(target: Pick<typeof backend, "commands">) {
        return {
          session: target.commands.session,
          execute(
            ...args: Parameters<typeof target.commands.execute>
          ): ReturnType<typeof target.commands.execute> {
            const [command] = args;
            if (command.kind === "edge.converge-create") {
              refusedCommands += 1;
              return Promise.resolve({
                outcome: "unsupported" as const,
                entity: "edge" as const,
                dimensions: ["convergence"] as const,
              });
            }
            return target.commands.execute(...args);
          },
        };
      }
      const refusing = deriveBackend(backend, {
        commands: refusingCommands(backend),
        transaction: (run, options) =>
          backend.transaction(
            (transaction) =>
              run(
                deriveBackend(transaction, {
                  commands: refusingCommands(transaction),
                }),
              ),
            options,
          ),
      });
      const store = createStore(graph, refusing);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      await expect(
        store.edges.knows.getOrCreateByEndpoints(alice, bob, {
          label: "friend",
        }),
      ).rejects.toMatchObject({
        details: {
          code: "DURABLE_EDGE_MATCH_IDENTITY_COMMAND_UNSUPPORTED",
          capability: "durableEdgeMatchIdentity",
          edgeKind: "knows",
        },
      });
      expect(refusedCommands).toBe(1);
      await expect(
        backend.findEdgesByKind({
          graphId: graph.id,
          kind: "knows",
          excludeDeleted: false,
          temporalMode: "includeTombstones",
        }),
      ).resolves.toHaveLength(0);
    } finally {
      await backend.close();
    }
  });

  it("uses the constraint fence for durable constrained-cardinality convergence", async () => {
    const { backend, db } = createLocalSqliteBackend();
    const sqlite = (db as typeof db & { $client: Database.Database }).$client;
    try {
      const graph = defineGraph({
        id: "durable_identity_constrained_cardinality",
        nodes: { Person: { type: Person } },
        edges: {
          knows: {
            type: knows,
            from: [Person],
            to: [Person],
            cardinality: "one",
            matchIdentity: { name: "knows-label", fields: ["label"] },
          },
        },
      });
      const [store] = await createStoreWithSchema(graph, backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      let convergenceCommands = 0;
      function trackedCommands(target: Pick<typeof backend, "commands">) {
        return {
          session: target.commands.session,
          execute(
            ...args: Parameters<typeof target.commands.execute>
          ): ReturnType<typeof target.commands.execute> {
            if (args[0].kind === "edge.converge-create") {
              convergenceCommands += 1;
            }
            return target.commands.execute(...args);
          },
        };
      }
      const tracked = deriveBackend(backend, {
        commands: trackedCommands(backend),
        transaction: (run, options) =>
          backend.transaction(
            (transaction) =>
              run(
                deriveBackend(transaction, {
                  commands: trackedCommands(transaction),
                }),
              ),
            options,
          ),
      });
      const trackedStore = createStore(graph, tracked);

      const created = await trackedStore.edges.knows.getOrCreateByEndpoints(
        alice,
        bob,
        { label: "friend" },
      );
      expect(
        sqlite
          .prepare(
            `SELECT edge_id FROM "typegraph_edge_claims" WHERE graph_id = ?`,
          )
          .all(graph.id),
      ).toHaveLength(1);
      await expect(
        trackedStore.edges.knows.getOrCreateByEndpoints(alice, bob, {
          label: "friend",
        }),
      ).resolves.toMatchObject({
        action: "found",
        edge: { id: created.edge.id },
      });
      expect(convergenceCommands).toBe(1);
    } finally {
      await backend.close();
    }
  });

  it("re-resolves a database-arbitrated durable identity race", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graph = durableGraph("durable_identity_race_resolution");
      const [setup] = await createStoreWithSchema(graph, backend);
      const alice = await setup.nodes.Person.create({ name: "Alice" });
      const bob = await setup.nodes.Person.create({ name: "Bob" });
      const owner = await setup.edges.knows.create(alice, bob, {
        label: "friend",
      });
      let injectConflict = true;
      function racingCommands(target: Pick<typeof backend, "commands">) {
        return {
          session: target.commands.session,
          execute(
            ...args: Parameters<typeof target.commands.execute>
          ): ReturnType<typeof target.commands.execute> {
            if (args[0].kind === "edge.converge-create" && injectConflict) {
              injectConflict = false;
              throw new EdgeMatchIdentityConflictError({
                attempted: [
                  {
                    id: "racing-attempt",
                    identityName: "knows-label",
                    kind: "knows",
                  },
                ],
              });
            }
            return target.commands.execute(...args);
          },
        };
      }
      const racing = deriveBackend(backend, {
        commands: racingCommands(backend),
        transaction: (run, options) =>
          backend.transaction(
            (transaction) =>
              run(
                deriveBackend(transaction, {
                  commands: racingCommands(transaction),
                }),
              ),
            options,
          ),
      });

      await expect(
        createStore(graph, racing).edges.knows.getOrCreateByEndpoints(
          alice,
          bob,
          { label: "friend" },
        ),
      ).resolves.toMatchObject({
        action: "found",
        edge: { id: owner.id },
      });
      expect(injectConflict).toBe(false);
    } finally {
      await backend.close();
    }
  });

  it("reports typed exhaustion after repeated durable identity races", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graph = durableGraph("durable_identity_race_exhaustion");
      const [setup] = await createStoreWithSchema(graph, backend);
      const alice = await setup.nodes.Person.create({ name: "Alice" });
      const bob = await setup.nodes.Person.create({ name: "Bob" });
      await setup.edges.knows.create(alice, bob, {
        label: "friend",
      });
      let convergenceAttempts = 0;
      function racingCommands(target: Pick<typeof backend, "commands">) {
        return {
          session: target.commands.session,
          execute(
            ...args: Parameters<typeof target.commands.execute>
          ): ReturnType<typeof target.commands.execute> {
            if (
              args[0].kind === "edge.converge-create" &&
              convergenceAttempts < 3
            ) {
              convergenceAttempts += 1;
              throw new EdgeMatchIdentityConflictError({
                attempted: [
                  {
                    id: "racing-attempt",
                    identityName: "knows-label",
                    kind: "knows",
                  },
                ],
              });
            }
            return target.commands.execute(...args);
          },
        };
      }
      const racing = deriveBackend(backend, {
        commands: racingCommands(backend),
        findEdgesByKind() {
          return Promise.resolve([]);
        },
        transaction: (run, options) =>
          backend.transaction(
            (transaction) =>
              run(
                deriveBackend(transaction, {
                  commands: racingCommands(transaction),
                  findEdgesByKind() {
                    return Promise.resolve([]);
                  },
                }),
              ),
            options,
          ),
      });

      const result = createStore(
        graph,
        racing,
      ).edges.knows.getOrCreateByEndpoints(alice, bob, { label: "friend" });
      await expect(result).rejects.toBeInstanceOf(DatabaseOperationError);
      await expect(result).rejects.toThrow("after 3 attempts");
      expect(convergenceAttempts).toBe(3);
    } finally {
      await backend.close();
    }
  });
});
