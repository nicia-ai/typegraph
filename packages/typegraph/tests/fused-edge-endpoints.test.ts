/**
 * The endpoint-fused edge insert has one portable public contract even though
 * only the bundled SQLite/PostgreSQL backends implement its optional fast
 * path. In particular, an empty INSERT ... RETURNING result is never exposed
 * as an ambiguous failure: ordered diagnostics still report `from` before
 * `to`, including tombstones.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, ValidationError } from "../src";
import { generatePostgresDDL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { type GraphBackend } from "../src/backend/types";
import { createInitializedStore } from "./test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const knows = defineEdge("knows", { schema: z.object({ note: z.string() }) });

const graph = defineGraph({
  id: "fused_edge_endpoints",
  nodes: { Person: { type: Person } },
  edges: {
    knows: { type: knows, from: [Person], to: [Person], cardinality: "many" },
  },
});

type BackendFixture = Readonly<{
  name: string;
  backend: GraphBackend;
  close: () => Promise<void>;
}>;

const fixtures: readonly Readonly<{
  name: string;
  create: () => Promise<BackendFixture>;
}>[] = [
  {
    name: "SQLite",
    create(): Promise<BackendFixture> {
      const { backend } = createLocalSqliteBackend();
      return Promise.resolve({
        name: "SQLite",
        backend,
        close: () => backend.close(),
      });
    },
  },
  {
    name: "PGlite",
    async create(): Promise<BackendFixture> {
      const client = await PGlite.create();
      await client.exec(generatePostgresDDL().join("\n\n"));
      return {
        name: "PGlite",
        backend: createPostgresBackend(drizzlePglite(client), {
          vector: false,
        }),
        close: () => client.close(),
      };
    },
  },
];

describe("fused edge endpoint validation", () => {
  for (const fixtureFactory of fixtures) {
    it(`preserves typed endpoint and duplicate outcomes on ${fixtureFactory.name}`, async () => {
      const fixture = await fixtureFactory.create();
      try {
        const store = await createInitializedStore(graph, fixture.backend);
        const from = await store.nodes.Person.create({ name: "from" });
        const successfulTo = await store.nodes.Person.create({
          name: "successful to",
        });
        const to = await store.nodes.Person.create({ name: "to" });

        const created = await store.edges.knows.create(from, successfulTo, {
          note: "created through fused endpoint validation",
        });
        expect(created.fromId).toBe(from.id);
        expect(created.toId).toBe(successfulTo.id);

        await expect(
          store.edges.knows.create({ kind: "Person", id: "missing-from" }, to, {
            note: "missing source",
          }),
        ).rejects.toMatchObject({
          details: { endpoint: "from", nodeId: "missing-from" },
        });

        await store.nodes.Person.delete(to.id);
        await expect(
          store.edges.knows.create(from, to, { note: "tombstoned target" }),
        ).rejects.toMatchObject({
          details: { endpoint: "to", nodeId: to.id },
        });

        await expect(
          store.edges.knows.create(
            { kind: "Person", id: "missing-from-again" },
            to,
            { note: "both unavailable" },
          ),
        ).rejects.toMatchObject({
          details: { endpoint: "from", nodeId: "missing-from-again" },
        });

        const other = await store.nodes.Person.create({ name: "other" });
        await store.edges.knows.create(
          from,
          other,
          { note: "first id" },
          {
            id: "caller-supplied-edge-id",
          },
        );
        await expect(
          store.edges.knows.create(
            from,
            other,
            { note: "duplicate id" },
            {
              id: "caller-supplied-edge-id",
            },
          ),
        ).rejects.toBeInstanceOf(ValidationError);
      } finally {
        await fixture.close();
      }
    });
  }
});
