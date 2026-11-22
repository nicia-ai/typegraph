/**
 * The write-shape golden for PostgreSQL through PGlite.
 * The scenarios, the runner and the matrix live in
 * `helpers/write-shape-golden-scenarios.ts`; snapshots in
 * `__snapshots__/write-shape-golden/pglite/`.
 */
import { vi } from "vitest";

import { registerWriteShapeGoldenFile } from "./helpers/write-shape-golden-scenarios";

vi.mock("nanoid", async () => {
  const { traceIds } = await import("./helpers/write-shape-trace-ids");
  return { nanoid: () => traceIds.next() };
});

registerWriteShapeGoldenFile("pglite");
