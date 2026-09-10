---
title: Ontology & Reasoning
description: Semantic relationships, type hierarchies, and inference
---

## When Do You Need an Ontology?

An ontology captures **meaning** about your data—relationships that exist at the type level, not just instance
level. You need ontology when:

- **Type hierarchies**: "A Podcast is a type of Media" (query for Media, get Podcasts too)
- **Concept relationships**: "Machine Learning is narrower than AI" (topic navigation)
- **Constraints**: "A Person cannot also be an Organization" (prevent invalid data)
- **Edge implications**: Query `knows` through more-specific `marriedTo` rows when explicitly requested
- **Bidirectional queries**: "manages and managedBy are inverses" (traverse in either direction)

Without ontology, you'd implement these manually—if statements scattered throughout your code, hand-rolled
validation, duplicate queries. Ontology centralizes this logic in your schema.

## How It Works

TypeGraph treats semantic relationships between types as **meta-edges**—edges at the type level rather than instance level:

```typescript
// Instance edges: relationships between INSTANCES
// "Alice knows Bob"
const knows = defineEdge("knows");

// Meta-edges: relationships between TYPES
// "Employee subClassOf Person"
subClassOf(Employee, Person);
```

When you define an ontology, TypeGraph:

1. **Precomputes closures** at store initialization (not query time)
2. **Expands only the query operations that explicitly opt in** (except inverse
   traversal, whose store default is `"inverse"` and can be changed)
3. **Enforces the documented constraints** when building a registry or writing data

It does not run a general reasoner, materialize implied edges, substitute
properties between types, or automatically expand every query.

## Verified Support Matrix

| Relation / feature | Runtime contract |
| --- | --- |
| `subClassOf` | Transitive registry closure, write-path endpoint assignability, and node-query expansion with `expansion: "subclasses"` (the default). The closure now also includes every `equivalentTo` class — two equivalent kinds are mutual subclasses of each other. The child's schema output must structurally extend the parent's — checked at compile time and refused at registry build otherwise |
| `disjointWith` | Same-ID collision enforcement, propagated through interleaved `subClassOf` and `equivalentTo` closure |
| `implies` | Transitive registry closure and opt-in traversal expansion with `expand: "implying"`; endpoints are validated |
| `inverseOf` | Single inverse partner, endpoint reversal validation, and traversal expansion with `expand: "inverse"` (the default store setting) |
| `equivalentTo` | Between two registered kinds, MUTUAL SUBSUMPTION: folded into the same closure `subClassOf` reads, so `isAssignableTo`, `expandSubClasses` / the `expansion` option, edge-endpoint acceptance, disjointness propagation and the `kindWithSubClasses` claim axis all treat the two kinds as substitutable. An IRI on either side stays an inert cross-system reference — it never becomes a kind, but a class reached *through* one still folds together. Restricted to node kinds: an equivalence class that mixes a node kind and an edge kind, or that holds more than one registered edge kind, is refused (`ONTOLOGY_EQUIVALENCE_INVALID_CLASS`) |
| `broader` / `narrower` | Transitive registry introspection, plus kind-taxonomy query expansion with `expansion: "narrower"` (untyped alias — no schema relationship is claimed) |
| `partOf` / `hasPart` | Transitive registry introspection only |
| `relatedTo` | Symmetric direct registry introspection through `getRelatedKinds` only |

