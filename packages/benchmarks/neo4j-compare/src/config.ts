/**
 * Mirrors packages/benchmarks/src/config.ts so the graph shape and
 * measurement methodology match exactly.
 */
export const BENCHMARK_CONFIG = {
  userCount: 1200,
  followsPerUser: 10,
  postsPerUser: 5,
  userBioBytes: 1024,
  postBodyBytes: 4096,
  batchSize: 250,
  warmupIterations: 2,
  sampleIterations: 15,
} as const;

export const NEO4J_CONFIG = {
  url: process.env.NEO4J_URL ?? "bolt://localhost:7687",
  user: process.env.NEO4J_USER ?? "neo4j",
  password: process.env.NEO4J_PASSWORD ?? "benchpass",
  database: process.env.NEO4J_DATABASE ?? "neo4j",
} as const;
