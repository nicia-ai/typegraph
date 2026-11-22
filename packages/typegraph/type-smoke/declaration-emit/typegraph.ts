/**
 * Declaration-emit consumer of the package root, and ONLY the root (plus
 * zod): every export below has an INFERRED type, so compiling it with
 * `declaration: true` makes TypeScript name each type the root's factories put
 * into it, through modules already in this file's program. The runner
 * (`scripts/test-types.ts consumer`) compiles each fixture in this directory
 * as its own program, so an entrypoint another fixture imports cannot make a
 * type nameable here.
 */
import {
  broader,
  count,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  disjointWith,
  embedding,
  equivalentTo,
  expr,
  field,
  type GraphBackend,
  implies,
  inverseOf,
  narrower,
  param,
  partOf,
  relatedTo,
  searchable,
  type Store,
  subClassOf,
} from "@nicia-ai/typegraph";
import { z } from "zod";

// The issue's reproduction, verbatim: a graph with no indexes, ontology or
// extension, from a module that imports only the root.
const Member = defineNode("Member", { schema: z.object({ name: z.string() }) });

export const minimalGraph = defineGraph({
  id: "g",
  nodes: { Member: { type: Member } },
  edges: {},
});

export const Organization = defineNode("Organization", {
  schema: z.object({ name: z.string() }),
});

export const Company = defineNode("Company", {
  schema: z.object({ name: z.string(), ticker: z.string().optional() }),
  description: "A company",
  annotations: { owner: "consumer" },
});

export const Agency = defineNode("Agency", {
  schema: z.object({ name: z.string() }),
});

export const Person = defineNode("Person", {
  schema: z.object({
    email: z.string(),
    name: z.string(),
    bio: searchable().optional(),
    vector: embedding(3).optional(),
  }),
});

export const Team = defineNode("Team", {
  schema: z.object({ title: z.string() }),
});

export const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});

export const employs = defineEdge("employs");
export const knows = defineEdge("knows");
export const mentors = defineEdge("mentors");
export const memberOf = defineEdge("memberOf");
export const teamOf = defineEdge("teamOf");

export const ontology = [
  subClassOf(Company, Organization),
  disjointWith(Company, Agency),
  equivalentTo(Agency, Agency),
  broader(Company, Organization),
  narrower(Organization, Company),
  relatedTo(Team, Organization),
  partOf(Team, Organization, { via: teamOf }),
  inverseOf(worksAt, employs),
  implies(mentors, knows),
] as const;

export const graph = defineGraph({
  id: "declaration_emit_consumer",
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "person_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Organization: { type: Organization },
    Company: { type: Company, onDelete: "cascade" },
    Agency: { type: Agency },
    Team: { type: Team },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Organization],
      cardinality: "many",
    },
    employs: { type: employs, from: [Organization], to: [Person] },
    knows: { type: knows, from: [Person], to: [Person] },
    mentors: { type: mentors, from: [Person], to: [Person], acyclic: true },
    memberOf: { type: memberOf, from: [Person], to: [Team] },
    teamOf: { type: teamOf, from: [Team], to: [Organization] },
  },
  ontology,
  identity: { sameIdAcrossKinds: "fold" },
  defaults: { onNodeDelete: "restrict", temporalMode: "current" },
  annotations: { domain: "consumer" },
});

export function openStore(backend: GraphBackend) {
  return createStore(graph, backend);
}

export type ConsumerStore = ReturnType<typeof openStore>;
export type DeclaredStore = Store<typeof graph>;

export async function createPerson(store: ConsumerStore) {
  return store.nodes.Person.create({ email: "a@example.com", name: "A" });
}

export async function hire(store: ConsumerStore, personId: string) {
  return store.transaction(async (tx) => {
    const company = await tx.nodes.Company.create({ name: "Acme" });
    return tx.edges.worksAt.create({ kind: "Person", id: personId }, company, {
      role: "engineer",
    });
  });
}

export async function peopleNamed(store: ConsumerStore, name: string) {
  return store
    .query()
    .from("Person", "person")
    .whereNode("person", (person) => person.name.eq(name))
    .traverse("worksAt", "job")
    .to("Organization", "org", { expansion: "subclasses" })
    .select((context) => ({
      id: context.person.id,
      email: context.person.email,
      role: context.job.role,
      org: context.org.name,
    }))
    .execute();
}

export type PeopleRow = Awaited<ReturnType<typeof peopleNamed>>[number];

export const queryPeople = (store: DeclaredStore) =>
  store
    .query()
    .from("Person", "person")
    .select((context) => context.person);

export const preparedPeople = (store: DeclaredStore) =>
  store
    .query()
    .from("Person", "person")
    .whereNode("person", (person) => person.name.eq(param("name")))
    .select((context) => ({ id: context.person.id, name: context.person.name }))
    .prepare();

export const jobsPerOrganization = (store: DeclaredStore) =>
  store
    .query()
    .from("Person", "person")
    .traverse("worksAt", "job")
    .to("Organization", "org")
    .groupBy("org", "name")
    .aggregate({ org: field("org", "name"), people: count("person") });

export const expressions = expr;

export const peopleNamedCount = (store: DeclaredStore) =>
  store.nodes.Person.count();

export const minimalStore = (backend: GraphBackend) =>
  createStore(minimalGraph, backend);
