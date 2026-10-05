import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  inspectGraphStorage,
  searchable,
} from "../../../src";
import { projectBackendWithout } from "../../../src/backend/derive-backend";
import type { GraphBackend } from "../../../src/backend/types";
import { createTestBackend, disableTransactions } from "../../test-utils";

const Note = defineNode("Note", {
  schema: z.object({ body: searchable({ language: "english" }) }),
});
const graph = defineGraph({ id: "probe_clear_preserve", nodes: { Note: { type: Note } }, edges: {} });

describe("clear-preserve-option-dropped", () => {
  it("clear-preserve-option-dropped: explicit preserve=true is applied or refused when the backend lacks the preserving member", async () => {
    const full = createTestBackend();
    const [seed] = await createStoreWithSchema(graph, full);
    await seed.nodes.Note.create({ body: "hello" });
    const rowsOf = async () =>
      (await inspectGraphStorage(seed)).relations.find((r) => r.relation === "contributionMaterializations")?.rows ?? 0;
    expect(await rowsOf()).toBeGreaterThan(0);

    const limited = projectBackendWithout(disableTransactions(full), [
      "clearGraphPreservingContributionMaterializations",
    ]) as unknown as GraphBackend;
    expect(limited.clearGraphPreservingContributionMaterializations).toBeUndefined();
    const store = createStore(graph, limited);
    let refused = false;
    try {
      await store.clear({ preserveContributionMaterializations: true });
    } catch {
      refused = true;
    }
    if (!refused) expect(await rowsOf()).toBeGreaterThan(0);
  });
});
