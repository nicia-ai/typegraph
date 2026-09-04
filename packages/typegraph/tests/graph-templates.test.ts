import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { deriveBackend } from "../src/backend/derive-backend";
import { sqliteInstantiateGraphTemplateStatement } from "../src/backend/drizzle/graph-template-sql";
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
      sqliteInstantiateGraphTemplateStatement({
        graphId: "tenant-a",
        schemaHash: "target-hash",
        schemaVersionsTableName: "typegraph_schema_versions",
        templatesTableName: "typegraph_graph_templates",
        contributionMaterializationsTableName:
          "typegraph_contribution_materializations",
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

  it("executes the schema and marker SQLite statements when instantiating", async () => {
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

      expect(preparedStatements).toHaveLength(3);
      expect(preparedStatements[0]).toContain("typegraph_base_schema_versions");
      expect(preparedStatements[1]).toContain("INSERT INTO");
      expect(preparedStatements[1]).not.toContain("schema_doc = ?");
      expect(preparedStatements[2]).toContain(
        "typegraph_contribution_materializations",
      );
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
    ).resolves.toMatchObject({
      0: { reconciledSchema: first.reconciled },
    });
  });

  it("refuses a stale template handle before consulting the backend registry", async () => {
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
    let instantiateCalls = 0;
    const instantiate = backend.instantiateGraphTemplate;
    if (instantiate === undefined)
      throw new Error("Expected template instantiation support");
    const observedBackend = deriveBackend(backend, {
      async instantiateGraphTemplate(params) {
        instantiateCalls += 1;
        return instantiate(params);
      },
    });

    await expect(
      instantiateGraphTemplate(observedBackend, {
        template: staleTemplate,
        graphId: "tenant-stale",
      }),
    ).rejects.toMatchObject({
      details: { code: "GRAPH_TEMPLATE_HANDLE_MISMATCH" },
    });
    expect(instantiateCalls).toBe(0);
  });

  it("refuses a handle whose local graph differs from its registered hash", async () => {
    const backend = createTestBackend();
    const [source] = await createAdapterStoreWithSchema(templateGraph, backend);
    const template = await registerGraphTemplate(backend, {
      templateId: "people-v1",
      reconciled: source.reconciledSchema,
    });
    const mismatchedTemplate = Object.freeze({
      ...template,
      reconciled: Object.freeze({
        ...template.reconciled,
        graph: Object.freeze({
          ...template.reconciled.graph,
          id: "different-source",
        }),
      }),
    });

    await expect(
      instantiateGraphTemplate(backend, {
        template: mismatchedTemplate,
        graphId: "tenant-mismatched",
      }),
    ).rejects.toMatchObject({
      details: { code: "GRAPH_TEMPLATE_HANDLE_MISMATCH" },
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
