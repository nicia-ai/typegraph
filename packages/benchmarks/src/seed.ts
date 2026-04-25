import {
  BENCHMARK_CONFIG,
  type FollowSeed,
  type NextSeed,
  type PostSeed,
  type UserSeed,
} from "./config";
import { EMBEDDING_DIMENSIONS, type PerfStore } from "./graph";
import { formatMs, nowMs } from "./utils";

function createRng(seed_: number): () => number {
  let seed = seed_;
  return function next(): number {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4_294_967_295;
  };
}

function buildPayload(prefix: string, bytes: number): string {
  const chunk = `${prefix}|`;
  return chunk.repeat(Math.ceil(bytes / chunk.length)).slice(0, bytes);
}

function buildUsers(): readonly UserSeed[] {
  return Array.from({ length: BENCHMARK_CONFIG.userCount }, (_, index) => ({
    id: `user_${index}`,
    name: `User ${index}`,
    city: index % 3 === 0 ? "San Francisco" : "New York",
    bio: buildPayload(`bio_${index}`, BENCHMARK_CONFIG.userBioBytes),
  }));
}

function buildPosts(users: readonly UserSeed[]): readonly PostSeed[] {
  const posts: PostSeed[] = [];

  for (const user of users) {
    for (
      let postIndex = 0;
      postIndex < BENCHMARK_CONFIG.postsPerUser;
      postIndex += 1
    ) {
      posts.push({
        id: `post_${user.id}_${postIndex}`,
        authorId: user.id,
        title: `Post ${user.id} ${postIndex}`,
        body: buildPayload(
          `body_${user.id}_${postIndex}`,
          BENCHMARK_CONFIG.postBodyBytes,
        ),
      });
    }
  }

  return posts;
}

function buildFollowEdges(
  userCount: number,
  followsPerUser: number,
  rng: () => number,
): readonly FollowSeed[] {
  const maxFollows = Math.min(followsPerUser, userCount - 1);
  const edges: FollowSeed[] = [];

  for (let fromIndex = 0; fromIndex < userCount; fromIndex += 1) {
    const seen = new Set<number>();

    while (seen.size < maxFollows) {
      const skew = rng();
      const candidate =
        skew < 0.2 ? Math.floor(rng() * 50) : Math.floor(rng() * userCount);

      if (candidate === fromIndex || seen.has(candidate)) {
        continue;
      }

      seen.add(candidate);
      edges.push({
        fromId: `user_${fromIndex}`,
        toId: `user_${candidate}`,
      });
    }
  }

  return edges;
}

function buildNextEdges(users: readonly UserSeed[]): readonly NextSeed[] {
  const edges: NextSeed[] = [];

  for (let index = 0; index < users.length - 1; index += 1) {
    const from = users[index];
    const to = users[index + 1];
    if (!from || !to) {
      continue;
    }

    edges.push({
      fromId: from.id,
      toId: to.id,
    });
  }

  return edges;
}

async function ingestUsers(
  store: PerfStore,
  users: readonly UserSeed[],
): Promise<void> {
  for (
    let index = 0;
    index < users.length;
    index += BENCHMARK_CONFIG.batchSize
  ) {
    const batch = users.slice(index, index + BENCHMARK_CONFIG.batchSize);

    await store.nodes.User.bulkInsert(
      batch.map((user) => ({
        id: user.id,
        props: {
          name: user.name,
          city: user.city,
          bio: user.bio,
        },
      })),
    );
  }
}

async function ingestPosts(
  store: PerfStore,
  posts: readonly PostSeed[],
): Promise<void> {
  for (
    let index = 0;
    index < posts.length;
    index += BENCHMARK_CONFIG.batchSize
  ) {
    const batch = posts.slice(index, index + BENCHMARK_CONFIG.batchSize);

    await store.nodes.Post.bulkInsert(
      batch.map((post) => ({
        id: post.id,
        props: {
          title: post.title,
          body: post.body,
        },
      })),
    );
  }
}

async function ingestFollowEdges(
  store: PerfStore,
  followEdges: readonly FollowSeed[],
): Promise<void> {
  for (
    let index = 0;
    index < followEdges.length;
    index += BENCHMARK_CONFIG.batchSize
  ) {
    const batch = followEdges.slice(index, index + BENCHMARK_CONFIG.batchSize);

    await store.edges.follows.bulkInsert(
      batch.map((edge) => ({
        from: { kind: "User" as const, id: edge.fromId },
        to: { kind: "User" as const, id: edge.toId },
        props: {},
      })),
    );
  }
}

