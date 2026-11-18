/**
 * Declaration-emit consumer: every export below has an INFERRED type, so a
 * consumer compiling with `declaration: true` makes TypeScript name each type
 * the package's factories put into it. The runner (`scripts/test-types.ts
 * consumer`) compiles this file from a packed-tarball install under both
 * `moduleResolution: "bundler"` and `"node16"`, then refuses any emitted
 * declaration that references a module other than a public entrypoint (a
 * hashed `dist/` chunk path is exactly what TypeScript falls back to when a
 * type is not exported from an entrypoint the program already imports).
 *
 * The file deliberately imports only the package root, `/indexes` (for the
 * index definers) and zod: a consumer must not need an extra entrypoint
 * import merely so its declarations can be emitted.
 */
import {
  broader,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  disjointWith,
  embedding,
  equivalentTo,
  type GraphBackend,
  implies,
  inverseOf,
  narrower,
  partOf,
  relatedTo,
  searchable,
  type Store,
  subClassOf,
} from "@nicia-ai/typegraph";
import { defineEdgeIndex, defineNodeIndex } from "@nicia-ai/typegraph/indexes";
import { z } from "zod";

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

export const personEmail = defineNodeIndex(Person, { fields: ["email"] });
export const workRole = defineEdgeIndex(worksAt, {
  fields: ["role"],
  direction: "out",
});

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
  indexes: [personEmail, workRole],
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
