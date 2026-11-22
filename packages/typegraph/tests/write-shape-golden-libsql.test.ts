/**
 * The write-shape golden for SQLite through `@libsql/client`, whose root runs static atomic programs as one `batch()`.
 * The scenarios, the runner and the matrix live in
 * `helpers/write-shape-golden-scenarios.ts`; snapshots in
 * `__snapshots__/write-shape-golden/libsql/`.
 */
import { vi } from "vitest";

import { registerWriteShapeGoldenFile } from "./helpers/write-shape-golden-scenarios";

vi.mock("nanoid", async () => {
  const { traceIds } = await import("./helpers/write-shape-trace-ids");
  return { nanoid: () => traceIds.next() };
});

registerWriteShapeGoldenFile("libsql");