async function ingestAuthoredEdges(
  store: PerfStore,
  posts: readonly PostSeed[],
): Promise<void> {
  for (
    let index = 0;
    index < posts.length;
    index += BENCHMARK_CONFIG.batchSize
  ) {
    const batch = posts.slice(index, index + BENCHMARK_CONFIG.batchSize);

    await store.edges.authored.bulkInsert(
      batch.map((post) => ({
        from: { kind: "User" as const, id: post.authorId },
        to: { kind: "Post" as const, id: post.id },
        props: {},
      })),
    );
  }
}

async function ingestNextEdges(
  store: PerfStore,
  nextEdges: readonly NextSeed[],
): Promise<void> {
  for (
    let index = 0;
    index < nextEdges.length;
    index += BENCHMARK_CONFIG.batchSize
  ) {
    const batch = nextEdges.slice(index, index + BENCHMARK_CONFIG.batchSize);

    await store.edges.next.bulkInsert(
      batch.map((edge) => ({
        from: { kind: "User" as const, id: edge.fromId },
        to: { kind: "User" as const, id: edge.toId },
        props: {},
      })),
    );
  }
}

/**
 * Fixed historical timestamp used as an `asOf` anchor for temporal
 * measurements. The seed creates a batch of "archived" users whose
 * `validTo` is set to this instant; queries with
 * `temporal("asOf", pastTimestamp)` see them, queries with the default
 * `current` mode do not. Exported so measurements can reference it.
 */
const TEMPORAL_ARCHIVE_BOUNDARY = "2020-01-01T00:00:00.000Z";
const TEMPORAL_ARCHIVE_ASOF = "2019-06-01T00:00:00.000Z";
const TEMPORAL_ARCHIVE_VALID_FROM = "2019-01-01T00:00:00.000Z";

export { TEMPORAL_ARCHIVE_ASOF };

const DOC_CATEGORIES = [
  "climate",
  "technology",
  "economics",
  "biology",
  "philosophy",
] as const;

const DOC_VOCABULARY: Readonly<
  Record<(typeof DOC_CATEGORIES)[number], readonly string[]>
> = {
  climate: [
    "climate change adaptation strategies",
    "renewable energy transition in the global south",
    "glacial retreat observations across the alps",
    "carbon capture technology commercial viability",
    "methane emissions from agriculture and industry",
    "extreme weather attribution studies",
    "policy frameworks for emissions trading",
    "tropical ecosystem resilience indicators",
    "climate modeling uncertainty bounds",
    "arctic permafrost thaw feedback loops",
  ],
  technology: [
    "distributed systems consensus algorithms",
    "large language model inference optimization",
    "graph database traversal performance",
    "edge computing deployment patterns",
    "query planner heuristics in relational engines",
    "vector similarity search index structures",
    "network protocol buffer serialization",
    "transactional memory on multicore hardware",
    "cache coherence in distributed stores",
    "zero-copy data interchange between services",
  ],
  economics: [
    "labor market frictions and wage dispersion",
    "monetary policy transmission mechanisms",
    "trade networks and comparative advantage",
    "household consumption smoothing behavior",
    "behavioral economics of retirement savings",
    "auction theory and revenue equivalence",
    "economic impact of automation on wages",
    "inflation expectations anchoring dynamics",
    "fiscal multipliers during recessions",
    "housing market price inelasticity",
  ],
  biology: [
    "bacterial quorum sensing signaling pathways",
    "neural circuit development in vertebrates",
    "circadian rhythm regulation molecular mechanisms",
    "protein folding energy landscape",
    "gene regulatory network evolution",
    "coral reef microbiome symbiosis",
    "CRISPR gene editing off-target analysis",
    "immune system antigen recognition dynamics",
    "plant drought stress response pathways",
    "epigenetic inheritance across generations",
  ],
  philosophy: [
    "metaphysical realism and scientific explanation",
    "ethics of autonomous decision making systems",
    "phenomenology of embodied cognition",
    "philosophy of mathematical practice",
    "free will and neural determinism",
    "virtue ethics in professional practice",
    "theories of consciousness and qualia",
    "moral status of non-human animals",
    "social contract theory modern applications",
    "philosophy of measurement and scientific realism",
  ],
};

type DocSeed = Readonly<{
  id: string;
  category: (typeof DOC_CATEGORIES)[number];
  title: string;
  body: string;
  embedding: readonly number[];
}>;

/**
 * Deterministic embedding seeded on the category so two "climate" docs
 * have similar vectors and "climate" vs "technology" docs have
 * dissimilar vectors. Good enough to make vector-ranked results
 * stable for regression testing; not a real language model.
 */
