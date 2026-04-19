import {
  defineEdge,
  defineGraph,
  defineNode,
  type EdgeId,
  getEdgeKinds,
  getNodeKinds,
  type NodeId,
  type NodeIdentifier,
  type NodeRef,
  type PathNode,
  type ReachableNode,
  type Store,
  type TemporalAlgorithmOptions,
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

// --- Graph algorithms: public surface shape checks ---

declare const aliceId: string;
declare const bobId: string;
declare const aliceNodeId: NodeId<typeof Person>;
declare const aliceNode: Awaited<ReturnType<typeof store.nodes.Person.getById>>;
declare const reachableRow: ReachableNode;
declare const pathNode: PathNode;

// NodeIdentifier accepts bare strings, Node instances, and any {id} shape.
const stringIdent: NodeIdentifier = aliceId;
const objectIdent: NodeIdentifier = { id: aliceId };
const reachableIdent: NodeIdentifier = reachableRow;
const pathIdent: NodeIdentifier = pathNode;
void stringIdent;
void objectIdent;
void reachableIdent;
void pathIdent;

// Every algorithm compiles with bare IDs, object identifiers, and Node values.
void store.algorithms.shortestPath(aliceId, bobId, { edges: ["knows"] });
void store.algorithms.shortestPath(
  aliceNode ?? aliceId,
  { id: bobId },
  { edges: ["knows"], maxHops: 10, direction: "both", cyclePolicy: "allow" },
);
void store.algorithms.reachable(aliceId, { edges: ["knows"] });
void store.algorithms.canReach(aliceId, bobId, { edges: ["knows"] });
void store.algorithms.neighbors(aliceId, { edges: ["knows"], depth: 2 });

// Degree accepts an options-less call and a specific edge-kind selection.
void store.algorithms.degree(aliceId);
void store.algorithms.degree(aliceId, { edges: ["knows"] });
void store.algorithms.degree(aliceId, {});

// TemporalAlgorithmOptions composes into every algorithm's option type.
const temporal: TemporalAlgorithmOptions = {
  temporalMode: "asOf",
  asOf: "2024-01-01T00:00:00Z",
};
void store.algorithms.shortestPath(aliceId, bobId, {
  edges: ["knows"],
  ...temporal,
});
void store.algorithms.reachable(aliceId, { edges: ["knows"], ...temporal });
void store.algorithms.neighbors(aliceId, { edges: ["knows"], ...temporal });
void store.algorithms.degree(aliceId, { ...temporal });

// Subgraph also accepts the temporal options (requires a branded NodeId).
void store.subgraph(aliceNodeId, {
  edges: ["knows"],
  temporalMode: "includeEnded",
});

// --- Negative cases (must fail compile) ---

// @ts-expect-error - "not_a_kind" isn't a registered edge kind
void store.algorithms.reachable(aliceId, { edges: ["not_a_kind"] });

void store.algorithms.reachable(aliceId, {
  edges: ["knows"],
  // @ts-expect-error - temporalMode literal must be a known TemporalMode
  temporalMode: "bogus_mode",
});

// @ts-expect-error - subgraph edge kind must be registered on the graph
void store.subgraph(aliceNodeId, { edges: ["not_a_kind"] });
