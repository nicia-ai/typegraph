import {
  defineEdge,
  defineGraph,
  defineNode,
  type EdgeId,
  getEdgeKinds,
  getNodeKinds,
  type NodeRef,
  type Store,
} from "@nicia-ai/typegraph";
import type { SqliteTables } from "@nicia-ai/typegraph/sqlite";
import { z } from "zod";

const Person = defineNode("Person", {
  schema: z.object({
    email: z.string(),
    name: z.string(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
  }),
});

const Project = defineNode("Project", {
  schema: z.object({
    title: z.string(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
  }),
});

const knows = defineEdge("knows");

const graph = defineGraph({
  id: "consumer_smoke_graph",
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "email_unique",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Company: { type: Company },
    Project: { type: Project },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
    },
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
    },
  },
  ontology: [],
});

declare const store: Store<typeof graph>;
declare const worksAtId: EdgeId<typeof worksAt>;
declare const sqliteTables: SqliteTables;

const nodeKinds = getNodeKinds(graph);
const edgeKinds = getEdgeKinds(graph);
const looseNodeRef: NodeRef = { kind: "SomeNodeKind", id: "node-id" };

void nodeKinds;
void edgeKinds;
void looseNodeRef;
void sqliteTables;

void store.edges.worksAt.getById(worksAtId);
void store.nodes.Person.findByConstraint("email_unique", {
  email: "alice@example.com",
  name: "Alice",
});

// @ts-expect-error - edge id brands cannot be mixed across edge kinds
void store.edges.knows.getById(worksAtId);

// @ts-expect-error - Project has no unique constraints, so constraint names are never
void store.nodes.Project.findByConstraint("title_unique", {
  title: "Launch Plan",
});
