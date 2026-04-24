/**
 * Seeds Neo4j with the same graph shape as the TypeGraph benchmark suite:
 *
 *   - 1,200 :User nodes (id, name, city, ~1KB bio)
 *   - 6,000 :Post nodes (id, title, ~4KB body)          5 per user
 *   - 1,199 :NEXT relationships forming a linear chain  user_0 -> user_1 -> ...
 *   -12,000 :FOLLOWS relationships                       10 per user
 *   - 6,000 :AUTHORED relationships                       1 per post
 *
 * Uses the same xorshift32 RNG seeded with 42 so the follow edges are
 * byte-identical to the TypeGraph seed.
 */
import neo4j, { type Driver } from "neo4j-driver";

import { BENCHMARK_CONFIG, NEO4J_CONFIG } from "./config.ts";
import { buildPayload, createRng, formatMs, nowMs } from "./utils.ts";

type User = { id: string; name: string; city: string; bio: string };
type Post = { id: string; authorId: string; title: string; body: string };
type Edge = { fromId: string; toId: string };

function buildUsers(): readonly User[] {
  return Array.from({ length: BENCHMARK_CONFIG.userCount }, (_, index) => ({
    id: `user_${index}`,
    name: `User ${index}`,
    city: index % 3 === 0 ? "San Francisco" : "New York",
    bio: buildPayload(`bio_${index}`, BENCHMARK_CONFIG.userBioBytes),
  }));
}

function buildPosts(users: readonly User[]): readonly Post[] {
  const posts: Post[] = [];
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

function buildFollowEdges(rng: () => number): readonly Edge[] {
  const maxFollows = Math.min(
    BENCHMARK_CONFIG.followsPerUser,
    BENCHMARK_CONFIG.userCount - 1,
  );
  const edges: Edge[] = [];
  for (
    let fromIndex = 0;
    fromIndex < BENCHMARK_CONFIG.userCount;
    fromIndex += 1
  ) {
    const seen = new Set<number>();
    while (seen.size < maxFollows) {
      const skew = rng();
      const candidate =
        skew < 0.2 ?
          Math.floor(rng() * 50)
        : Math.floor(rng() * BENCHMARK_CONFIG.userCount);
      if (candidate === fromIndex || seen.has(candidate)) continue;
      seen.add(candidate);
      edges.push({ fromId: `user_${fromIndex}`, toId: `user_${candidate}` });
    }
  }
  return edges;
}

function buildNextEdges(users: readonly User[]): readonly Edge[] {
  const edges: Edge[] = [];
  for (let index = 0; index < users.length - 1; index += 1) {
    edges.push({ fromId: users[index]!.id, toId: users[index + 1]!.id });
  }
  return edges;
}

async function resetAndIndex(driver: Driver): Promise<void> {
  const session = driver.session({ database: NEO4J_CONFIG.database });
  try {
    await session.run("MATCH (n) DETACH DELETE n");
    await session.run(
      "CREATE INDEX user_id IF NOT EXISTS FOR (u:User) ON (u.id)",
    );
    await session.run(
      "CREATE INDEX post_id IF NOT EXISTS FOR (p:Post) ON (p.id)",
    );
    // Wait for indexes to be online before we start seeding.
    await session.run("CALL db.awaitIndexes(30000)");
  } finally {
    await session.close();
  }
}

async function loadUsers(
  driver: Driver,
  users: readonly User[],
): Promise<void> {
  const session = driver.session({ database: NEO4J_CONFIG.database });
  try {
    for (let i = 0; i < users.length; i += BENCHMARK_CONFIG.batchSize) {
      const batch = users.slice(i, i + BENCHMARK_CONFIG.batchSize);
      await session.run(
        `UNWIND $rows AS row
         CREATE (u:User {id: row.id, name: row.name, city: row.city, bio: row.bio})`,
        { rows: batch },
      );
    }
  } finally {
    await session.close();
  }
}

async function loadPosts(
  driver: Driver,
  posts: readonly Post[],
): Promise<void> {
  const session = driver.session({ database: NEO4J_CONFIG.database });
  try {
    for (let i = 0; i < posts.length; i += BENCHMARK_CONFIG.batchSize) {
      const batch = posts.slice(i, i + BENCHMARK_CONFIG.batchSize);
      await session.run(
        `UNWIND $rows AS row
         CREATE (p:Post {id: row.id, title: row.title, body: row.body})`,
        { rows: batch },
      );
    }
  } finally {
    await session.close();
  }
}

async function loadRelationships(
  driver: Driver,
  relType: "FOLLOWS" | "NEXT" | "AUTHORED",
  fromLabel: "User" | "Post",
  toLabel: "User" | "Post",
  edges: readonly Edge[],
): Promise<void> {
  const session = driver.session({ database: NEO4J_CONFIG.database });
  try {
    for (let i = 0; i < edges.length; i += BENCHMARK_CONFIG.batchSize) {
      const batch = edges.slice(i, i + BENCHMARK_CONFIG.batchSize);
      await session.run(
        `UNWIND $rows AS row
         MATCH (a:${fromLabel} {id: row.fromId})
         MATCH (b:${toLabel}   {id: row.toId})
         CREATE (a)-[:${relType}]->(b)`,
        { rows: batch },
      );
    }
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  const driver = neo4j.driver(
    NEO4J_CONFIG.url,
    neo4j.auth.basic(NEO4J_CONFIG.user, NEO4J_CONFIG.password),
    { maxConnectionPoolSize: 10 },
  );

  try {
    const rng = createRng(42);
    const users = buildUsers();
    const posts = buildPosts(users);
    const nextEdges = buildNextEdges(users);
    const followEdges = buildFollowEdges(rng);
    const authoredEdges: readonly Edge[] = posts.map((p) => ({
      fromId: p.authorId,
      toId: p.id,
    }));

    console.log(`Neo4j seed: ${NEO4J_CONFIG.url} (${NEO4J_CONFIG.database})`);

    const startedAt = nowMs();

    await resetAndIndex(driver);
    await loadUsers(driver, users);
    await loadPosts(driver, posts);
    await loadRelationships(driver, "NEXT", "User", "User", nextEdges);
    await loadRelationships(driver, "FOLLOWS", "User", "User", followEdges);
    await loadRelationships(driver, "AUTHORED", "User", "Post", authoredEdges);

    const elapsed = nowMs() - startedAt;
    const total =
      users.length +
      posts.length +
      nextEdges.length +
      followEdges.length +
      authoredEdges.length;

    console.log(`ingestion: ${formatMs(elapsed)} for ${total} items`);
  } finally {
    await driver.close();
  }
}

await main();
