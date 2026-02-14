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
- **Edge implications**: "If Alice is married to Bob, she also knows Bob" (inferred relationships)
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
2. **Expands queries** automatically based on relationships
3. **Enforces constraints** when creating nodes and edges

## Core Meta-Edges

TypeGraph provides a standard set of meta-edges:

```typescript
import { subClassOf, broader, narrower, equivalentTo, sameAs, differentFrom, disjointWith, partOf, hasPart, relatedTo, inverseOf, implies } from "@nicia-ai/typegraph";
```

### Subsumption (Type Inheritance)

**`subClassOf`**: Defines type inheritance where instances of the child are also instances of the parent.

```typescript
subClassOf(Podcast, Media);
subClassOf(Article, Media);
subClassOf(Company, Organization);
```

**Query Behavior:**

Subclass expansion is **opt-in** via `includeSubClasses: true`:

```typescript
// Without expansion: returns only nodes with kind="Media"
const mediaOnly = await store
  .query()
  .from("Media", "m")
  .select((ctx) => ctx.m)
  .execute();

// With expansion: returns Media, Podcast, AND Article nodes
const allMedia = await store
  .query()
  .from("Media", "m", { includeSubClasses: true })
  .select((ctx) => ctx.m)
  .execute();
// Results include nodes of kind "Media", "Podcast", and "Article"
```

This is a fundamental difference from traditional ORM inheritance—TypeGraph stores the concrete type
(`kind: "Podcast"`) in the database, and expands at query time when requested.

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

### Equivalence

**`equivalentTo`**: Defines semantic equivalence between types or external IRIs.

```typescript
equivalentTo(Person, "https://schema.org/Person");
equivalentTo(Organization, "https://schema.org/Organization");
```

**`sameAs`**: Declares identity between individuals (for deduplication).

**`differentFrom`**: Explicitly asserts non-identity.

### Constraints

**`disjointWith`**: Declares that two types cannot share the same ID.

```typescript
disjointWith(Person, Organization);
disjointWith(Podcast, Article);
```

**Effect**: Attempting to create a node that violates disjointness throws `DisjointError`:

```typescript
// Create a Person with ID "entity-1"
await store.nodes.Person.create({ name: "Alice" }, { id: "entity-1" });

// Throws DisjointError: Person and Organization are disjoint
await store.nodes.Organization.create({ name: "Acme" }, { id: "entity-1" });
```

### Composition

**`partOf`** and **`hasPart`**: Define compositional relationships.

```typescript
partOf(Chapter, Book);
hasPart(Book, Chapter);
partOf(Episode, Podcast);
hasPart(Podcast, Episode);
```

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
inverseOf(sameAs, sameAs);
```

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
    partOf(Episode, Podcast),

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
```

## Custom Meta-Edges

Define domain-specific meta-edges:

```typescript
import { metaEdge } from "@nicia-ai/typegraph";

// Custom meta-edge for prerequisite relationships
const prerequisiteOf = metaEdge("prerequisiteOf", {
  transitive: true,
  inference: "hierarchy",
  description: "Learning prerequisite (Calculus prerequisiteOf LinearAlgebra)",
});

// Custom meta-edge for superseding relationships
const supersedes = metaEdge("supersedes", {
  transitive: true,
  inference: "substitution",
  description: "Replacement relationship (v2 supersedes v1)",
});
```

### Meta-Edge Properties

Each meta-edge can be configured with these properties to control how TypeGraph computes closures and expands queries:

| Property     | Type            | Description               |
| ------------ | --------------- | ------------------------- |
| `transitive` | `boolean`       | A→B, B→C implies A→C      |
| `symmetric`  | `boolean`       | A→B implies B→A           |
| `reflexive`  | `boolean`       | A→A is always true        |
| `inverse`    | `string`        | Name of inverse meta-edge |
| `inference`  | `InferenceType` | How this affects queries  |

### Inference Types

The `inference` property determines how the meta-edge affects query behavior:

| Type             | Description                                  |
| ---------------- | -------------------------------------------- |
| `"subsumption"`  | Query for X includes instances of subclasses |
| `"hierarchy"`    | Enables broader/narrower traversal           |
| `"substitution"` | Can substitute equivalent types              |
| `"constraint"`   | Validation rules                             |
| `"composition"`  | Part-whole navigation                        |
| `"association"`  | Discovery/recommendation                     |
| `"none"`         | No automatic inference                       |

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

- `subClassOf`: Instance identity (a Podcast **is** a Media)
- `broader`: Conceptual relation (ML **relates to** AI, but ML instance ≠ AI instance)

```typescript
// CORRECT: Type hierarchy
subClassOf(Podcast, Media);

// CORRECT: Concept hierarchy
broader(MachineLearning, ArtificialIntelligence);

// WRONG: Don't mix them
// subClassOf(MachineLearning, ArtificialIntelligence);
```

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

## API Reference

### Ontology Functions

#### `subClassOf(child, parent)`

Declares type inheritance.

```typescript
function subClassOf(child: NodeType, parent: NodeType): OntologyRelation;
```

#### `broader(narrower, broader)`

Declares hierarchical relationship (narrower concept to broader concept).

```typescript
function broader(narrower: NodeType, broader: NodeType): OntologyRelation;
```

#### `narrower(broader, narrower)`

Declares hierarchical relationship (broader concept to narrower concept).

```typescript
function narrower(broader: NodeType, narrower: NodeType): OntologyRelation;
```

#### `equivalentTo(a, b)`

Declares semantic equivalence between types or with external IRIs.

```typescript
function equivalentTo(
  a: NodeType | string,
  b: NodeType | string
): OntologyRelation;
```

#### `sameAs(a, b)`

Declares identity between individuals.

```typescript
function sameAs(a: NodeType, b: NodeType): OntologyRelation;
```

#### `differentFrom(a, b)`

Declares non-identity.

```typescript
function differentFrom(a: NodeType, b: NodeType): OntologyRelation;
```

#### `disjointWith(a, b)`

Declares mutual exclusion (types cannot share the same ID).

```typescript
function disjointWith(a: NodeType, b: NodeType): OntologyRelation;
```

#### `partOf(part, whole)`

Declares compositional relationship (part to whole).

```typescript
function partOf(part: NodeType, whole: NodeType): OntologyRelation;
```

#### `hasPart(whole, part)`

Declares compositional relationship (whole to part).

```typescript
function hasPart(whole: NodeType, part: NodeType): OntologyRelation;
```

#### `relatedTo(a, b)`

Declares association between types.

```typescript
function relatedTo(a: NodeType, b: NodeType): OntologyRelation;
```

#### `inverseOf(edgeA, edgeB)`

Declares edge types as inverses of each other.

```typescript
function inverseOf(edgeA: EdgeType, edgeB: EdgeType): OntologyRelation;
```

#### `implies(edgeA, edgeB)`

Declares that one edge type implies another exists.

```typescript
function implies(edgeA: EdgeType, edgeB: EdgeType): OntologyRelation;
```

#### `metaEdge(name, options?)`

Creates a custom meta-edge for domain-specific relationships.

```typescript
function metaEdge(
  name: string,
  options?: {
    transitive?: boolean;
    symmetric?: boolean;
    reflexive?: boolean;
    inverse?: string;
    inference?: InferenceType;
    description?: string;
  },
): MetaEdge;
```

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
