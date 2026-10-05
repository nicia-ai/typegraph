/**
 * FINDING composition-refusal-class-differs-on-portable-path.
 *
 * Documented contract (errors.md `CompositionError`, ontology.md "One whole per
 * part"): a second attach of a part is refused with `CompositionError`, which
 * carries `incumbentEdgeId`. The fused claim path honors that. When the same
 * create reaches the portable fallback (a custom command port answering
 * `unsupported`), the pre-insert cardinality probe refuses first and the
 * caller sees `CardinalityError` with no incumbent detail: the refusal class
 * depends on which side of the fused/portable seam executed.
 *
 * Correct behavior: the same typed refusal on both sides of the seam.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CompositionError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../../../src";
import { createTestBackend } from "../../test-utils";
import { withUnsupportedCommands } from "./harness";

const Org = defineNode("Org", { schema: z.object({}) });
const Dept = defineNode("Dept", { schema: z.object({}) });
const deptOf = defineEdge("deptOf", { schema: z.object({}) });

const graph = defineGraph({
  id: "audit_refusal_class",
  nodes: { Org: { type: Org }, Dept: { type: Dept } },
  edges: {
    deptOf: { type: deptOf, from: [Dept], to: [Org], cardinality: "one" },
  },
  ontology: [partOf(Dept, Org, { via: deptOf })],
});

async function secondAttachError(
  backend: ReturnType<typeof createTestBackend>,
): Promise<unknown> {
  const [store] = await createStoreWithSchema(graph, backend);
  const orgA = await store.nodes.Org.create({});
  const orgB = await store.nodes.Org.create({});
  const dept = await store.nodes.Dept.create({});
  await store.edges.deptOf.create(dept, orgA, {});
  return store.edges.deptOf.create(dept, orgB, {}).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("composition-refusal-class-differs-on-portable-path", () => {
  it("refuses a second whole with CompositionError when the command port answers unsupported", async () => {
    const fused = await secondAttachError(createTestBackend());
    expect(fused).toBeInstanceOf(CompositionError);

    const portable = await secondAttachError(
      withUnsupportedCommands(createTestBackend()),
    );
    expect(portable).toBeInstanceOf(CompositionError);
  });
});
