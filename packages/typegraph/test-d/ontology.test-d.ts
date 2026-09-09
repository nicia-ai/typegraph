import { expectAssignable, expectError, expectType } from "tsd";
import { z } from "zod";

import {
  type AnyEdgeType,
  broader,
  defineEdge,
  defineGraph,
  defineNode,
  disjointWith,
  equivalentTo,
  inverseOf,
  type NodeType,
  type OntologyRelation,
  type Store,
} from "..";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Individual = defineNode("Individual", {
  schema: z.object({ name: z.string() }),
});
const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});
const employedBy = defineEdge("employedBy", {
  schema: z.object({ role: z.string() }),
});

// Two node kinds — the unwidened, pre-D1 usage still typechecks.
// C.1 narrows the return type to a TypedOntologyRelation (still assignable
// to OntologyRelation, never identical to it), so this is an assignability
// check, not an exact-type one.
expectAssignable<OntologyRelation>(equivalentTo(Person, Individual));

// A node kind mapped to an external IRI — the right parameter has always
// accepted a bare string.
expectAssignable<OntologyRelation>(
  equivalentTo(Person, "https://schema.org/Person"),
);

// D1's widened left parameter: an edge kind mapped to an external IRI, so an
// edge can be declared equivalent to a cross-system vocabulary term.
expectAssignable<OntologyRelation>(
  equivalentTo(worksAt, "https://schema.org/worksFor"),
);

// Two edge kinds have no defined substitution semantics (the runtime refusal
// in ontology/validation.ts exists precisely because this has no compile-time
// spelling: only a shared-IRI chain can put two edge kinds in one class).
expectError(equivalentTo(worksAt, employedBy));

declare const anyEdge: AnyEdgeType;
declare const anyNode: NodeType;
expectAssignable<OntologyRelation>(
  equivalentTo(anyEdge, "https://example.com/x"),
);
expectAssignable<OntologyRelation>(equivalentTo(anyNode, anyNode));

// A node kind paired with an edge kind, in EITHER order, has no defined
// substitution semantics either — refused at registry build
// (ONTOLOGY_EQUIVALENCE_INVALID_CLASS) — and the overload set (C13-R1-11)
// tightened this to a compile-time refusal too, in the node-first direction.
// (The edge-first direction, `equivalentTo(anyEdge, anyNode)`, DOES
// typecheck via the `(AnyEdgeType, NodeType)` overload; only the runtime
// registry build refuses it, matching the two-edge-kind case's runtime-only
// refusal above.)
expectError(equivalentTo(anyNode, anyEdge));

// ============================================================
// R2 — every meta-edge factory returns a typed relation
// ============================================================

// The IRI overload keeps `from` at the exact kind and types `to` as the
// bare `string` an external vocabulary term is, instead of collapsing the
// whole relation to `OntologyRelation`.
const personIriEquivalence = equivalentTo(Person, "https://schema.org/Person");
expectType<typeof Person>(personIriEquivalence.from);
expectType<string>(personIriEquivalence.to);
expectType<"equivalentTo">(personIriEquivalence.metaEdge.name);
expectAssignable<OntologyRelation>(personIriEquivalence);

// The non-C.1 helpers carry their meta-edge name literal too, so
// `SubsumptionAffected` can tell "this relation does not touch my kind"
// from "this relation was never typed".
const conceptBroader = broader(Individual, Person);
expectType<"broader">(conceptBroader.metaEdge.name);
expectType<typeof Individual>(conceptBroader.from);
expectAssignable<OntologyRelation>(conceptBroader);

const edgeInverse = inverseOf(worksAt, employedBy);
expectType<"inverseOf">(edgeInverse.metaEdge.name);
expectType<typeof worksAt>(edgeInverse.from);
expectAssignable<OntologyRelation>(edgeInverse);

const mediaDisjoint = disjointWith(Individual, Person);
expectType<"disjointWith">(mediaDisjoint.metaEdge.name);
expectAssignable<OntologyRelation>(mediaDisjoint);

// ============================================================
// R2 — SubsumptionAffected under the typed relations
// ============================================================

