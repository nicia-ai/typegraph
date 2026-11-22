/**
 * Declaration-emit consumer of the root with `/indexes` and
 * `/graph-extension`: the graph-with-indexes and graph-with-extension cases,
 * which need an entrypoint besides the root by construction. Each
 * single-entrypoint fixture in this directory compiles in its own program, so
 * this one cannot make a type nameable for them.
 */
import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "@nicia-ai/typegraph";
import { defineGraphExtension } from "@nicia-ai/typegraph/graph-extension";
import { defineEdgeIndex, defineNodeIndex } from "@nicia-ai/typegraph/indexes";
import { z } from "zod";

export const Person = defineNode("Person", {
  schema: z.object({ email: z.string(), name: z.string() }),
});

export const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});

export const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});

export const personEmail = defineNodeIndex(Person, { fields: ["email"] });
export const workRole = defineEdgeIndex(worksAt, {
  fields: ["role"],
  direction: "out",
});

export const indexedGraph = defineGraph({
  id: "composed_consumer",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: { worksAt: { type: worksAt, from: [Person], to: [Company] } },
  indexes: [personEmail, workRole],
});

export const proposal = defineGraphExtension({
  nodes: {
    Paper: { properties: { title: { type: "string" } } },
  },
  edges: {
    authored: { from: ["Person"], to: ["Paper"] },
  },
});

export const openStore = (backend: GraphBackend) =>
  createStore(indexedGraph, backend);

export const evolve = async (backend: GraphBackend) =>
  openStore(backend).evolve(proposal);
