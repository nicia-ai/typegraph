/**
 * A get-or-create `partOf` postcondition decides the incumbent's disposition
 * UNDER THE FENCE, and writes the attachment in the same transaction as the
 * property update it came with.
 *
 * The cross-backend suite (`tests/backends/integration/composition-*.ts`)
 * asserts the outcomes of the attachment surface on a real engine, but it
 * cannot place a competing write in the window between the lock-free
 * pre-check and the fenced re-read: two calls started with `Promise.all`
 * usually serialize on a single-connection engine, so an implementation that
 * acts on the stale pre-check verdict passes by luck. This file removes the
 * luck — the racing attachment is performed INSIDE the pre-check's own read
 * (a wrapper on the root backend's `findEdgesConnectedTo`, through
 * `deriveBackend`, never a spread copy), after the read has already answered,
 * so the second caller's pre-check provably observed a pre-attach snapshot.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CompositionExistenceError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
  UniquenessError,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import {
  type FindEdgesConnectedToParams,
  type GraphBackend,
} from "../src/backend/types";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const AfWhole = defineNode("AfWhole", { schema: z.object({}) });
const AfPart = defineNode("AfPart", {
  schema: z.object({ slug: z.string(), code: z.string() }),
});
const AF_SLUG_UNIQUE = {
  name: "af_part_slug",
  fields: ["slug"],
  scope: "kind",
  collation: "binary",
} as const;
/**
 * A SECOND unique constraint, on a field the get-or-create lookup does NOT
 * key on: what lets one call match an existing part by `slug` while the
 * property update it carries collides with another part's `code`.
 */
const AF_CODE_UNIQUE = {
  name: "af_part_code",
  fields: ["code"],
  scope: "kind",
  collation: "binary",
} as const;
const afPartOf = defineEdge("afPartOf", { schema: z.object({}) });

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      AfWhole: { type: AfWhole },
      AfPart: { type: AfPart, unique: [AF_SLUG_UNIQUE, AF_CODE_UNIQUE] },
    },
    edges: {
      afPartOf: {
        type: afPartOf,
        from: [AfPart],
        to: [AfWhole],
        cardinality: "one",
      },
    },
    // `existence: "optional"` (the default): the part can exist unattached,
    // which is the state a get-or-create postcondition repairs.
    ontology: [partOf(AfPart, AfWhole, { via: afPartOf })],
  });
}

/**
 * Decorates the ROOT backend's `findEdgesConnectedTo` — the read the
 * `partOf` pre-check runs outside any transaction — so that an armed race
 * hook runs AFTER the read resolved and BEFORE its rows are returned. The
 * caller therefore holds a snapshot that the hook's own committed write has
 * already invalidated, which is exactly the state a stale verdict would act
 * on.
 */
function raceablePreCheckBackend(
  base: GraphBackend,
  state: {
    hook: (() => Promise<void>) | undefined;
    partId: string | undefined;
  },
): GraphBackend {
  return deriveBackend(base, {
    findEdgesConnectedTo: async (params: FindEdgesConnectedToParams) => {
      const rows = await base.findEdgesConnectedTo(params);
      const hook = state.hook;
      if (hook !== undefined && params.nodeId === state.partId) {
        state.hook = undefined;
        await hook();
      }
      return rows;
    },
  });
}

