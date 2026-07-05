import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, type GraphBackend } from "../src";
import { type TransactionBackend } from "../src/backend/types";
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
});