`sameAs`, `differentFrom`, and the custom `metaEdge()` factory were removed
— see [Upgrading past the removed `sameAs`/`differentFrom`/`metaEdge()`
APIs](/schema-evolution#upgrading-past-the-removed-sameasdifferentfrommetaedge-apis)
for what replaces them and what a document that still persists one does on
load.

## Core Meta-Edges

TypeGraph provides a standard set of meta-edges:

```typescript
import { subClassOf, broader, narrower, equivalentTo, disjointWith, partOf, hasPart, relatedTo, inverseOf, implies } from "@nicia-ai/typegraph";
```

### Subsumption (Type Inheritance)

**`subClassOf`**: Defines type inheritance where instances of the child are also instances of the parent.

```typescript
subClassOf(Podcast, Media);
subClassOf(Article, Media);
subClassOf(Company, Organization);
```

**The structural contract:** `subClassOf(child, parent)` requires the child's
schema output to structurally extend the parent's — every property the
parent requires, the child has with a compatible type; the child may add
properties (width subtyping) or narrow an optional-in-parent property.
`equivalentTo` between two registered kinds checks the same contract
in **both** directions. The check runs twice: at **compile time**
(TypeScript rejects an incompatible pair with a message naming the missing
or incompatible fields), and at **registry build** for whatever the type
checker cannot see — a value-level constraint like `z.string().min(3)`
tightening a bare `z.string()`. The registry check is authoritative and
covers all three authoring routes (a compile-time graph, an `evolve()`-
authored extension, and a deserialized persisted document), throwing a
`ConfigurationError` under one of four codes:

| code | when |
| --- | --- |
| `ONTOLOGY_SUBCLASS_NOT_STRUCTURAL_SUBTYPE` | a `subClassOf` child's schema does not extend its parent's |
| `ONTOLOGY_SUBCLASS_SCHEMA_INCOMPARABLE` | the projected JSON Schema cannot judge the pair (`$ref`, `allOf`, `not`, or an unmodeled keyword) |
| `ONTOLOGY_EQUIVALENCE_NOT_STRUCTURAL_SUBTYPE` | an `equivalentTo` pair fails in one direction |
| `ONTOLOGY_EQUIVALENCE_SCHEMA_INCOMPARABLE` | the same, but the pair is incomparable |

**Known gap:** the registry check compares kinds' projected JSON Schema, and
a Zod construct `z.toJSONSchema` cannot convert (`z.set()`, `z.map()`, and
others) projects as a generic `{ type: "object" }` for every kind that
contains one — so two kinds that differ only inside such a field are
indistinguishable to the check and a genuinely incompatible pair is silently
accepted rather than refused. This applies equally to a compile-time graph,
an `evolve()`-authored extension, and a deserialized document; avoid
`z.set()`/`z.map()` on a node schema that participates in `subClassOf` or
`equivalentTo` until the projection is made distinguishable.

If your hierarchy is a **taxonomy** rather than a genuine subtype
relationship — the child doesn't actually extend the parent's schema —
declare `broader(child, parent)` instead; see
[Hierarchical (Concept Hierarchy)](#hierarchical-concept-hierarchy) below and
`expansion: "narrower"` in [Source](/queries/source#expansion-narrower--kind-level-taxonomies).

**Query behavior — polymorphic by default:**

A query against a kind other kinds declare themselves `subClassOf` returns
subtype rows **by default**, since the structural contract guarantees the
subtype rows satisfy the parent's shape:

```typescript
// Default: returns Media, Podcast, AND Article nodes
const allMedia = await store
  .query()
  .from("Media", "m")
  .select((ctx) => ctx.m)
  .execute();
// Results include nodes of kind "Media", "Podcast", and "Article"

// Narrowed: returns only nodes with kind="Media"
const mediaOnly = await store
  .query()
  .from("Media", "m", { expansion: "exact" })
  .select((ctx) => ctx.m)
  .execute();
```

This is a fundamental difference from traditional ORM inheritance—TypeGraph stores the concrete type
(`kind: "Podcast"`) in the database, and expands at query time by default. The
alias's `kind` field and `NodeId` brand widen to `string` for a kind the
ontology can actually affect (a graph with no subsumption relations keeps its
exact literal types); only the parent's own properties are statically typed on
the alias, since that is all the contract guarantees. `search()` and the
collection APIs (`find`, `count`, `updateWhere`, `compareAndSet`) are
unaffected and stay exact-kind. See
[Subclass queries are polymorphic](/queries/source) for the full option and
`queryDefaults.expansion` in [Schemas & Stores](/schemas-stores) for
the store-wide migration knob.

**Changing this on a populated graph**: adding a `subClassOf` relation is
checked against existing data before it commits — it can merge two
uniqueness components or propagate a `disjointWith` down to a new
descendant — and removing one is checked for live edges whose endpoints rely
on the subsumption. See
[Ontology tightenings are checked against your data](/schema-evolution#ontology-tightenings-are-checked-against-your-data).
An incompatible hierarchy on a populated graph is refused before the upgrade
even reaches that data check — see
[Schema evolution](/schema-evolution#structural-subsumption-is-checked-before-you-upgrade).

### Hierarchical (Concept Hierarchy)

**`broader`** and **`narrower`**: Define conceptual hierarchy without identity.

```typescript
broader(MachineLearning, ArtificialIntelligence);
broader(DeepLearning, MachineLearning);
broader(ArtificialIntelligence, Technology);
```

**Important**: This is different from `subClassOf`. A topic instance of "ML" is related to "AI",
but is **not** an instance of "AI".

```typescript
// Get all topics narrower than Technology
const narrowerTopics = registry.expandNarrower("Technology");
// ["ArtificialIntelligence", "MachineLearning", "DeepLearning", ...]
```

A query can expand through this same closure with `expansion: "narrower"` on
`from()`/`to()`/`fromDynamic()`/`toDynamic()` — since no schema relationship
is claimed, the resulting alias is untyped (no static property access; use
`fromDynamic()`'s `.field(name)` discriminator). This is the small,
fixed-vocabulary reading of a kind taxonomy — a handful of concepts known at
schema-authoring time, each declared as its own node kind. For a vocabulary
that grows at runtime (new concepts added without a schema change), prefer
the instance-level pattern instead: a single `Concept` node kind, a
`broader` **edge** between concept instances, traversed with
`.recursive()` — the SKOS / Wikidata / LinkML model. Choose the kind-level
form when the vocabulary is closed and small; choose the instance-level form
when it is open-ended. The instance-level `broader` edge kind can declare
[`acyclic: true`](#enforce-an-instance-level-taxonomy-with-acyclic-true), and
the engine then refuses at write time any edge that would close a `broader`
cycle ([`EdgeAcyclicityError`](/errors#edgeacyclicityerror)) rather than
leaving cycle freedom to the application; a search the engine cuts short
reports [`EdgeAcyclicityIndeterminateError`](/errors#edgeacyclicityindeterminateerror)
instead of guessing. Kind-level `broader`/`narrower` needs no declaration:
a cyclic kind taxonomy is refused when the registry is built.

```typescript
// Instance-level: a single Concept kind, broader as an edge
const Concept = defineNode("Concept", { schema: z.object({ label: z.string() }) });
const broaderEdge = defineEdge("broader", { schema: z.object({}) });

const ancestors = await store
  .query()
  .from("Concept", "c")
  .whereNode("c", (n) => n.id.eq(leafConceptId))
  .traverse("broader", "e")
  .recursive()
  .to("Concept", "ancestor")
  .select((ctx) => ctx.ancestor)
  .execute();
```

**Changing this on a populated graph**: `broader`/`narrower` never gate a
write or change what a claim contends for, so adding or removing one is
always safe and auto-migrates unconditionally.

### Equivalence

**`equivalentTo`**: Between two registered kinds, `equivalentTo` is MUTUAL
SUBSUMPTION — the registry folds the class into the same closure `subClassOf`
uses, so the two kinds become fully substitutable:

```typescript
const Company = defineNode("Company", { schema: z.object({ name: z.string() }) });
const Corporation = defineNode("Corporation", { schema: z.object({ name: z.string() }) });

equivalentTo(Company, Corporation);

registry.isAssignableTo("Corporation", "Company"); // true
registry.isAssignableTo("Company", "Corporation"); // true — mutual
registry.expandSubClasses("Company"); // ["Company", "Corporation"]
```

That substitutability reaches every consumer of the subsumption closure:
`expansion: "subclasses"` on a `Company`-scoped query or `search()` call also
returns `Corporation` rows, an edge endpoint declared `to: [Company]` accepts
a `Corporation` node, and disjointness declared against `Company` propagates
to `Corporation` too. A `kindWithSubClasses` uniqueness constraint fences
across the pair — the two kinds share one claim axis, so a value unique for
`Company` is now also unique for `Corporation`.

Because subsumption is a strict order (`isSubClassOf(k, k)` is always false,
and `expandSubClasses` never repeats a kind), a kind that sits strictly
between two mutually-equivalent kinds collapses into the same class too, even
though nothing declares it equivalent to either one directly:

```typescript
equivalentTo(Doctor, Physician);
subClassOf(Doctor, Consultant);
subClassOf(Consultant, Physician);
// Doctor and Physician were declared equivalent; Consultant only ever
// declared subClassOf. But Doctor ⊑ Consultant ⊑ Physician ⊑ Doctor is now a
// cycle, so all three are mutually assignable and share one subclass
// component: ["Consultant", "Doctor", "Physician"].
```

This is the mathematically forced consequence of making `equivalentTo` mutual
subsumption, not a special case the registry detects — `Consultant` never
appears in an `equivalentTo` declaration, but the closure over `subClassOf`
and `equivalentTo` together puts it on the same cycle as `Doctor` and
`Physician`.

`equivalentTo` also maps a type to an external IRI for cross-system mapping,
exactly as before. An IRI is an inert reference — it never becomes a kind of
its own — but a class *reached through* one still folds together:

```typescript
equivalentTo(Person, "https://schema.org/Person");
equivalentTo(Individual, "https://schema.org/Person");
// Person and Individual are now one class, even though neither equivalentTo
// call named the other directly.
```

An edge kind may be mapped to an external IRI too (`equivalentTo`'s left
parameter accepts `NodeType | AnyEdgeType`), but subsumption itself is a
node-kind relation. An equivalence class is refused, with a
`ConfigurationError` whose details code is `ONTOLOGY_EQUIVALENCE_INVALID_CLASS`,
when it mixes a node kind and an edge kind, or when it contains more than one
registered edge kind (which can happen transitively, through two edges mapped
to the same IRI):

```typescript
// Refused: worksAt (an edge kind) and Person (a node kind) in one class.
equivalentTo(worksAt, Person);

// Refused: two registered edge kinds folded together through a shared IRI.
equivalentTo(worksAt, "https://schema.org/worksFor");
equivalentTo(employedBy, "https://schema.org/worksFor");

// Legal: one edge kind and one node kind, each mapped to its OWN IRI.
equivalentTo(worksAt, "https://schema.org/worksFor");
equivalentTo(Person, "https://schema.org/Person");
```

**`sameAs`** and **`differentFrom`** — deprecated type-level factories that
behaved identically to `equivalentTo` and as a decorative no-op relation,
respectively — were removed. For durable individual identity, enable the
graph-level TypeGraph Identity Profile and use `store.identity`. That ledger
deliberately does not provide OWL property substitution or automatic
graph-wide query expansion. See
[Upgrading past the removed `sameAs`/`differentFrom`/`metaEdge()` APIs](/schema-evolution#upgrading-past-the-removed-sameasdifferentfrommetaedge-apis)
for what a document that still persists one of these relations does on load.

**Changing this on a populated graph**: `equivalentTo` is classified exactly
like `subClassOf` — an addition is checked against existing data (it can
propagate a `disjointWith`, and will also merge uniqueness components once
equivalence folds into subsumption), and a removal is checked for live edges
relying on it. See
[Ontology tightenings are checked against your data](/schema-evolution#ontology-tightenings-are-checked-against-your-data).

### Constraints

**`disjointWith`**: Declares that two types cannot share the same ID.

```typescript
disjointWith(Person, Organization);
disjointWith(Podcast, Article);
```

Disjointness is inherited by subclasses. If `Company subClassOf Organization`,
then `disjointWith(Person, Organization)` also makes `Person` and `Company`
disjoint.

**Effect**: Attempting to create a node that violates disjointness throws `DisjointError`:

```typescript
// Create a Person with ID "entity-1"
await store.nodes.Person.create({ name: "Alice" }, { id: "entity-1" });

// Throws DisjointError: Person and Organization are disjoint
await store.nodes.Organization.create({ name: "Acme" }, { id: "entity-1" });
```

**Coherence rules**: `disjointWith` cannot contradict the rest of the ontology.
A kind disjoint with itself, a kind disjoint with one of its own subclass
ancestors, a common subclass of two disjoint parents, and a kind declared both
`equivalentTo` and `disjointWith` another are all rejected, including overlaps
reached through mixed equivalence/subclass paths. An equivalence class that
mixes a node kind and an edge kind, or that holds more than one registered
edge kind, is rejected too (`ONTOLOGY_EQUIVALENCE_INVALID_CLASS`; see
"Equivalence" above). These checks run both when you construct a graph and
when a persisted schema is reloaded, so a document written by an older, more
permissive version can fail validation on load with a `ConfigurationError`
whose details code names the specific check. To recover, fix the graph
definition and, for a persisted schema, correct the stored document before
upgrading (or rewrite it through the previous minor version, which still
accepts it). The same construction-and-reload rule applies to the other
ontology coherence checks (duplicate relations, hierarchical self-loops and
cycles, and inverse-partner uniqueness).

**Changing this on a populated graph**: adding `disjointWith` is checked
against every live node before it commits — two nodes already sharing an id
under kinds the new relation makes mutually exclusive refuse the migration.
Removing `disjointWith` can never invalidate existing data, so it stays safe
and auto-migrates unconditionally. See
[Ontology tightenings are checked against your data](/schema-evolution#ontology-tightenings-are-checked-against-your-data).

### Composition

**`partOf`** and **`hasPart`**: Declare a whole/part relationship, realized by
an edge kind that actually stores the containment. `via` is required and
names that edge; `partSide` is required only when the edge's endpoints make
both orientations valid.

```typescript
const episodeOf = defineEdge("episodeOf");

partOf(Episode, Podcast, { via: episodeOf });
// hasPart(Podcast, Episode, { via: episodeOf }) declares the identical pair —
// pick whichever direction reads more naturally, not both.
```

`via`'s realizing edge must declare a whole-side cardinality of `"one"` or
`"oneActive"`: `cardinality` when the part is the edge's `from` endpoint,
`targetCardinality` when the part is its `to` endpoint. Every `(from, to)`
pair the edge admits must be declared as a composition pair in that same
orientation — an edge cannot be a composition edge for some of its endpoints
and a plain edge for the rest.

A same-kind (reflexive) pair, or any pair whose realizing edge admits both
orientations between the two kinds, is ambiguous: `partSide: "from" | "to"`
must be declared explicitly, naming which endpoint holds the part.

```typescript
const parentSection = defineEdge("parentSection");

// `parentSection` admits Section -> Section either way, so the orientation
// can't be inferred.
partOf(Section, Section, { via: parentSection, partSide: "from" });
```

**Changing this on a populated graph**: declaring or dropping a `partOf`/
`hasPart` pair itself auto-migrates unconditionally either way — the schema
change does not walk existing rows, so a graph that already holds parts with
more than one live whole (written before the pair was declared, by trusted
import, or by direct SQL) is not repaired by the declaration. Run
`store.verifyConstraintFences()` (the `family: "composition"` entries) after
adding a pair to a populated graph. Removing a pair only ever loosens a
constraint, so it stays safe regardless.

#### Attaching a part: `partOf: { kind, id, via?, props? }`

Every write that can give a part a whole takes the same attachment value:
`create`, `bulkCreate` (per item), `getOrCreateByConstraint` /
`bulkGetOrCreateByConstraint`, and
[`reparent`](#reparent-moving-a-part-to-a-new-whole).

```typescript
const chapter = await store.nodes.Chapter.create(
  { title: "Openings" },
  {
    partOf: {
      kind: "Book",
      id: book.id,
      via: "chapterOf",
      props: { order: 1 },
    },
  },
);
```

The node and its realizing composition edge are written in **one**
transaction: a lost composition claim, a dead or missing whole, a cardinality
refusal, or an acyclicity refusal aborts the node create too.

- **`kind` / `id`** name the whole. A pair that is not declared between the
  two kinds raises `ConfigurationError`
  (`details.code: "COMPOSITION_WHOLE_NOT_DECLARED"`).
- **`via`** names the realizing edge kind. It is required only when the part
  kind declares **more than one** composition pair toward that whole kind:
  omitting it there raises `ConfigurationError`
  (`COMPOSITION_VIA_AMBIGUOUS`) rather than silently picking one, and naming
  an edge kind that realizes no declared pair between them raises
  `COMPOSITION_VIA_NOT_DECLARED`.
- **`props`** are the realizing edge's own properties, validated against that
  edge kind's schema exactly as `store.edges.<via>.create(...)` would
  validate them. A realizing edge with required schema fields therefore needs
  `props` here.

#### `reparent`: moving a part to a new whole

```typescript
await store.nodes.Chapter.reparent(chapter.id, {
  kind: "Anthology",
  id: anthology.id,
  via: "includedIn",
});
```

Moving a part is a first-class operation because neither half is legal on its
own: the new attachment refuses while the old edge still holds the part's
one-whole claim, and — under `existence: "required"` — detaching the old edge
refuses while the part is live. `reparent` performs both under one per-graph
fence, in one transaction, and validates the **final** state: one whole,
acyclicity over the composition union, and a required part never left
detached. The part keeps its id, its properties, and every descendant beneath
it.

The move is ONE instant — the same timestamp ends the old window and opens
the new one — but what that buys a reader depends on the incumbent row's own
population, which is also what decides how the old attachment is retired:

| population | retire | valid-time read at any instant before the move |
| --- | --- | --- |
| `"one"` | the composition edge is deleted | the attachment is gone from every `store.asOf(t)` read, at every coordinate — a `"one"` binding persists for the row's whole life, ended or not, so an ended row would still read as an attachment |
| `"oneActive"` | the window is ended at the move instant | the previous membership stays readable as valid-time history; because the same instant ends the old window and opens the new one, no `store.asOf(t)` coordinate shows the part with zero wholes or with two |

Reparenting to the whole the part already holds (through the same `via`, when
one is stated) is accepted as a **no-op** — no write, no history — so a
caller converging on a destination need not first ask where the part is.
Stated `props` are still checked on that no-op: valid and canonically equal
to the realizing edge's live stored props, the no-op stands; valid but
different raises `CompositionExistenceError` (`situation: "props"`) rather
than being silently dropped, since the no-op performs no write to apply it —
`store.edges.<via>.update(...)` changes the edge directly. A kind that
declares no `partOf`/`hasPart` pair at all raises
`ConfigurationError` (`COMPOSITION_NOT_A_PART`); a missing or already-deleted
part raises `NodeNotFoundError`.

#### `existence`: a part that cannot exist without a whole

`existence: "required"` on a `partOf`/`hasPart` pair says a part of that kind
can never exist without a live whole — the default, `"optional"`, is every
declaration written before this option existed.

```typescript
partOf(Segment, Episode, { via: segmentOf, existence: "required" });
```

Three refusals follow from that one declaration:

- **A bare create is refused.** `store.nodes.Segment.create({...})` with no
  `partOf` throws `CompositionExistenceError`
  (`COMPOSITION_WHOLE_REQUIRED`) before any row is written. Pass `partOf: {
  kind, id }` naming the whole; the node and its composition edge are written
  in the same transaction — a lost composition claim or a dead/missing whole
  aborts the create too.
- **Detaching a live part is refused.** Ending, soft-deleting, or
  hard-deleting the composition edge of a LIVE required part throws the same
  error with `situation: "detach"`. A part that is already retired (soft- or
  hard-deleted) is not orphaned by losing its edge, so that case is allowed.
  The two ways out are deleting the part itself (which frees its edge) and
  [`reparent`](#reparent-moving-a-part-to-a-new-whole), which retires the old
  attachment and creates the new one in one transaction so the part is never
  detached at all.
- **`partOf` on `getOrCreateByConstraint` is a POSTCONDITION.** When the call
  returns, the resolved node holds exactly the stated attachment. On
  `"created"`/`"resurrected"` it is applied as a plain create's `partOf` is;
  on `"found"`/`"updated"` it is checked — a node that already holds this
  whole through the resolved pair's realizing edge satisfies it (idempotent
  when stated `props` are omitted, or valid and canonically equal to the
  edge's live stored props — a valid but DIFFERENT `props` refuses with
  `situation: "props"` instead of being silently kept, since a satisfied
  match writes no edge), a node with no live whole has the attachment written
  now (required or optional alike), and a node with a **different** live
  whole, or the same whole through another realizing edge, is refused with
  `CompositionExistenceError` (`situation: "existing"`) naming both sides.
  Moving a part is [`reparent`](#reparent-moving-a-part-to-a-new-whole)'s
  decision, never a side effect of a lookup. The attachment is resolved
  BEFORE the match is read, so the three `ConfigurationError` refusals above
  (`COMPOSITION_WHOLE_NOT_DECLARED`, `COMPOSITION_VIA_NOT_DECLARED`,
  `COMPOSITION_VIA_AMBIGUOUS`) fire identically on a found node and on a
  created one.

`existence: "required"` is about detachment and bare creation, not about
deleting the *whole* — deleting a whole still cascades to its required parts
(see the cascade note above), rather than refusing.

`partOf` (and the equivalent option on `bulkCreate`'s per-item `partOf`) is
also accepted as a convenience on an `existence: "optional"` pair — the same
one write, never required for one.

Composition existence is a create/detach-time write-path guarantee, not a
retroactive repair: `store.verifyConstraintFences()` reports a live required
part with no live whole (data written before the declaration, or by trusted
import — see below) but does not fix it.

**Changing `existence` on an already-declared pair**: flipping `existence` in
place — the pair itself (`via`, `partSide`) stays the same, only the
`"optional"`/`"required"` value changes — is classified as one `modified`
change, never as removing and re-adding the pair. Tightening
(`"optional"` → `"required"`) is a `warning`-severity change: it runs the
SAME data check a brand-new required pair does (a live part with no live
whole refuses the commit), reached directly through `ensureSchema`/
`createAdapterStoreWithSchema`'s ordinary auto-migrate path — no explicit
`migrateSchema()` call is needed. Loosening (`"required"` → `"optional"`) is
always `safe`: every state the tightened constraint forbade is still
admitted, so it auto-migrates unconditionally regardless of data.

#### Choosing a containment tier

Not every "this belongs to that" relationship is composition. Before reaching
for `partOf`/`hasPart`, place the relation in exactly one of three tiers:

| tier | what you write | what the runtime guarantees |
| --- | --- | --- |
| 1 — Composition | `partOf(Part, Whole, { via: edge })` | everything below |
| 2 — Aggregation | `cardinality`, `targetCardinality`, `acyclic` on an edge registration | each rule enforced independently, with no ownership slot, no cascade, no cross-relation constraint |
| 3 — Mereology | an ordinary edge kind + `.recursive()` | transitivity only, no integrity claim |

Tier 1 is enforced, in full, at write time:

- **Declaration shape.** The realizing edge's whole-side cardinality is
  `"one"` or `"oneActive"`, and every endpoint pair the edge admits is a
  declared composition pair in that orientation.
- **One whole per part.** A part holds exactly one whole across **every**
  declared composition relation and **both** orientations — two different
  realizing edge kinds contend for one reserved claim row, so the second
  attach refuses with `CompositionError`
  ([`COMPOSITION_WHOLE_OCCUPIED`](/errors#compositionerror)). Move a part
  with [`reparent`](#reparent-moving-a-part-to-a-new-whole), never by
  attaching a second edge.
- **Acyclicity over the composition union.** Every realizing edge kind forms
  ONE oriented (part → whole) relation, probed on each composition edge
  write, so a cycle spanning two different realizing edge kinds is caught
  even though neither kind is `acyclic` alone
  ([`EdgeAcyclicityError`](/errors#edgeacyclicityerror)).
- **Leaf-first cascade.** Deleting a whole deletes its live parts closure
  leaf-first, in the same transaction, each part through its own node-delete
  pipeline. See
  [Composition Cascade](/limitations#composition-cascade) for what the
  cascade deliberately does *not* do.
- **`existence: "required"`.** An opt-in per pair: a part of that kind can
  never exist without a live whole (see below).
- **Navigation and export.** `parts()`/`wholes()` cross heterogeneous,
  mixed-orientation edge kinds, and `subgraph({ composition: true })` returns
  the complete owned unit — a root plus its entire parts closure, at whatever
  depth the part tree happens to be rather than at the caller's `maxDepth`.
  There is no depth ceiling on that closure and no partial answer: it is a
  set-semantics recursion bounded by its own visited set, the same way the
  acyclicity probe is exhaustive, so a part chain of any length comes back
  whole. An engine that cuts the closure statement short (a
  `statement_timeout`, a cancelled query) REFUSES with a `ConfigurationError`
  (`COMPOSITION_UNIT_INDETERMINATE`) naming the root, rather than handing back
  the rows it managed to reach — the same treatment the acyclicity probe gives
  a cut-short search. `maxDepth` and `cyclePolicy` continue to bound the
  `edges` traversal a caller lists alongside it, and the engine's 1000-hop
  ceiling on an explicit traversal applies to that list alone.

The composition claim rides `typegraph_edge_claims`, the same relation edge
cardinality claims use. A deployment initialized before that relation existed
raises `ConfigurationError` (`EDGE_CLAIM_RELATION_MISSING`) on the first
`partOf`/`hasPart` write and must be migrated under owner credentials — see
[Backend Setup](/backend-setup).

**The only tier with a cascade is the only tier with an ownership slot.** A
part with two owners is not a part. Any relation whose users need shared
membership, overlapping hierarchies, or re-homing a child when its parent is
removed is tier 2, not tier 1 — declaring it `partOf` would mean deleting the
parent deletes children that should have survived.

**Rows retained for external referrers are tier 2, not composition.** A
"version of X" relation whose parts must stay resolvable by id after the
whole is deleted — a historical run record, a receipt, an audit snapshot — is
single-parent and acyclic like composition, but its members must *outlive*
their parent. That is exactly what composition's cascade refuses to do
(parts die with the whole), so this pattern is aggregation: a plain edge with
`cardinality`/`targetCardinality`, no `partOf`/`hasPart`.

A worked, product-shaped version of this distinction: `Artifact ->
ArtifactVersion -> ArtifactChunk`, `ChangeSet -> ChangeSetItem`, `Skill ->
SkillVersion`, and `EvalRun -> results` are true composition (exactly one
parent, parts die with the whole). A folder tree where deleting a folder
re-homes its children to the deleted folder's parent, or a document whose
deletion retracts claims but leaves the referenced entity standing on
remaining support, is aggregation — declaring either `partOf` would be wrong,
not just imprecise.

### Edge Relationships

**`inverseOf`**: Declares two edge kinds as inverses of each other.

```typescript
inverseOf(manages, managedBy);
inverseOf(cites, citedBy);
inverseOf(follows, followedBy);
```

**Effect**: You can query in either direction using the registry:

```typescript
const inverse = registry.getInverseEdge("manages"); // "managedBy"
```

You can also expand traversals to include inverse edge kinds at query time:

```typescript
const relationships = await store
  .query()
  .from("Person", "p")
  .traverse("manages", "e", { expand: "inverse" })
  .to("Person", "other")
  .select((ctx) => ({
    other: ctx.other.name,
    via: ctx.e.kind,
  }))
  .execute();
```

For symmetric relationships, declare an edge as its own inverse:

```typescript
inverseOf(collaboratesWith, collaboratesWith);
```

An edge may have only one distinct inverse partner. Every allowed pair must be
compatible with a reversed pair in its partner, in both traversal directions,
using equal kinds or `subClassOf` assignability. Matching the independent source
and target unions is insufficient for source-dependent edges. A self-inverse
edge must satisfy the same reversed-pair check against itself.

**Changing this on a populated graph**: adding or removing `inverseOf`
changes what a default `expand: "inverse"` traversal returns for existing
edges — a read-semantics change — so it is `breaking` and requires an
explicit `migrateSchema()`. See
[Ontology tightenings are checked against your data](/schema-evolution#ontology-tightenings-are-checked-against-your-data).

**`implies`**: Declares that one edge kind implies another exists.

```typescript
implies(marriedTo, knows);
implies(bestFriends, friends);
implies(friends, knows);
```

**Effect**: Query for `knows` can include `marriedTo`, `bestFriends`, and `friends` edges:

```typescript
const connections = await store
  .query()
  .from("Person", "p")
  .traverse("knows", "e", { expand: "implying" })
  .to("Person", "other")
  .select((ctx) => ctx.other)
  .execute();
```

**Endpoint compatibility is required.** `implies(edgeA, edgeB)` only makes
sense if every node kind `edgeA` can connect could also, in principle,
satisfy `edgeB`'s own domain/range — otherwise `expand: "implying"` would
traverse rows whose kinds don't match what the traversal actually asked for.
Every allowed pair in `edgeA` must match a single allowed pair in `edgeB`:
both endpoints must be assignable — equal, or a `subClassOf` descendant —
to their corresponding endpoint in that pair. For
[source-dependent targets](/core-concepts#source-dependent-targets), finding
the source in one entry and the target in another does not suffice.
An incompatible pair (say, `Author -> Paper` implying
`Paper -> Topic`) throws `ConfigurationError` wherever the graph is built
into a store or committed as a schema version (`createStore`,
`createStoreWithSchema`, `store.evolve({ ontology })`) — including relations
authored through a graph extension, not just `implies()` calls in code.

**Changing this on a populated graph**: adding or removing `implies` changes
what a default `expand: "implying"` traversal returns for existing edges —
the same read-semantics reasoning as `inverseOf` — so it is also `breaking`
and requires an explicit `migrateSchema()`. See
[Ontology tightenings are checked against your data](/schema-evolution#ontology-tightenings-are-checked-against-your-data).

## Using the Ontology

### In Graph Definition

```typescript
const graph = defineGraph({
  id: "knowledge_base",
  nodes: { ... },
  edges: { ... },
  ontology: [
    // Type hierarchy
    subClassOf(Podcast, Media),
    subClassOf(Article, Media),
    subClassOf(Company, Organization),

    // Concept hierarchy
    broader(MachineLearning, ArtificialIntelligence),
    broader(DeepLearning, MachineLearning),

    // Constraints
    disjointWith(Person, Organization),
    disjointWith(Media, Person),

    // Composition
    partOf(Episode, Podcast, { via: episodeOf }),

    // Edge relationships
    inverseOf(cites, citedBy),
    implies(marriedTo, knows),
  ],
});
```

### Registry Lookups

The type registry (accessed via `store.registry`) provides methods to query the ontology:

```typescript
const registry = store.registry;

// Subsumption
registry.isSubClassOf("Podcast", "Media"); // true
registry.expandSubClasses("Media"); // ["Media", "Podcast", "Article"]

// Hierarchy
registry.expandNarrower("Technology"); // ["AI", "ML", "DL", ...]
registry.expandBroader("DeepLearning"); // ["ML", "AI", "Technology"]

// Constraints
registry.areDisjoint("Person", "Organization"); // true
registry.getDisjointKinds("Person"); // ["Organization", "Media", ...]

// Edge relationships
registry.getInverseEdge("cites"); // "citedBy"
registry.getImpliedEdges("marriedTo"); // ["knows"]
registry.getImplyingEdges("knows"); // ["marriedTo", "bestFriends", "friends"]
registry.getRelatedKinds("MachineLearning"); // ["DataScience", ...]
```

## Type-Level Annotations

The custom `metaEdge()` factory was removed — it never made the registry
compute a custom closure or made the query builder execute custom inference
in any release; it only carried metadata through serialization. For
domain-specific, type-level vocabulary the library has no built-in reasoning
for, attach it as free-form JSON on the graph definition instead:

```typescript
const graph = defineGraph({
  // ...
  annotations: {
    prerequisiteOf: {
      transitive: true,
      pairs: [["Calculus", "LinearAlgebra"]],
    },
    supersedes: {
      transitive: true,
      pairs: [["v2", "v1"]],
    },
  },
});
```

`annotations` (`GraphAnnotations`, a `Record<string, JsonValue>`) travels
with the graph definition exactly like the core meta-edges do — persisted,
serialized, and visible through `store.introspect().annotations` — with no
KindRegistry closure computed over it. Your application interprets the
vocabulary, the same way `metaEdge()`'s custom properties always required
application code to interpret them. See
[examples/08-custom-ontology.ts](https://github.com/nicia-ai/typegraph/blob/main/packages/typegraph/examples/08-custom-ontology.ts)
for a complete example, including a transitive-closure walk over an
annotated relation. See
[Upgrading past the removed `sameAs`/`differentFrom`/`metaEdge()` APIs](/schema-evolution#upgrading-past-the-removed-sameasdifferentfrommetaedge-apis)
for the migration from an existing `metaEdge()` declaration.

## Closure Computation

TypeGraph precomputes transitive closures at store initialization:

```typescript
// subClassOf closure
// If: Podcast subClassOf Media, Episode subClassOf Media
// Then: expandSubClasses("Media") = ["Media", "Podcast", "Episode"]

// implies closure
// If: marriedTo implies partneredWith, partneredWith implies knows
// Then: getImpliedEdges("marriedTo") = ["partneredWith", "knows"]
```

This makes queries efficient—expansion happens at query compilation time, not execution time.

## Best Practices

### Separate `subClassOf` from `broader`

These have different semantics:

- `subClassOf`: Type membership (a Podcast instance is also a Media instance)
- `broader`: Conceptual relation (ML **relates to** AI, but ML instance ≠ AI instance)

```typescript
// CORRECT: Type hierarchy — Podcast's schema extends Media's
subClassOf(Podcast, Media);

// CORRECT: Concept hierarchy — MachineLearning does not extend
// ArtificialIntelligence's schema, so this could not compile as subClassOf
broader(MachineLearning, ArtificialIntelligence);

// WRONG: Don't mix them — and since C.1/C.2, a subClassOf declaration whose
// child does not structurally extend the parent no longer compiles, and is
// refused at registry build even when authored dynamically:
// subClassOf(MachineLearning, ArtificialIntelligence);
```

If you already have a `subClassOf` that models a taxonomy rather than a
subtype relationship, the fix is `broader(child, parent)` plus
`expansion: "narrower"` on the queries that relied on the old expansion.

### Use Disjoint Constraints

Prevent impossible combinations:

```typescript
// Good: Prevent ID conflicts
disjointWith(Person, Organization);
disjointWith(Person, Product);
disjointWith(Organization, Product);
```

### Model Edge Hierarchies with Implies

```typescript
// Relationship hierarchy: specific → general
implies(marriedTo, partneredWith);
implies(partneredWith, knows);
implies(parentOf, relatedTo);
implies(siblingOf, relatedTo);
implies(relatedTo, knows);
```

### Use InverseOf for Bidirectional Queries

```typescript
inverseOf(manages, managedBy);
inverseOf(follows, followedBy);
inverseOf(cites, citedBy);
```

This lets you query efficiently in either direction without duplicating edges.

### Enforce an Instance-Level Taxonomy with `acyclic: true`

`subClassOf` is a **type-level** relation between kinds; it says nothing
about instances of one concept kind pointing at each other (a category tree,
a concept hierarchy). For that, declare the edge itself `acyclic: true` and
traverse it with `.recursive()`:

```typescript
const Concept = defineNode("Concept", { schema: z.object({ name: z.string() }) });
const broaderEdge = defineEdge("broader", { schema: z.object({}) });

const graph = defineGraph({
  nodes: { Concept: { type: Concept } },
  edges: {
    broader: {
      type: broaderEdge,
      from: [Concept],
      to: [Concept],
      acyclic: true,
    },
  },
});

// A concept can never (transitively) be broader than itself.
await store.query(Concept).from(root).recursive("broader", { maxHops: 20 });
```

This is not expressible as an OWL 2 DL axiom — OWL has no acyclicity
constraint on a property — but it matches SHACL-SPARQL's cycle shape
(`$this ex:broader+ $this`) exactly, enforced transactionally rather than
left to a query the caller must remember to run.

## API Reference

### Ontology Functions

#### `subClassOf(child, parent)`

Declares type inheritance. `child`'s schema output must structurally extend
`parent`'s — checked at compile time (a mismatched pair fails to compile,
naming the incompatible fields) and at registry build for what the type
checker cannot see (value-level constraints). See
[the structural contract](#subsumption-type-inheritance) above.

```typescript
function subClassOf<C extends NodeType, P extends NodeType>(
  child: C,
  parent: P & SubClassOfCheck<C, P>, // SubClassOfCheck resolves to `unknown` on success, or a mismatch object naming the incompatible fields
): TypedOntologyRelation<"subClassOf", C, P>;
```

#### `broader(narrower, broader)`

Declares hierarchical relationship (narrower concept to broader concept).

```typescript
function broader<N extends NodeType, B extends NodeType>(
  narrower: N,
  broader: B,
): TypedOntologyRelation<"broader", N, B>;
```

#### `narrower(broader, narrower)`

Declares hierarchical relationship (broader concept to narrower concept).

```typescript
function narrower<B extends NodeType, N extends NodeType>(
  broader: B,
  narrower: N,
): TypedOntologyRelation<"narrower", B, N>;
```

#### `equivalentTo(kindA, kindBOrIri)`

Declares mutual subsumption between two registered kinds, or maps a kind to an
external IRI for cross-system mapping. The left parameter accepts an edge kind
too, so an edge can be mapped to an IRI — subsumption itself stays a node-kind
relation, so an equivalence class mixing a node kind and an edge kind, or
holding more than one registered edge kind, is refused
(`ONTOLOGY_EQUIVALENCE_INVALID_CLASS`; see "Equivalence" above). Between two
node kinds, `equivalentTo` carries the same structural contract as
`subClassOf`, checked in **both** directions.

```typescript
function equivalentTo<A extends NodeType, B extends NodeType>(
  kindA: A,
  kindB: B & EquivalentToCheck<A, B>,
): TypedOntologyRelation<"equivalentTo", A, B>;
function equivalentTo<A extends NodeType | AnyEdgeType>(
  kindA: A,
  iri: string,
): TypedOntologyRelation<"equivalentTo", A, string>;
function equivalentTo<A extends AnyEdgeType, B extends NodeType>(
  kindA: A,
  kindB: B,
): TypedOntologyRelation<"equivalentTo", A, B>;
```

#### `disjointWith(a, b)`

Declares mutual exclusion (types cannot share the same ID).

```typescript
function disjointWith<A extends NodeType, B extends NodeType>(
  a: A,
  b: B,
): TypedOntologyRelation<"disjointWith", A, B>;
```

#### `partOf(part, whole, options)`

Declares a compositional relationship (part to whole), realized by the edge
kind named in `options.via`. `options.partSide` is required only when `via`'s
endpoints admit both orientations between `part` and `whole` (a same-kind
pair, or any pair the edge's declaration otherwise leaves ambiguous).

```typescript
type CompositionPartSide = "from" | "to";

type CompositionOptions = {
  via: EdgeType;
  partSide?: CompositionPartSide;
  /** Default `"optional"`. See `existence` above. */
  existence?: "optional" | "required";
};

function partOf<Part extends NodeType, Whole extends NodeType>(
  part: Part,
  whole: Whole,
  options: CompositionOptions,
): TypedOntologyRelation<"partOf", Part, Whole>;
```

#### `hasPart(whole, part, options)`

Declares a compositional relationship (whole to part) — the mirror of
`partOf`. Declaring both directions for the same pair is redundant; pick one.

```typescript
function hasPart<Whole extends NodeType, Part extends NodeType>(
  whole: Whole,
  part: Part,
  options: CompositionOptions,
): TypedOntologyRelation<"hasPart", Whole, Part>;
```

#### `relatedTo(a, b)`

Declares a symmetric association available through
`registry.getRelatedKinds(kind)`. It has no query behavior.

```typescript
function relatedTo<A extends NodeType, B extends NodeType>(
  a: A,
  b: B,
): TypedOntologyRelation<"relatedTo", A, B>;
```

#### `inverseOf(edgeA, edgeB)`

Declares edge types as inverses of each other.

```typescript
function inverseOf<A extends AnyEdgeType, B extends AnyEdgeType>(
  edgeA: A,
  edgeB: B,
): TypedOntologyRelation<"inverseOf", A, B>;
```

#### `implies(edgeA, edgeB)`

Declares that one edge type implies another exists.

```typescript
function implies<A extends AnyEdgeType, B extends AnyEdgeType>(
  edgeA: A,
  edgeB: B,
): TypedOntologyRelation<"implies", A, B>;
```

Each allowed pair in `edgeA` must be assignable to one allowed pair in `edgeB`
(equal, or a `subClassOf` descendant, on both endpoints). Throws
`ConfigurationError` when the graph is built into a store or committed as a
schema version if they aren't — see [Edge Relationships](#edge-relationships)
above.

### Type Registry API

The type registry is available via `store.registry` and provides methods to query the ontology at runtime.

#### `isSubClassOf(child, parent)`

Checks if a type is a subclass of another.

```typescript
registry.isSubClassOf(child: string, parent: string): boolean;

registry.isSubClassOf("Podcast", "Media"); // true
```

#### `expandSubClasses(type)`

Returns a type and all its subclasses.

```typescript
registry.expandSubClasses(type: string): readonly string[];

registry.expandSubClasses("Media"); // ["Media", "Podcast", "Article"]
```

#### `areDisjoint(a, b)`

Checks if two types are disjoint.

```typescript
registry.areDisjoint(a: string, b: string): boolean;

registry.areDisjoint("Person", "Organization"); // true
```

#### `getDisjointKinds(type)`

Returns all types disjoint with the given type.

```typescript
registry.getDisjointKinds(type: string): readonly string[];

registry.getDisjointKinds("Person"); // ["Organization", "Media", ...]
```

#### `expandNarrower(type)`

Returns all types narrower than the given type (via `broader` relationships).

```typescript
registry.expandNarrower(type: string): readonly string[];

registry.expandNarrower("Technology"); // ["AI", "ML", "DeepLearning", ...]
```

#### `expandBroader(type)`

Returns all types broader than the given type.

```typescript
registry.expandBroader(type: string): readonly string[];

registry.expandBroader("DeepLearning"); // ["MachineLearning", "AI", "Technology"]
```

#### `getInverseEdge(edgeType)`

Returns the inverse of an edge type.

```typescript
registry.getInverseEdge(edgeType: string): string | undefined;

registry.getInverseEdge("manages"); // "managedBy"
```

#### `getImpliedEdges(edgeType)`

Returns edges implied by an edge type.

```typescript
registry.getImpliedEdges(edgeType: string): readonly string[];

registry.getImpliedEdges("marriedTo"); // ["knows"]
```

#### `getImplyingEdges(edgeType)`

Returns edges that imply an edge type.

```typescript
registry.getImplyingEdges(edgeType: string): readonly string[];

registry.getImplyingEdges("knows"); // ["marriedTo", "bestFriends", "friends"]
```

#### `expandImplyingEdges(edgeType)`

Returns an edge type and all edges that imply it.

```typescript
registry.expandImplyingEdges(edgeType: string): readonly string[];

registry.expandImplyingEdges("knows"); // ["knows", "marriedTo", "bestFriends", "friends"]
```
