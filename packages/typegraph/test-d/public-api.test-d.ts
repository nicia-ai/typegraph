import { expectAssignable, expectError, expectType } from "tsd";
import { z } from "zod";

import {
  type BatchableQuery,
  defineEdge,
  defineGraph,
  defineNode,
  type Edge,
  type EdgeId,
  getEdgeKinds,
  getNodeKinds,
  type NodeId,
  type NodeRef,
  type Store,
} from "..";

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
  id: "public_api_test_graph",
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
        {
          name: "name_unique",
          fields: ["name"],
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
declare const worksAtEdge: Awaited<
  ReturnType<typeof store.edges.worksAt.create>
>;

const nodeKinds = getNodeKinds(graph);
const edgeKinds = getEdgeKinds(graph);

expectType<readonly ("Person" | "Company" | "Project")[]>(nodeKinds);
expectType<readonly ("worksAt" | "knows")[]>(edgeKinds);

expectAssignable<NodeRef>({ kind: "AnyKind", id: "node-id" });
expectAssignable<Parameters<typeof store.edges.worksAt.create>[0]>({
  kind: "Person",
  id: "person-id",
});

expectType<EdgeId<typeof worksAt>>(worksAtEdge.id);
expectType<"Person">(worksAtEdge.fromKind);
expectType<NodeId<typeof Person>>(worksAtEdge.fromId);
expectType<"Company">(worksAtEdge.toKind);
expectType<NodeId<typeof Company>>(worksAtEdge.toId);

void store.edges.worksAt.getById(worksAtId);
expectError(store.edges.knows.getById(worksAtId));

void store.nodes.Person.findByConstraint("email_unique", {
  email: "alice@example.com",
  name: "Alice",
});
void store.nodes.Person.findByConstraint("name_unique", {
  email: "alice@example.com",
  name: "Alice",
});

expectError(
  store.nodes.Person.findByConstraint("missing_constraint", {
    email: "alice@example.com",
    name: "Alice",
  }),
);

expectError(
  store.nodes.Project.findByConstraint("title_unique", {
    title: "Roadmap",
  }),
);

// ============================================================
// Edge batchFind* — published .d.ts surface
// ============================================================

declare const personRef: NodeRef<typeof Person>;
declare const companyRef: NodeRef<typeof Company>;

// batchFindFrom / batchFindTo return BatchableQuery with correct edge type
type WorksAtEdge = Edge<typeof worksAt, typeof Person, typeof Company>;

expectType<BatchableQuery<WorksAtEdge>>(
  store.edges.worksAt.batchFindFrom(personRef),
);
expectType<BatchableQuery<WorksAtEdge>>(
  store.edges.worksAt.batchFindTo(companyRef),
);
expectType<BatchableQuery<WorksAtEdge>>(
  store.edges.worksAt.batchFindByEndpoints(personRef, companyRef),
);

// Endpoint constraints are enforced on batchFind* methods
expectError(store.edges.worksAt.batchFindFrom(companyRef));
expectError(store.edges.worksAt.batchFindTo(personRef));
expectError(store.edges.worksAt.batchFindByEndpoints(companyRef, personRef));
