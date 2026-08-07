import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../src";
import { type IdentityTransferAssertion } from "../src/identity/service";
import { exportGraphStream } from "../src/interchange";
import { storeRuntime } from "../src/store/runtime-port";
import { requireDefined } from "../src/utils/presence";
import { createInitializedStore, createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const graph = defineGraph({
  id: "identity_interchange_pagination",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
  },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

const CANONICAL_TIMESTAMP = "2024-01-01T00:00:00.000Z";

type Ref = Readonly<{ kind: "Person" | "Company"; id: string }>;

function assertion(id: string, a: Ref, b: Ref): IdentityTransferAssertion {
  return {
    id,
    relation: "same",
    a,
    b,
    validFrom: CANONICAL_TIMESTAMP,
  };
}

describe("Identity interchange pagination", () => {
  it("uses database assertion-id order and the last scanned row as its cursor", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const lateFirst = await store.nodes.Person.create(
      { name: "Late first" },
      { id: "z-first" },
    );
    const lateSecond = await store.nodes.Person.create(
      { name: "Late second" },
      { id: "z-second" },
    );
    const earlyFirst = await store.nodes.Person.create(
      { name: "Early first" },
      { id: "a-first" },
    );
    const earlySecond = await store.nodes.Person.create(
      { name: "Early second" },
      { id: "a-second" },
    );
    await storeRuntime(store).importIdentityAssertionsAtTarget(
      store.backend,
      [
        assertion("assertion-a", lateFirst, lateSecond),
        assertion("assertion-b", earlyFirst, earlySecond),
      ],
      "state",
    );

    const page = await storeRuntime(store).readIdentityAssertionPageAtTarget(
      store.backend,
      "state",
      { limit: 2 },
    );

    // Endpoint sorting would reverse these rows. Pagination instead preserves
    // the database's assertion-id scan order and advances from that same scan.
    expect(page.assertions.map((item) => item.id)).toEqual([
      "assertion-a",
      "assertion-b",
    ]);
    expect(page.nextAfter).toBe("assertion-b");
    expect(page.done).toBe(false);
  });

  it("continues through empty in-memory-filtered pages to later matches", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const firstCompany = await store.nodes.Company.create(
      { name: "First company" },
      { id: "company-first" },
    );
    const secondCompany = await store.nodes.Company.create(
      { name: "Second company" },
      { id: "company-second" },
    );
    const firstPerson = await store.nodes.Person.create(
      { name: "First person" },
      { id: "person-first" },
    );
    const secondPerson = await store.nodes.Person.create(
      { name: "Second person" },
      { id: "person-second" },
    );
    await storeRuntime(store).importIdentityAssertionsAtTarget(
      store.backend,
      [
        assertion("assertion-a-filtered", firstCompany, secondCompany),
        assertion("assertion-z-included", firstPerson, secondPerson),
      ],
      "state",
    );
    const nodeKinds = [
      "Person",
      ...Array.from({ length: 201 }, (_, index) => `UnusedKind${index}`),
    ];

    const firstPage = await storeRuntime(
      store,
    ).readIdentityAssertionPageAtTarget(store.backend, "state", {
      nodeKinds,
      limit: 1,
    });
    expect(firstPage).toEqual({
      assertions: [],
      nextAfter: "assertion-a-filtered",
      done: false,
    });

    const exportedAssertionIds: string[] = [];
    for await (const chunk of exportGraphStream(store, {
      nodeKinds,
      batchSize: 1,
    })) {
      if (chunk.type === "identity") {
        exportedAssertionIds.push(...chunk.assertions.map((item) => item.id));
      }
    }
    expect(exportedAssertionIds).toEqual(["assertion-z-included"]);
  });

  it("settles the export transaction when the consumer returns early", async () => {
    const backend = createTestBackend();
    const transaction = vi.spyOn(backend, "transaction");
    const store = await createInitializedStore(graph, backend);
    await store.nodes.Person.create({ name: "Alice" }, { id: "alice" });
    const iterator = exportGraphStream(store, {
      batchSize: 1,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "header" },
    });
    // Identify the export's snapshot transaction by the options only it opens.
    // Indexing by position would pick up the `create` above, whose write
    // transaction has already fulfilled and so certifies nothing.
    const exportTransactionResult = requireDefined(
      transaction.mock.calls
        .map((call, index) => ({ options: call[1], index }))
        .filter(
          ({ options }) =>
            options?.isolationLevel === "repeatable_read" &&
            options.accessMode === "read_only",
        )
        .map(({ index }) => transaction.mock.results[index])
        .at(-1),
    );
    expect(exportTransactionResult.type).toBe("return");
    const transactionSettled = Promise.resolve(
      exportTransactionResult.value,
    ).then(
      () => ({ settled: "fulfilled" as const }),
      (error: unknown) => ({ settled: "rejected" as const, error }),
    );

    await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
    // `return()` does not resolve until the transaction has left its callback;
    // awaiting this would hang if the producer remained blocked on its push.
    // Cancellation unblocks the producer by REJECTING its in-flight push, so
    // the snapshot transaction rolls back with that error — asserting
    // "fulfilled" here would assert the opposite of the intended behavior.
    const outcome = await transactionSettled;
    expect(outcome.settled).toBe("rejected");
    expect(outcome).toMatchObject({
      error: { message: "Export stream consumer cancelled." },
    });
  });
});
