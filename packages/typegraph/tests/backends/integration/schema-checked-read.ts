import { describe, expect, it, vi } from "vitest";

import {
  ConfigurationError,
  createStore,
  defineGraph,
  SchemaChangedError,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { serializeSchema } from "../../../src/schema/serializer";
import { integrationTestGraph } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

export function registerSchemaCheckedReadIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("schema-checked reads", () => {
    it("checks the version in one ordered statement, including empty and stale results", async () => {
      const starts: string[] = [];
      const store = await context.createStore(integrationTestGraph, {
        hooks: {
          onQueryStart: (event) => {
            starts.push(event.sql);
          },
        },
      });
      await store.nodes.Person.create({ name: "B", age: 2 });
      await store.nodes.Person.create({ name: "A", age: 1 });
      const activeSchema = await context
        .getBackend()
        .getActiveSchema(store.graphId);
      const version = activeSchema?.version;
      const select = vi.fn((ctx: { p: { name: string } }) => ctx.p.name);
      const query = store
        .query()
        .from("Person", "p")
        .orderBy("p", "age", "desc")
        .select(select)
        .limit(1);
      const probe = vi.spyOn(context.getBackend(), "getActiveSchema");
      starts.length = 0;
      expect(await query.executeChecked(version)).toEqual(["B"]);
      expect(starts).toHaveLength(1);
      expect(probe).not.toHaveBeenCalled();
      expect(select).toHaveBeenCalledTimes(1);
      const ordered = store
        .query()
        .from("Person", "schema")
        .orderBy("schema", "age", "desc")
        .select((ctx) => ctx.schema.name);
      expect(await ordered.executeChecked(version)).toEqual(["B", "A"]);
      const empty = store
        .query()
        .from("Person", "p")
        .whereNode("p", (node) => node.name.eq("missing"))
        .select(select);
      starts.length = 0;
      expect(await empty.executeChecked(version)).toEqual([]);
      expect(starts).toHaveLength(1);
      const nextVersion = (version ?? 0) + 1;
      await context.getBackend().commitSchemaVersion({
        graphId: store.graphId,
        expected:
          version === undefined ?
            { kind: "initial" }
          : { kind: "active", version },
        version: nextVersion,
        schemaHash: "checked-read-next-version",
        schemaDoc: serializeSchema(integrationTestGraph, nextVersion),
      });
      for (const stale of [query, empty]) {
        starts.length = 0;
        select.mockClear();
        await expect(stale.executeChecked(version)).rejects.toMatchObject({
          name: "SchemaChangedError",
          details: {
            expected: version,
            actual: nextVersion,
            graphId: store.graphId,
          },
        });
        expect(starts).toHaveLength(1);
        expect(select).not.toHaveBeenCalled();
      }
      expect(await query.executeChecked(nextVersion)).toEqual(["B"]);
      probe.mockRestore();
    });

    it("distinguishes an absent schema from an initialized version", async () => {
      const uninitialized = defineGraph({
        id: "uninitialized_checked_read",
        nodes: integrationTestGraph.nodes,
        edges: integrationTestGraph.edges,
      });
      const store = createStore(uninitialized, context.getBackend());
      const query = store
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p);
      expect(await query.executeChecked(undefined)).toEqual([]);
      await expect(query.executeChecked(0)).rejects.toBeInstanceOf(
        SchemaChangedError,
      );
    });

    it("refuses recursive and relevance queries before executing SQL", async () => {
      const backend = context.getBackend();
      const store = createStore(integrationTestGraph, backend);
      const execute = vi.spyOn(backend, "execute");
      const recursive = store
        .query()
        .from("Person", "p")
        .traverse("knows", "edge")
        .recursive({ maxHops: 2 })
        .to("Person", "target")
        .select((ctx) => ctx.target);
      const relevance = store
        .query()
        .from("Article", "article")
        .whereNode("article", (node) => node.$fulltext.matches("example"))
        .select((ctx) => ctx.article);
      for (const query of [recursive, relevance]) {
        await expect(query.executeChecked(undefined)).rejects.toBeInstanceOf(
          ConfigurationError,
        );
      }
      expect(execute).not.toHaveBeenCalled();
      execute.mockRestore();
    });

    it("refuses a custom backend without a schema binding before SQL", async () => {
      const backend = context.getBackend();
      const execute = vi.spyOn(backend, "execute");
      const customBackend = deriveBackend(backend, {
        tableNames: undefined,
      });
      const store = createStore(integrationTestGraph, customBackend);
      await expect(
        store
          .query()
          .from("Person", "p")
          .select((ctx) => ctx.p)
          .executeChecked(undefined),
      ).rejects.toBeInstanceOf(ConfigurationError);
      expect(execute).not.toHaveBeenCalled();
      execute.mockRestore();
    });
  });
}
