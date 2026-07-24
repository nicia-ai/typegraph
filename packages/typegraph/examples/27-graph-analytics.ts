/**
 * Example 27: Graph Analytics (whole-graph algorithms over a citation DAG)
 *
 * The next chapter of the research-copilot story (example 14). Same corpus of
 * landmark ML papers, same real citation DAG — but instead of point queries
 * (shortestPath, degree, neighbors) this example runs the *whole-graph*
 * analytics that landed across releases 0.37 and 0.38:
 *
 *   • weaklyConnectedComponents  → is the literature one connected body?
 *   • weightedShortestPath        → cheapest citation lineage by year-gap,
 *                                     contrasted with the fewest-hop lineage
 *   • pageRank                     → propagated citation authority vs raw count
 *   • personalizedPageRank         → "what's important *to CLIP*" vs globally
 *   • labelPropagation             → do research communities fall out of the
 *                                     undirected citation graph, or does it
 *                                     oscillate?
 *
 * These five require a pinned transactional connection (they run multiple SQL
 * rounds in one repeatable snapshot); the in-memory SQLite backend used here
 * advertises that capability. Every number printed below is computed at run
 * time — nothing is hard-coded.
 *
 * Run with:
 *   npx tsx examples/27-graph-analytics.ts
 */
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  GraphAlgorithmConvergenceError,
} from "@nicia-ai/typegraph";
import { z } from "zod";

import { requireDefined } from "../src/utils/presence";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Schema
// ============================================================
//
// Trimmed relative to example 14 — analytics here run over the citation graph,
// so Paper carries only the fields those algorithms and the readout need. The
// `cites` edge gains two numeric weights (see below) so weightedShortestPath
// has a genuinely meaningful cost to minimize.

const Paper = defineNode("Paper", {
  schema: z.object({
    key: z.string(),
    title: z.string(),
    year: z.number().int(),
  }),
});

const Author = defineNode("Author", {
  schema: z.object({ name: z.string() }),
});

const Topic = defineNode("Topic", {
  schema: z.object({ name: z.string() }),
});

/**
 * Two weights on each citation, both computed from publication years at seed
 * time:
 *
 *   • `yearGap = citingYear - citedYear` — how far back a citation reaches.
 *     A natural first guess for "cost", but it TELESCOPES: because a `cites`
 *     path always steps newer→older, the sum of gaps along any route from A to
 *     B collapses to exactly `A.year - B.year`, independent of the route. So
 *     every path between two papers ties on total year-gap and
 *     weightedShortestPath can never find a "cheaper" one — it degenerates to a
 *     tie-broken shortestPath. We keep it to show that degeneracy concretely.
 *
 *   • `yearGapCost = yearGap²` — a convex temporal cost. Squaring breaks the
 *     telescoping: one big leap across a decade (gap 27 → cost 729) is now far
 *     more expensive than the same span crossed by several incremental
 *     citations (e.g. 1²+27² beaten by routing through a paper one year older).
 *     This models "prefer the smoothest incremental lineage" and genuinely
 *     diverges from the fewest-hop path — which is the whole point of a
 *     weighted shortest path.
 */
const cites = defineEdge("cites", {
  schema: z.object({
    yearGap: z.number().int(),
    yearGapCost: z.number().int(),
  }),
});
const authoredBy = defineEdge("authored_by", { schema: z.object({}) });
const coversTopic = defineEdge("covers_topic", { schema: z.object({}) });

const graph = defineGraph({
  id: "graph_analytics",
  nodes: {
    Paper: { type: Paper },
    Author: { type: Author },
    Topic: { type: Topic },
  },
  edges: {
    cites: { type: cites, from: [Paper], to: [Paper] },
    authored_by: { type: authoredBy, from: [Paper], to: [Author] },
    covers_topic: { type: coversTopic, from: [Paper], to: [Topic] },
  },
});

// ============================================================
// Seed corpus: landmark ML papers with a realistic citation DAG
// ============================================================
//
// Identical dataset to example 14 (the research-copilot corpus): real papers,
// real authors, real topics, and a real `cites` DAG pointing from newer papers
// to the older ones they cite.

