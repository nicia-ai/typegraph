/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/core` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import {
  createExternalRef,
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  externalRef,
  getEdgeKinds,
  getNodeKinds,
  KindRegistry,
  recordedInstant,
  resolveGraphVectorSlots,
  searchable,
} from "@nicia-ai/typegraph/core";
import { z } from "zod";

export const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    body: searchable(),
    vector: embedding(4).optional(),
    source: externalRef("Source").optional(),
  }),
  annotations: { owner: "consumer" },
});

export const Source = defineNode("Source", {
  schema: z.object({ url: z.string() }),
});

export const cites = defineEdge("cites", {
  schema: z.object({ page: z.number().int().optional() }),
});

export const graph = defineGraph({
  id: "core_consumer",
  nodes: {
    Document: {
      type: Document,
      unique: [
        {
          name: "title",
          fields: ["title"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Source: { type: Source },
  },
  edges: {
    cites: { type: cites, from: [Document], to: [Source], cardinality: "many" },
  },
  identity: { sameIdAcrossKinds: "fold" },
});

export const sourceRef = createExternalRef("Source");
export const nodeKinds = getNodeKinds(graph);
export const edgeKinds = getEdgeKinds(graph);
export const vectorSlots = resolveGraphVectorSlots(graph);
export const registryFor = (registry: KindRegistry) => registry;
export const instant = (...args: Parameters<typeof recordedInstant>) =>
  recordedInstant(...args);
