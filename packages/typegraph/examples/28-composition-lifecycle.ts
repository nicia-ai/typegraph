/**
 * Example 28: Composition Lifecycle
 *
 * A podcast publishes episodes, and each episode is cut into segments. A
 * segment has no meaning outside the episode it belongs to: delete the
 * episode, and its segments should go with it. That is composition —
 * `partOf`/`hasPart` — not an ordinary edge:
 *
 *   Segment --(segmentOf, REQUIRED, oneActive)--> Episode --(episodeOf, one)--> Podcast
 *
 * A segment can never exist without a live episode (`existence: "required"`);
 * an episode's podcast is optional metadata by comparison. `segmentOf` also
 * carries a required `order` property, so attaching a segment always states
 * `partOf.props`.
 *
 * This example demonstrates:
 * - declaring composition with `partOf`, `existence: "required"`, and a
 *   realizing edge with a required schema property
 * - a bare create of a required part is refused; `partOf` with `props`
 *   succeeds
 * - idempotent attachment via `getOrCreateByConstraint`'s `partOf`
 *   postcondition, including its refusal for a genuinely different whole
 * - `reparent` moving a part between wholes, and reparenting to the current
 *   whole as a no-op
 * - `store.subgraph(root, { composition: true })` exporting the complete
 *   owned unit, at any depth
 * - the delete cascade's `cascadedParts`, surfaced identically on an
 *   `onOperationEnd` hook and on a `transactionWithReceipt` receipt
 *
 * Run with:
 *   npx tsx examples/28-composition-lifecycle.ts
 */
import { deepStrictEqual } from "node:assert/strict";

import {
  CompositionExistenceError,
  createAdapterStore,
  defineEdge,
  defineGraph,
  defineNode,
  type OperationHookContext,
  partOf,
} from "@nicia-ai/typegraph";
import { z } from "zod";

import { requireDefined } from "../src/utils/presence";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Schema: Podcast -> Episode -> Segment, two composition pairs
// ============================================================

const Podcast = defineNode("Podcast", {
  schema: z.object({ title: z.string() }),
});
const Episode = defineNode("Episode", {
  schema: z.object({ title: z.string() }),
});
const Segment = defineNode("Segment", {
  schema: z.object({ label: z.string() }),
});

const episodeOf = defineEdge("episodeOf", { schema: z.object({}) });
// The realizing edge for the REQUIRED pair carries a required property, so
// every attachment through it must state `partOf.props`.
const segmentOf = defineEdge("segmentOf", {
  schema: z.object({ order: z.number().int() }),
});

