import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { instantiateGraphTemplateStatement } from "../src/backend/drizzle/graph-template-sql";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { defineGraph } from "../src/core/define-graph";
import { defineNode } from "../src/core/node";
import { renderSqlite } from "../src/query/sql-fragment";
import {
  instantiateGraphTemplate,
  registerGraphTemplate,
} from "../src/schema/graph-templates";
import { parseSerializedSchema } from "../src/schema/manager";
import {
  createAdapterStore,
  createAdapterStoreWithSchema,
  createVerifiedAdapterStore,
} from "../src/store/store";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const templateGraph = defineGraph({
  id: "graph_template_source",
  nodes: { Person: { type: Person } },
  edges: {},
});

describe("graph templates", () => {
  it("uses one schema-document-free SQLite statement for instantiation", () => {
    const rendered = renderSqlite(
      instantiateGraphTemplateStatement({
        dialect: "sqlite",
        graphId: "tenant-a",
        schemaHash: "target-hash",
        schemaVersionsTableName: "typegraph_schema_versions",
        templatesTableName: "typegraph_graph_templates",
        templateId: "people-v1",
        templateSchemaHash: "source-hash",
      }),
    );

    expect(rendered.sql).not.toContain(";");
    expect(rendered.sql).toContain("INSERT INTO");
    expect(rendered.params).toEqual([
      "tenant-a",
      "target-hash",
      "tenant-a",
      "people-v1",
      "source-hash",
      "tenant-a",
      "target-hash",
    ]);
  });

  it("executes exactly one SQLite statement when instantiating", async () => {
    const { backend, db } = createLocalSqliteBackend();
    const client = (db as unknown as Readonly<{ $client: Database.Database }>)
      .$client;
    const preparedStatements: string[] = [];
    const originalPrepare = client.prepare.bind(client);
    client.prepare = function prepare(source: string) {
      preparedStatements.push(source);
      return originalPrepare(source);
    };

    try {
      const [source] = await createAdapterStoreWithSchema(
        templateGraph,
        backend,
      );
      const template = await registerGraphTemplate(backend, {
        templateId: "people-v1",
        reconciled: source.reconciledSchema,
      });
      preparedStatements.length = 0;

      await instantiateGraphTemplate(backend, {
        template,
        graphId: "tenant-one-statement",
      });

      expect(preparedStatements).toHaveLength(1);
      expect(preparedStatements[0]).toContain("INSERT INTO");
      expect(preparedStatements[0]).not.toContain("schema_doc = ?");
    } finally {
      await backend.close();
    }
  });

  it("instantiates a target v1 with one final schema shape and converges on retry", async () => {
    const backend = createTestBackend();
    const [source] = await createAdapterStoreWithSchema(templateGraph, backend);
    const template = await registerGraphTemplate(backend, {
      templateId: "people-v1",
      reconciled: source.reconciledSchema,
    });

    const first = await instantiateGraphTemplate(backend, {
      template,
      graphId: "tenant-a",
    });
    const retry = await instantiateGraphTemplate(backend, {
      template,
      graphId: "tenant-a",
    });

    expect(first.status).toBe("ready");
    expect(retry.status).toBe("ready");
    expect(first.schema.version).toBe(1);
    expect(retry.schema.schema_hash).toBe(first.schema.schema_hash);
    const stored = parseSerializedSchema(first.schema.schema_doc);
    expect(stored.graphId).toBe("tenant-a");
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.nodes)).toEqual(["Person"]);
    expect(first.reconciled).toMatchObject({
      graph: { id: "tenant-a" },
      version: 1,
      hash: first.schema.schema_hash,
    });

    const targetGraph = defineGraph({
      id: "tenant-a",
      nodes: { Person: { type: Person } },
      edges: {},
    });
    const targetStore = createAdapterStore(targetGraph, backend, {
      reconciled: first.reconciled,
    });
    expect(targetStore.reconciledSchema).toStrictEqual(first.reconciled);
    await expect(
      createVerifiedAdapterStore(targetGraph, backend),
    ).rejects.toMatchObject({ name: "StoreNotInitializedError" });
  });

  it("refuses a stale template handle instead of cloning a different registry row", async () => {
    const backend = createTestBackend();
    const [source] = await createAdapterStoreWithSchema(templateGraph, backend);
    const template = await registerGraphTemplate(backend, {
      templateId: "people-v1",
      reconciled: source.reconciledSchema,
    });
    const staleTemplate = Object.freeze({
      ...template,
      schemaHash: "stale-source-hash",
    });

    await expect(
      instantiateGraphTemplate(backend, {
        template: staleTemplate,
        graphId: "tenant-stale",
      }),
    ).rejects.toMatchObject({
      details: { code: "GRAPH_TEMPLATE_INSTANTIATION_REFUSED" },
    });
  });

  it("refuses a target that already belongs to a different schema", async () => {
    const backend = createTestBackend();
    const [source] = await createAdapterStoreWithSchema(templateGraph, backend);
    const template = await registerGraphTemplate(backend, {
      templateId: "people-v1",
      reconciled: source.reconciledSchema,
    });
    const conflictingGraph = defineGraph({
      id: "tenant-b",
      nodes: {},
      edges: {},
    });
    await createAdapterStoreWithSchema(conflictingGraph, backend);

    await expect(
      instantiateGraphTemplate(backend, { template, graphId: "tenant-b" }),
    ).rejects.toMatchObject({
      details: { code: "GRAPH_TEMPLATE_INSTANTIATION_REFUSED" },
    });
  });
});
