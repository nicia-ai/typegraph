---
title: Research Copilot
description: Semantic search, ontology expansion, and graph algorithms combined into an explainable literature-review digest over a citation graph
---

A single runnable example that exercises nearly every TypeGraph capability —
typed schema, [ontology](/ontology), vector embeddings, recursive traversals,
and the [graph algorithms](/graph-algorithms) — against a corpus of
landmark ML papers. It produces an explainable literature-review digest in one
run against a single SQLite file, with zero external services.

:::tip[Just want the code?]
Full source on GitHub: [`packages/typegraph/examples/14-research-copilot.ts`](https://github.com/nicia-ai/typegraph/blob/main/packages/typegraph/examples/14-research-copilot.ts)
:::

## What You Get

A natural-language query comes in. The copilot returns a ranked, chronological
reading list with citation counts, authors, and topics — all computed against
a single in-memory SQLite database:

```text
 Query: "contrastive self-supervised representation learning for vision"

 Recommended reading order (chronological among top-ranked):

  2012  ImageNet Classification with Deep Convolutional Neural Networks  [3 citations]
        Alex Krizhevsky, Ilya Sutskever, Geoffrey Hinton
        topics: CNN, ComputerVision, DeepLearning
        why: semantic 0.449 · topic match: DeepLearning · 3 incoming citations
  2014  Adam: A Method for Stochastic Optimization  [1 citation]
        Diederik Kingma, Jimmy Ba
        topics: Optimization
        why: semantic 0.429 · 1 incoming citation
  2019  Momentum Contrast for Unsupervised Visual Representation Learning  [1 citation]
        Kaiming He, Haoqi Fan, Yuxin Wu, et al.
        topics: Contrastive, SelfSupervised, ComputerVision
        why: semantic 0.523 · topic match: SelfSupervised, Contrastive · 1 incoming citation
  2020  A Simple Framework for Contrastive Learning of Visual Representations  [1 citation]
        Ting Chen, Simon Kornblith, Mohammad Norouzi, et al.
        topics: Contrastive, SelfSupervised, ComputerVision
        why: semantic 0.436 · topic match: SelfSupervised, Contrastive · 1 incoming citation
  2020  An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale  [1 citation]
        Alexey Dosovitskiy, Lucas Beyer, Alexander Kolesnikov, et al.
        topics: Transformer, ComputerVision, DeepLearning
        why: semantic 0.350 · topic match: DeepLearning · 1 incoming citation
```

## Architecture

Each moving part maps to a single TypeGraph primitive:

| Feature                              | TypeGraph capability                                        |
| ------------------------------------ | ----------------------------------------------------------- |
| Semantic paper retrieval             | `embedding()` fields + cosine similarity                    |
| Topic hierarchy expansion            | [Ontology](/ontology) + `store.algorithms.reachable()`      |
| Citation-authority ranking           | `store.algorithms.degree()` over `cites`                    |
| Explainable paper lineage            | `store.algorithms.shortestPath()` over `cites`              |
| "Does this trace back to X?"         | `store.algorithms.canReach()`                               |
| Co-author discovery (2-hop)          | `store.algorithms.neighbors()`                              |
| Reading-list assembly                | [Query builder](/queries/overview) with typed traversals    |

## Schema

Three node kinds and four edges model the citation graph plus a topic
hierarchy that supports query expansion:

```typescript
const Paper = defineNode("Paper", {
  schema: z.object({
    // Title + abstract are `searchable()` so BM25 ranks papers by
    // keyword hits (rare technical terms, author surnames, dataset
    // names) — exactly the queries where embeddings are least
    // discriminative.
    title: searchable({ language: "english" }),
    year: z.number().int(),
    abstract: searchable({ language: "english" }),
    embedding: embedding(128),
  }),
});

const Author = defineNode("Author", {
  schema: z.object({ name: z.string() }),
});

const Topic = defineNode("Topic", {
  schema: z.object({ name: z.string() }),
});

const cites = defineEdge("cites", { schema: z.object({}) });
const authoredBy = defineEdge("authored_by", { schema: z.object({}) });
const coversTopic = defineEdge("covers_topic", { schema: z.object({}) });

// Topic hierarchy: `CNN broader_than DL` reads "CNN is a more specific
// concept than DL". Recursive traversal expands narrow query terms into
// their ancestor concepts for higher recall.
const broaderThan = defineEdge("broader_than", { schema: z.object({}) });

const graph = defineGraph({
  id: "research_copilot",
  nodes: { Paper: { type: Paper }, Author: { type: Author }, Topic: { type: Topic } },
  edges: {
    cites: { type: cites, from: [Paper], to: [Paper] },
    authored_by: { type: authoredBy, from: [Paper], to: [Author] },
    covers_topic: { type: coversTopic, from: [Paper], to: [Topic] },
    broader_than: { type: broaderThan, from: [Topic], to: [Topic] },
  },
});
```

## Scene by Scene

The example walks through five capabilities end-to-end. Each produces real
console output against the seeded corpus of 18 landmark papers.

### 1. Semantic retrieval

Every paper has a 128-dimensional embedding. Rank the corpus against a
query embedding and take the top hits:

```typescript
const queryEmbedding = mockEmbedding(query);
const allPapers = await store.nodes.Paper.find();
const ranked = allPapers
  .map((paper) => ({
    paper,
    similarity: cosine(queryEmbedding, paper.embedding),
  }))
  .sort((a, b) => b.similarity - a.similarity);
```

In production, swap the in-JS ranking for `p.embedding.similarTo(queryEmbedding, k)`
in a [query builder](/queries/overview) predicate — backed by pgvector or
sqlite-vec — to do the scoring in SQL. See [Semantic Search](/semantic-search).

`title` and `abstract` are declared `searchable()`, so the same corpus
is also indexed for BM25 via SQLite's FTS5. The example runs a
rare-token query against the fulltext index to show where BM25 wins —
dataset names, method acronyms, proper nouns — exactly the queries
embeddings smooth out:

```typescript
const fulltextHits = await store.search.fulltext("Paper", {
  query: "Dropout",
  limit: 3,
  includeSnippets: true,
});
```

```text
─── Fulltext retrieval (BM25 via FTS5) for: "Dropout" ───
  2.619  Dropout: A Simple Way to Prevent Neural Networks from Overfitting
        <mark>Dropout</mark>: A Simple Way to Prevent Neural Networks from Overfitting
        Randomly zeroing unit activations during training prevents co-adaptation and…
```

In production you'd fuse the two via `store.search.hybrid()`, which
runs both retrievers and blends them with Reciprocal Rank Fusion at
the SQL layer:

```typescript
const hits = await store.search.hybrid("Paper", {
  limit: 10,
  vector: { fieldPath: "embedding", queryEmbedding, metric: "cosine" },
  fulltext: { query, includeSnippets: true },
  // Weight fulltext slightly higher for the entity-heavy queries
  // typical of literature search.
  fusion: { method: "rrf", k: 60, weights: { vector: 1, fulltext: 1.25 } },
});
```

See the [Fulltext Search guide](/fulltext-search) for tuning and
[Example 15](https://github.com/nicia-ai/typegraph/blob/main/packages/typegraph/examples/15-fulltext-hybrid-search.ts)
for an end-to-end hybrid walkthrough.

### 2. Ontology-expanded topic matching

A query for the narrow topic `Contrastive` should also return papers tagged
with its ancestors (`SelfSupervised`, `DeepLearning`). `reachable()` walks
the `broader_than` edge recursively and returns every ancestor topic:

```typescript
const topicAncestors = await store.algorithms.reachable(contrastiveTopic, {
  edges: ["broader_than"],
  maxHops: 10,
  excludeSource: true,
});
```

Then filter papers whose `covers_topic` edge lands in the expanded set:

```typescript
const topicMatches = await store
  .query()
  .from("Paper", "p")
  .traverse("covers_topic", "e")
  .to("Topic", "t")
  .whereNode("t", (t) => t.id.in([...expandedTopicIds]))
  .select((ctx) => ({ id: ctx.p.id, title: ctx.p.title, topic: ctx.t.name }))
  .execute();
```

Output:

```text
  Expanded set: {Contrastive, SelfSupervised, DeepLearning}
```

### 3. Citation-authority re-ranking

Pure vector similarity is noisy. Fuse it with in-degree on the `cites` edge
so highly-cited papers bubble up:

```typescript
const citationCount = await store.algorithms.degree(paperId, {
  edges: ["cites"],
  direction: "in",
});
const score = similarity + topicBonus + Math.log(citationCount + 1) / 10;
```

Output:

```text
 score = similarity + 0.05 * topicMatches + log(1 + citations) / 10

 rank  score  sim    topic  cites  title
 ───────────────────────────────────────────────────────────────────
   1   0.692  0.523      2      1  Momentum Contrast for Unsupervised Visual Representation Learning
   2   0.638  0.449      1      3  ImageNet Classification with Deep Convolutional Neural Networks
   3   0.606  0.436      2      1  A Simple Framework for Contrastive Learning of Visual Representations
```

### 4. Explainable lineage

"You've read AlexNet — how does SimCLR trace back to it?" `shortestPath`
returns an ordered list of nodes, which the example formats as a tree:

```typescript
const lineage = await store.algorithms.shortestPath(simclr.id, alex.id, {
  edges: ["cites"],
  maxHops: 6,
});
```

```text
   2-hop citation lineage:

   A Simple Framework for Contrastive Learning of Visual Representations
     └─▶ Deep Residual Learning for Image Recognition
       └─▶ ImageNet Classification with Deep Convolutional Neural Networks
```

### 5. Heritage check

`canReach` is the boolean sibling of `shortestPath` — useful when you don't
need the path, just the answer. Here: "which of these modern papers still
trace back to Rumelhart's 1986 backprop paper?"

```typescript
const reaches = await store.algorithms.canReach(paper.id, backprop.id, {
  edges: ["cites"],
  maxHops: 10,
});
```

```text
   ✓  "LLaMA: Open and Efficient Foundation Language Models"       traces to Rumelhart 1986
   ✓  "Learning Transferable Visual Models From Natural Language"  traces to Rumelhart 1986
   ✓  "Chain-of-Thought Prompting Elicits Reasoning in Large LMs"  traces to Rumelhart 1986
   ✓  "A Simple Framework for Contrastive Learning of Visual Reps" traces to Rumelhart 1986
```

### 6. Collaborator discovery

`neighbors` returns the direct neighborhood of a node. Compose it — authors
of CLIP → their other papers → co-authors on those papers — to rank natural
collaborators by shared-paper count:

```typescript
const clipAuthors = await store.algorithms.neighbors(clip.id, {
  edges: ["authored_by"],
  depth: 1,
});

// For each CLIP author: walk authored_by backwards to all their papers,
// then forwards to all their co-authors.
const perAuthorPapers = await Promise.all(
  clipAuthors.map((author) =>
    store.algorithms.neighbors(author.id, {
      edges: ["authored_by"],
      direction: "in",
      depth: 1,
    }),
  ),
);
```

Issuing each level in parallel keeps the fan-out at `O(depth)` round-trips
instead of `O(authors × papers)`.

```text
 Seed paper authors: Ilya Sutskever, Jong Wook Kim, Aditya Ramesh, Alec Radford, Chris Hallacy

 Nearby collaborators beyond the original CLIP paper:
   2× shared papers with CLIP authors  Alex Krizhevsky
   2× shared papers with CLIP authors  Geoffrey Hinton
   2× shared papers with CLIP authors  Rewon Child
   2× shared papers with CLIP authors  Jeffrey Wu
   1× shared papers with CLIP authors  Nitish Srivastava
```

## Run It

The full source lives at
[`packages/typegraph/examples/14-research-copilot.ts`](https://github.com/nicia-ai/typegraph/blob/main/packages/typegraph/examples/14-research-copilot.ts).
From a checkout of the repository:

```bash
pnpm install
npx tsx packages/typegraph/examples/14-research-copilot.ts
```

The example builds the graph, runs every scene, and tears down — all
against an in-memory SQLite database. To persist it, point
`createExampleBackend()` at a file path. To run it on Postgres, swap the
import to `createPostgresBackend` — see [Backend Setup](/backend-setup).

## Next Steps

- [Graph Algorithms](/graph-algorithms) — the full API for `shortestPath`,
  `reachable`, `canReach`, `neighbors`, and `degree`
- [Knowledge Graph for RAG](/examples/knowledge-graph-rag) — entity linking,
  chunk traversal, and hybrid vector + fulltext retrieval
- [Ontology & Reasoning](/ontology) — inverse edges, subclass hierarchies,
  and other ontology primitives beyond `broader_than`
- [Semantic Search](/semantic-search) — production vector search with
  pgvector and sqlite-vec
