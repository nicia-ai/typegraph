import {
  BENCHMARK_CONFIG,
  type FollowSeed,
  type NextSeed,
  type PostSeed,
  type UserSeed,
} from "./config";
import { type PerfStore } from "./graph";
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

function buildUsers(): readonly UserSeed[] {
  return Array.from({ length: BENCHMARK_CONFIG.userCount }, (_, index) => ({
    id: `user_${index}`,
    name: `User ${index}`,
    city: index % 3 === 0 ? "San Francisco" : "New York",
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

export async function seedStore(store: PerfStore): Promise<void> {
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

  const elapsed = nowMs() - startedAt;
  const totalItems =
    users.length +
    posts.length +
    nextEdges.length +
    followEdges.length +
    posts.length;

  console.log(`ingestion: ${formatMs(elapsed)} for ${totalItems} items`);
}