type SeedPaper = Readonly<{
  key: string;
  title: string;
  year: number;
  authors: readonly string[];
  topics: readonly string[];
  cites: readonly string[];
}>;

const PAPERS: readonly SeedPaper[] = [
  {
    key: "backprop",
    title: "Learning representations by back-propagating errors",
    year: 1986,
    authors: ["David Rumelhart", "Geoffrey Hinton", "Ronald Williams"],
    topics: ["Optimization", "DeepLearning"],
    cites: [],
  },
  {
    key: "lenet",
    title: "Gradient-Based Learning Applied to Document Recognition",
    year: 1998,
    authors: ["Yann LeCun", "Leon Bottou", "Yoshua Bengio"],
    topics: ["CNN", "ComputerVision"],
    cites: ["backprop"],
  },
  {
    key: "word2vec",
    title: "Efficient Estimation of Word Representations in Vector Space",
    year: 2013,
    authors: ["Tomas Mikolov", "Kai Chen", "Greg Corrado", "Jeffrey Dean"],
    topics: ["Embeddings", "NLP"],
    cites: ["backprop"],
  },
  {
    key: "alexnet",
    title: "ImageNet Classification with Deep Convolutional Neural Networks",
    year: 2012,
    authors: ["Alex Krizhevsky", "Ilya Sutskever", "Geoffrey Hinton"],
    topics: ["CNN", "ComputerVision", "DeepLearning"],
    cites: ["lenet", "backprop"],
  },
  {
    key: "dropout",
    title: "Dropout: A Simple Way to Prevent Neural Networks from Overfitting",
    year: 2014,
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
    authors: ["Diederik Kingma", "Jimmy Ba"],
    topics: ["Optimization"],
    cites: ["backprop"],
  },
  {
    key: "vgg",
    title: "Very Deep Convolutional Networks for Large-Scale Image Recognition",
    year: 2014,
    authors: ["Karen Simonyan", "Andrew Zisserman"],
    topics: ["CNN", "ComputerVision"],
    cites: ["alexnet"],
  },
  {
    key: "resnet",
    title: "Deep Residual Learning for Image Recognition",
    year: 2015,
    authors: ["Kaiming He", "Xiangyu Zhang", "Shaoqing Ren", "Jian Sun"],
    topics: ["CNN", "ComputerVision", "DeepLearning"],
    cites: ["alexnet", "vgg", "dropout"],
  },
  {
    key: "seq2seq",
    title: "Sequence to Sequence Learning with Neural Networks",
    year: 2014,
    authors: ["Ilya Sutskever", "Oriol Vinyals", "Quoc Le"],
    topics: ["RNN", "NLP", "DeepLearning"],
    cites: ["backprop", "word2vec"],
  },
  {
    key: "transformer",
    title: "Attention Is All You Need",
    year: 2017,
    authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar", "Jakob Uszkoreit"],
    topics: ["Transformer", "Attention", "NLP"],
    cites: ["seq2seq", "adam", "dropout", "word2vec"],
  },
  {
    key: "bert",
    title:
      "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
    year: 2018,
    authors: [
      "Jacob Devlin",
      "Ming-Wei Chang",
      "Kenton Lee",
      "Kristina Toutanova",
    ],
    topics: ["Transformer", "NLP", "SelfSupervised", "LanguageModel"],
    cites: ["transformer", "word2vec"],
  },
  {
    key: "gpt2",
    title: "Language Models are Unsupervised Multitask Learners",
    year: 2019,
    authors: ["Alec Radford", "Jeffrey Wu", "Rewon Child", "Ilya Sutskever"],
    topics: ["Transformer", "NLP", "LanguageModel"],
    cites: ["transformer", "bert"],
  },
  {
    key: "moco",
    title: "Momentum Contrast for Unsupervised Visual Representation Learning",
    year: 2019,
    authors: ["Kaiming He", "Haoqi Fan", "Yuxin Wu", "Saining Xie"],
    topics: ["Contrastive", "SelfSupervised", "ComputerVision"],
    cites: ["resnet"],
  },
  {
    key: "simclr",
    title:
      "A Simple Framework for Contrastive Learning of Visual Representations",
    year: 2020,
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
    authors: [
      "Alec Radford",
      "Jong Wook Kim",
      "Chris Hallacy",
      "Aditya Ramesh",
      "Ilya Sutskever",
    ],
    topics: ["Contrastive", "MultiModal", "ComputerVision", "NLP", "SelfSupervised"],
    cites: ["vit", "simclr", "bert", "gpt2"],
  },
  {
    key: "cot",
    title:
      "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models",
    year: 2022,
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
    authors: ["Hugo Touvron", "Thibaut Lavril", "Gautier Izacard"],
    topics: ["Transformer", "LanguageModel", "NLP"],
    cites: ["transformer", "gpt2", "cot"],
  },
];

