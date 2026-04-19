/**
 * Example 14: Research Copilot (RAG + Citation Graph + Tier 1 Algorithms)
 *
 * A "fuck yeah" showcase that combines everything TypeGraph does:
 *
 *   • Typed schema with Zod            → compile-time guarantees
 *   • Ontology (topic hierarchy)        → query expansion
 *   • Vector embeddings                 → semantic retrieval
 *   • Recursive CTE traversals          → subgraph extraction
 *   • Tier 1 graph algorithms           → shortestPath / reachable /
 *                                          canReach / neighbors / degree
 *
 * The scenario: a researcher asks natural-language questions over a corpus
 * of landmark ML papers. The copilot combines semantic search, ontology-
 * expanded topic matching, citation-authority ranking (degree), explainable
 * recommendations (shortestPath), and co-author discovery (neighbors) — all
 * over a single SQLite database with zero external services.
 *
 * Run with:
 *   npx tsx examples/14-research-copilot.ts
 */
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
} from "@nicia-ai/typegraph";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Schema
// ============================================================

const Paper = defineNode("Paper", {
  schema: z.object({
    title: z.string(),
    year: z.number().int(),
    abstract: z.string(),
    embedding: embedding(128),
  }),
});

const Author = defineNode("Author", {
  schema: z.object({
    name: z.string(),
  }),
});

const Topic = defineNode("Topic", {
  schema: z.object({
    name: z.string(),
  }),
});

const cites = defineEdge("cites", { schema: z.object({}) });
const authoredBy = defineEdge("authored_by", { schema: z.object({}) });
const coversTopic = defineEdge("covers_topic", { schema: z.object({}) });
/**
 * Topic hierarchy edge: `CNN broader_than DL` reads "CNN is a more specific
 * concept than DL". Recursive traversal over this edge expands narrow query
 * terms into their ancestor concepts for higher recall.
 */
const broaderThan = defineEdge("broader_than", { schema: z.object({}) });

const graph = defineGraph({
  id: "research_copilot",
  nodes: {
    Paper: { type: Paper },
    Author: { type: Author },
    Topic: { type: Topic },
  },
  edges: {
    cites: { type: cites, from: [Paper], to: [Paper] },
    authored_by: { type: authoredBy, from: [Paper], to: [Author] },
    covers_topic: { type: coversTopic, from: [Paper], to: [Topic] },
    broader_than: { type: broaderThan, from: [Topic], to: [Topic] },
  },
});

// ============================================================
// Mock embedding helper
// ============================================================
//
// Real deployments plug in OpenAI / sentence-transformers / etc. For the
// demo we derive a deterministic 128-d vector from the text so similarity
// rankings are reproducible without a network call.

function mockEmbedding(text: string): number[] {
  const dim = 128;
  const vector = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const token of tokens) {
    let hash = 0;
    for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    for (let i = 0; i < dim; i++) {
      vector[i]! += Math.sin(hash * (i + 1)) * 0.25 + Math.cos(hash + i) * 0.25;
    }
  }
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / magnitude);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // both vectors are unit-length
}

// ============================================================
// Seed corpus: landmark ML papers with a realistic citation DAG
// ============================================================

type SeedPaper = Readonly<{
  key: string;
  title: string;
  year: number;
  abstract: string;
  authors: readonly string[];
  topics: readonly string[];
  cites: readonly string[];
}>;

