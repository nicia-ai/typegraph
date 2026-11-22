/**
 * The edge-create path golden for PostgreSQL through PGlite, `root` receivers.
 * The scenarios and the matrix live in
 * `helpers/edge-create-path-golden-scenarios.ts`; snapshots in
 * `__snapshots__/edge-create-path-golden/pglite/`.
 */
import { vi } from "vitest";

import { registerEdgeCreatePathGoldenFile } from "./helpers/edge-create-path-golden-scenarios";

vi.mock("nanoid", async () => {
  const { traceIds } = await import("./helpers/write-shape-trace-ids");
  return { nanoid: () => traceIds.next() };
});

registerEdgeCreatePathGoldenFile("pglite", "root");
