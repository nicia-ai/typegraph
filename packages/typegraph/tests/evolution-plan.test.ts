import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph } from "../src/core/define-graph";
import { defineEdge } from "../src/core/edge";
import { defineNode } from "../src/core/node";
import { defineGraphExtension } from "../src/graph-extension/define-graph-extension";
import { mergeGraphExtension } from "../src/graph-extension/merge";
import {
  getEvolutionPlanPayload,
  prepareEvolutionPlan,
} from "../src/schema/evolution-plan";
import { computeSchemaHash, serializeSchema } from "../src/schema/serializer";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "evolution_plan_test",
  nodes: { Person: { type: Person } },
  edges: {},
});

async function snapshot() {
  const storedSchema = serializeSchema(graph, 1);
  const baselineHash = await computeSchemaHash(storedSchema);
  return {
    baselineGraph: graph,
    baselineVersion: 1,
    baselineHash,
    storedSchema,
  };
}

describe("evolution planning", () => {
  it("prepares an immutable metadata-only change without row scans or provisioning", async () => {
    const extension = defineGraphExtension({
      nodes: {
        Tag: { properties: { name: { type: "string", optional: true } } },
      },
    });
    const plan = await prepareEvolutionPlan({
      ...(await snapshot()),
      extension,
    });
    expect(plan.status).toBe("change");
    if (plan.status !== "change") return;
    expect(plan.requirements.requireEmpty).toEqual([]);
    expect(plan.requirements.vectorSlots).toEqual([]);
    expect(plan.requirements.identityAffectedKinds).toEqual([]);
    expect(plan.requirements.readdedKindCandidates).toEqual([
      { entity: "node", kindName: "Tag" },
    ]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.requirements)).toBe(true);
    const payload = getEvolutionPlanPayload(plan);
    expect(payload?.schemaDocument?.version).toBe(2);
    expect(
      await computeSchemaHash(requireDefined(payload?.schemaDocument)),
    ).toBe(plan.resultingHash);
    expect(getEvolutionPlanPayload({ ...plan })).toBeUndefined();
  });

  it("names required-empty probes and introduced vector slots", async () => {
    const first = defineGraphExtension({
      nodes: {
        Tag: { properties: { name: { type: "string", optional: true } } },
      },
    });
    const baselineGraph = mergeGraphExtension(graph, first);
    const storedSchema = serializeSchema(baselineGraph, 2);
    const baselineHash = await computeSchemaHash(storedSchema);
    const extension = defineGraphExtension({
      nodes: {
        Tag: {
          properties: {
            name: { type: "string" },
            vector: {
              type: "array",
              items: { type: "number" },
              embedding: { dimensions: 3 },
              optional: true,
            },
          },
        },
      },
    });
    const plan = await prepareEvolutionPlan({
      baselineGraph,
      baselineVersion: 2,
      baselineHash,
      storedSchema,
      extension,
    });
    expect(plan.status).toBe("change");
    if (plan.status !== "change") return;
    expect(plan.requirements.requireEmpty).toEqual([
      { entity: "node", kindName: "Tag" },
    ]);
    expect(plan.requirements.vectorSlots).toEqual([
      { kindName: "Tag", fieldName: "vector" },
    ]);
  });

  it("returns a branded no-op bound to the baseline snapshot", async () => {
    const extension = defineGraphExtension({
      nodes: { Tag: { properties: { name: { type: "string" } } } },
    });
    const baselineGraph = mergeGraphExtension(graph, extension);
    const storedSchema = serializeSchema(baselineGraph, 2);
    const baselineHash = await computeSchemaHash(storedSchema);
    const plan = await prepareEvolutionPlan({
      baselineGraph,
      baselineVersion: 2,
      baselineHash,
      storedSchema,
      extension,
    });
    expect(plan).toMatchObject({
      status: "noop",
      baselineVersion: 2,
      baselineHash,
      resultingHash: baselineHash,
    });
    expect(getEvolutionPlanPayload(plan)?.mergedGraph).toBe(baselineGraph);
  });

  it("preserves unknown document fields and isolates mutable caller extensions", async () => {
    const extension = structuredClone(
      defineGraphExtension({
        nodes: { Tag: { properties: { name: { type: "string" } } } },
      }),
    );
    const initial = await snapshot();
    const storedSchema = {
      ...initial.storedSchema,
      futureMetadata: { flag: "retained" },
    };
    const plan = await prepareEvolutionPlan({
      ...initial,
      storedSchema,
      extension,
    });
    const payload = getEvolutionPlanPayload(plan);
    const originalHash = plan.resultingHash;
    const properties = extension.nodes.Tag.properties as Record<
      string,
      unknown
    >;
    properties["name"] = { type: "number" };
    const document = requireDefined(payload?.schemaDocument);
    const futureMetadata = Object.entries(document).find(
      ([key]) => key === "futureMetadata",
    )?.[1];
    expect(futureMetadata).toEqual({ flag: "retained" });
    expect(await computeSchemaHash(document)).toBe(originalHash);
    expect(Object.isFrozen(futureMetadata)).toBe(true);
  });

  it("rejects endpoint-incompatible ontology before producing a plan", async () => {
    const Author = defineNode("Author", { schema: z.object({}) });
    const Paper = defineNode("Paper", { schema: z.object({}) });
    const Topic = defineNode("Topic", { schema: z.object({}) });
    const writes = defineEdge("writes", { schema: z.object({}) });
    const about = defineEdge("about", { schema: z.object({}) });
    const baselineGraph = defineGraph({
      id: "evolution_plan_bad_ontology",
      nodes: {
        Author: { type: Author },
        Paper: { type: Paper },
        Topic: { type: Topic },
      },
      edges: {
        writes: { type: writes, from: [Author], to: [Paper] },
        about: { type: about, from: [Paper], to: [Topic] },
      },
    });
    const storedSchema = serializeSchema(baselineGraph, 1);
    const baselineHash = await computeSchemaHash(storedSchema);
    const extension = defineGraphExtension({
      ontology: [{ metaEdge: "implies", from: "about", to: "writes" }],
    });
    await expect(
      prepareEvolutionPlan({
        baselineGraph,
        baselineVersion: 1,
        baselineHash,
        storedSchema,
        extension,
      }),
    ).rejects.toThrow(/endpoint-incompatible/);
  });
});