const PAPERS: readonly SeedPaper[] = [
  {
    key: "backprop",
    title: "Learning representations by back-propagating errors",
    year: 1986,
    abstract:
      "A procedure that adjusts the weights of hidden units in neural networks using gradients of the error. The backbone of modern deep learning optimization.",
    authors: ["David Rumelhart", "Geoffrey Hinton", "Ronald Williams"],
    topics: ["Optimization", "DeepLearning"],
    cites: [],
  },
  {
    key: "lenet",
    title: "Gradient-Based Learning Applied to Document Recognition",
    year: 1998,
    abstract:
      "Convolutional neural networks trained end-to-end outperform hand-engineered features on handwritten digit recognition.",
    authors: ["Yann LeCun", "Leon Bottou", "Yoshua Bengio"],
    topics: ["CNN", "ComputerVision"],
    cites: ["backprop"],
  },
  {
    key: "word2vec",
    title: "Efficient Estimation of Word Representations in Vector Space",
    year: 2013,
    abstract:
      "Dense vector representations of words learned from large unlabeled corpora via shallow neural networks; captures analogical semantic structure.",
    authors: ["Tomas Mikolov", "Kai Chen", "Greg Corrado", "Jeffrey Dean"],
    topics: ["Embeddings", "NLP"],
    cites: ["backprop"],
  },
  {
    key: "alexnet",
    title: "ImageNet Classification with Deep Convolutional Neural Networks",
    year: 2012,
    abstract:
      "A large deep CNN trained on ImageNet crushes prior benchmarks, launching the modern deep learning era of computer vision.",
    authors: ["Alex Krizhevsky", "Ilya Sutskever", "Geoffrey Hinton"],
    topics: ["CNN", "ComputerVision", "DeepLearning"],
    cites: ["lenet", "backprop"],
  },
  {
    key: "dropout",
    title: "Dropout: A Simple Way to Prevent Neural Networks from Overfitting",
    year: 2014,
    abstract:
      "Randomly zeroing unit activations during training prevents co-adaptation and dramatically improves generalization.",
    authors: [
      "Nitish Srivastava",
      "Geoffrey Hinton",
      "Alex Krizhevsky",
      "Ilya Sutskever",
    ],
    topics: ["DeepLearning", "Optimization"],
    cites: ["alexnet", "backprop"],
  },
  {
    key: "adam",
    title: "Adam: A Method for Stochastic Optimization",
    year: 2014,
    abstract:
      "An adaptive moment estimation algorithm for first-order gradient-based optimization of stochastic objective functions; the default optimizer for modern deep learning.",
    authors: ["Diederik Kingma", "Jimmy Ba"],
    topics: ["Optimization"],
    cites: ["backprop"],
  },
  {
    key: "vgg",
    title: "Very Deep Convolutional Networks for Large-Scale Image Recognition",
    year: 2014,
    abstract:
      "Very deep architectures with small 3x3 filters achieve state-of-the-art on image classification.",
    authors: ["Karen Simonyan", "Andrew Zisserman"],
    topics: ["CNN", "ComputerVision"],
    cites: ["alexnet"],
  },
  {
    key: "resnet",
    title: "Deep Residual Learning for Image Recognition",
    year: 2015,
    abstract:
      "Residual connections let us train networks with hundreds of layers by reformulating layers as learning residual functions.",
    authors: ["Kaiming He", "Xiangyu Zhang", "Shaoqing Ren", "Jian Sun"],
    topics: ["CNN", "ComputerVision", "DeepLearning"],
    cites: ["alexnet", "vgg", "dropout"],
  },
  {
    key: "seq2seq",
    title: "Sequence to Sequence Learning with Neural Networks",
    year: 2014,
    abstract:
      "An encoder-decoder LSTM architecture that maps variable-length input sequences to variable-length output sequences end-to-end.",
    authors: ["Ilya Sutskever", "Oriol Vinyals", "Quoc Le"],
    topics: ["RNN", "NLP", "DeepLearning"],
    cites: ["backprop", "word2vec"],
  },
  {
    key: "transformer",
    title: "Attention Is All You Need",
    year: 2017,
    abstract:
      "A new sequence transduction architecture based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.",
    authors: [
      "Ashish Vaswani",
      "Noam Shazeer",
      "Niki Parmar",
      "Jakob Uszkoreit",
    ],
    topics: ["Transformer", "Attention", "NLP"],
    cites: ["seq2seq", "adam", "dropout", "word2vec"],
  },
  {
    key: "bert",
    title:
      "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
    year: 2018,
    abstract:
      "Masked language modeling on bidirectional transformers produces representations that transfer to a wide range of NLP tasks via fine-tuning.",
    authors: ["Jacob Devlin", "Ming-Wei Chang", "Kenton Lee", "Kristina Toutanova"],
    topics: ["Transformer", "NLP", "SelfSupervised", "LanguageModel"],
    cites: ["transformer", "word2vec"],
  },
  {
    key: "gpt2",
    title: "Language Models are Unsupervised Multitask Learners",
    year: 2019,
    abstract:
      "A large transformer trained on diverse web text demonstrates strong zero-shot performance across many downstream NLP tasks.",
    authors: [
      "Alec Radford",
      "Jeffrey Wu",
      "Rewon Child",
      "Ilya Sutskever",
    ],
    topics: ["Transformer", "NLP", "LanguageModel"],
    cites: ["transformer", "bert"],
  },
  {
    key: "moco",
    title:
      "Momentum Contrast for Unsupervised Visual Representation Learning",
    year: 2019,
    abstract:
      "A contrastive learning framework that uses a momentum encoder and a dynamic queue of negatives to learn visual representations without labels.",
    authors: ["Kaiming He", "Haoqi Fan", "Yuxin Wu", "Saining Xie"],
    topics: ["Contrastive", "SelfSupervised", "ComputerVision"],
    cites: ["resnet"],
  },
  {
    key: "simclr",
    title:
      "A Simple Framework for Contrastive Learning of Visual Representations",
    year: 2020,
    abstract:
      "A surprisingly simple contrastive framework—strong augmentation, a nonlinear projection head, large batch sizes—produces state-of-the-art self-supervised visual representations.",
    authors: [
      "Ting Chen",
      "Simon Kornblith",
      "Mohammad Norouzi",
      "Geoffrey Hinton",
    ],
    topics: ["Contrastive", "SelfSupervised", "ComputerVision"],
    cites: ["resnet", "moco", "dropout"],
  },
  {
    key: "vit",
    title:
      "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale",
    year: 2020,
    abstract:
      "Applying a pure transformer directly to sequences of image patches achieves excellent results on image classification when pre-trained at scale.",
    authors: [
      "Alexey Dosovitskiy",
      "Lucas Beyer",
      "Alexander Kolesnikov",
      "Dirk Weissenborn",
    ],
    topics: ["Transformer", "ComputerVision", "DeepLearning"],
    cites: ["transformer", "resnet", "bert"],
  },
  {
    key: "clip",
    title:
      "Learning Transferable Visual Models From Natural Language Supervision",
    year: 2021,
    abstract:
      "Contrastive pre-training over 400M (image, text) pairs learns a joint embedding space that enables zero-shot image classification on dozens of benchmarks.",
    authors: [
      "Alec Radford",
      "Jong Wook Kim",
      "Chris Hallacy",
      "Aditya Ramesh",
      "Ilya Sutskever",
    ],
    topics: [
      "Contrastive",
      "MultiModal",
      "ComputerVision",
      "NLP",
      "SelfSupervised",
    ],
    cites: ["vit", "simclr", "bert", "gpt2"],
  },
  {
    key: "cot",
    title: "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models",
    year: 2022,
    abstract:
      "Prompting large language models to produce intermediate reasoning steps dramatically improves their performance on arithmetic, commonsense, and symbolic reasoning tasks.",
    authors: [
      "Jason Wei",
      "Xuezhi Wang",
      "Dale Schuurmans",
      "Maarten Bosma",
      "Ed Chi",
      "Quoc Le",
    ],
    topics: ["LanguageModel", "Reasoning", "NLP"],
    cites: ["gpt2", "bert"],
  },
  {
    key: "llama",
    title: "LLaMA: Open and Efficient Foundation Language Models",
    year: 2023,
    abstract:
      "A collection of foundation language models ranging from 7B to 65B parameters trained exclusively on publicly available data, competitive with much larger closed models.",
    authors: ["Hugo Touvron", "Thibaut Lavril", "Gautier Izacard"],
    topics: ["Transformer", "LanguageModel", "NLP"],
    cites: ["transformer", "gpt2", "cot"],
  },
];

