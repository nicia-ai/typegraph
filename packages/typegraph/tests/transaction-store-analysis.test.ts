import { describe, expect, it } from "vitest";
import { z } from "zod";

import { decorateBackend } from "../src/backend";
import { defineGraph, defineNode } from "../src/core";
import { createStore } from "../src/store";
import { createTestBackend } from "./test-utils";

const Analyzed = defineNode("Analyzed", {
  schema: z.object({ name: z.string() }),
});

const analysisGraph = defineGraph({
  id: "transaction_store_analysis",
  nodes: { Analyzed: { type: Analyzed } },
  edges: {},
});

describe("transaction-bound store analysis", () => {
  it("executes analysis through the transaction backend", async () => {
    const backend = createTestBackend();
    let transactionExecuteCount = 0;
    const instrumented = decorateBackend(backend, {
      transaction: (fn, options) =>
        backend.transaction(
          (tx) =>
            fn(
              decorateBackend(tx, {
                execute: async (query) => {
                  transactionExecuteCount++;
                  return tx.execute(query);
                },
              }),
            ),
          options,
        ),
    });
    const store = createStore(analysisGraph, instrumented);

    await store.transaction(async (tx) => {
      transactionExecuteCount = 0;
      await tx.describe();
      expect(transactionExecuteCount).toBeGreaterThan(0);
    });
  });
});
