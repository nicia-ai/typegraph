import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import {
  exportGraph,
  type GraphData,
  importGraph,
  ImportOptionsSchema,
  trustedImportGraph,
} from "../src/interchange";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows", {
  schema: z.object({ label: z.string(), note: z.string().optional() }),
});

function importGraphDefinition(id: string) {
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

function payload(edges: GraphData["edges"]): GraphData {
  return {
    formatVersion: "2.0",
    exportedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "external", description: "edge identity import test" },
    nodes: [
      { kind: "Person", id: "alice", properties: { name: "Alice" } },
      { kind: "Person", id: "bob", properties: { name: "Bob" } },
    ],
    edges,
  };
}

const importOptions = ImportOptionsSchema.parse({
  onConflict: "error",
  refreshStatistics: false,
});

describe("edge match identity import", () => {
  it("refuses an onConflict update that changes a durable identity field", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graph = importGraphDefinition("import_identity_update");
      const [store] = await createStoreWithSchema(graph, backend);
      await importGraph(
        store,
        payload([
          {
            kind: "knows",
            id: "knows-1",
            from: { kind: "Person", id: "alice" },
            to: { kind: "Person", id: "bob" },
            properties: { label: "friend", note: "original" },
          },
        ]),
        importOptions,
      );

      const result = await importGraph(
        store,
        payload([
          {
            kind: "knows",
            id: "knows-1",
            from: { kind: "Person", id: "alice" },
            to: { kind: "Person", id: "bob" },
            properties: { label: "colleague", note: "changed" },
          },
        ]),
        ImportOptionsSchema.parse({
          onConflict: "update",
          refreshStatistics: false,
        }),
      );

      expect(result.edges.updated).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        entityType: "edge",
        id: "knows-1",
      });
      expect(result.errors[0]?.error).toContain(
        "match identity fields are immutable",
      );
      await expect(
        store.edges.knows.getById("knows-1" as never),
      ).resolves.toMatchObject({ label: "friend", note: "original" });

      await expect(
        store.edges.knows.getOrCreateByEndpoints(
          { kind: "Person", id: "alice" } as never,
          { kind: "Person", id: "bob" } as never,
          { label: "friend" },
        ),
      ).resolves.toMatchObject({
        action: "found",
        edge: { id: "knows-1", label: "friend" },
      });
    } finally {
      await backend.close();
    }
  });

  it("records duplicate identities in one payload as per-row errors", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        importGraphDefinition("import_identity_duplicate_payload"),
        backend,
      );
      const result = await importGraph(
        store,
        payload([
          {
            kind: "knows",
            id: "knows-1",
            from: { kind: "Person", id: "alice" },
            to: { kind: "Person", id: "bob" },
            properties: { label: "friend" },
          },
          {
            kind: "knows",
            id: "knows-2",
            from: { kind: "Person", id: "alice" },
            to: { kind: "Person", id: "bob" },
            properties: { label: "friend" },
          },
        ]),
        importOptions,
      );

      expect(result.edges).toMatchObject({ created: 1 });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        entityType: "edge",
        id: "knows-2",
      });
      expect(result.errors[0]?.error).toContain(
        "schema-declared match identity",
      );
    } finally {
      await backend.close();
    }
  });

  it("records an existing identity owner without aborting unrelated rows", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        importGraphDefinition("import_identity_existing_owner"),
        backend,
      );
      await importGraph(
        store,
        payload([
          {
            kind: "knows",
            id: "knows-owner",
            from: { kind: "Person", id: "alice" },
            to: { kind: "Person", id: "bob" },
            properties: { label: "friend" },
          },
        ]),
        importOptions,
      );

      const nextPayload = payload([
        {
          kind: "knows",
          id: "knows-conflict",
          from: { kind: "Person", id: "alice" },
          to: { kind: "Person", id: "bob" },
          properties: { label: "friend" },
        },
        {
          kind: "knows",
          id: "knows-valid",
          from: { kind: "Person", id: "alice" },
          to: { kind: "Person", id: "bob" },
          properties: { label: "colleague" },
        },
      ]);
      const result = await importGraph(
        store,
        { ...nextPayload, nodes: [] },
        importOptions,
      );

      expect(result.edges).toMatchObject({ created: 1 });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        entityType: "edge",
        id: "knows-conflict",
      });
      expect(result.errors[0]?.error).toContain(
        "schema-declared match identity",
      );
      await expect(
        store.edges.knows.getById("knows-valid" as never),
      ).resolves.toMatchObject({ label: "colleague" });
    } finally {
      await backend.close();
    }
  });

  it("records oversized durable identities per row and keeps importing", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        importGraphDefinition("import_identity_oversized_row"),
        backend,
      );
      const result = await importGraph(
        store,
        payload([
          {
            kind: "knows",
            id: "knows-valid-1",
            from: { kind: "Person", id: "alice" },
            to: { kind: "Person", id: "bob" },
            properties: { label: "friend" },
          },
          {
            kind: "knows",
            id: "knows-too-large",
            from: { kind: "Person", id: "alice" },
            to: { kind: "Person", id: "bob" },
            properties: { label: "x".repeat(3000) },
          },
          {
            kind: "knows",
            id: "knows-valid-2",
            from: { kind: "Person", id: "alice" },
            to: { kind: "Person", id: "bob" },
            properties: { label: "colleague" },
          },
        ]),
        importOptions,
      );

      expect(result.edges.created).toBe(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        entityType: "edge",
        id: "knows-too-large",
      });
      expect(result.errors[0]?.error).toContain("portable storage limit");
      await expect(
        store.edges.knows.getById("knows-too-large" as never),
      ).resolves.toBeUndefined();
    } finally {
      await backend.close();
    }
  });

  it("records deferred duplicate-id identity conflicts per row", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        importGraphDefinition("import_identity_deferred_conflict"),
        backend,
      );
      await importGraph(
        store,
        payload([
          {
            kind: "knows",
            id: "identity-owner",
            from: { kind: "Person", id: "alice" },
            to: { kind: "Person", id: "bob" },
            properties: { label: "friend" },
          },
        ]),
        importOptions,
      );

      const duplicate = {
        kind: "knows",
        id: "deferred-id",
        from: { kind: "Person", id: "alice" },
        to: { kind: "Person", id: "bob" },
        properties: { label: "friend" },
      } as const;
      const result = await importGraph(
        store,
        { ...payload([duplicate, duplicate]), nodes: [] },
        importOptions,
      );

      expect(result.edges.created).toBe(0);
      expect(result.errors).toHaveLength(2);
      expect(result.errors.every((entry) => entry.id === "deferred-id")).toBe(
        true,
      );
      expect(
        result.errors.every((entry) =>
          entry.error.includes("schema-declared match identity"),
        ),
      ).toBe(true);
    } finally {
      await backend.close();
    }
  });

  it("round-trips exported defaults through trusted identity keying", async () => {
    // Trusted import deliberately does not parse schemas or invent properties:
    // its contract is an export-produced stream. The source write applies the
    // default, export carries that persisted value, and trusted keying must use
    // the same value rather than a separately synthesized default.
    const defaultedKnows = defineEdge("defaultedKnows", {
      schema: z.object({ label: z.string().default("friend") }),
    });
    const graph = defineGraph({
      id: "trusted_import_identity_defaults",
      nodes: { Person: { type: Person } },
      edges: {
        defaultedKnows: {
          type: defaultedKnows,
          from: [Person],
          to: [Person],
          matchIdentity: { name: "defaulted-label", fields: ["label"] },
        },
      },
    });
    const source = createLocalSqliteBackend();
    const target = createLocalSqliteBackend();
    try {
      const sourceStore = createStore(graph, source.backend);
      const alice = await sourceStore.nodes.Person.create({ name: "Alice" });
      const bob = await sourceStore.nodes.Person.create({ name: "Bob" });
      const owner = await sourceStore.edges.defaultedKnows.create(
        alice,
        bob,
        {},
      );
      const exported = await exportGraph(sourceStore);
      expect(exported.edges[0]?.properties).toEqual({ label: "friend" });

      const targetStore = createStore(graph, target.backend);
      await trustedImportGraph(targetStore, exported);
      await expect(
        targetStore.edges.defaultedKnows.getOrCreateByEndpoints(alice, bob, {}),
      ).resolves.toMatchObject({
        action: "found",
        edge: { id: owner.id, label: "friend" },
      });
    } finally {
      await source.backend.close();
      await target.backend.close();
    }
  });
});