function buildSeededEmbedding(
  rng: () => number,
  category: (typeof DOC_CATEGORIES)[number],
  docIndex: number,
): readonly number[] {
  const categoryAxis = DOC_CATEGORIES.indexOf(category);
  const vector = new Array<number>(EMBEDDING_DIMENSIONS);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i += 1) {
    // Category-correlated component on one axis, per-doc noise elsewhere.
    const onCategoryAxis = i === categoryAxis * 30;
    const base = onCategoryAxis ? 1 + (rng() - 0.5) * 0.2 : (rng() - 0.5) * 0.1;
    vector[i] = base + docIndex * 1e-6;
  }
  // Normalize for cosine-style similarity stability.
  let magnitude = 0;
  for (const v of vector) magnitude += v * v;
  const norm = Math.sqrt(magnitude);
  for (let i = 0; i < vector.length; i += 1) {
    vector[i] = vector[i]! / norm;
  }
  return vector;
}

function buildDocs(rng: () => number, count: number): readonly DocSeed[] {
  const docs: DocSeed[] = [];
  for (let index = 0; index < count; index += 1) {
    const category = DOC_CATEGORIES[index % DOC_CATEGORIES.length]!;
    const vocab = DOC_VOCABULARY[category];
    const sentence = vocab[index % vocab.length]!;
    docs.push({
      id: `doc_${index}`,
      category,
      title: `${sentence} — entry ${index}`,
      body: `${sentence}. ${vocab.join(" ")}. Entry ${index} explores ${category} in depth with references to related literature.`,
      embedding: buildSeededEmbedding(rng, category, index),
    });
  }
  return docs;
}

async function ingestDocs(store: PerfStore): Promise<readonly DocSeed[]> {
  // Keep doc count stable regardless of --scale; the search shapes are
  // about per-query latency, not about dataset density.
  const DOC_COUNT = 500;
  const rng = (() => {
    let seed = 4242;
    return () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4_294_967_295;
    };
  })();
  const docs = buildDocs(rng, DOC_COUNT);
  for (
    let index = 0;
    index < docs.length;
    index += BENCHMARK_CONFIG.batchSize
  ) {
    const batch = docs.slice(index, index + BENCHMARK_CONFIG.batchSize);
    await store.nodes.Doc.bulkInsert(
      batch.map((doc) => ({
        id: doc.id,
        props: {
          title: doc.title,
          body: doc.body,
          category: doc.category,
          embedding: doc.embedding,
        },
      })),
    );
  }
  return docs;
}

async function ingestArchivedUsers(store: PerfStore): Promise<void> {
  // Creating nodes directly with validFrom in the past and validTo at
  // the boundary gives us a typed temporal footprint: these users exist
  // when queried at `TEMPORAL_ARCHIVE_ASOF` and disappear at `current`.
  const archivedCount = Math.max(
    50,
    Math.round(BENCHMARK_CONFIG.userCount * 0.1),
  );
  const archived = Array.from({ length: archivedCount }, (_, index) => ({
    id: `archived_user_${index}`,
    props: {
      name: `Archived ${index}`,
      city: "Boston",
      bio: buildPayload(`archived_${index}`, BENCHMARK_CONFIG.userBioBytes),
    },
  }));

  for (
    let index = 0;
    index < archived.length;
    index += BENCHMARK_CONFIG.batchSize
  ) {
    const batch = archived.slice(index, index + BENCHMARK_CONFIG.batchSize);
    await Promise.all(
      batch.map((node) =>
        store.nodes.User.create(node.props, {
          id: node.id,
          validFrom: TEMPORAL_ARCHIVE_VALID_FROM,
          validTo: TEMPORAL_ARCHIVE_BOUNDARY,
        }),
      ),
    );
  }
}

type SeedResult = Readonly<{
  /**
   * Total items ingested (users + posts + edges + archived + docs), for
   * reporting in the benchmark header alongside elapsed time.
   */
  totalItems: number;
  /**
   * Vocabulary and seeded embeddings for Doc fulltext/vector measurements.
   * `undefined` when vector support is not available so search
   * measurements can skip cleanly.
   */
  docs: readonly { id: string; embedding: readonly number[] }[] | undefined;
}>;

export async function seedStore(store: PerfStore): Promise<SeedResult> {
  const rng = createRng(42);
  const users = buildUsers();
  const posts = buildPosts(users);
  const nextEdges = buildNextEdges(users);
  const followEdges = buildFollowEdges(
    BENCHMARK_CONFIG.userCount,
    BENCHMARK_CONFIG.followsPerUser,
    rng,
  );

  const startedAt = nowMs();
  await ingestUsers(store, users);
  await ingestPosts(store, posts);
  await ingestNextEdges(store, nextEdges);
  await ingestFollowEdges(store, followEdges);
  await ingestAuthoredEdges(store, posts);
  await ingestArchivedUsers(store);
  const docs = await ingestDocs(store);

  const elapsed = nowMs() - startedAt;
  const totalItems =
    users.length +
    posts.length +
    nextEdges.length +
    followEdges.length +
    posts.length +
    docs.length;

  console.log(`ingestion: ${formatMs(elapsed)} for ${totalItems} items`);

  return { totalItems, docs };
}
