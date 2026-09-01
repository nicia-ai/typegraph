import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, ValidationError } from "../src";
import { createStore, createStoreWithSchema } from "../src/store/store";
import { createTestBackend, disableTransactions } from "./test-utils";

const Item = defineNode("Item", {
  schema: z.object({ label: z.string() }),
});

const graph = defineGraph({
  id: "store_analysis_unit",
  nodes: { Item: { type: Item } },
  edges: {},
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

  it("refuses to assemble a snapshot on a non-transactional backend", async () => {
    const backend = disableTransactions(createTestBackend());
    const store = createStore(graph, backend);

    await expect(store.describe()).rejects.toMatchObject({
      code: "STORE_ANALYSIS_SNAPSHOT_UNSUPPORTED",
    });
  });
});
