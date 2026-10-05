import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../../../src";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import { FORMAT_VERSION, type GraphData } from "../../../src/interchange";

export const Root = defineNode("IsRoot", { schema: z.object({}) });
export const Mid = defineNode("IsMid", { schema: z.object({}) });
export const Leaf = defineNode("IsLeaf", { schema: z.object({}) });
export const midOf = defineEdge("isMidOf", { schema: z.object({}) });
export const leafOf = defineEdge("isLeafOf", { schema: z.object({}) });

export function buildGraph(population: "one" | "oneActive", id = "is-probe") {
  return defineGraph({
    id: `${id}-${population}`,
    nodes: { IsRoot: { type: Root }, IsMid: { type: Mid }, IsLeaf: { type: Leaf } },
    edges: {
      isMidOf: { type: midOf, from: [Mid], to: [Root], cardinality: population },
      isLeafOf: { type: leafOf, from: [Leaf], to: [Mid], cardinality: population },
    },
    ontology: [
      partOf(Mid, Root, { via: midOf, existence: "required" }),
      partOf(Leaf, Mid, { via: leafOf, existence: "required" }),
    ],
  });
}

export async function openStore(population: "one" | "oneActive") {
  const { backend } = createLocalSqliteBackend();
  const [store] = await createStoreWithSchema(buildGraph(population), backend);
  return { store, backend };
}

export function payload(data: Pick<GraphData, "nodes" | "edges">): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external", description: "import-state probe" },
    ...data,
  };
}

export const PAST_FROM = "2020-01-01T00:00:00.000Z";
export const PAST_TO = "2021-01-01T00:00:00.000Z";
