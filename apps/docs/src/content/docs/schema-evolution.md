---
title: Evolving Schemas in Production
description: Step-by-step guide for safely evolving your graph schema across deployments
---

Your graph schema will change as your application grows. This guide covers how
to make those changes safely — from adding a field to renaming a node type.

For API reference, see [Schema Migrations](/schema-management). For evolving
the kind set itself **at runtime** (agent-induced kinds, plugin-supplied
kinds, multi-tenant kind sets), see [Graph Extensions](/graph-extensions).

## How Schema Evolution Works

When you call `createStoreWithSchema()`, TypeGraph:

1. Serializes your current graph definition
2. Compares it against the stored schema (by hash, then by diff)
3. **Safe changes** — auto-migrates and bumps the version
4. **Breaking changes** — throws `MigrationError` (or returns `status: "breaking"`)

The key insight: TypeGraph manages **schema metadata**, not data migration. When
you add an optional field, TypeGraph records that the schema now includes it. It
does not alter existing rows — Zod defaults handle that at read time.

## Safe Changes

These changes are backwards compatible and auto-migrate without intervention:

- Adding new node types
- Adding new edge types
- Adding optional properties (with defaults)
- Adding `broader`, `narrower`, `partOf`, `hasPart`, or `relatedTo` ontology
  relations
- Removing `disjointWith` ontology relations
- Changing per-kind annotations (UI hints, audit policy, etc.)
- Changing graph-scoped annotations (display metadata, capabilities, etc.)

