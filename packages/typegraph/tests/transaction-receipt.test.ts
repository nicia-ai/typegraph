import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "../src";
import {
  type TransactionBackend,
  type TransactionOptions,
} from "../src/backend/types";
import { createTransactionReceiptRecorder } from "../src/store/transaction-receipt";
import { createInitializedStore, createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});

const receiptGraph = defineGraph({
  id: "transaction_receipt",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "many",
    },
  },
});

// Kind names are arbitrary identifiers, so `constructor` is a legal node kind.
// This graph pins the receipt path end-to-end for prototype-colliding names.
const PrototypeNamed = defineNode("constructor", {
  schema: z.object({ name: z.string() }),
});

const prototypeKindGraph = defineGraph({
  id: "receipt_prototype_kind",
  nodes: {
    constructor: { type: PrototypeNamed },
  },
  edges: {},
});

function disableTransactions(backend: GraphBackend): GraphBackend {
  return {
    ...backend,
    capabilities: { ...backend.capabilities, transactions: false },
    transaction: () =>
      Promise.reject(new Error("synthetic backend has transactions disabled")),
  };
}

function recordTransactionTargetCalls(
  target: TransactionBackend,
  calls: string[],
): TransactionBackend {
  return {
    ...target,
    async insertNode(params) {
      calls.push("insertNode");
      return target.insertNode(params);
    },
    async insertEdge(params) {
      calls.push("insertEdge");
      return target.insertEdge(params);
    },
  };
}

function recordBackendCalls(
  backend: GraphBackend,
): Readonly<{ backend: GraphBackend; calls: string[] }> {
  const calls: string[] = [];
  return {
    calls,
    backend: {
      ...backend,
      async insertNode(params) {
        calls.push("insertNode");
        return backend.insertNode(params);
      },
      async insertEdge(params) {
        calls.push("insertEdge");
        return backend.insertEdge(params);
      },
      async transaction(fn, options) {
        calls.push("transaction");
        return backend.transaction(
          (target, sql) => fn(recordTransactionTargetCalls(target, calls), sql),
          options,
        );
      },
    },
  };
}

async function writeFixture(
  backend: GraphBackend,
  receipt: boolean,
): Promise<readonly string[]> {
  const recorded = recordBackendCalls(backend);
  const store = await createInitializedStore(receiptGraph, recorded.backend);
  recorded.calls.length = 0;

  if (receipt) {
    await store.transaction(
      async (tx) => {
        const person = await tx.nodes.Person.create({ name: "Alice" });
        const company = await tx.nodes.Company.create({ name: "Acme" });
        await tx.edges.worksAt.create(person, company, { role: "Engineer" });
      },
      { receipt: true },
    );
  } else {
    await store.transaction(async (tx) => {
      const person = await tx.nodes.Person.create({ name: "Alice" });
      const company = await tx.nodes.Company.create({ name: "Acme" });
      await tx.edges.worksAt.create(person, company, { role: "Engineer" });
    });
  }

  return recorded.calls;
}

describe("transaction receipts", () => {
  it("returns counts on non-transactional backends", async () => {
    const backend = disableTransactions(createTestBackend());
    const store = await createInitializedStore(receiptGraph, backend);

    const outcome = await store.transaction(
      async (tx) => {
        const person = await tx.nodes.Person.create({ name: "Alice" });
        const company = await tx.nodes.Company.create({ name: "Acme" });
        await tx.edges.worksAt.create(person, company, { role: "Engineer" });
        return person.id;
      },
      { receipt: true },
    );

    expect(outcome.receipt.writes.nodes).toEqual({ Person: 1, Company: 1 });
    expect(outcome.receipt.writes.edges).toEqual({ worksAt: 1 });
    expect(outcome.receipt.writes.total).toBe(3);
    await expect(
      store.nodes.Person.getById(outcome.result),
    ).resolves.toMatchObject({ name: "Alice" });
  });

  it("does not add backend write calls when receipt counting is requested", async () => {
    const withoutReceipt = await writeFixture(createTestBackend(), false);
    const withReceipt = await writeFixture(createTestBackend(), true);

    expect(withReceipt).toEqual(withoutReceipt);
  });

  it("passes isolationLevel through to the backend and strips the receipt flag", async () => {
    const backend = createTestBackend();
    const seenOptions: (TransactionOptions | undefined)[] = [];
    const spyingBackend: GraphBackend = {
      ...backend,
      async transaction(fn, options) {
        seenOptions.push(options);
        return backend.transaction(fn, options);
      },
    };
    const store = await createInitializedStore(receiptGraph, spyingBackend);
    seenOptions.length = 0;

    await store.transaction(
      async (tx) => {
        await tx.nodes.Person.create({ name: "Alice" });
      },
      { receipt: true, isolationLevel: "read_committed" },
    );

    const forwarded = seenOptions.at(-1);
    expect(forwarded?.isolationLevel).toBe("read_committed");
    expect(forwarded !== undefined && "receipt" in forwarded).toBe(false);
  });

  it("rejects a receipt option that is present but not boolean", async () => {
    const store = await createInitializedStore(
      receiptGraph,
      createTestBackend(),
    );
    const truthyNonBoolean = { receipt: 1 } as unknown as { receipt: true };

    await expect(
      store.transaction(async (tx) => {
        await tx.nodes.Person.create({ name: "Never" });
      }, truthyNonBoolean),
    ).rejects.toThrow(ConfigurationError);
    await expect(store.nodes.Person.count()).resolves.toBe(0);
  });

  it("counts a node kind named after an Object.prototype member", async () => {
    const store = await createInitializedStore(
      prototypeKindGraph,
      createTestBackend(),
    );

    const outcome = await store.transaction(
      async (tx) => {
        await tx.nodes.constructor.create({ name: "proto" });
      },
      { receipt: true },
    );

    expect(Object.entries(outcome.receipt.writes.nodes)).toEqual([
      ["constructor", 1],
    ]);
    expect(outcome.receipt.writes.total).toBe(1);
  });
});

describe("transaction receipt recorder", () => {
  it("counts kinds whose names collide with Object.prototype members", () => {
    const recorder = createTransactionReceiptRecorder();
    recorder.recordNode("constructor", 1);
    recorder.recordNode("constructor", 1);
    recorder.recordNode("__proto__", 2);
    recorder.recordNode("toString", 3);
    recorder.recordEdge("hasOwnProperty", 4);

    const receipt = recorder.snapshot();

    expect(
      Object.entries(receipt.writes.nodes).toSorted(([left], [right]) =>
        left.localeCompare(right),
      ),
    ).toEqual([
      ["__proto__", 2],
      ["constructor", 2],
      ["toString", 3],
    ]);
    expect(Object.entries(receipt.writes.edges)).toEqual([
      ["hasOwnProperty", 4],
    ]);
    expect(receipt.writes.total).toBe(11);
  });

  it("keeps zero-count intents out of the buckets and the total", () => {
    const recorder = createTransactionReceiptRecorder();
    recorder.recordNode("Person", 0);

    const receipt = recorder.snapshot();

    expect(Object.entries(receipt.writes.nodes)).toEqual([]);
    expect(receipt.writes.total).toBe(0);
  });
});
