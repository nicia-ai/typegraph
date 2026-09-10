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
  CardinalityError,
  CompositionExistenceError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  EndpointNotFoundError,
  partOf,
  UniquenessError,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import {
  type FindEdgesConnectedToParams,
  type GraphBackend,
  type TransactionBackend,
  type TransactionOptions,
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
/**
 * The realizing edge carries one optional property, so a caller can restate
 * `partOf.props` the way an idempotent ingest does.
 */
const afPartOf = defineEdge("afPartOf", {
  schema: z.object({ rank: z.number().optional() }),
});

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
 * The same shape with `targetCardinality: "one"` on the realizing edge: a
 * whole holds at most one part, so attaching a second is a refusal the
 * edge's own PREPARATION raises (a cardinality read), not the incumbent
 * decision — the class of refusal that used to follow the property update.
 */
function buildSinglePartWholeGraph(id: string) {
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
        targetCardinality: "one",
      },
    },
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

describe("a refused attachment and the property update it came with", () => {
  /**
   * The refusal the FENCED incumbent decision raises must precede the
   * property update's first statement, not follow it. A caller that catches
   * the refusal inside an enclosing `store.transaction(...)` is the case that
   * can tell the two orders apart: the get-or-create leg runs on the
   * caller's transaction (`resolveWriteTransactionMode` answers `"existing"`),
   * so there is no nested frame to roll back and whatever statements already
   * ran stay committed with the enclosing transaction.
   */
  it("leaves the property update unapplied when the fenced attachment refuses and the caller catches it inside a transaction", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(
      buildGraph("af_refuse_before_update"),
      backend,
    );

    const wholeA = await store.nodes.AfWhole.create({});
    const wholeB = await store.nodes.AfWhole.create({});
    const part = await store.nodes.AfPart.create({
      slug: "owned",
      code: "original",
    });
    await store.nodes.AfPart.reparent(part.id, {
      kind: "AfWhole",
      id: wholeA.id,
    });

    // MUTATION CHECK: move the `decideCompositionAttachmentUnderFence` call
    // in `executeNodeUpsertUpdate` back below
    // `performNodeUpdateWithResurrectionRecovery`
    // (src/store/operations/node-operations.ts). The refused attachment then
    // follows the update, and `code` below reads "mutated".
    await store.transaction(async (tx) => {
      const refusal = await tx.nodes.AfPart.getOrCreateByConstraint(
        "af_part_slug",
        { slug: "owned", code: "mutated" },
        {
          ifExists: "update",
          partOf: { kind: "AfWhole", id: wholeB.id },
        },
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(CompositionExistenceError);
      expect((refusal as CompositionExistenceError).details.situation).toBe(
        "existing",
      );
    });

    const reread = requireDefined(await store.nodes.AfPart.getById(part.id));
    expect(reread.code).toBe("original");

    const edges = await store.edges.afPartOf.find(
      {},
      { temporalMode: "includeEnded" },
    );
    expect(edges).toHaveLength(1);
    expect(requireDefined(edges[0]).toId).toBe(wholeA.id);
    expect(requireDefined(edges[0]).meta.validTo).toBeUndefined();
  });

  /**
   * The same precedence question as the previous test, for the refusal a
   * DEAD whole raises rather than a conflicting incumbent: both must precede
   * the property update, because both are now decided inside
   * `decideCompositionAttachmentUnderFence` before it returns.
   */
  it("leaves an unattached part unattached when the requested whole is dead and the caller catches it inside a transaction", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(
      buildGraph("af_refuse_dead_whole_before_update"),
      backend,
    );

    const whole = await store.nodes.AfWhole.create({});
    const part = await store.nodes.AfPart.create({
      slug: "unattached",
      code: "original",
    });
    await store.nodes.AfWhole.delete(whole.id);

    // MUTATION CHECK: delete the whole-liveness read in
    // `decideCompositionAttachmentUnderFence`
    // (src/store/operations/composition-create.ts) — i.e. revert to letting
    // `attachCompositionCreateEdge`'s own `assertLiveEdgeEndpoints` be the
    // only place a dead whole is caught. The refusal then follows
    // `performNodeUpdateWithResurrectionRecovery` instead of preceding it,
    // and `code` below reads "mutated".
    await store.transaction(async (tx) => {
      const refusal = await tx.nodes.AfPart.getOrCreateByConstraint(
        "af_part_slug",
        { slug: "unattached", code: "mutated" },
        {
          ifExists: "update",
          partOf: { kind: "AfWhole", id: whole.id },
        },
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(EndpointNotFoundError);
      expect((refusal as EndpointNotFoundError).details.endpoint).toBe("to");
    });

    const reread = requireDefined(await store.nodes.AfPart.getById(part.id));
    expect(reread.code).toBe("original");

    const edges = await store.edges.afPartOf.find(
      {},
      { temporalMode: "includeEnded" },
    );
    expect(edges).toEqual([]);
  });

  /**
   * The refusals the realizing edge's own preparation owns — here a
   * cardinality read against a whole that already holds its one part — must
   * precede the property update as well: the get-or-create leg prepares the
   * edge before the update and issues only the insert after it.
   */
  it("leaves the property update unapplied when the edge's own cardinality read refuses and the caller catches it inside a transaction", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(
      buildSinglePartWholeGraph("af_refuse_cardinality_before_update"),
      backend,
    );

    const whole = await store.nodes.AfWhole.create({});
    const occupant = await store.nodes.AfPart.create(
      { slug: "occupant", code: "occupant" },
      { partOf: { kind: "AfWhole", id: whole.id } },
    );
    const part = await store.nodes.AfPart.create({
      slug: "second",
      code: "original",
    });

    // MUTATION CHECK: in `executeNodeUpsertUpdate`
    // (src/store/operations/node-operations.ts), move the
    // `prepareCompositionAttachmentDecision` call below
    // `performNodeUpdateWithResurrectionRecovery`. The cardinality refusal
    // then follows the update, and `code` below reads "mutated".
    await store.transaction(async (tx) => {
      const refusal = await tx.nodes.AfPart.getOrCreateByConstraint(
        "af_part_slug",
        { slug: "second", code: "mutated" },
        {
          ifExists: "update",
          partOf: { kind: "AfWhole", id: whole.id },
        },
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(CardinalityError);
    });

    const reread = requireDefined(await store.nodes.AfPart.getById(part.id));
    expect(reread.code).toBe("original");

    const edges = await store.edges.afPartOf.find(
      {},
      { temporalMode: "includeEnded" },
    );
    expect(edges).toHaveLength(1);
    expect(requireDefined(edges[0]).fromId).toBe(occupant.id);
  });
});

