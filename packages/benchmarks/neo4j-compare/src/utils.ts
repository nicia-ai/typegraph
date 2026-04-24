/**
 * Matches packages/benchmarks/src/utils.ts and seed.ts behavior so the
 * generated graph shape is byte-identical across both benchmark runs.
 */
export function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

export function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

export function formatMs(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

/**
 * xorshift32 RNG — identical to packages/benchmarks/src/seed.ts so that a
 * seeded run produces the exact same follow edges as the TypeGraph benchmark.
 */
export function createRng(seed_: number): () => number {
  let seed = seed_;
  return function next(): number {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4_294_967_295;
  };
}

export function buildPayload(prefix: string, bytes: number): string {
  const chunk = `${prefix}|`;
  return chunk.repeat(Math.ceil(bytes / chunk.length)).slice(0, bytes);
}
