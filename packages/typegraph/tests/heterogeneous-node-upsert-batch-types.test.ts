import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  defineGraph,
  defineNode,
  type HistoryTransactionContext,
} from "../src";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const Company = defineNode("Company", {
  schema: z.object({ title: z.string() }),
});
const graph = defineGraph({
  id: "heterogeneous-node-upsert-batch-types",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {},
});

declare const tx: HistoryTransactionContext<typeof graph>;

function assertAcceptedCalls(): void {
  const result = tx.writeNodeUpsertBatch([
    {
      kind: "Person",
      id: asNodeId<typeof Person>("person"),
      props: { name: "Ada" },
    },
    {
      kind: "Company",
      id: asNodeId<typeof Company>("company"),
      props: { title: "Nicia" },
    },
  ] as const);
  expectTypeOf(result).resolves.toExtend<readonly unknown[]>();

  void tx.writeNodeUpsertBatch([
    {
      kind: "Person",
      id: asNodeId<typeof Person>("person"),
      // @ts-expect-error the kind determines the input schema
      props: { title: "not a person" },
    },
  ]);
}

describe("heterogeneous node upsert batch types", () => {
  it("accepts caller IDs across declared node kinds", () => {
    expect(graph.id).toBe("heterogeneous-node-upsert-batch-types");
    expectTypeOf(assertAcceptedCalls).toBeFunction();
  });
});