const graph = defineGraph({
  id: "podcast_composition_example",
  nodes: {
    Podcast: {
      type: Podcast,
      unique: [
        {
          name: "podcast_title",
          fields: ["title"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Episode: {
      type: Episode,
      unique: [
        {
          name: "episode_title",
          fields: ["title"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Segment: {
      type: Segment,
      unique: [
        {
          name: "segment_label",
          fields: ["label"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    // Optional pair: an episode's podcast is metadata, not a lifeline.
    episodeOf: {
      type: episodeOf,
      from: [Episode],
      to: [Podcast],
      cardinality: "one",
    },
    // Required pair: a segment cannot outlive the episode it was cut from.
    segmentOf: {
      type: segmentOf,
      from: [Segment],
      to: [Episode],
      cardinality: "oneActive",
    },
  },
  ontology: [
    partOf(Episode, Podcast, { via: episodeOf }),
    partOf(Segment, Episode, { via: segmentOf, existence: "required" }),
  ],
});

function assertEqual<T>(actual: T, expected: T, label: string): void {
  // `deepStrictEqual` compares Sets and Maps by membership; a JSON round
  // trip would serialize every Set as `{}` and pass vacuously.
  deepStrictEqual(actual, expected, label);
  console.log(`  OK: ${label}`);
}

function assertTrue(condition: boolean, label: string): void {
  if (!condition) throw new Error(`${label}: expected true, got false`);
  console.log(`  OK: ${label}`);
}

export async function main(): Promise<void> {
  const backend = createExampleBackend();

  const endedOperations: OperationHookContext[] = [];
  const startedOperations: OperationHookContext[] = [];
  const store = createAdapterStore(graph, backend, {
    hooks: {
      onOperationStart: (ctx) => startedOperations.push(ctx),
      onOperationEnd: (ctx) => endedOperations.push(ctx),
    },
  });

  try {
    console.log(
      "=== Composition Lifecycle (Podcast -> Episode -> Segment) ===\n",
    );

    // ============================================================
    // 1. A bare required-part create is refused; `partOf` with props works
    // ============================================================

    console.log(
      "=== 1. Required existence: bare create refused, partOf succeeds ===\n",
    );

    const podcast = await store.nodes.Podcast.create({ title: "Deep Dive" });
    const episode = await store.nodes.Episode.create(
      { title: "Pilot" },
      { partOf: { kind: "Podcast", id: podcast.id } },
    );
    console.log(`  created podcast ${podcast.id} and episode ${episode.id}`);

    const bareCreateError = await store.nodes.Segment.create({
      label: "cold-open",
    }).catch((error: unknown) => error);
    assertTrue(
      bareCreateError instanceof CompositionExistenceError,
      "bare Segment.create is refused with CompositionExistenceError",
    );
    assertEqual(
      (bareCreateError as CompositionExistenceError).code,
      "COMPOSITION_WHOLE_REQUIRED",
      "refusal code is COMPOSITION_WHOLE_REQUIRED",
    );
    assertEqual(
      (bareCreateError as CompositionExistenceError).details.situation,
      "create",
      "refusal situation is 'create'",
    );
    assertEqual(
      await store.nodes.Segment.count(),
      0,
      "no Segment row was written by the refused create",
    );

    const coldOpen = await store.nodes.Segment.create(
      { label: "cold-open" },
      {
        partOf: { kind: "Episode", id: episode.id, props: { order: 1 } },
      },
    );
    const coldOpenEdges = await store.edges.segmentOf.findFrom(coldOpen);
    console.log(
      `  created segment ${coldOpen.id} attached via segmentOf order=${requireDefined(coldOpenEdges[0]).order}`,
    );
    assertEqual(coldOpenEdges.length, 1, "exactly one segmentOf edge exists");
    assertEqual(
      requireDefined(coldOpenEdges[0]).order,
      1,
      "the realizing edge carries the stated props",
    );

    // ============================================================
    // 2. Idempotent get-or-create with `partOf`
    // ============================================================

    console.log(
      "\n=== 2. getOrCreateByConstraint: idempotent attach, refused move ===\n",
    );

    const attachment = {
      kind: "Episode" as const,
      id: episode.id,
      via: "segmentOf" as const,
      props: { order: 2 },
    };

    const firstCall = await store.nodes.Segment.getOrCreateByConstraint(
      "segment_label",
      { label: "interview" },
      { partOf: attachment },
    );
    assertEqual(firstCall.action, "created", "first call creates the segment");

    const secondCall = await store.nodes.Segment.getOrCreateByConstraint(
      "segment_label",
      { label: "interview" },
      { partOf: attachment },
    );
    assertEqual(secondCall.action, "found", "second identical call finds it");
    assertEqual(
      secondCall.node.id,
      firstCall.node.id,
      "the found node is the same segment",
    );
    const interviewEdgesAfterRepeat = await store.edges.segmentOf.findFrom(
      firstCall.node,
    );
    assertEqual(
      interviewEdgesAfterRepeat.length,
      1,
      "no new segmentOf edge was written by the repeat",
    );

    const otherEpisode = await store.nodes.Episode.create(
      { title: "Bonus" },
      { partOf: { kind: "Podcast", id: podcast.id } },
    );
    const movedElsewhereError =
      await store.nodes.Segment.getOrCreateByConstraint(
        "segment_label",
        { label: "interview" },
        { partOf: { kind: "Episode", id: otherEpisode.id } },
      ).catch((error: unknown) => error);
    assertTrue(
      movedElsewhereError instanceof CompositionExistenceError,
      "naming a DIFFERENT whole is refused",
    );
    assertEqual(
      (movedElsewhereError as CompositionExistenceError).details.situation,
      "existing",
      "refusal situation is 'existing'",
    );
    assertEqual(
      (movedElsewhereError as CompositionExistenceError).code,
      "COMPOSITION_WHOLE_CONFLICT",
      "refusal code is COMPOSITION_WHOLE_CONFLICT",
    );
    const interviewEdgesAfterRefusal = await store.edges.segmentOf.findFrom(
      firstCall.node,
    );
    assertEqual(
      requireDefined(interviewEdgesAfterRefusal[0]).toId,
      episode.id,
      "the segment stays on its original episode — moving is reparent's job",
    );

    // ============================================================
    // 3. `reparent`: moving a part to a new whole
    // ============================================================

    console.log(
      "\n=== 3. reparent moves a part; reparenting in place is a no-op ===\n",
    );

    await store.nodes.Segment.reparent(firstCall.node.id, {
      kind: "Episode",
      id: otherEpisode.id,
      props: { order: 2 },
    });
    const interviewEdgesAfterMove = await store.edges.segmentOf.findFrom(
      firstCall.node,
      { temporalMode: "includeEnded" },
    );
    assertEqual(
      interviewEdgesAfterMove.length,
      2,
      "population 'oneActive' ENDS the old edge rather than deleting it",
    );
    const endedEdge = requireDefined(
      interviewEdgesAfterMove.find((edge) => edge.toId === episode.id),
      "the retired attachment",
    );
    const liveEdge = requireDefined(
      interviewEdgesAfterMove.find((edge) => edge.toId === otherEpisode.id),
      "the new attachment",
    );
    assertTrue(
      endedEdge.meta.validTo !== undefined,
      "the retired edge's window is closed",
    );
    assertEqual(
      liveEdge.meta.validFrom,
      requireDefined(endedEdge.meta.validTo),
      "the new window opens at the exact instant the old one closed",
    );

    await store.nodes.Segment.reparent(firstCall.node.id, {
      kind: "Episode",
      id: otherEpisode.id,
    });
    const interviewEdgesAfterNoop = await store.edges.segmentOf.findFrom(
      firstCall.node,
      { temporalMode: "includeEnded" },
    );
    assertEqual(
      interviewEdgesAfterNoop.length,
      2,
      "reparenting to the whole already held is a no-op — no new edge, no history",
    );

    // ============================================================
    // 4. Complete export: subgraph({ composition: true })
    // ============================================================

    console.log(
      "\n=== 4. subgraph({ composition: true }) exports the whole unit ===\n",
    );

    const exportPodcast = await store.nodes.Podcast.create({
      title: "Field Notes",
    });
    const exportEpisode = await store.nodes.Episode.create(
      { title: "Launch Day" },
      { partOf: { kind: "Podcast", id: exportPodcast.id } },
    );
    const exportSegmentOne = await store.nodes.Segment.create(
      { label: "intro" },
      {
        partOf: {
          kind: "Episode",
          id: exportEpisode.id,
          props: { order: 1 },
        },
      },
    );
    const exportSegmentTwo = await store.nodes.Segment.create(
      { label: "outro" },
      {
        partOf: {
          kind: "Episode",
          id: exportEpisode.id,
          props: { order: 2 },
        },
      },
    );

    const unit = await store.subgraph(exportPodcast.id, {
      edges: [],
      composition: true,
    });
    console.log(
      `  exported ${unit.nodes.size} nodes rooted at ${requireDefined(unit.root).kind}/${requireDefined(unit.root).id}`,
    );
    assertEqual(
      requireDefined(unit.root).kind,
      "Podcast",
      "the export's root is the podcast",
    );
    assertEqual(
      new Set(unit.nodes.keys()),
      new Set([
        exportPodcast.id,
        exportEpisode.id,
        exportSegmentOne.id,
        exportSegmentTwo.id,
      ]),
      "the export carries the podcast, its episode, AND both segments",
    );

    // ============================================================
    // 5. Cascade receipt: delete the whole, inspect the cascade
    // ============================================================

    console.log(
      "\n=== 5. Deleting the whole cascades leaf-first, reported as cascadedParts ===\n",
    );

    startedOperations.length = 0;
    endedOperations.length = 0;

    const { receipt } = await store.transactionWithReceipt(async (tx) => {
      await tx.nodes.Podcast.delete(exportPodcast.id);
    });

    console.log(`  onOperationEnd fired ${endedOperations.length} time(s)`);
    assertEqual(
      endedOperations.length,
      1,
      "exactly one operation event for the whole's delete — the cascade adds none",
    );
    const endContext = requireDefined(endedOperations[0]);
    assertEqual(endContext.kind, "Podcast", "the event is the Podcast delete");
    const expectedCascade = [
      { kind: "Segment", id: exportSegmentOne.id },
      { kind: "Segment", id: exportSegmentTwo.id },
      { kind: "Episode", id: exportEpisode.id },
    ];
    console.log(
      `  hook cascadedParts: ${JSON.stringify(endContext.cascadedParts)}`,
    );
    assertEqual(
      endContext.cascadedParts,
      expectedCascade,
      "onOperationEnd names the cascaded parts leaf-first",
    );
    assertTrue(
      requireDefined(startedOperations[0]).cascadedParts === undefined,
      "onOperationStart never carries cascadedParts — the cascade isn't planned yet",
    );

    console.log(
      `  transactionWithReceipt cascadedParts: ${JSON.stringify(receipt.cascadedParts)}`,
    );
    assertEqual(
      receipt.cascadedParts,
      expectedCascade,
      "the receipt reports the identical cascade",
    );
    assertEqual(
      receipt.writes.nodes,
      { Podcast: 1 },
      "the cascade is NOT folded into the write counters — one delete call, one write intent",
    );
    assertEqual(
      await store.nodes.Episode.getById(exportEpisode.id),
      undefined,
      "the cascaded episode is actually gone",
    );
    assertEqual(
      await store.nodes.Segment.getById(exportSegmentOne.id),
      undefined,
      "the cascaded segment is actually gone",
    );

    console.log("\n=== Composition lifecycle example complete ===");
  } finally {
    await backend.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
