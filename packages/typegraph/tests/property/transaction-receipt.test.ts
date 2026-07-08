import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../../src";
import { createInitializedStore, createTestBackend } from "../test-utils";

const Person = defineNode("ReceiptPerson", {
  schema: z.object({ name: z.string() }),
});

const Company = defineNode("ReceiptCompany", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("receiptKnows", {
  schema: z.object({ since: z.string() }),
});

const receiptPropertyGraph = defineGraph({
  id: "receipt_property",
  nodes: {
    ReceiptPerson: { type: Person },
    ReceiptCompany: { type: Company },
  },
  edges: {
    receiptKnows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "many",
    },
  },
});

type ReceiptOperation =
  | Readonly<{ kind: "personCreate" }>
  | Readonly<{ kind: "personBulkCreate"; count: number }>
  | Readonly<{ kind: "companyCreate" }>
  | Readonly<{ kind: "edgeCreate" }>
  | Readonly<{ kind: "edgeBulkCreate"; count: number }>;

type ExpectedCounts = Readonly<{
  nodes: Record<string, number>;
  edges: Record<string, number>;
  total: number;
}>;

const operationArbitrary: fc.Arbitrary<ReceiptOperation> = fc.oneof(
  fc.constant<ReceiptOperation>({ kind: "personCreate" }),
  fc.integer({ min: 0, max: 3 }).map<ReceiptOperation>((count) => ({
    kind: "personBulkCreate",
    count,
  })),
  fc.constant<ReceiptOperation>({ kind: "companyCreate" }),
  fc.constant<ReceiptOperation>({ kind: "edgeCreate" }),
  fc
    .integer({ min: 0, max: 3 })
    .map<ReceiptOperation>((count) => ({ kind: "edgeBulkCreate", count })),
);

function addCount(
  counts: Record<string, number>,
  kind: string,
  count: number,
): void {
  if (count === 0) return;
  counts[kind] = (counts[kind] ?? 0) + count;
}

function expectedCountsFor(
  operations: readonly ReceiptOperation[],
): ExpectedCounts {
  const nodes: Record<string, number> = {};
  const edges: Record<string, number> = {};
  let total = 0;

  for (const operation of operations) {
    switch (operation.kind) {
      case "personCreate": {
        addCount(nodes, "ReceiptPerson", 1);
        total += 1;
        break;
      }
      case "personBulkCreate": {
        addCount(nodes, "ReceiptPerson", operation.count);
        total += operation.count;
        break;
      }
      case "companyCreate": {
        addCount(nodes, "ReceiptCompany", 1);
        total += 1;
        break;
      }
      case "edgeCreate": {
        addCount(edges, "receiptKnows", 1);
        total += 1;
        break;
      }
      case "edgeBulkCreate": {
        addCount(edges, "receiptKnows", operation.count);
        total += operation.count;
        break;
      }
    }
  }

  return { nodes, edges, total };
}

describe("transaction receipt properties", () => {
  it("matches an independently tracked write-intent count", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(operationArbitrary, { minLength: 0, maxLength: 20 }),
        async (operations) => {
          const store = await createInitializedStore(
            receiptPropertyGraph,
            createTestBackend(),
          );
          const [alice, bob] = await store.transaction(async (tx) =>
            tx.nodes.ReceiptPerson.bulkCreate([
              { props: { name: "Alice" }, id: "seed-alice" },
              { props: { name: "Bob" }, id: "seed-bob" },
            ]),
          );
          if (alice === undefined || bob === undefined) {
            throw new Error("Seed nodes were not created");
          }

          const outcome = await store.transactionWithReceipt(async (tx) => {
            let sequence = 0;
            for (const operation of operations) {
              switch (operation.kind) {
                case "personCreate": {
                  await tx.nodes.ReceiptPerson.create(
                    { name: `Person ${sequence}` },
                    { id: `person-${sequence}` },
                  );
                  break;
                }
                case "personBulkCreate": {
                  await tx.nodes.ReceiptPerson.bulkCreate(
                    Array.from({ length: operation.count }, (_, index) => ({
                      props: { name: `Bulk Person ${sequence}-${index}` },
                      id: `person-${sequence}-${index}`,
                    })),
                  );
                  break;
                }
                case "companyCreate": {
                  await tx.nodes.ReceiptCompany.create(
                    { name: `Company ${sequence}` },
                    { id: `company-${sequence}` },
                  );
                  break;
                }
                case "edgeCreate": {
                  await tx.edges.receiptKnows.create(
                    alice,
                    bob,
                    { since: `edge-${sequence}` },
                    { id: `edge-${sequence}` },
                  );
                  break;
                }
                case "edgeBulkCreate": {
                  await tx.edges.receiptKnows.bulkCreate(
                    Array.from({ length: operation.count }, (_, index) => ({
                      from: alice,
                      to: bob,
                      props: { since: `bulk-edge-${sequence}-${index}` },
                      id: `edge-${sequence}-${index}`,
                    })),
                  );
                  break;
                }
              }
              sequence += 1;
            }
          });

          const expected = expectedCountsFor(operations);
          expect(outcome.receipt.writes.nodes).toEqual(expected.nodes);
          expect(outcome.receipt.writes.edges).toEqual(expected.edges);
          expect(outcome.receipt.writes.total).toBe(expected.total);
          expect(outcome.receipt.writes.total).toBe(
            Object.values(outcome.receipt.writes.nodes).reduce(
              (sum, count) => sum + count,
              0,
            ) +
              Object.values(outcome.receipt.writes.edges).reduce(
                (sum, count) => sum + count,
                0,
              ),
          );
        },
      ),
      { numRuns: 25 },
    );
  });
});