describe("get-or-create's partOf postcondition under the fence", () => {
  it("refuses a part that acquired a DIFFERENT whole between the pre-check and the fenced re-read, leaving the winner's attachment", async () => {
    const state: {
      hook: (() => Promise<void>) | undefined;
      partId: string | undefined;
    } = { hook: undefined, partId: undefined };
    const backend = raceablePreCheckBackend(createTestBackend(), state);
    const [store] = await createStoreWithSchema(
      buildGraph("af_refuse_race"),
      backend,
    );

    const wholeA = await store.nodes.AfWhole.create({});
    const wholeB = await store.nodes.AfWhole.create({});
    const part = await store.nodes.AfPart.create({
      slug: "contested",
      code: "c1",
    });
    state.partId = part.id;

    // The competing caller: attaches the part to A, and commits, while the
    // refusing caller below is holding a pre-attach read.
    state.hook = async () => {
      const attached = await store.nodes.AfPart.getOrCreateByConstraint(
        "af_part_slug",
        { slug: "contested", code: "c1" },
        { partOf: { kind: "AfWhole", id: wholeA.id } },
      );
      expect(attached.action).toBe("found");
    };

    // MUTATION CHECK: state `onIncumbent: "replace"` in
    // `resolveGetOrCreateAttachmentRequest`
    // (src/store/operations/node-operations.ts), or act on the lock-free
    // pre-check's verdict instead of the fenced re-read's. This call then
    // MOVES the part to B — no refusal at all — and the final assertion
    // finds the part under the loser's whole.
    const refusal = await store.nodes.AfPart.getOrCreateByConstraint(
      "af_part_slug",
      { slug: "contested", code: "c1" },
      { partOf: { kind: "AfWhole", id: wholeB.id } },
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(CompositionExistenceError);
    const details = (refusal as CompositionExistenceError).details;
    expect(details.situation).toBe("existing");
    expect(details.currentWhole).toEqual({ kind: "AfWhole", id: wholeA.id });
    expect(details.requestedWhole).toEqual({ kind: "AfWhole", id: wholeB.id });
    expect(details.requestedVia).toBe("afPartOf");

    // Exactly one attachment, held by the winner.
    const edges = await store.edges.afPartOf.find(
      {},
      { temporalMode: "includeEnded" },
    );
    expect(edges).toHaveLength(1);
    expect(requireDefined(edges[0]).toId).toBe(wholeA.id);
    // The hook ran: the race really happened.
    expect(state.hook).toBeUndefined();
  });

  it("is satisfied when the whole acquired in that same window is the one it asked for", async () => {
    const state: {
      hook: (() => Promise<void>) | undefined;
      partId: string | undefined;
    } = { hook: undefined, partId: undefined };
    const backend = raceablePreCheckBackend(createTestBackend(), state);
    const [store] = await createStoreWithSchema(
      buildGraph("af_idempotent_race"),
      backend,
    );

    const whole = await store.nodes.AfWhole.create({});
    const part = await store.nodes.AfPart.create({
      slug: "converging",
      code: "c1",
    });
    state.partId = part.id;

    state.hook = async () => {
      await store.nodes.AfPart.getOrCreateByConstraint(
        "af_part_slug",
        { slug: "converging", code: "c1" },
        { partOf: { kind: "AfWhole", id: whole.id } },
      );
    };

    // MUTATION CHECK: make the fenced verdict treat ANY incumbent as a
    // contradiction (drop the `incumbentHoldsRequestedAttachment` arm from
    // `decideCompositionIncumbent`, src/store/operations/composition-create.ts)
    // and this convergent second call refuses instead of resolving.
    const result = await store.nodes.AfPart.getOrCreateByConstraint(
      "af_part_slug",
      { slug: "converging", code: "c1" },
      { partOf: { kind: "AfWhole", id: whole.id } },
    );
    expect(result.action).toBe("found");

    // One attachment, not two, and no retired window from a needless move.
    const edges = await store.edges.afPartOf.find(
      {},
      { temporalMode: "includeEnded" },
    );
    expect(edges).toHaveLength(1);
    expect(requireDefined(edges[0]).meta.validTo).toBeUndefined();
    expect(state.hook).toBeUndefined();
  });

  it("leaves an unattached part unattached when the ifExists update it came with is refused", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(
      buildGraph("af_one_write_plan"),
      backend,
    );

    const whole = await store.nodes.AfWhole.create({});
    const keeper = await store.nodes.AfPart.create({
      slug: "keeper",
      code: "free",
    });
    await store.nodes.AfPart.create({ slug: "other", code: "taken" });

    // MUTATION CHECK: run the attachment in its own write plan again (call
    // `applyExistingPartOfPostcondition` before `executeNodeUpsertUpdate`
    // instead of passing `compositionAttachment` into it,
    // src/store/operations/node-operations.ts). The attachment then commits
    // before the update is refused, and both assertions below fail: the edge
    // exists, and the part holds a whole the call it came with never applied.
    const refusal = await store.nodes.AfPart.getOrCreateByConstraint(
      "af_part_slug",
      { slug: "keeper", code: "taken" },
      {
        ifExists: "update",
        partOf: { kind: "AfWhole", id: whole.id },
      },
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(UniquenessError);

    // No attachment, in any window state: the refused update took the
    // attachment with it.
    const edges = await store.edges.afPartOf.find(
      {},
      { temporalMode: "includeEnded" },
    );
    expect(edges).toEqual([]);

    // And the property the call tried to write never landed either.
    const reread = requireDefined(await store.nodes.AfPart.getById(keeper.id));
    expect(reread.code).toBe("free");
  });
});
