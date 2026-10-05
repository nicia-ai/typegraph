import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
  pruneIdentityTransitions,
  TypeGraphError,
} from "../../../src";
import {
  createRecordedInstant,
  recordedInstantRevision,
} from "../../../src/core/temporal";
import { createTestBackend } from "../../test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "identity_history_options_probe",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});
const ref = (id: string) => ({ kind: "Person" as const, id });

describe("identity-history-options", () => {
  // The watermark means "history below revision W is gone". Revisions are
  // allocated as previous + 1 under the graph write fence, so the highest
  // watermark that can be true is (current clock revision + 1), the same
  // floor archival restore stamps. A prune target beyond that must be refused
  // with a typed error (or clamped); installing it makes every later commit
  // land below the watermark, so replay of fresh history reports truncation.
  it("prune-future-watermark-installed", async () => {
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
      { history: true },
    );
    for (const id of ["a", "b", "c"]) {
      await store.nodes.Person.create({ name: id }, { id });
    }
    await store.identity.assertSame(ref("a"), ref("b"));
    const clock = await store.recordedNow();
    if (clock === undefined) throw new Error("expected a recorded clock");
    const clockRevision = recordedInstantRevision(clock);
    const far = createRecordedInstant(
      clockRevision + 1000,
      "2999-01-01T00:00:00.000Z",
    );

    let installedWatermark: number | undefined;
    try {
      installedWatermark = (
        await pruneIdentityTransitions(store, { beforeRecorded: far })
      ).prunedBeforeRevision;
    } catch (error) {
      expect(error).toBeInstanceOf(TypeGraphError);
      return;
    }
    expect(installedWatermark).toBeLessThanOrEqual(clockRevision + 1);

    await store.identity.assertSame(ref("a"), ref("c"));
    const latest = await store.recordedNow();
    if (latest === undefined) throw new Error("expected a recorded clock");
    const replay = await store.identity.replay(ref("a"), {
      fromRecorded: latest,
      toRecorded: latest,
    });
    expect(replay.truncatedBefore).toBeUndefined();
    expect(replay.steps.length).toBeGreaterThan(0);
  });
});
