import { expectAssignable, expectError, expectType } from "tsd";
import { z } from "zod";

import {
  type AnyEdgeType,
  defineEdge,
  defineNode,
  equivalentTo,
  type NodeType,
  type OntologyRelation,
  sameAs,
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
expectType<OntologyRelation>(equivalentTo(Person, "https://schema.org/Person"));

// D1's widened left parameter: an edge kind mapped to an external IRI, so an
// edge can be declared equivalent to a cross-system vocabulary term.
expectType<OntologyRelation>(
  equivalentTo(worksAt, "https://schema.org/worksFor"),
);

// Two edge kinds have no defined substitution semantics (the runtime refusal
// in ontology/validation.ts exists precisely because this has no compile-time
// spelling: only a shared-IRI chain can put two edge kinds in one class).
expectError(equivalentTo(worksAt, employedBy));

// `sameAs` is the deprecated `equivalentTo` alias and is deliberately NOT
// widened — it is scheduled for removal (roadmap R1) and no interop case
// needs the edge-to-IRI shape on it.
expectError(sameAs(worksAt, "https://schema.org/worksFor"));

// `sameAs`'s existing NodeType-only shape still typechecks. Same C.1
// narrowing as equivalentTo above -- assignable, not identical.
expectAssignable<OntologyRelation>(sameAs(Person, Individual));

declare const anyEdge: AnyEdgeType;
declare const anyNode: NodeType;
expectType<OntologyRelation>(equivalentTo(anyEdge, "https://example.com/x"));
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