// ============================================================
// Main: seed the citation graph, then run whole-graph analytics
// ============================================================

export async function main(): Promise<void> {
  // Async initialization: whole-graph analytics need a pinned transactional
  // connection, which createStoreWithSchema materializes here. (Sync createStore
  // is attach-only and would not advertise graphAnalytics support.)
  const backend = createExampleBackend();
  const [store] = await createStoreWithSchema(graph, backend);

  console.log("━".repeat(68));
  console.log(" Graph Analytics — whole-graph algorithms over a citation DAG");
  console.log("━".repeat(68));

  const analyticsLabel =
    backend.capabilities.graphAnalytics?.supported === true ?
      "supported (pinned transactional snapshot)"
    : "UNSUPPORTED on this backend";
  console.log(` Graph analytics capability: ${analyticsLabel}`);
  console.log("\n Tour:");
  console.log("  [1] weaklyConnectedComponents — one body of work, or islands?");
  console.log("  [2] weightedShortestPath — fewest hops vs cheapest lineage");
  console.log("  [3] pageRank — propagated authority vs raw citation count");
  console.log("  [4] personalizedPageRank — importance relative to CLIP");
  console.log("  [5] labelPropagation — do research communities emerge?");

  // ----------------------------------------------------------
  // Seed the graph
  // ----------------------------------------------------------

  const paperByKey = new Map<string, { id: string; title: string; year: number }>();
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
    // Deterministic ids (default is a random nanoid). This matters here beyond
    // tidy output: the exact-tie rules in WCC, PageRank, and especially
    // labelPropagation break ties on the node's `(id, kind)` under binary
    // ordering. With random ids, whether label propagation *converges or
    // oscillates* on this borderline graph can flip run to run. Pinning ids
    // makes every figure below reproducible.
    const created = await store.nodes.Paper.create(
      {
        key: paper.key,
        title: paper.title,
        year: paper.year,
      },
      { id: `paper-${paper.key}` },
    );
    paperByKey.set(paper.key, {
      id: created.id,
      title: created.title,
      year: created.year,
    });

    for (const name of paper.authors) {
      const author = await ensureAuthor(name);
      await store.edges.authored_by.create(created, author, {});
    }
    for (const name of paper.topics) {
      const topic = await ensureTopic(name);
      await store.edges.covers_topic.create(created, topic, {});
    }
  }

  // Citation edges carry the year-gap weight, computed from the two papers'
  // publication years at seed time.
  for (const paper of PAPERS) {
    const source = requireDefined(paperByKey.get(paper.key));
    for (const citedKey of paper.cites) {
      const target = requireDefined(paperByKey.get(citedKey));
      const yearGap = source.year - target.year;
      await store.edges.cites.create(
        { kind: "Paper", id: source.id },
        { kind: "Paper", id: target.id },
        { yearGap, yearGapCost: yearGap * yearGap },
      );
    }
  }

  const titleById = new Map(
    [...paperByKey.values()].map((paper) => [paper.id, paper.title]),
  );
  const yearById = new Map(
    [...paperByKey.values()].map((paper) => [paper.id, paper.year]),
  );
  const keyById = new Map(
    [...paperByKey.entries()].map(([key, value]) => [value.id, key]),
  );
  const shortTitle = (id: string): string => {
    const full = titleById.get(id) ?? id;
    return full.length > 52 ? full.slice(0, 49) + "..." : full;
  };

  const totalCitations = PAPERS.reduce((sum, paper) => sum + paper.cites.length, 0);
  console.log(
    `\nIngested ${PAPERS.length} papers, ${authorByName.size} authors, ` +
      `${topicByName.size} topics, ${totalCitations} citation edges.\n`,
  );

  // ----------------------------------------------------------
  // [1] Weakly connected components
  // ----------------------------------------------------------
  //
  // Treats `cites` as undirected and partitions the papers by connectivity.
  // One component ⇒ every paper is tied into the same body of work; multiple
  // ⇒ there are citation-isolated islands. nodeKinds: ["Paper"] keeps authors
  // and topics out of the partition.

  console.log("━".repeat(68));
  console.log(" [1] weaklyConnectedComponents over the cites graph");
  console.log("━".repeat(68) + "\n");

  const components = await store.algorithms.weaklyConnectedComponents({
    edges: ["cites"],
    nodeKinds: ["Paper"],
  });

  const byComponent = new Map<string, string[]>();
  for (const membership of components) {
    const list = byComponent.get(membership.componentId) ?? [];
    list.push(membership.id);
    byComponent.set(membership.componentId, list);
  }

  console.log(
    ` ${components.length} papers partition into ${byComponent.size} ` +
      `component(s):`,
  );
  for (const [componentId, memberIds] of byComponent) {
    const size = memberIds.length;
    console.log(
      `   • component of ${size} paper(s), rooted at "${shortTitle(componentId)}"`,
    );
  }

  // ----------------------------------------------------------
  // [2] Weighted shortest path — fewest hops vs cheapest lineage
  // ----------------------------------------------------------
  //
  // Three routes between the same two papers, computed three ways:
  //   • shortestPath                     → fewest hops
  //   • weightedShortestPath by yearGap  → linear temporal cost (degenerate:
  //                                          every route ties, see schema note)
  //   • weightedShortestPath by yearGapCost → convex temporal cost, which
  //                                          genuinely prefers incremental
  //                                          lineage over one big leap
  // The convex cost is where "cheapest" stops meaning "fewest hops".

  console.log("\n" + "━".repeat(68));
  console.log(" [2] weightedShortestPath — fewest hops vs cheapest lineage");
  console.log("━".repeat(68) + "\n");

  // Compact route rendering, e.g. "clip(2021) → vit(2020)".
  const renderRoute = (nodes: readonly Readonly<{ id: string }>[]): string =>
    nodes
      .map((node) => {
        const key = keyById.get(node.id) ?? node.id;
        const year = yearById.get(node.id);
        return year ? `${key}(${year})` : key;
      })
      .join(" → ");

  for (const [fromKey, toKey] of [
    ["seq2seq", "backprop"],
    ["transformer", "backprop"],
    ["clip", "backprop"],
    ["llama", "backprop"],
  ] as const) {
    const from = requireDefined(paperByKey.get(fromKey));
    const to = requireDefined(paperByKey.get(toKey));

    const hopPath = await store.algorithms.shortestPath(from.id, to.id, {
      edges: ["cites"],
      maxHops: 10,
    });
    const byYearGap = await store.algorithms.weightedShortestPath(
      from.id,
      to.id,
      { edges: ["cites"], weightProperty: "yearGap" },
    );
    const byConvexCost = await store.algorithms.weightedShortestPath(
      from.id,
      to.id,
      { edges: ["cites"], weightProperty: "yearGapCost" },
    );

    console.log(` ${fromKey} → ${toKey}:`);
    if (hopPath && byYearGap && byConvexCost) {
      const divergesHops = byConvexCost.depth !== hopPath.depth;
      console.log(
        `   shortestPath (fewest hop):   ${hopPath.depth} hops   ` +
          renderRoute(hopPath.nodes),
      );
      console.log(
        `   weighted by yearGap:         ${byYearGap.depth} hops   ` +
          `totalWeight=${byYearGap.totalWeight}   ` +
          renderRoute(byYearGap.nodes),
      );
      console.log(
        `   weighted by yearGapCost:     ${byConvexCost.depth} hops   ` +
          `totalWeight=${byConvexCost.totalWeight}   ` +
          renderRoute(byConvexCost.nodes) +
          (divergesHops ? "   ◀── more hops, lower convex cost" : ""),
      );
    } else {
      console.log("   (no path)");
    }
    console.log();
  }

  // ----------------------------------------------------------
  // [3] PageRank — propagated authority vs raw citation count
  // ----------------------------------------------------------
  //
  // Citation authority = "cited by influential papers, propagated". Which
  // direction produces it depends on the edge orientation. Our `cites` edge is
  // stored citing→cited, so a random surfer following edges FORWARD
  // (direction: "out") drifts toward the heavily-cited old papers and they
  // accumulate the score. direction: "out" is therefore the authority ranking
  // here; direction: "in" would reverse the walk and rank citation *hubs*
  // (papers with long bibliographies, like CLIP/LLaMA) instead — the opposite
  // of authority. The comparison column is the raw incoming-citation count via
  // degree(direction: "in"), i.e. how many papers cite each one.

  console.log("━".repeat(68));
  console.log(" [3] pageRank (authority, direction: out) vs raw citation count");
  console.log("━".repeat(68) + "\n");

  const pageRankScores = await store.algorithms.pageRank({
    edges: ["cites"],
    nodeKinds: ["Paper"],
    direction: "out",
  });

  const rawCitationCount = new Map<string, number>();
  for (const paper of paperByKey.values()) {
    const count = await store.algorithms.degree(paper.id, {
      edges: ["cites"],
      direction: "in",
    });
    rawCitationCount.set(paper.id, count);
  }

  // Rank position by raw citation count (for the Δrank column), ties broken by
  // score so the comparison is stable.
  const byRawCount = [...paperByKey.values()].toSorted((left, right) => {
    const delta =
      (rawCitationCount.get(right.id) ?? 0) - (rawCitationCount.get(left.id) ?? 0);
    return delta === 0 ? left.title.localeCompare(right.title) : delta;
  });
  const rawRankById = new Map(byRawCount.map((paper, index) => [paper.id, index + 1]));

  console.log(
    "  PR-rank  score     cites  raw-rank  Δ  title\n  " + "─".repeat(64),
  );
  for (const [index, entry] of pageRankScores.slice(0, 8).entries()) {
    const prRank = index + 1;
    const rawCount = rawCitationCount.get(entry.id) ?? 0;
    const rawRank = rawRankById.get(entry.id) ?? 0;
    const delta = rawRank - prRank;
    const deltaLabel = delta === 0 ? "  ·" : delta > 0 ? `+${delta}` : `${delta}`;
    console.log(
      `  ${String(prRank).padStart(5)}    ${entry.score.toFixed(5)}  ` +
        `${String(rawCount).padStart(5)}  ${String(rawRank).padStart(6)}  ` +
        `${deltaLabel.padStart(3)}  ${shortTitle(entry.id)}`,
    );
  }
  console.log(
    "\n  (Δ = raw-citation rank minus PageRank rank; positive means PageRank",
  );
  console.log("   ranks the paper HIGHER than raw citation count does.)");

  // ----------------------------------------------------------
  // [4] Personalized PageRank — importance relative to CLIP
  // ----------------------------------------------------------
  //
  // Same power iteration, but teleport mass returns to CLIP instead of spreading
  // uniformly. Scores now mean "structurally close to CLIP's citation lineage"
  // rather than "globally authoritative". direction: "out" walks the citations
  // CLIP makes (and their onward citations), surfacing CLIP's own ancestry.

  console.log("\n" + "━".repeat(68));
  console.log(" [4] personalizedPageRank seeded on CLIP (direction: out)");
  console.log("━".repeat(68) + "\n");

  const clip = requireDefined(paperByKey.get("clip"));
  // Reuse the global authority ranking from [3] (direction: "out") as the
  // baseline: the contrast we want is "important to CLIP specifically" vs
  // "important globally", both measured the same way.
  const globalRankById = new Map(
    pageRankScores.map((entry, index) => [entry.id, index + 1]),
  );

  const personalized = await store.algorithms.personalizedPageRank({
    edges: ["cites"],
    nodeKinds: ["Paper"],
    direction: "out",
    seeds: [{ id: clip.id, kind: "Paper" }],
  });

  console.log(
    "  PPR-rank  score     global-rank  Δ    title\n  " + "─".repeat(66),
  );
  for (const [index, entry] of personalized.slice(0, 8).entries()) {
    const pprRank = index + 1;
    const globalRank = globalRankById.get(entry.id) ?? 0;
    const delta = globalRank - pprRank;
    const deltaLabel = delta === 0 ? "  ·" : delta > 0 ? `+${delta}` : `${delta}`;
    console.log(
      `  ${String(pprRank).padStart(6)}    ${entry.score.toFixed(5)}  ` +
        `${String(globalRank).padStart(11)}  ${deltaLabel.padStart(3)}  ` +
        shortTitle(entry.id),
    );
  }
  console.log(
    "\n  (Δ = global authority rank minus CLIP-personalized rank; positive",
  );
  console.log(
    "   means CLIP's neighborhood pulls the paper UP relative to global.)",
  );

  // ----------------------------------------------------------
  // [5] Label propagation — do research communities emerge?
  // ----------------------------------------------------------
  //
  // CDLP over the undirected projection of `cites`. A citation DAG projected to
  // undirected can easily contain tree-shaped or even-cycle neighborhoods that
  // provably never converge (they oscillate between two labelings forever), so
  // try onMaxIterations: "throw" first and see what REALLY happens; on an
  // oscillation, fall back to "return" for the fixed-round labeling.

  console.log("\n" + "━".repeat(68));
  console.log(" [5] labelPropagation over the undirected cites graph");
  console.log("━".repeat(68) + "\n");

  const topicsByPaper = new Map<string, string[]>();
  for (const paper of PAPERS) topicsByPaper.set(paper.key, [...paper.topics]);

  const reportCommunities = (
    memberships: readonly Readonly<{ id: string; labelId: string }>[],
  ): void => {
    const byLabel = new Map<string, string[]>();
    for (const membership of memberships) {
      const list = byLabel.get(membership.labelId) ?? [];
      list.push(membership.id);
      byLabel.set(membership.labelId, list);
    }
    const communities = [...byLabel.values()].toSorted(
      (left, right) => right.length - left.length,
    );
    console.log(`   ${communities.length} communities:\n`);
    for (const memberIds of communities) {
      console.log(`   ── community of ${memberIds.length} ──`);
      for (const id of memberIds) {
        const key = keyById.get(id) ?? id;
        const topics = (topicsByPaper.get(key) ?? []).slice(0, 3).join(", ");
        console.log(`      ${shortTitle(id).padEnd(52)} [${topics}]`);
      }
    }
  };

  try {
    const converged = await store.algorithms.labelPropagation({
      edges: ["cites"],
      nodeKinds: ["Paper"],
      onMaxIterations: "throw",
    });
    console.log(" Converged with onMaxIterations: \"throw\".\n");
    reportCommunities(converged);
  } catch (error) {
    if (error instanceof GraphAlgorithmConvergenceError) {
      console.log(
        " onMaxIterations: \"throw\" raised GraphAlgorithmConvergenceError —",
      );
      console.log(
        " the undirected citation graph oscillates (tree / even-cycle structure",
      );
      console.log(
        " that mirrors labels back and forth). Retrying with \"return\" for the",
      );
      console.log(" fixed-round labeling:\n");
      const fixedRound = await store.algorithms.labelPropagation({
        edges: ["cites"],
        nodeKinds: ["Paper"],
        onMaxIterations: "return",
      });
      reportCommunities(fixedRound);
    } else {
      throw error;
    }
  }

  console.log("\n" + "━".repeat(68));
  console.log(
    " Every figure above was computed at run time over a single in-memory",
  );
  console.log(
    " SQLite database. Swap to Postgres by changing one import — exact",
  );
  console.log(
    " algorithms are backend-identical; PageRank agrees within tolerance.",
  );
  console.log("━".repeat(68) + "\n");

  await store.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