// An IRI-routed equivalence on `IriMedia` widens that kind's alias (the
// registry folds the IRI equivalence class into the subclass closure, so a
// co-registered kind's rows really can come back) while leaving a kind no
// relation names exact.
const IriMedia = defineNode("IriMedia", {
  schema: z.object({ title: z.string() }),
});
const IriPerson = defineNode("IriPerson", {
  schema: z.object({ name: z.string() }),
});
const iriGraph = defineGraph({
  id: "r2_iri_equivalence",
  nodes: { IriMedia: { type: IriMedia }, IriPerson: { type: IriPerson } },
  edges: {},
  ontology: [equivalentTo(IriMedia, "https://schema.org/CreativeWork")],
});

declare const iriStore: Store<typeof iriGraph>;
const iriEquivalencedQuery = iriStore
  .query()
  .from("IriMedia", "m")
  .select((ctx) => ctx.m);
declare const iriEquivalencedRow: Awaited<
  ReturnType<(typeof iriEquivalencedQuery)["execute"]>
>[number];
expectType<string>(iriEquivalencedRow.kind);

const iriUntouchedQuery = iriStore
  .query()
  .from("IriPerson", "p")
  .select((ctx) => ctx.p);
declare const iriUntouchedRow: Awaited<
  ReturnType<(typeof iriUntouchedQuery)["execute"]>
>[number];
expectType<"IriPerson">(iriUntouchedRow.kind);

// A tuple whose every element is a typed relation stays exact for a kind
// none of those relations subsumes: `broader`/`inverseOf` are not
// subsumption axes, and now that they are typed they no longer erase the
// tuple into conservative widening.
const TaxonomyMedia = defineNode("TaxonomyMedia", {
  schema: z.object({ title: z.string() }),
});
const TaxonomyPodcast = defineNode("TaxonomyPodcast", {
  schema: z.object({ title: z.string(), rssUrl: z.string() }),
});
const publishes = defineEdge("publishes", {
  schema: z.object({ at: z.string() }),
});
const typedTupleGraph = defineGraph({
  id: "r2_typed_tuple",
  nodes: {
    TaxonomyMedia: { type: TaxonomyMedia },
    TaxonomyPodcast: { type: TaxonomyPodcast },
  },
  edges: {
    publishes: {
      type: publishes,
      from: [TaxonomyMedia],
      to: [TaxonomyPodcast],
    },
  },
  ontology: [
    broader(TaxonomyPodcast, TaxonomyMedia),
    inverseOf(publishes, publishes),
  ],
});

declare const typedTupleStore: Store<typeof typedTupleGraph>;
const typedTupleQuery = typedTupleStore
  .query()
  .from("TaxonomyMedia", "m")
  .select((ctx) => ctx.m);
declare const typedTupleRow: Awaited<
  ReturnType<(typeof typedTupleQuery)["execute"]>
>[number];
expectType<"TaxonomyMedia">(typedTupleRow.kind);

// One element annotated as the bare `OntologyRelation` erases the literals
// `SubsumptionAffected` matches on, so the whole graph widens
// conservatively rather than reporting a kind as unaffected.
const AnnotatedMedia = defineNode("AnnotatedMedia", {
  schema: z.object({ title: z.string() }),
});
const AnnotatedPerson = defineNode("AnnotatedPerson", {
  schema: z.object({ name: z.string() }),
});
const annotatedRelation: OntologyRelation = broader(
  AnnotatedMedia,
  AnnotatedMedia,
);
const annotatedElementGraph = defineGraph({
  id: "r2_annotated_element",
  nodes: {
    AnnotatedMedia: { type: AnnotatedMedia },
    AnnotatedPerson: { type: AnnotatedPerson },
  },
  edges: {},
  ontology: [annotatedRelation],
});

declare const annotatedStore: Store<typeof annotatedElementGraph>;
const annotatedQuery = annotatedStore
  .query()
  .from("AnnotatedPerson", "p")
  .select((ctx) => ctx.p);
declare const annotatedRow: Awaited<
  ReturnType<(typeof annotatedQuery)["execute"]>
>[number];
expectType<string>(annotatedRow.kind);
