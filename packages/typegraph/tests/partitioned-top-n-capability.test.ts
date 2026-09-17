import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineNode,
  UnsupportedBackendCapabilityError,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import type { GraphBackend } from "../src/backend/types";
import type { CompiledRowsSql } from "../src/query/sql-intent";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), score: z.number() }),
});
const graph = defineGraph({
  id: "partitioned_top_n_capability",
  nodes: { Person: { type: Person } },
  edges: {},
});

function createObservedBackend(): Readonly<{
  backend: GraphBackend;
  statements: () => number;
}> {
  const source = createTestBackend();
  let statementCount = 0;
  const backend = deriveBackend(source, {
    execute: async <Row>(query: CompiledRowsSql) => {
      statementCount += 1;
      return source.execute<Row>(query);
    },
    executeRaw: async <Row>(sqlText: string, params: readonly unknown[]) => {
      statementCount += 1;
      const executeRaw = source.executeRaw;
      if (executeRaw === undefined)
        throw new Error("Test backend must support raw execution");
      return executeRaw<Row>(sqlText, params);
    },
  });
  return { backend, statements: () => statementCount };
}

function relation(backend: GraphBackend) {
  return createStore(graph, backend)
    .query()
    .from("Person", "person")
    .project((fields) => ({
      id: fields.person.id,
      name: fields.person.name,
      score: fields.person.score,
    }))
    .asRelation()
    .topPerPartition({
      partitionBy: (columns) => [columns.name],
      orderBy: (columns) => [
        { expression: columns.score, direction: "desc" },
        { expression: columns.id },
      ],
      limit: 1,
    });
}

function withoutWindowFunctions(backend: GraphBackend): GraphBackend {
  return deriveBackend(backend, {
    capabilities: { ...backend.capabilities, windowFunctions: false },
  });
}

describe("partitioned top-N capability refusal", () => {
  it("refuses compile, SQL rendering, and all direct terminals before executing SQL", async () => {
    const observed = createObservedBackend();
    const top = relation(withoutWindowFunctions(observed.backend));

    expect(() => top.compile()).toThrow(UnsupportedBackendCapabilityError);
    expect(() => top.toSQL()).toThrow(UnsupportedBackendCapabilityError);
    await expect(top.execute()).rejects.toBeInstanceOf(
      UnsupportedBackendCapabilityError,
    );
    await expect(top.count()).rejects.toBeInstanceOf(
      UnsupportedBackendCapabilityError,
    );
    await expect(top.exists()).rejects.toBeInstanceOf(
      UnsupportedBackendCapabilityError,
    );
    expect(observed.statements()).toBe(0);
  });

  it("refuses a batch item before executing any batch SQL", async () => {
    const observed = createObservedBackend();
    const batchStore = createStore(graph, observed.backend);
    const top = relation(withoutWindowFunctions(observed.backend));

    await expect(
      batchStore.batchOnce(() => [top] as const),
    ).rejects.toBeInstanceOf(UnsupportedBackendCapabilityError);
    expect(observed.statements()).toBe(0);
  });

  it("preserves the batch-wide refusal on a window-function-disabled backend", async () => {
    const observed = createObservedBackend();
    const disabled = withoutWindowFunctions(observed.backend);
    const batchStore = createStore(graph, disabled);
    const top = relation(disabled);

    await expect(batchStore.batchOnce(() => [top] as const)).rejects.toThrow(
      "store.batchOnce() requires backend window-function support",
    );
    expect(observed.statements()).toBe(0);
  });

  it("uses the actual same-root execution target capability", async () => {
    const observed = createObservedBackend();
    const enabled = observed.backend;
    const disabled = withoutWindowFunctions(enabled);
    const top = relation(disabled);

    await expect(top.executeOn(disabled)).rejects.toBeInstanceOf(
      UnsupportedBackendCapabilityError,
    );
    await expect(relation(enabled).executeOn(disabled)).rejects.toBeInstanceOf(
      UnsupportedBackendCapabilityError,
    );
    expect(observed.statements()).toBe(0);
    await expect(top.executeOn(enabled)).resolves.toEqual([]);
    expect(observed.statements()).toBeGreaterThan(0);
  });
});