/**
 * Topic hierarchy: narrow -> broader. Recursively expanding this edge lets
 * a search for "Contrastive" also surface "SelfSupervised" and
 * "DeepLearning" results.
 */
const TOPIC_HIERARCHY: readonly (readonly [string, string])[] = [
  ["CNN", "DeepLearning"],
  ["RNN", "DeepLearning"],
  ["Transformer", "DeepLearning"],
  ["Attention", "Transformer"],
  ["Contrastive", "SelfSupervised"],
  ["SelfSupervised", "DeepLearning"],
  ["LanguageModel", "NLP"],
  ["Reasoning", "LanguageModel"],
  ["Embeddings", "NLP"],
  ["MultiModal", "DeepLearning"],
  ["Optimization", "DeepLearning"],
  ["ComputerVision", "DeepLearning"],
  ["NLP", "DeepLearning"],
];

// ============================================================
// Main: build the graph, then run the copilot demo
// ============================================================

export async function main(): Promise<void> {
  const store = createStore(graph, createExampleBackend());

  console.log("━".repeat(68));
  console.log(" Research Copilot — RAG + citation graph + Tier 1 algorithms");
  console.log("━".repeat(68));

  // ----------------------------------------------------------
  // Seed the graph
  // ----------------------------------------------------------

  const paperByKey = new Map<string, { id: string; title: string }>();
  type AuthorNode = Awaited<ReturnType<typeof store.nodes.Author.create>>;
  type TopicNode = Awaited<ReturnType<typeof store.nodes.Topic.create>>;
  const authorByName = new Map<string, AuthorNode>();
  const topicByName = new Map<string, TopicNode>();

  async function ensureAuthor(name: string): Promise<AuthorNode> {
    const cached = authorByName.get(name);
    if (cached) return cached;
    const created = await store.nodes.Author.create({ name });
    authorByName.set(name, created);
    return created;
  }

  async function ensureTopic(name: string): Promise<TopicNode> {
    const cached = topicByName.get(name);
    if (cached) return cached;
    const created = await store.nodes.Topic.create({ name });
    topicByName.set(name, created);
    return created;
  }

  for (const paper of PAPERS) {
    const created = await store.nodes.Paper.create({
      title: paper.title,
      year: paper.year,
      abstract: paper.abstract,
      embedding: mockEmbedding(`${paper.title}. ${paper.abstract}`),
    });
    paperByKey.set(paper.key, { id: created.id, title: created.title });

    for (const name of paper.authors) {
      const author = await ensureAuthor(name);
      await store.edges.authored_by.create(created, author, {});
    }
    for (const name of paper.topics) {
      const topic = await ensureTopic(name);
      await store.edges.covers_topic.create(created, topic, {});
    }
  }

  for (const paper of PAPERS) {
    const source = paperByKey.get(paper.key)!;
    for (const citedKey of paper.cites) {
      const target = paperByKey.get(citedKey)!;
      await store.edges.cites.create(
        { kind: "Paper", id: source.id },
        { kind: "Paper", id: target.id },
        {},
      );
    }
  }

  for (const [narrow, broad] of TOPIC_HIERARCHY) {
    const narrowTopic = await ensureTopic(narrow);
    const broadTopic = await ensureTopic(broad);
    await store.edges.broader_than.create(narrowTopic, broadTopic, {});
  }

  console.log(
    `\nIngested ${PAPERS.length} papers, ${authorByName.size} authors, ${topicByName.size} topics.\n`,
  );

  // ----------------------------------------------------------
  // Scene 1: Semantic retrieval with ontology-expanded topics
  // ----------------------------------------------------------

  const query =
    "contrastive self-supervised representation learning for vision";
  console.log("━".repeat(68));
  console.log(` [1] Semantic retrieval for: "${query}"`);
  console.log("━".repeat(68));

  const queryEmbedding = mockEmbedding(query);

  // Fetch every paper + embedding once; rank by cosine similarity in JS.
  // In production you'd use `d.embedding.similarTo(queryEmbedding, k)` for
  // hardware-accelerated vector search via pgvector or sqlite-vec.
  const allPapers = await store.nodes.Paper.find();
  type PaperNode = (typeof allPapers)[number];
  const paperById = new Map<string, PaperNode>(
    allPapers.map((paper) => [paper.id, paper]),
  );
  const ranked = allPapers
    .map((paper) => ({
      paper,
      similarity: cosine(queryEmbedding, paper.embedding),
    }))
    .sort((a, b) => b.similarity - a.similarity);

  console.log("\nTop semantic hits (vector similarity only):");
  for (const hit of ranked.slice(0, 5)) {
    const stars = "★".repeat(Math.max(1, Math.round(hit.similarity * 10)));
    console.log(
      `  ${hit.similarity.toFixed(3)} ${stars.padEnd(10)} ${hit.paper.title}`,
    );
  }

  // ----------------------------------------------------------
  // Scene 2: Ontology-expanded topic retrieval
  // ----------------------------------------------------------

  console.log("\n─── Ontology-expanded topic match ───");
  console.log(
    ' Query: "Contrastive" → recursively expand via broader_than → all',
  );
  console.log(" ancestor concepts matched too (SelfSupervised, DeepLearning).\n");

  const contrastiveTopic = topicByName.get("Contrastive")!;
  const expandedTopicIds = new Set<string>([contrastiveTopic.id]);
  const topicAncestors = await store.algorithms.reachable(contrastiveTopic, {
    edges: ["broader_than"],
    maxHops: 10,
    excludeSource: true,
  });
  for (const topic of topicAncestors) expandedTopicIds.add(topic.id);

  const topicById = new Map<string, TopicNode>(
    [...topicByName.values()].map((topic) => [topic.id, topic]),
  );
  const expandedTopics = [...expandedTopicIds].map(
    (id) => topicById.get(id)!.name,
  );
  console.log(`  Expanded to: ${expandedTopics.join(" → ")}\n`);

  // Papers covering ANY topic in the expanded set (one query via IN predicate)
  const topicMatches = await store
    .query()
    .from("Paper", "p")
    .traverse("covers_topic", "e")
    .to("Topic", "t")
    .whereNode("t", (t) => t.id.in([...expandedTopicIds]))
    .select((ctx) => ({
      id: ctx.p.id,
      title: ctx.p.title,
      topic: ctx.t.name,
    }))
    .execute();

  const matchByPaper = new Map<string, Set<string>>();
  for (const row of topicMatches) {
    const set = matchByPaper.get(row.id) ?? new Set();
    set.add(row.topic);
    matchByPaper.set(row.id, set);
  }

  console.log(" Papers matching expanded topic set:");
  for (const [paperId, topics] of matchByPaper) {
    const paper = paperById.get(paperId)!;
    console.log(`   • ${paper.title}`);
    console.log(`       covers: [${[...topics].join(", ")}]`);
  }

  // ----------------------------------------------------------
  // Scene 3: Re-rank hybrid results by citation authority
  // ----------------------------------------------------------

  console.log("\n" + "━".repeat(68));
  console.log(" [2] Citation-authority re-ranking (degree)");
  console.log("━".repeat(68) + "\n");

  const candidateIds = new Set<string>([
    ...ranked.slice(0, 8).map((hit) => hit.paper.id),
    ...matchByPaper.keys(),
  ]);

  const hybridScored = await Promise.all(
    [...candidateIds].map(async (paperId) => {
      const paper = paperById.get(paperId)!;
      const citationCount = await store.algorithms.degree(paperId, {
        edges: ["cites"],
        direction: "in",
      });
      const similarity = cosine(queryEmbedding, paper.embedding);
      const topicBonus = (matchByPaper.get(paperId)?.size ?? 0) * 0.05;
      const authorityBoost = Math.log(citationCount + 1) / 10;
      const score = similarity + topicBonus + authorityBoost;
      return { paper, similarity, citationCount, score };
    }),
  );

  hybridScored.sort((a, b) => b.score - a.score);

  console.log(
    " rank  score  sim    cites  title".padEnd(68) + "\n " + "─".repeat(67),
  );
  for (const [index, entry] of hybridScored.slice(0, 6).entries()) {
    const rank = `  ${index + 1}`.padStart(4);
    console.log(
      `${rank}   ${entry.score.toFixed(3)}  ${entry.similarity.toFixed(3)}  ${String(entry.citationCount).padStart(5)}  ${entry.paper.title}`,
    );
  }

  // ----------------------------------------------------------
  // Scene 4: Explainable recommendations via shortestPath
  // ----------------------------------------------------------

  console.log("\n" + "━".repeat(68));
  console.log(" [3] Explainable lineage (shortestPath)");
  console.log("━".repeat(68));
  console.log(
    '\n "You\'ve read AlexNet — how does SimCLR trace back to it?"\n',
  );

  const alex = paperByKey.get("alexnet")!;
  const simclr = paperByKey.get("simclr")!;

  const lineage = await store.algorithms.shortestPath(simclr.id, alex.id, {
    edges: ["cites"],
    maxHops: 6,
  });

  const titleById = new Map(
    [...paperByKey.values()].map((paper) => [paper.id, paper.title]),
  );

  if (lineage) {
    console.log(`   ${lineage.depth}-hop citation lineage:\n`);
    for (const [index, node] of lineage.nodes.entries()) {
      const title = titleById.get(node.id) ?? node.id;
      const prefix = index === 0 ? "   " : " ".repeat(3 + index * 2) + "└─▶ ";
      console.log(`${prefix}${title}`);
    }
  } else {
    console.log("   (no path)");
  }

  // ----------------------------------------------------------
  // Scene 5: "Is this work grounded in backprop?"
  // ----------------------------------------------------------

  console.log("\n─── Heritage check (canReach) ───\n");

  const backprop = paperByKey.get("backprop")!;
  for (const key of ["llama", "clip", "cot", "simclr"] as const) {
    const paper = paperByKey.get(key)!;
    const reaches = await store.algorithms.canReach(paper.id, backprop.id, {
      edges: ["cites"],
      maxHops: 10,
    });
    console.log(
      `   ${reaches ? "✓" : "✗"}  "${paper.title.slice(0, 55).padEnd(55)}"  ${reaches ? "traces to Rumelhart 1986" : "does not reach"}`,
    );
  }

  // ----------------------------------------------------------
  // Scene 6: Co-author discovery via 2-hop neighborhood
  // ----------------------------------------------------------

  console.log("\n" + "━".repeat(68));
  console.log(" [4] Collaborator discovery (neighbors, 2 hops)");
  console.log("━".repeat(68));
  console.log(
    '\n "If I write a paper citing CLIP, who are my natural co-authors?"\n',
  );

  const clip = paperByKey.get("clip")!;

  // 1-hop out: CLIP → authors
  const clipAuthors = await store.algorithms.neighbors(clip.id, {
    edges: ["authored_by"],
    depth: 1,
  });

  // For each CLIP author: 1-hop in along authored_by = all their papers,
  // then 1-hop out = all collaborators. Issue each level in parallel so the
  // full fan-out finishes in O(depth) round-trips instead of O(authors × papers).
  const collaboratorCounts = new Map<string, number>();
  const perAuthorPapers = await Promise.all(
    clipAuthors.map((author) =>
      store.algorithms.neighbors(author.id, {
        edges: ["authored_by"],
        direction: "in",
        depth: 1,
      }),
    ),
  );
  const perAuthorCollaborators = await Promise.all(
    perAuthorPapers.map((papers) =>
      Promise.all(
        papers.map((paper) =>
          store.algorithms.neighbors(paper.id, {
            edges: ["authored_by"],
            depth: 1,
          }),
        ),
      ),
    ),
  );
  for (const [authorIndex, clipAuthor] of clipAuthors.entries()) {
    for (const collaborators of perAuthorCollaborators[authorIndex]!) {
      for (const collab of collaborators) {
        if (collab.id === clipAuthor.id) continue;
        collaboratorCounts.set(
          collab.id,
          (collaboratorCounts.get(collab.id) ?? 0) + 1,
        );
      }
    }
  }

  const topCollaborators = [...collaboratorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const authorById = new Map<string, string>(
    [...authorByName.values()].map((author) => [author.id, author.name]),
  );
  for (const [id, count] of topCollaborators) {
    console.log(
      `   ${count}× shared papers  ${authorById.get(id) ?? id}`,
    );
  }

  // ----------------------------------------------------------
  // Scene 7: Literature review digest
  // ----------------------------------------------------------

  console.log("\n" + "━".repeat(68));
  console.log(" [5] One-shot literature review digest");
  console.log("━".repeat(68) + "\n");

  console.log(` Query: "${query}"\n`);
  console.log(" Recommended reading order (chronological among top-ranked):\n");

  const topPicks = hybridScored
    .slice(0, 5)
    .sort((a, b) => a.paper.year - b.paper.year);

  const picksWithMeta = await Promise.all(
    topPicks.map(async (pick) => {
      const [paperAuthors, paperTopics] = await Promise.all([
        store
          .query()
          .from("Paper", "p")
          .whereNode("p", (p) => p.id.eq(pick.paper.id))
          .traverse("authored_by", "e")
          .to("Author", "a")
          .select((ctx) => ctx.a.name)
          .execute(),
        store
          .query()
          .from("Paper", "p")
          .whereNode("p", (p) => p.id.eq(pick.paper.id))
          .traverse("covers_topic", "e")
          .to("Topic", "t")
          .select((ctx) => ctx.t.name)
          .execute(),
      ]);
      return { pick, paperAuthors, paperTopics };
    }),
  );

  for (const { pick, paperAuthors, paperTopics } of picksWithMeta) {
    const citationLabel = pick.citationCount === 1 ? "citation" : "citations";
    console.log(
      `  ${pick.paper.year}  ${pick.paper.title}  [${pick.citationCount} ${citationLabel}]`,
    );
    console.log(`        ${paperAuthors.slice(0, 3).join(", ")}${paperAuthors.length > 3 ? ", et al." : ""}`);
    console.log(`        topics: ${paperTopics.join(", ")}`);
  }

  console.log("\n" + "━".repeat(68));
  console.log(" Everything above ran against a single in-memory SQLite file.");
  console.log(" Swap to Postgres by changing one import.");
  console.log("━".repeat(68) + "\n");

  await store.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
