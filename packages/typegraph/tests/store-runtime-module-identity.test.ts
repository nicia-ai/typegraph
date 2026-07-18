import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../src/core";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "store_runtime_module_identity",
  nodes: { Person: { type: Person } },
  edges: {},
});

describe("Store runtime module identity", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reads Store and transaction ports across module instances", async () => {
    const firstStoreModule = await import("../src/store/store");
    const firstRuntimeModule = await import("../src/store/runtime-port");
    const store = firstStoreModule.createStore(graph, createTestBackend());

    vi.resetModules();
    const secondRuntimeModule = await import("../src/store/runtime-port");
    const secondViewModule = await import("../src/store/store-view");

    expect(secondRuntimeModule.storeBackend(store)).toBe(
      firstRuntimeModule.storeBackend(store),
    );
    expect(() =>
      new secondViewModule.StoreView(store, { mode: "current" }).query(),
    ).not.toThrow();

    await store.transaction(async (transaction) => {
      vi.resetModules();
      const thirdRuntimeModule = await import("../src/store/runtime-port");
      expect(thirdRuntimeModule.transactionBackend(transaction)).toBe(
        firstRuntimeModule.transactionBackend(transaction),
      );
    });
  });

  it("shares internal capability and schema brands across module instances", async () => {
    const firstBackendModule = await import("../src/backend/types");
    const firstSchemaModule = await import("../src/query/compiler/schema");
    const schema = firstSchemaModule.createSqlSchema();
    const recordedRead = firstSchemaModule.recordedRelation({ schema });

    vi.resetModules();
    const secondBackendModule = await import("../src/backend/types");
    const secondSchemaModule = await import("../src/query/compiler/schema");

    expect(secondBackendModule.INTERNAL_TEMPORARY_WRITES).toBe(
      firstBackendModule.INTERNAL_TEMPORARY_WRITES,
    );
    expect(secondSchemaModule.requireSqlSchema(schema)).toBe(schema);
    expect(
      secondSchemaModule.requireExternalRecordedReadSource(recordedRead),
    ).toBe(recordedRead);
  });

  it("fails descriptively when a runtime port is absent", async () => {
    const runtimeModule = await import("../src/store/runtime-port");
    const viewModule = await import("../src/store/store-view");

    expect(() => runtimeModule.storeBackend({})).toThrow(
      "Cannot access this Store's runtime port",
    );
    expect(() =>
      new viewModule.StoreView({} as never, { mode: "current" }).query(),
    ).toThrow("Cannot access this Store's runtime port");
    expect(() => runtimeModule.transactionBackend({})).toThrow(
      "Cannot access this transaction's runtime port",
    );
  });
});
