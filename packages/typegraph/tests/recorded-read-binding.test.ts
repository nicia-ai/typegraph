import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createQueryBuilder,
  createStore,
  defineGraph,
  defineNode,
  type ExternalRecordedReadSource,
  recordedRelation,
  type StoreOptions,
} from "../src";
import { ConfigurationError } from "../src/errors";
import { compileQuery } from "../src/query/compiler";
import {
  createRecordedReadBinding,
  createSqlSchema,
  recordedReadSqlSchema,
  type SqlSchema,
} from "../src/query/compiler/schema";
import { buildKindRegistry } from "../src/registry";
import { toSqlString } from "./sql-test-utils";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "recorded-read-binding-test",
  nodes: { Person: { type: Person } },
  edges: {},
});

const registry = buildKindRegistry(graph);

function structurallyCompatibleSqlSchema(): SqlSchema {
  const schema = createSqlSchema();
  return {
    tables: schema.tables,
    nodesTable: schema.nodesTable,
    edgesTable: schema.edgesTable,
    recordedNodesTable: schema.recordedNodesTable,
    recordedEdgesTable: schema.recordedEdgesTable,
    recordedClockTable: schema.recordedClockTable,
    fulltextTable: schema.fulltextTable,
  } as unknown as SqlSchema;
}

describe("recorded read binding", () => {
  it("requires an explicit binding before compiling recorded-time reads", () => {
    const schema = createSqlSchema();
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "person")
      .select((context) => context.person.id);
    const ast = {
      ...query.toAst(),
      recordedAsOf: "2026-01-01T00:00:00.000Z",
    };

    expect(() =>
      compileQuery(ast, graph.id, { dialect: "sqlite", schema }),
    ).toThrow("Recorded-time reads require a recorded read relation");

    const compiled = compileQuery(ast, graph.id, {
      dialect: "sqlite",
      schema,
      recordedReadBinding: createRecordedReadBinding(schema),
    });
    const sql = toSqlString(compiled);

    expect(sql).toContain(schema.tables.recordedNodes);
    expect(sql).not.toContain(`FROM "${schema.tables.nodes}"`);
  });

  it("rejects runtime-forged SQL schemas at public schema boundaries", () => {
    const forgedSchema = structurallyCompatibleSqlSchema();
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "person")
      .select((context) => context.person.id);

    expect(() => recordedRelation({ schema: forgedSchema })).toThrow(
      ConfigurationError,
    );
    expect(() => recordedRelation({ schema: forgedSchema })).toThrow(
      "recordedRelation schema must be created with createSqlSchema(...)",
    );
    expect(() =>
      createStore(graph, createTestBackend(), { schema: forgedSchema }),
    ).toThrow("store schema must be created with createSqlSchema(...)");
    expect(() =>
      compileQuery(query.toAst(), graph.id, {
        dialect: "sqlite",
        schema: forgedSchema,
      }),
    ).toThrow("compileQuery schema must be created with createSqlSchema(...)");
  });

  it("rejects runtime-forged external recorded read sources", () => {
    const schema = createSqlSchema();
    const forged = {
      source: "external",
      schema,
    } as unknown as ExternalRecordedReadSource;

    expect(() =>
      createStore(graph, createTestBackend(), { recordedRead: forged }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createStore(graph, createTestBackend(), { recordedRead: forged }),
    ).toThrow("recordedRead must be created with recordedRelation({ schema })");
  });

  it("rejects runtime-forged recorded read bindings in the compiler", () => {
    const schema = createSqlSchema();
    const forged = {
      source: "typegraph-capture",
      schema,
    } as unknown as Parameters<typeof recordedReadSqlSchema>[0];

    expect(() => recordedReadSqlSchema(forged)).toThrow(ConfigurationError);
    expect(() => recordedReadSqlSchema(forged)).toThrow(
      "Recorded-time reads require a recorded read relation created by TypeGraph",
    );
  });

  it("keeps recorded read source descriptors immutable at runtime", () => {
    const schema = createSqlSchema();
    const external = recordedRelation({ schema });
    const captured = createRecordedReadBinding(schema);

    expect(Object.isFrozen(external)).toBe(true);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(() => {
      (external as { source: string }).source = "typegraph-capture";
    }).toThrow(TypeError);
    expect(() => {
      delete (external as { schema?: unknown }).schema;
    }).toThrow(TypeError);
  });

  it("keeps recorded read SQL schema views immutable and factory-branded", () => {
    const schema = createSqlSchema();
    const recordedSchema = recordedReadSqlSchema(
      createRecordedReadBinding(schema),
    );

    expect(Object.isFrozen(recordedSchema)).toBe(true);
    expect(recordedSchema.nodesTable).toBe(schema.recordedNodesTable);
    expect(recordedSchema.edgesTable).toBe(schema.recordedEdgesTable);
    expect(() => {
      (recordedSchema as { nodesTable?: unknown }).nodesTable = undefined;
    }).toThrow(TypeError);
    expect(() => recordedRelation({ schema: recordedSchema })).not.toThrow();
  });

  it("rejects runtime recordedRead bindings on history stores", () => {
    const options = {
      history: true,
      recordedRead: recordedRelation({ schema: createSqlSchema() }),
    } as unknown as StoreOptions;

    expect(() => createStore(graph, createTestBackend(), options)).toThrow(
      ConfigurationError,
    );
    expect(() => createStore(graph, createTestBackend(), options)).toThrow(
      "recordedRead cannot be combined with history: true",
    );
  });
});
