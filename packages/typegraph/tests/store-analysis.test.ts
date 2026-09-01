import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, ValidationError } from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import type { GraphBackend } from "../src/backend/types";
import type { CompiledRowsSql } from "../src/query/sql-intent";
import { createStore, createStoreWithSchema } from "../src/store/store";
import { createTestBackend, disableTransactions } from "./test-utils";

const Item = defineNode("Item", {
  schema: z.object({ label: z.string() }),
});
const related = defineEdge("related", {
  schema: z.object({ note: z.string().optional() }),
});

const graph = defineGraph({
  id: "store_analysis_unit",
  nodes: { Item: { type: Item } },
  edges: { related: { type: related, from: [Item], to: [Item] } },
});

describe("Store analysis argument validation", () => {
  it("rejects an invalid page size before reading", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend());

    await expect(
      store.validateStore({ entity: "node", kind: "Item", pageSize: 0 }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: {
        issues: [
          {
            path: "pageSize",
            message: "Expected an integer between 1 and 1000",
          },
        ],
      },
    });
  });

  it("rejects an unknown kind with a typed validation error", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend());

    await expect(
      store.validateStore({ entity: "node", kind: "Missing" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("uses statement-level analysis on a non-transactional backend", async () => {
    const backend = disableTransactions(createTestBackend());
    const store = createStore(graph, backend);

    await expect(store.describe()).resolves.toMatchObject({
      statistics: {
        nodes: [{ kind: "Item", count: 0 }],
      },
    });
  });

  it("uses separate bounded node and edge statements", async () => {
    const baseBackend = createTestBackend();
    let dataStatements = 0;
    const observedBackend: GraphBackend = deriveBackend(baseBackend, {
      execute: async <T>(query: CompiledRowsSql) => {
        dataStatements += 1;
        return baseBackend.execute<T>(query);
      },
    });
    const [store] = await createStoreWithSchema(graph, observedBackend);

    dataStatements = 0;
    await store.describe();
    expect(dataStatements).toBe(2);

    dataStatements = 0;
    await store.validateStore({
      entity: "node",
      kind: "Item",
      pageSize: 1,
    });
    expect(dataStatements).toBe(1);
  });

  it("batches more than 1000 declared paths below the result-column budget", async () => {
    const propertyCount = 1001;
    const shape = Object.fromEntries(
      Array.from({ length: propertyCount }, (_, index) => [
        `field_${index.toString().padStart(4, "0")}`,
        z.string().optional(),
      ]),
    );
    const Wide = defineNode("Wide", { schema: z.object(shape) });
    const wideGraph = defineGraph({
      id: "store_analysis_wide_schema",
      nodes: { Wide: { type: Wide } },
      edges: {},
    });
    const baseBackend = createTestBackend();
    let dataStatements = 0;
    const observedBackend: GraphBackend = deriveBackend(baseBackend, {
      execute: async <T>(query: CompiledRowsSql) => {
        dataStatements += 1;
        return baseBackend.execute<T>(query);
      },
    });
    const store = createStore(wideGraph, observedBackend);
    await observedBackend.insertNode({
      graphId: wideGraph.id,
      kind: "Wide",
      id: "wide-row",
      props: {
        field_0000: "first",
        field_0500: "middle",
        field_1000: "last",
      },
    });
    dataStatements = 0;

    const description = await store.describe();

    expect(dataStatements).toBe(4);
    const widePopulation = description.statistics.nodes[0];
    expect(widePopulation?.properties).toHaveLength(propertyCount);
    for (const path of ["/field_0000", "/field_0500", "/field_1000"]) {
      expect(
        widePopulation?.properties.find((property) => property.path === path),
      ).toEqual({
        path,
        presentCount: 1,
        nullCount: 0,
        nonNullCount: 1,
        coverage: 1,
      });
    }
  });
});