/**
 * Counts the write transactions a call opens. The per-graph write fence is
 * taken inside one (`BEGIN IMMEDIATE` on SQLite, a session advisory lock on
 * Postgres), so "no transaction" is the only observable proof that an
 * already-satisfied resolve stayed read-only.
 */
function transactionCountingBackend(
  base: GraphBackend,
  counter: { transactions: number },
): GraphBackend {
  return deriveBackend(base, {
    transaction: async <T>(
      fn: (tx: TransactionBackend) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> => {
      counter.transactions += 1;
      return base.transaction(fn, options);
    },
  });
}

describe("an already-satisfied partOf resolve", () => {
  /**
   * W2's "the already-satisfied, no-update path stays read-only" must not
   * depend on whether the caller restated the realizing edge's props: an
   * idempotent ingest that passes `partOf: { ..., props }` every time would
   * otherwise take the per-graph write fence on every call for a verdict of
   * "nothing to do" — graph-wide serialization on Postgres, for a no-op.
   */
  it("opens no write transaction when the stated partOf props already AGREE with the live edge", async () => {
    const counter = { transactions: 0 };
    const backend = transactionCountingBackend(createTestBackend(), counter);
    const [store] = await createStoreWithSchema(
      buildGraph("af_satisfied_props_readonly"),
      backend,
    );

    const whole = await store.nodes.AfWhole.create({});
    await store.nodes.AfPart.create({ slug: "ingested", code: "c1" });
    await store.nodes.AfPart.getOrCreateByConstraint(
      "af_part_slug",
      { slug: "ingested", code: "c1" },
      { partOf: { kind: "AfWhole", id: whole.id, props: { rank: 3 } } },
    );

    counter.transactions = 0;
    // MUTATION CHECK: narrow the pre-check's skip back to
    // `request.attachment.props === undefined`
    // (`applyExistingPartOfPostcondition`,
    // src/store/operations/node-operations.ts) and this restate opens one
    // write transaction to discover it has nothing to write.
    const again = await store.nodes.AfPart.getOrCreateByConstraint(
      "af_part_slug",
      { slug: "ingested", code: "c1" },
      { partOf: { kind: "AfWhole", id: whole.id, props: { rank: 3 } } },
    );
    expect(again.action).toBe("found");
    expect(counter.transactions).toBe(0);
  });

  /**
   * The other half of the same skip: props that DISAGREE are never decided
   * from the lock-free read. The call escalates to the fence, which is what
   * refuses.
   */
  it("still refuses through the fence when the stated partOf props DIFFER", async () => {
    const counter = { transactions: 0 };
    const backend = transactionCountingBackend(createTestBackend(), counter);
    const [store] = await createStoreWithSchema(
      buildGraph("af_satisfied_props_differ"),
      backend,
    );

    const whole = await store.nodes.AfWhole.create({});
    await store.nodes.AfPart.create({ slug: "ingested", code: "c1" });
    await store.nodes.AfPart.getOrCreateByConstraint(
      "af_part_slug",
      { slug: "ingested", code: "c1" },
      { partOf: { kind: "AfWhole", id: whole.id, props: { rank: 3 } } },
    );

    counter.transactions = 0;
    const refusal = await store.nodes.AfPart.getOrCreateByConstraint(
      "af_part_slug",
      { slug: "ingested", code: "c1" },
      { partOf: { kind: "AfWhole", id: whole.id, props: { rank: 9 } } },
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CompositionExistenceError);
    expect((refusal as CompositionExistenceError).details.situation).toBe(
      "props",
    );
    expect(counter.transactions).toBeGreaterThan(0);
  });
});
