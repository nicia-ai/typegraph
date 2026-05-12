---
title: Agent-Driven Schema
description: Runtime schema evolution end-to-end — an agent proposes new kinds and edges, the validator gates them, store.evolve commits, the live graph absorbs them with no restart and no codegen.
---

A runnable end-to-end demonstration of [graph extensions](/graph-extensions) —
the 0.25.0 feature that lets you grow the schema **at runtime** when something
new shows up in the world. An agent (LLM, scraper, ETL pipeline) proposes new
node and edge kinds from observed data, the validator gates the proposal, and
`store.evolve()` commits the new schema as a durable version. The live graph
starts ingesting under the new schema in the same process, with full Zod
validation, fulltext indexing, unique constraints, and cross-kind edge
enforcement — no restart, no codegen, no `any` cast on the read side.

:::tip[Just want the code?]
Full source on GitHub: [`packages/typegraph/examples/16-graph-extensions.ts`](https://github.com/nicia-ai/typegraph/blob/main/packages/typegraph/examples/16-graph-extensions.ts)
:::

:::note[Want to see this against real data with a real LLM?]
A separate demo repo runs the same loop against public-record clinical
research data with an open-weight LLM proposing schema after each stage of
the corpus arrives:
[`pdlug/typegraph-clinical-demo`](https://github.com/pdlug/typegraph-clinical-demo).
:::

## The shape of the loop

Runtime schema evolution is one verb (`store.evolve`) sitting between two
deliberate sources of friction:

1. **The validator.** Every proposal — even one built in TypeScript by your
   own code — flows through `validateGraphExtension`, which returns
   structured `{path, code, message}` issues. Typos, unknown property
   refinements, malformed edge endpoints all come back as routable errors
   instead of throwing deep in `evolve`.
2. **The incompatibility classifier.** Once data exists, `evolve` rejects
   any change that would corrupt it — narrowing a type, removing a
   required field on a populated kind, dropping an edge with live rows.
   A misbehaving agent can't silently break the graph.

You provide the third moving part — the operator gate. Nothing in TypeGraph
auto-applies what an agent proposes. Your code decides whether to call
`evolve` on a validated proposal; the library makes sure the call is safe
when you do.

## What you get

The example walks through nine steps against a fresh SQLite database,
starting with a single compile-time kind (`Document`) and ending with three
kinds the agent invented at runtime. Sample output:

```text
[1] Booted with compile-time kind: Document
    Active schema version: 1
    Materialized 1 compile-time index

[2] Agent proposal validated:
    nodes: Paper, Author
    edges: authoredBy

[3] evolve() committed and materialized
    Active schema version: 2
    registry.hasNodeType('Paper'): true
    registry.hasEdgeType('authoredBy'): true

[4] Ingested 2 Paper, 2 Author, 2 authoredBy edges
    fulltext("Paper", "transformer architecture") -> 1 hit(s)
      score=0.61  title="Attention is all you need"
    Duplicate doi rejected: true

[5] Dynamic multi-hop traversal Paper -> Author:
    Language models are unsupervised multitask learners (#1) by Alec Radford

[6] Incompatible re-proposal rejected:
    Paper.year: TYPE_CHANGE (number -> string)

[7] Deprecated kinds: [Document]

[8] removeKinds(['Author']) — cascading edge cleanup
    registry.hasNodeType('Author'): false
    registry.hasEdgeType('authoredBy'): false
    Active schema version: 5

[9] Restart parity:
    validation.status: VALID
    registry.hasNodeType('Paper'): true
    registry.hasNodeType('Author') (removed in step 7): false
    deprecatedKinds: [Document]
    Found 2 Paper nodes after restart
```

The interesting moments are step 4 (fulltext + unique-constraint
enforcement against a runtime kind), step 6 (the incompatibility gate),
and step 9 (everything survives a fresh `createStoreWithSchema` against
the same database — kinds, deprecation flags, indexes).

## The boot graph

Start with one compile-time kind so the live graph has structure before
the agent shows up. Everything compile-time stays type-safe end-to-end
even as extension kinds accumulate around it:

```typescript
const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    body: z.string(),
  }),
});

const documentTitle = defineNodeIndex(Document, { fields: ["title"] });

const baseGraph = defineGraph({
  id: "research_corpus",
  nodes: { Document: { type: Document } },
  edges: {},
  indexes: [documentTitle],
});

const { backend } = createLocalSqliteBackend();
const [store] = await createStoreWithSchema(baseGraph, backend);
```

## Scene by scene

### 1. The agent returns a JSON proposal

What an LLM or scraper actually hands back is a JSON document, not a typed
value. `validateGraphExtension(unknown, { strict })` is the Result-style
entry point: it walks the document, collects every structural issue, and
returns a typed `GraphExtension` on success. Strict mode rejects unknown
sibling keys so a field typo (`node` instead of `nodes`) fails loudly
instead of silently producing an empty extension.

```typescript
const agentJson: unknown = JSON.parse(`{
  "nodes": {
    "Paper": {
      "description": "Academic paper inferred from the corpus",
      "properties": {
        "title": { "type": "string", "minLength": 1, "searchable": {} },
        "abstract": { "type": "string", "searchable": {}, "optional": true },
        "doi": { "type": "string", "minLength": 1 },
        "year": { "type": "number", "int": true, "min": 1900, "max": 2100 }
      },
      "unique": [{ "name": "paper_doi_unique", "fields": ["doi"] }]
    },
    "Author": {
      "properties": {
        "name": { "type": "string", "minLength": 1, "searchable": {} },
        "affiliation": { "type": "string", "optional": true }
      }
    }
  },
  "edges": {
    "authoredBy": {
      "from": ["Paper"], "to": ["Author"],
      "properties": { "order": { "type": "number", "int": true, "min": 1 } }
    }
  },
  "indexes": [
    { "entity": "node", "kind": "Paper",
      "name": "paper_by_year", "fields": ["year"] }
  ]
}`);

const result = validateGraphExtension(agentJson, { strict: true });
if (!result.success) {
  // result.error.issues is a structured list — route it back to the agent.
  throw result.error;
}
const extension: GraphExtension = result.data;
```

Each issue carries a stable `code` (`UNKNOWN_DOCUMENT_KEY`,
`INVALID_PROPERTY_REFINEMENT`, `MISSING_REQUIRED_FIELD`, …) — useful both
for routing failures back to the model in a repair loop and for treating
validation outcomes as data instead of exceptions.

### 2. Commit + materialize atomically

`evolve` runs the incompatibility check, commits a new schema version, and
returns a new `Store` carrying the merged registry. `eager: {}` turns it
into a one-call "schema committed AND indexes materialized" verb so the
returned store is ready to ingest by the time the promise resolves:

```typescript
const evolved = await store.evolve(extension, { eager: {} });
```

### 3. Ingest under the new schema

Extension kinds get the same CRUD surface as compile-time kinds — there's no
separate dynamic API to learn. The difference is at the type system: extension
kinds aren't visible at compile time, so the collection's type is the generic
`NodeCollection` rather than a kind-specific one. Property validation, unique
constraints, fulltext indexing, and edge endpoint enforcement all run live:

```typescript
const papers = evolved.getNodeCollectionOrThrow("Paper");
const authors = evolved.getNodeCollectionOrThrow("Author");
const authoredBy = evolved.getEdgeCollectionOrThrow("authoredBy");

const attention = await papers.create({
  title: "Attention is all you need",
  abstract: "We propose a new simple network architecture, the Transformer.",
  doi: "10.5555/3295222.3295349",
  year: 2017,
});
await authoredBy.create(attention, vaswani, { order: 1 });

// The `searchable: {}` brand on Paper.title flows through to the
// backend's fulltext index — same BM25 retrieval extension kinds get
// at compile time.
const hits = await evolved.search.fulltext("Paper", {
  query: "transformer architecture",
  limit: 3,
});

// Unique-constraint enforcement is live for extension kinds too.
const duplicate = await papers.create({
  title: "Duplicate doi",
  doi: "10.5555/3295222.3295349", // same doi as `attention` above
  year: 2024,
}).catch((err) => err);
// → UniqueConstraintError
```

### 4. Multi-hop traversals over runtime kinds

The typed query builder methods (`from`, `traverse`, `to`) require
compile-time kind literals so they can give you full intellisense. For
runtime kinds, use the `*Dynamic` siblings — they accept arbitrary strings,
validate them against the registry (typo → `KindNotFoundError`), and surface
a `.field("name").number().gte(...)` predicate API so an MCP server can
traverse a runtime graph without an `as any`:

```typescript
const rows = await evolved
  .query()
  .fromDynamic("Paper", "p")
  .traverseDynamic("authoredBy", "a")
  .toDynamic("Author", "u")
  .whereNode("p", (p) => p.field("year").number().gte(2018))
  .select((ctx) => ({
    paperTitle: ctx.p.title,
    authorName: ctx.u.name,
    order: ctx.a.order,
  }))
  .execute();
```

Dynamic and typed methods mix freely — `from("Document", ...)` chained to
`traverseDynamic("authoredBy", ...)` is well-formed.

### 5. The incompatibility gate

The agent (or any caller) eventually proposes something that would corrupt
existing data. Against an empty kind some changes are allowed; against a
populated one, the classifier rejects them:

```typescript
const breakingProposal: GraphExtension = {
  ...extension,
  nodes: {
    ...extension.nodes,
    Paper: {
      ...extension.nodes!.Paper!,
      properties: {
        ...extension.nodes!.Paper!.properties,
        year: { type: "string" }, // was number — TYPE_CHANGE
      },
    },
  },
};

const rejection = await evolved
  .evolve(breakingProposal)
  .catch((err) => err);

if (rejection instanceof IncompatibleChangeError) {
  for (const change of rejection.changes) {
    console.log(`${change.kind}.${change.field}: ${change.type}`);
  }
  // → Paper.year: TYPE_CHANGE
}
```

This is the "data corruption" backstop. A misbehaving agent in a tight loop
cannot evolve the schema into a shape that breaks existing rows.

### 6. Deprecate and remove

Deprecation is a **signal**, not a gate. It surfaces in
`store.introspect().deprecatedKinds` for codegen tools and lint rules, but
reads and writes against the deprecated kind continue to work:

```typescript
const deprecated = await evolved.deprecateKinds(["Document"]);
// Document is now flagged but still fully usable.
await deprecated.nodes.Document.create({
  title: "Legacy doc",
  body: "Still readable, just flagged",
});
```

Removal is the harder verb. `removeKinds(["Author"], { eager: {} })`
commits a new schema version that drops `Author` and cascades to any edge
whose endpoints depend on it (here, `authoredBy`). With `eager: {}` the
data-cleanup phase runs inline — rows and edge data are deleted before the
verb returns:

```typescript
const trimmed = await deprecated.removeKinds(["Author"], { eager: {} });
// registry.hasNodeType('Author')  -> false
// registry.hasEdgeType('authoredBy') -> false (cascaded)
```

### 7. Restart parity

The whole point of "durable schema versions" is that nothing above is
in-memory state. A fresh process opening the same database sees every
accepted extension, deprecation flag, and materialized index without
re-running any verb:

```typescript
const [restored, validation] = await createStoreWithSchema(baseGraph, backend);

// validation.status === "VALID"
// restored.registry.hasNodeType("Paper")   -> true
// restored.registry.hasNodeType("Author")  -> false (removed in step 6)
// restored.introspect().deprecatedKinds    -> ["Document"]

const papers = restored.getNodeCollectionOrThrow("Paper");
await papers.find({}); // returns the rows from step 3
```

This is what makes runtime evolution safe for production: agent-proposed
schema is regular schema by the time the next process starts up.

## Run it

```bash
git clone https://github.com/nicia-ai/typegraph
cd typegraph
pnpm install
npx tsx packages/typegraph/examples/16-graph-extensions.ts
```

The example builds the graph, walks every step against an in-memory SQLite
database, and prints output for each. To persist it, point
`createLocalSqliteBackend()` at a file path. To run on Postgres, swap the
import to `createPostgresBackend` — see [Backend Setup](/backend-setup).

## Next steps

- [Graph Extensions](/graph-extensions) — the full reference for
  `defineGraphExtension`, `validateGraphExtension`, `evolve`,
  `deprecateKinds`, `removeKinds`, and the structured-issue codes
- [`pdlug/typegraph-clinical-demo`](https://github.com/pdlug/typegraph-clinical-demo)
  — the same loop driven by an open-weight LLM against public-record
  clinical data, with a repair loop and a smoke-test pattern that catches
  latent shape mismatches the static validator can't
- [Schema Migrations](/schema-management) — the lower-level primitives
  graph extensions ride on top of (`SchemaVersion`, change classification,
  reconciliation watermarks)
- [Dynamic Queries](/queries/source) — `fromDynamic`, `traverseDynamic`,
  and the predicate accessor for runtime kinds
