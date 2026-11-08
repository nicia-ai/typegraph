import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../../src";
import { type MutationPlanBuilder } from "../../src/graph-merge";

const Item = defineNode("Item", {
  schema: z.object({ name: z.string(), note: z.string().optional() }),
});
const Owner = defineNode("Owner", { schema: z.object({ label: z.string() }) });
const owns = defineEdge("owns", { schema: z.object({ weight: z.number() }) });
const graph = defineGraph({
  id: "mutation_types",
  nodes: { Item: { type: Item }, Owner: { type: Owner } },
  edges: { owns: { type: owns, from: [Owner], to: [Item] } },
});

function checkOperationTypes(builder: MutationPlanBuilder<typeof graph>): void {
  builder.createNode("Item", "new", { name: "item" });
  builder.updateNode("Item", "existing", { note: undefined });
  builder.createEdge(
    "owns",
    "edge",
    { kind: "Owner", id: "owner" },
    { kind: "Item", id: "item" },
    { weight: 1 },
  );
  // @ts-expect-error Unregistered node kind.
  builder.deleteNode("Missing", "id");
  // @ts-expect-error Creates require the kind's required properties.
  builder.createNode("Item", "id", {});
  // @ts-expect-error Patches preserve the field's input type.
  builder.updateNode("Item", "id", { name: 1 });
  // @ts-expect-error Replacements require a complete input.
  builder.replaceNode("Item", "id", {});
  builder.createEdge(
    "owns",
    "edge",
    // @ts-expect-error The source endpoint must be an Owner.
    { kind: "Item", id: "item" },
    { kind: "Item", id: "item" },
    { weight: 1 },
  );
  // @ts-expect-error Edge patches preserve the field's input type.
  builder.updateEdge("owns", "edge", { weight: "invalid" });
}

describe("mutation plan types", () => {
  it("retains graph-specific kinds, properties, and endpoints", () => {
    expectTypeOf(graph.nodes.Item.type.kind).toEqualTypeOf<"Item">();
    expectTypeOf(checkOperationTypes)
      .parameter(0)
      .toEqualTypeOf<MutationPlanBuilder<typeof graph>>();
  });
});
