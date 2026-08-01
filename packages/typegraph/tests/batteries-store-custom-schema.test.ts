/**
 * Custom-`SqlSchema` handling in the batteries-included store constructors
 * and the schema manager, from two review findings:
 *
 *  - The constructors provision physical tables from `store.schema` but used
 *    to spread `schemaManagement` afterwards — a `schema` smuggled there
 *    replaced the provisioned one, so the Store read tables that were never
 *    created ("no such table: nested_custom_nodes").
 *
 *  - The manager accepted `options.schema` without `requireSqlSchema()`
 *    brand validation, so a schema-shaped plain object could expose custom
 *    names to provisioning while its SQL fragments targeted the defaults —
 *    committing version 1 with the closure in the wrong tables.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "../src";
import { createLocalPgliteStore } from "../src/backend/postgres/pglite-store";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { createLocalSqliteStore } from "../src/backend/sqlite/local-store";
import { createSqlSchema } from "../src/query/compiler/schema";
import { getActiveSchema } from "../src/schema";
import { matchingObject } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Author = defineNode("Author", {
  schema: z.object({ penName: z.string() }),
});

const graph = defineGraph({
  id: "batteries_custom_schema",
  nodes: { Person: { type: Person }, Author: { type: Author } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

const CUSTOM_TABLES = {
  nodes: "nested_custom_nodes",
  edges: "nested_custom_edges",
  identityAssertions: "nested_custom_identity_assertions",
  recordedIdentityAssertions: "nested_custom_recorded_identity_assertions",
  identityClosure: "nested_custom_identity_closure",
} as const;

describe("batteries-included constructors with a custom SqlSchema", () => {
  it("provisions and reads the same custom tables on SQLite", async () => {
    const schema = createSqlSchema(CUSTOM_TABLES);
    const store = await createLocalSqliteStore(graph, {
      store: { schema },
      // A smuggled second schema is excluded by the type and stripped at
      // runtime — the provisioned schema is the only source of truth.
      schemaManagement: {
        schema: createSqlSchema({}),
      } as never,
    });
    try {
      const person = await store.nodes.Person.create(
        { name: "N" },
        { id: "nested" },
      );
      await store.nodes.Author.create({ penName: "N." }, { id: "nested" });
      expect(
        await store.identity.areSame(person, { kind: "Author", id: "nested" }),
      ).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("provisions and reads the same custom tables on PGlite", async () => {
    const schema = createSqlSchema(CUSTOM_TABLES);
    const store = await createLocalPgliteStore(graph, {
      store: { schema },
      schemaManagement: {
        schema: createSqlSchema({}),
      } as never,
    });
    try {
      const person = await store.nodes.Person.create(
        { name: "N" },
        { id: "nested" },
      );
      await store.nodes.Author.create({ penName: "N." }, { id: "nested" });
      expect(
        await store.identity.areSame(person, { kind: "Author", id: "nested" }),
      ).toBe(true);
    } finally {
      await store.close();
    }
  });
});

describe("schema option brand validation", () => {
  it("rejects a schema-shaped plain object before any commit", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const legacy = createStore(
        defineGraph({
          id: graph.id,
          nodes: { Person: { type: Person }, Author: { type: Author } },
          edges: {},
        }),
        backend,
      );
      await legacy.nodes.Person.create({ name: "S" }, { id: "shared" });
      await legacy.nodes.Author.create({ penName: "S." }, { id: "shared" });

      // A frozen schema-shaped object whose provisioning names are custom
      // but whose SQL fragments target the defaults — the exact shape that
      // used to land the version-1 closure in tables the Store never reads.
      const realSchema = createSqlSchema(CUSTOM_TABLES);
      const counterfeit = Object.freeze({
        ...(realSchema as unknown as Record<string, unknown>),
      });

      await expect(
        createStoreWithSchema(graph, backend, {
          schema: counterfeit as never,
        }),
      ).rejects.toMatchObject({
        details: matchingObject({ code: "INVALID_SQL_SCHEMA" }),
      });
      // Rejection happens before the version commit: no active row remains.
      expect(await getActiveSchema(backend, graph.id)).toBeUndefined();
    } finally {
      await backend.close();
    }
  });
});