Adding `disjointWith`, `subClassOf`, or `equivalentTo` — and removing
`subClassOf` or `equivalentTo` — auto-migrate too, but only after a
data check. See
[Ontology tightenings are checked against your data](#ontology-tightenings-are-checked-against-your-data)
below.

### Adding an Optional Property

```typescript
// Version 1
const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
  }),
});

// Version 2 — safe, auto-migrates
const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string().optional(),
  }),
});
```

On startup, `createStoreWithSchema()` returns `status: "migrated"`. Existing
Person nodes return `email: undefined` — no data transformation needed.

### Adding a Node Type with Edges

```typescript
// Version 2 — add Company and worksAt in one deploy
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});

const graph = defineGraph({
  id: "my_app",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
  },
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [Company] },
  },
});
```

This is a single safe migration. New node and edge types don't affect existing
data.

### Changing Annotations

The `annotations` field on `defineNode` and `defineEdge` is part of the canonical
schema, so any change bumps the schema version. Changes are classified as
`safe` — no data migration needed, only the schema document is updated.

```typescript
// Version 1
const Incident = defineNode("Incident", {
  schema: z.object({ title: z.string() }),
  annotations: {
    ui: { titleField: "title", icon: "alert-triangle" },
  },
});

// Version 2 — swap the icon, add audit policy
const Incident = defineNode("Incident", {
  schema: z.object({ title: z.string() }),
  annotations: {
    ui: { titleField: "title", icon: "circle-alert" },
    audit: { pii: false, retentionDays: 365 },
  },
});
```

`getSchemaChanges()` reports each annotations-only change per kind:

```typescript
import { getSchemaChanges } from "@nicia-ai/typegraph/schema";

const diff = await getSchemaChanges(backend, graph);

for (const change of diff?.nodes ?? []) {
  if (change.details.includes("Annotations")) {
    console.log(`${change.kind}: annotations changed (${change.severity})`);
    // → "Incident: annotations changed (safe)"
  }
}
```

The hash is computed with stable sorted-key order at every depth, so
re-formatting the annotations object — or swapping sibling key order — does
not bump the version. Only structural or value changes do.

A few things worth knowing:

- Graphs that never set `annotations` produce identical canonical-form hashes
  to graphs from before this field existed. Adoption requires no migration.
- The canonical form omits empty / default annotations, so absent,
  explicit `undefined`, and explicit `{}` all hash identically — no migration
  is triggered just by writing `annotations: {}`.
- Annotations values must be JSON-serializable (`bigint`, `function`, `Date`,
  and other class instances are rejected at definition time).

See the [schemas-stores reference](/schemas-stores#per-kind-annotations) for the
full annotations contract.

### Rolling out graph-scoped annotations

Graph-scoped annotations use a top-level `SerializedSchema` field. During a
mixed-version rollout, an older schema writer can otherwise recommit a document
without a field it does not understand. Use this two-step deployment invariant:

1. Upgrade **every process that can write schema versions** to TypeGraph 0.54 or
   newer, without adding graph annotations yet.
2. After no older schema writer remains, enable `defineGraph({ annotations })`
   or `defineGraphExtension({ annotations })` and commit the safe schema change.

Readers may be upgraded independently, but the writer floor must be complete
before annotations are enabled. TypeGraph 0.54+ preserves unknown top-level
schema fields across parse-and-recommit cycles, so later additive metadata
slices follow the same rollout rule.

## Ontology tightenings are checked against your data

Some ontology changes can invalidate rows that already exist. TypeGraph
classifies these by what they do to your data, not just to the schema
document, and runs a data check inside the schema-commit transaction before
publishing the new version:

| Meta-edge                                    | Added                                             | Removed                                           |
| --------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| `disjointWith`                                | Warning — checked against live nodes               | Safe                                                |
| `subClassOf`, `equivalentTo`                  | Warning — checked against live nodes               | Warning — checked against live edges               |
| `inverseOf`, `implies`                        | Breaking                                            | Breaking                                            |
| `broader`, `narrower`, `partOf`, `hasPart`, `relatedTo` | Safe | Safe |

`sameAs` and `differentFrom` no longer have a public factory to author them
with (see
[Upgrading past the removed `sameAs`/`differentFrom`/`metaEdge()` APIs](#upgrading-past-the-removed-sameasdifferentfrommetaedge-apis)
below), but a document persisted before the removal can still name one: the
classifier treats a `sameAs` relation exactly like `equivalentTo` above, and
a `differentFrom` relation exactly like the always-safe row.

- **Adding `disjointWith`** is checked against every live node: if two nodes
  already share an id under kinds the new relation makes mutually exclusive
  (directly, or via `subClassOf` propagation), the commit refuses.
- **Adding `subClassOf` or `equivalentTo`** is checked two ways: it
  can propagate an existing `disjointWith` down to a kind that was not
  disjoint before (same check as above), and it can merge two previously
  independent `kindWithSubClasses` uniqueness components — if both already
  hold a live row under the same key, the commit refuses.
- **Removing `subClassOf` or `equivalentTo`** can shrink an edge
  kind's admitted endpoint pairs. If a live edge's endpoints rely on the
  subsumption the relation provided, the commit refuses.
- **Removing `disjointWith`** never invalidates anything — loosening a
  constraint cannot make an existing row wrong — so it stays safe and
  auto-migrates unconditionally.
- **Adding or removing `inverseOf` or `implies`** changes what a default
  `expand: "inverse"` / `expand: "implying"` traversal returns for existing
  edges — a read-semantics change, not a data-validity one — so it is
  `breaking` and requires an explicit `migrateSchema()`, the same treatment
  the Operational Identity `sameIdAcrossKinds` flip gets.
- A relation whose `from` or `to` names a kind **this same commit removes**
  is always safe with no check — `Store.removeKinds()` is unaffected.

A refused tightening throws `MigrationError`:

```typescript
try {
  await createStoreWithSchema(graph, backend);
} catch (error) {
  if (error instanceof MigrationError && error.details.reason === "ontology-tightening-violated") {
    console.log(error.details.violations);
    // → the exact rows blocking the migration, in the shape
    //   store.verifyConstraintFences() returns
  }
}
```

Resolve the offending rows (delete them, change their kind, or narrow the
ontology change), then retry. `store.verifyConstraintFences()` lists the same
rows on demand at any time — run it against a live store to find conflicts
before attempting a migration.

**Residual window.** The check runs inside the commit transaction but takes no
additional lock: under the previous schema the tightening's kinds are not yet
disjoint (or their uniqueness components have not yet merged, or the edge
kind's endpoints have not yet shrunk), so there is no claim for a lock to
fence. A writer that commits under the previous schema version between the
check and the version compare-and-swap is invisible to it — the same residual
window the existing empty-kind removal fence carries.
`store.verifyConstraintFences()` remains the post-hoc detector for exactly
that window.

## Edge cardinality tightenings are checked against your data

Making an edge's `cardinality` or `targetCardinality` more restrictive — for
example widening `many` to `one`, or adding `targetCardinality: "one"` to an
edge that previously had none — runs the same kind of data check as an
ontology tightening, inside the same schema-commit transaction, using the
same fold every cardinality-aware layer shares
(`edgeCardinalityAxisReferences`, see
[Target cardinality](/core-concepts#target-cardinality)). Each axis this
commit newly constrains — source or target, independently — is probed
against the live population before the version is published:

- **Source-side tightening** (`cardinality` narrowing) counts live edges per
  source; a source already exceeding the new bound refuses the commit.
- **Target-side tightening** (`targetCardinality` narrowing) counts live
  edges per target instead, using the same probe shape with the endpoint
  swapped — a target already exceeding the new bound refuses the commit.
- An edge kind that tightens **both axes in the same commit** is checked
  independently for each; either violation refuses the whole commit, and the
  thrown error reports every newly-constrained axis, not just the first one
  found.
- A commit that declares a constrained `cardinality` or `targetCardinality`
  on a **brand-new edge kind** owes this exact same check: a stored schema
  with no entry for the kind reads as `many` on both axes, so any constrained
  value the new kind declares differs from that default and is probed like
  any other tightening. This is intentional — an edge kind can be re-added
  after removal, with live rows already under it — but it means a purely
  additive schema change (adding a kind) can still require the atomic
  preflight primitive described below.

Like an ontology tightening, this check needs the backend's atomic
preflight-commit primitive (`commitSchemaVersionWithPreflight`); a backend
that implements only `commitSchemaVersion` throws `ConfigurationError` code
`EDGE_CARDINALITY_TIGHTENING_REQUIRES_ATOMIC_BACKEND` — see
[Schema-tightening and constraint-fence audit guard codes](/errors#schema-tightening-and-constraint-fence-audit-guard-codes).

A refused tightening throws `MigrationError` with
`details.reason === "edge-cardinality-tightening-violated"`:

```typescript
try {
  await createStoreWithSchema(graph, backend);
} catch (error) {
  if (
    error instanceof MigrationError &&
    error.details.reason === "edge-cardinality-tightening-violated"
  ) {
    console.log(error.details.axes); // → the newly-constrained axes
    console.log(error.details.violations); // → the offending rows
  }
}
```

Resolve the offending rows (delete the excess edges, or loosen the target
schema change), then retry. This check has the same residual window as the
ontology tightening check above: it takes no additional lock, so a writer
committing under the previous schema version between the probe and the
version compare-and-swap is invisible to it.

## Structural subsumption is checked before you upgrade

Separately from the data check above, a `subClassOf`/`equivalentTo`
hierarchy is checked for a **schema-shape** violation — the child's schema
no longer structurally extends the parent's — and this check happens before
the data check, before any commit: `getSchemaChanges(backend, graph)` throws
a `ConfigurationError` naming the child, the parent, and the offending
property path if the graph you're about to commit would introduce one. This
runs even when a migration only edits a node kind's **property** schema and
touches no relation at all — a property change on a kind already party to an
existing hierarchy can break it just as surely as a relation change can.

**`requiresMigration` does not surface this refusal.** By design, it
collapses any `ConfigurationError` from `getSchemaChanges` — this one
included — to `true` rather than propagating it, so it can serve as a
least-privilege routing check that never throws for a document it cannot
interpret. Call `getSchemaChanges` directly (as below) to see the refusal
and its details; `requiresMigration` only tells you a migration is needed,
never why.

```typescript
try {
  await getSchemaChanges(backend, graph);
} catch (error) {
  if (error instanceof ConfigurationError) {
    console.log(error.details.code); // e.g. ONTOLOGY_SUBCLASS_NOT_STRUCTURAL_SUBTYPE
    console.log(error.details.childKind, error.details.parentKind);
  }
}
```

No data migration is required for this class of refusal — it's a
schema-authoring fix (loosen the parent, tighten the child, or replace
`subClassOf` with `broader` if the relation was really a taxonomy). Only the
**AFTER** side of a diff is enforced this way; the BEFORE (stored) side is a
delta input the diff never writes through, so an already-incoherent
persisted document can still be repaired by a fix-forward migration that
removes the offending relation.

## Upgrading past the removed `sameAs`/`differentFrom`/`metaEdge()` APIs

Three ontology APIs were removed: the custom `metaEdge()` factory (and its
`MetaEdgeOptions`), the public `InferenceType` union and the
`transitive`/`symmetric`/`reflexive`/`inverse`/`inference` members of
`MetaEdgeProperties`, and the deprecated `sameAs`/`differentFrom` factories.
None of them ever drove runtime behavior beyond serialized introspection —
see [Type-Level Annotations](/ontology#type-level-annotations) and the
[Verified Support Matrix](/ontology#verified-support-matrix). Nothing about
opening an EXISTING store changes: a schema document written before this
release keeps loading, unmodified, with no action required.

**If your code calls `metaEdge()`.** Delete the declaration. Move any
free-form metadata you attached (a custom `description`, or the
`transitive`/`inference`/etc. properties you set) into `annotations` on
`defineGraph()` instead, and update whatever application code walked
`store.introspect().ontology` for that meta-edge's relations to instead walk
the annotated data — see
[Type-Level Annotations](/ontology#type-level-annotations) for a worked
example.

**If your code calls `sameAs(A, B)`.** Replace it with `equivalentTo(A, B)`
— behaviorally identical in every release `sameAs` ever shipped in (the
registry always folded `sameAs` into the same equivalence closure as
`equivalentTo`; that fold is exactly how a persisted `sameAs` relation keeps
being interpreted below).

**If your code calls `differentFrom(A, B)`.** Delete the call. It was
decorative — the registry never enforced it — so removing it changes
nothing your application could observe. For actual cross-kind instance
identity, enable the graph-level TypeGraph Identity Profile
(`identity: { sameIdAcrossKinds: "fold" }`) and use `store.identity`.

**A store opened against a persisted document that still has one of
these keeps loading**, and reading `store.introspect()` on it still works:

- A `metaEdges` catalog entry that still carries `transitive`/`symmetric`/
  `reflexive`/`inverse`/`inference` parses — those fields are simply never
  read. The serializer no longer emits them, but only the next commit that
  detects an actual semantic change rewrites the document — an upgrade with
  no accompanying ontology change leaves the old document, extra fields and
  all, in place, and pays the slower parse-and-diff path on every boot
  instead of the schema-hash fast path (`ensureSchema`,
  `src/schema/manager.ts`) until a real change lands.
- A relation naming `sameAs` keeps folding into the equivalence closure
  exactly like `equivalentTo` — `registry.areEquivalent(A, B)`,
  `isAssignableTo`, and every other equivalence-driven check are unaffected.
- A relation naming `differentFrom` keeps being inert, as it always was.

**This is a one-way door for rolling deploys and rollback.** The narrowed
`SerializedMetaEdge` shape only appears once a document gets rewritten (see
above), but from that point on it cannot be read by a `@nicia-ai/typegraph`
release older than this one — the pre-change `serializedSchemaZod` required
`transitive`/`symmetric`/`reflexive`/`inference` on every `metaEdges` entry,
so an older reader's `parseSerializedSchema` throws on the new shape instead
of degrading. In a mixed-version fleet, upgrade every application instance
sharing a database to this release or later before any of them commits a
schema change, and do not roll back to an older release once one has.

**Once your code moves a `sameAs(A, B)` to `equivalentTo(A, B)`, or deletes a
`differentFrom(A, B)`, the next commit auto-migrates.** Both are classified
by the same relation-level severity table as any other ontology change (see
[Ontology tightenings are checked against your data](#ontology-tightenings-are-checked-against-your-data)
above): migrating `sameAs` to `equivalentTo` is a relation removed
(`warning`, checked against live edges) plus a relation added (`warning`,
checked against live nodes) — never `breaking` — and dropping
`differentFrom` is a relation removed (`safe`). Neither requires an explicit
`migrateSchema()`.

## Breaking Changes

These require explicit handling:

- Removing node or edge types
- Removing properties
- Adding required properties (no default)
- Renaming types or properties
- Adding or removing an `inverseOf` or `implies` ontology relation

TypeGraph will throw `MigrationError` by default. You have two options: fix
the schema to be backwards compatible, or use the expand-contract pattern.

## The Expand-Contract Pattern

For breaking changes, use a multi-deploy strategy. This is the same pattern
used in relational database migrations — deploy in phases so there's never a
moment where running code is incompatible with the schema.

### Renaming a Property

Rename `name` to `fullName` on Person in three deploys:

#### Deploy 1 — Expand: add the new property

```typescript
const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    fullName: z.string().optional(), // New property, optional for now
  }),
});
```

Safe migration. Then backfill existing data:

```typescript
const [store] = await createStoreWithSchema(graph, backend);

const people = await store.query(Person).execute();
for (const person of people) {
  if (!person.properties.fullName) {
    await store.nodes.Person.update(person.id, {
      fullName: person.properties.name,
    });
  }
}
```

#### Deploy 2 — Switch: use the new property everywhere

Update all application code to read/write `fullName` instead of `name`. Both
properties still exist, so this deploy is safe.

#### Deploy 3 — Contract: remove the old property

```typescript
const Person = defineNode("Person", {
  schema: z.object({
    fullName: z.string(),
  }),
});
```

This is a breaking change (removing `name`). Use `migrateSchema()` to force it:

```typescript
import { getSchemaChanges, migrateSchema } from "@nicia-ai/typegraph/schema";

const [store, result] = await createStoreWithSchema(graph, backend, {
  throwOnBreaking: false,
});

if (result.status === "breaking") {
  // We've already backfilled — safe to force migrate
  const activeSchema = await backend.getActiveSchema(graph.id);
  await migrateSchema(backend, graph, activeSchema!.version);
}
```

Two things `migrateSchema()` will not let you do by accident:

- **Drop a kind that still holds rows.** The commit is refused with a
  `MigrationError` whose `details.reason` is `"kind-removal"`. Committing
  would make those rows unreachable, and the next `materializeRemovals()`
  would delete them — it re-derives removals by walking schema history, so
  the drop is not reversible by putting the kind back. Export or delete the
  rows first (see [Removing a Node Type](#removing-a-node-type)), or pass
  `{ discardDroppedKindRows: true }` if losing them is the intent. Dropping
  an *empty* kind needs no flag.
- **Erase kinds added at runtime.** `migrateSchema()` folds the persisted
  graph extension into the graph you hand it, the same way
  `createStoreWithSchema()` does, so passing your compile-time graph never
  drops a kind that `evolve()` committed. To remove one of those
  deliberately, use `removeKinds()` — it queues the cleanup rows that make
  the removal reconcilable.

### Removing a Node Type

#### Deploy 1 — Stop creating new instances

Update application code to stop creating the deprecated node type. Existing data
remains.

#### Deploy 2 — Clean up references

Delete edges that reference the deprecated node type, then delete the nodes
themselves:

```typescript
// Delete all edges connected to deprecated nodes
const deprecated = await store.query(OldNode).execute();
for (const node of deprecated) {
  await store.nodes.OldNode.delete(node.id);
}
```

#### Deploy 3 — Remove from schema

Remove the node type from `defineGraph()` and force migrate. Deploy 2 is what
makes this step legal: `migrateSchema()` refuses to drop a kind that still
holds rows, so if any remain you will get a `MigrationError` with
`details.reason === "kind-removal"` naming the kind and its row count rather
than silent data loss.

### Changing a Property Type

Change `age` from `z.string()` to `z.number()`:

#### Deploy 1 — Add the new property

```typescript
const Person = defineNode("Person", {
  schema: z.object({
    age: z.string(),
    ageNumeric: z.number().optional(),
  }),
});
```

#### Deploy 2 — Backfill and switch

```typescript
const people = await store.query(Person).execute();
for (const person of people) {
  if (person.properties.ageNumeric === undefined) {
    await store.nodes.Person.update(person.id, {
      ageNumeric: parseInt(person.properties.age, 10),
    });
  }
}
```

#### Deploy 3 — Contract

Remove `age`, rename `ageNumeric` to `age` with the new type, and force migrate.

### Changing an Embedding Dimension

Switching embedding models usually changes the vector dimension (e.g.
`embedding(1536)` → `embedding(3072)`). The stored vectors are invalid under the
new dimension — they must be recomputed, not converted — so this is handled
out-of-band from the schema diff. Update the field's `embedding(N)` in the
schema, then call `store.reembedVectorField()`. It drops and recreates the
field's per-`(graphId, kind, field)` `tg_vec_*` storage at the new dimension and,
when you pass an `embed` callback, pages the kind's nodes and re-embeds them:

```typescript
const result = await store.reembedVectorField("Document", "embedding", {
  embed: async (nodes) => {
    const texts = nodes.map((node) => node.content); // schema fields are top-level
    const vectors = await batchEmbed(texts); // your new model
    return new Map(nodes.map((node, index) => [node.id, vectors[index]]));
  },
});
// result.recreated === true, result.reembedded === <count of re-embedded nodes>
```

Without an `embed` callback, the storage is recreated empty and you re-embed via
normal `update()` writes. Until a field is re-embedded at the new dimension, a
stray write at the **old** dimension throws `EmbeddingDimensionChangedError`.

## Pre-Deploy Schema Checks

Use `getSchemaChanges()` in CI to catch breaking changes before they reach
production.

### CI/CD Script

```typescript
import { getSchemaChanges } from "@nicia-ai/typegraph/schema";

async function checkSchema(backend: GraphBackend, graph: GraphDef) {
  const diff = await getSchemaChanges(backend, graph);

  if (!diff) {
    console.log("No existing schema — first deploy");
    return;
  }

  if (!diff.hasChanges) {
    console.log("Schema unchanged");
    return;
  }

  console.log("Schema changes detected:");
  console.log(diff.summary);

  for (const change of [...diff.nodes, ...diff.edges]) {
    const icon =
      change.severity === "safe"
        ? "[safe]"
        : change.severity === "warning"
          ? "[warn]"
          : "[BREAKING]";
    console.log(`  ${icon} ${change.details}`);
  }

  if (diff.hasBreakingChanges) {
    console.error("Breaking changes require migration before deploy.");
    process.exit(1);
  }
}
```

### Staging Validation

Before deploying to production, run against a staging database that mirrors
production schema state:

```typescript
const [store, result] = await createStoreWithSchema(graph, stagingBackend);

switch (result.status) {
  case "initialized":
    console.log("Staging DB was empty — initialized");
    break;
  case "migrated":
    console.log(
      `Auto-migrated v${result.fromVersion} → v${result.toVersion}`,
    );
    console.log("Changes:", result.diff.summary);
    break;
  case "breaking":
    console.error("Would break in production. Fix before deploying.");
    process.exit(1);
    break;
}
```

## Testing Schema Changes

### Unit Testing Migrations

Test that your migration code handles existing data correctly:

```typescript
import { createStoreWithSchema, defineGraph, defineNode } from "@nicia-ai/typegraph";
import { createTestBackend } from "./test-utils";

it("migrates name to fullName", async () => {
  const backend = createTestBackend();

  // Set up v1 with data
  const graphV1 = defineGraph({
    id: "test",
    nodes: { Person: { type: PersonV1 } },
    edges: {},
  });
  const [storeV1] = await createStoreWithSchema(graphV1, backend);
  await storeV1.nodes.Person.create({ name: "Alice" });

  // Migrate to v2 (expand phase)
  const graphV2 = defineGraph({
    id: "test",
    nodes: { Person: { type: PersonV2WithBothFields } },
    edges: {},
  });
  const [storeV2, result] = await createStoreWithSchema(graphV2, backend);
  expect(result.status).toBe("migrated");

  // Run backfill
  const people = await storeV2.query(PersonV2WithBothFields).execute();
  for (const person of people) {
    await storeV2.nodes.Person.update(person.id, {
      fullName: person.properties.name,
    });
  }

  // Verify
  const updated = await storeV2.query(PersonV2WithBothFields).execute();
  expect(updated[0].properties.fullName).toBe("Alice");
});
```

### Previewing Changes Without Applying

Use `getSchemaChanges()` to see what would change without modifying the database:

```typescript
import { getSchemaChanges } from "@nicia-ai/typegraph/schema";

const diff = await getSchemaChanges(backend, newGraph);
if (diff?.hasChanges) {
  console.log("Pending changes:", diff.summary);
  console.log("Breaking:", diff.hasBreakingChanges);

  for (const change of diff.nodes) {
    console.log(`  ${change.severity}: ${change.details}`);
  }
}
```

## Version History

TypeGraph preserves all schema versions in the `typegraph_schema_versions`
table. Only one version is active at a time.

```text
typegraph_schema_versions
├── version 1 (initial)           ← inactive
├── version 2 (added email)       ← inactive
├── version 3 (added Company)     ← active
```

Access version history through the backend:

```typescript
// Get a specific version
const v1 = await backend.getSchemaVersion("my_app", 1);
console.log("V1 created at:", v1?.created_at);

// Get the active version
const active = await backend.getActiveSchema("my_app");
console.log("Current version:", active?.version);
```

## Summary: Change Classification

| Change                         | Classification | Auto-Migrated? |
| ------------------------------ | -------------- | -------------- |
| Add node type                  | Safe           | Yes            |
| Add edge type                  | Safe           | Yes            |
| Add optional property          | Safe           | Yes            |
| Add `broader`/`narrower`/`partOf`/`hasPart`/`relatedTo` | Safe | Yes |
| Add `disjointWith`, `subClassOf`, `equivalentTo` | Warning (data-checked) | Yes, if the check passes |
| Remove `subClassOf`, `equivalentTo` | Warning (data-checked) | Yes, if the check passes |
| Remove `disjointWith`          | Safe           | Yes            |
| Add/remove `inverseOf`, `implies` | Breaking    | No             |
| Change kind annotations           | Safe           | Yes            |
| Add required property          | Breaking       | No             |
| Remove property                | Breaking       | No             |
| Remove node/edge type          | Breaking       | No             |
| Rename node/edge type          | Breaking       | No             |
| Change property type           | Breaking       | No             |
| Change onDelete behavior       | Warning        | Yes            |
| Change unique constraints      | Warning        | Yes            |
| Change edge cardinality (source-side, `cardinality`) | Warning (data-checked if tightened) | Yes, if the check passes |
| Change edge target cardinality (`targetCardinality`) | Warning (data-checked if tightened) | Yes, if the check passes |
| Change edge endpoint kinds     | Warning        | Yes            |
| Remove allowed source-dependent endpoint pairs | Breaking | No |

## Rollback

If a deployment goes wrong, you can switch back to a previous schema version.
Version history is always preserved — `rollbackSchema()` simply changes which
version is active.

```typescript
import { rollbackSchema } from "@nicia-ai/typegraph/schema";

// Roll back to version 2
await rollbackSchema(backend, "my_app", 2);
```

This does not delete newer versions. You can migrate forward again later.

## Migration Hooks

Use `onBeforeMigrate` and `onAfterMigrate` for observability — logging,
metrics, and alerts during schema migrations:

```typescript
const [store, result] = await createStoreWithSchema(graph, backend, {
  onBeforeMigrate: (context) => {
    console.log(`Migrating ${context.graphId} v${context.fromVersion} → v${context.toVersion}`);
    console.log("Changes:", context.diff.summary);
  },
  onAfterMigrate: (context) => {
    console.log(`Migration complete: v${context.toVersion}`);
    metrics.increment("schema_migrations_total");
  },
});
```

For data transformations (backfill scripts), run them explicitly after store
creation rather than inside hooks. This gives you control over retries and
error handling:

```typescript
const [store, result] = await createStoreWithSchema(graph, backend);

if (result.status === "migrated" && result.toVersion === 3) {
  // Backfill fullName from name for the expand phase
  const people = await store.query(Person).execute();
  for (const person of people) {
    if (!person.properties.fullName) {
      await store.nodes.Person.update(person.id, {
        fullName: person.properties.name,
      });
    }
  }
}
```

## Reclaiming Removed Embedding Storage

Embeddings live in per-`(graphId, kind, field)` tables (`tg_vec_*`), provisioned
by the privileged migrator (`createStoreWithSchema`, or `evolve()` for a
runtime-added field). When you remove an `embedding()` field from a **surviving**
kind, the schema change commits fast but the field's now-orphaned vector table
remains until you reconcile it. `store.materializeRemovals()` drops it — and
clears its durable contribution marker so a later re-add re-provisions cleanly
(this is the same pass that cleans up storage for fully removed kinds):

```typescript
const result = await store.materializeRemovals();

for (const reclaimed of result.reclaimedVectorFields) {
  // → { kind: "Document", fieldPath: "embedding", status: "reclaimed" }
  console.log(`Dropped vector table for ${reclaimed.kind}.${reclaimed.fieldPath}`);
}
```

The pass is idempotent and derived from immutable schema history, so re-running
it lists the same removed fields and the underlying `DROP ... IF EXISTS` is a
no-op on subsequent calls.

## Current Limitations

- **No automatic data transformation.** TypeGraph tracks schema metadata
  changes but does not transform existing rows. Use backfill scripts (or
  `onAfterMigrate` hooks) for data migration.
- **No rename detection.** Renaming a property looks like a removal + addition.
  Use the expand-contract pattern instead.
- **Schema-level only.** Migrations operate on the graph definition, not on
  underlying database tables. TypeGraph's storage tables are
  schema-agnostic (nodes and edges are stored as JSON properties), so
  "schema migration" means updating the schema document that TypeGraph
  tracks, not running `ALTER TABLE`.
