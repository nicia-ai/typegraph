/**
 * The replay algorithm: shape, limits, refusals, retention watermark, and the
 * equivalence pin (L3) — replay's before/after NEVER comes from the
 * transition log's own `class`/`priorClass` columns, only from
 * `historicalIdentityReconstructionCtes` via `loadHistoricalClasses`.
 *
 * `identityReplay` / `identityTransitionsOf` are reached by module path
 * throughout most of this file (the fine-grained refusal/limit/watermark
 * cases below); the trailing "public facade surface" suite exercises the
 * public release surface, `store.identity.replay` / `transitionsOf` and
 * their transaction-facade counterparts, directly.
 */
import { sql as drizzleSql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAdapterStoreWithSchema, defineGraph, defineNode } from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import {
  createRecordedInstant,
  recordedInstantRevision,
} from "../src/core/temporal";
import { IdentityReplayError, ValidationError } from "../src/errors";
import {
  IDENTITY_REPLAY_MAX_LIMIT,
  identityReplay,
  identityTransitionsOf,
} from "../src/identity/replay";
import { pruneIdentityTransitionsForContext } from "../src/identity/transition-log";
import { storeRuntime } from "../src/store/runtime-port";
import { nowIso } from "../src/utils/date";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });

const graph = defineGraph({
  id: "identity_replay",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

async function buildAbcStore() {
  const [store] = await createAdapterStoreWithSchema(
    graph,
    createTestBackend(),
    { history: true },
  );
  await store.nodes.Person.create({ name: "A" }, { id: "a" });
  await store.nodes.Person.create({ name: "B" }, { id: "b" });
  await store.nodes.Person.create({ name: "C" }, { id: "c" });
  return store;
}

describe("identity replay", () => {
  it("refuses replay on a store without history: true", async () => {
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
      { history: false },
    );
    const ctx = storeRuntime(store).identityContext();
    await expect(
      identityReplay(ctx, { kind: "Person", id: "a" }),
    ).rejects.toThrow(IdentityReplayError);
    await expect(
      identityReplay(ctx, { kind: "Person", id: "a" }),
    ).rejects.toMatchObject({
      details: { code: "IDENTITY_REPLAY_REQUIRES_HISTORY" },
    });
  });

  it("rejects a limit above IDENTITY_REPLAY_MAX_LIMIT", async () => {
    const store = await buildAbcStore();
    const ctx = storeRuntime(store).identityContext();
    await expect(
      identityReplay(
        ctx,
        { kind: "Person", id: "a" },
        {
          limit: IDENTITY_REPLAY_MAX_LIMIT + 1,
        },
      ),
    ).rejects.toThrow();
  });

  // Load-bearing: a page size below 1, or a fractional one, is a typed
  // refusal — never a page. Mutation check: drop the
  // `!Number.isInteger(resolved) || resolved < 1` guard from `resolveLimit`
  // (replay.ts) and every case below fails — `limit: 0` resolves to an empty
  // page whose `nextFrom` names the FIRST boundary, so the documented
  // `while (cursor !== undefined)` loop re-reads that same empty page
  // forever, and the fractional cases escape as a bare `TypeError` from
  // `requireDefined` instead of a `ValidationError`.
  it("rejects a limit below 1 or fractional, so a page always advances the cursor", async () => {
    const store = await buildAbcStore();
    const a = { kind: "Person" as const, id: "a" };
    const b = { kind: "Person" as const, id: "b" };
    await store.identity.assertSame(a, b);
    const ctx = storeRuntime(store).identityContext();

    for (const limit of [0, -1, 0.5, 1.5]) {
      await expect(identityTransitionsOf(ctx, a, { limit })).rejects.toThrow(
        ValidationError,
      );
      await expect(identityReplay(ctx, a, { limit })).rejects.toThrow(
        ValidationError,
      );
    }
    await expect(
      identityTransitionsOf(ctx, a, { limit: 0 }),
    ).rejects.toMatchObject({
      details: { issues: [{ path: "limit", message: "Got 0." }] },
    });

    // The smallest ACCEPTED page still moves: one boundary, and a cursor
    // pointing past it.
    const page = await identityTransitionsOf(ctx, a, { limit: 1 });
    expect(page.transitions.length).toBeGreaterThan(0);
  });

  it("replays merge / split / re-merge: every step's before/after matches an independent asOfRecorded read", async () => {
    // G1R2-09: `identityReplay` assigns `before = previousAfter` for every
    // non-first boundary (replay.ts), so a loop comparing `current.before`
    // against `previous.after` compares a value against the variable it was
    // copied from — it cannot fail for any implementation of the walk. Every
    // assertion below instead checks against `store.asOfRecorded(...)`, a
    // read path replay's OWN reconstruction never touches, matching the
    // cross-backend twin (tests/backends/integration/identity-replay.ts).
    const store = await buildAbcStore();
    const a = { kind: "Person" as const, id: "a" };
    const b = { kind: "Person" as const, id: "b" };

    const same1 = await store.identity.assertSame(a, b);
    await store.identity.assertSame(b, { kind: "Person", id: "c" });
    await store.identity.retractAssertion(same1.assertion.id);
    await store.identity.assertSame(a, b);

    const ctx = storeRuntime(store).identityContext();
    const replay = await identityReplay(ctx, a);

    // The exact cause sequence, not merely "contains" — merge (assert a-b),
    // merge (assert b-c, absorbing a transitively), split (retract a-b, in
    // TWO records sharing one boundary: a departs alone, b/c's own record
    // shares the same self-referential canonical), re-merge (assert a-b).
    expect(replay.steps.map((step) => step.transition.cause)).toEqual([
      "assert",
      "assert",
      "retract",
      "retract",
      "assert",
    ]);

    // Every step's `after` — and the first step's `before` — independently
    // verified against `asOfRecorded`, never against another step's own
    // reconstructed value.
    for (const [index, step] of replay.steps.entries()) {
      const after = await store
        .asOfRecorded(step.transition.recorded)
        .identity.membersOf(a);
      expect(step.after.map((ref) => ref.id).toSorted()).toEqual(
        after.map((ref) => ref.id).toSorted(),
      );
      if (index > 0) continue;
      const revision = recordedInstantRevision(step.transition.recorded);
      const beforeInstant = createRecordedInstant(revision - 1, nowIso());
      const before = await store
        .asOfRecorded(beforeInstant)
        .identity.membersOf(a);
      expect(step.before.map((ref) => ref.id).toSorted()).toEqual(
        before.map((ref) => ref.id).toSorted(),
      );
    }

    // The final step's `after` also matches a live membersOf read.
    const lastStep = replay.steps.at(-1);
    if (lastStep === undefined) throw new Error("expected at least one step");
    const liveMembers = await store.identity.membersOf(a);
    expect(lastStep.after.map((ref) => ref.id).toSorted()).toEqual(
      liveMembers.map((ref) => ref.id).toSorted(),
    );
  });

  it("transitionsOf and replay agree on the same transition rows", async () => {
    const store = await buildAbcStore();
    const a = { kind: "Person" as const, id: "a" };
    const b = { kind: "Person" as const, id: "b" };
    await store.identity.assertSame(a, b);

    const ctx = storeRuntime(store).identityContext();
    const { transitions } = await identityTransitionsOf(ctx, a);
    const replay = await identityReplay(ctx, a);
    expect(replay.steps.map((step) => step.transition.transitionId)).toEqual(
      transitions.map((transition) => transition.transitionId),
    );
  });

  // Load-bearing (R3): lineage DISCOVERY must ignore the caller's window.
  // The seed set can only learn a class name from a note that mentions it,
  // and the note that teaches it routinely sits ABOVE the window — the walk
  // starts at the CURRENT canonical and hops backwards through `priorClass`.
  // Mutation check: give `readIdentityTransitions` back its `fromRevision` /
  // `toRevision` filters and pass the caller's bounds into
  // `walkClassLineage` (its pre-R3 shape) — the walk from `a` then reads
  // nothing at or below the first merge's revision, both `windowed` and
  // `windowedReplay` come back empty, and the first two expectations here
  // fail. `pnpm exec vitest run tests/identity-replay.test.ts --maxWorkers=2`.
  it("R3: a windowed read discovers lineage the window itself cannot see", async () => {
    const store = await buildAbcStore();
    const a = { kind: "Person" as const, id: "a" };
    const b = { kind: "Person" as const, id: "b" };
    const c = { kind: "Person" as const, id: "c" };

    // B and C merge FIRST. Every note at this boundary names the {b, c}
    // class — `a` appears nowhere at or below it.
    await store.identity.assertSame(b, c);
    const throughFirstMerge = await store.recordedNow();
    if (throughFirstMerge === undefined) {
      throw new Error("expected a recorded instant");
    }
    // A joins and takes over as canonical (code-point-smallest member), so
    // the walk from `b` now seeds on `a`.
    await store.identity.assertSame(a, b);

    const ctx = storeRuntime(store).identityContext();
    const firstMergeRevision = recordedInstantRevision(throughFirstMerge);

    const { transitions: windowed } = await identityTransitionsOf(ctx, b, {
      toRecorded: throughFirstMerge,
    });
    expect(windowed.length).toBeGreaterThan(0);
    const windowedReplay = await identityReplay(ctx, b, {
      toRecorded: throughFirstMerge,
    });
    expect(windowedReplay.steps.length).toBeGreaterThan(0);

    // The window still narrows the ANSWER — discovery being unbounded must
    // not leak the later boundary back into the result.
    for (const transition of windowed) {
      expect(recordedInstantRevision(transition.recorded)).toBeLessThanOrEqual(
        firstMergeRevision,
      );
    }
    const { transitions: unbounded } = await identityTransitionsOf(ctx, b);
    expect(unbounded.length).toBeGreaterThan(windowed.length);
  });

  // Load-bearing (R7): the boundary limit pages, it never refuses. Mutation
  // check: make `pageBoundaries` (replay.ts) throw when
  // `boundaries.length > limit` instead of cutting the page — every
  // `limit: 1` call below rejects and the whole test fails.
  it("R7: limit caps a page and hands back nextFrom, and the pages reassemble the whole lineage", async () => {
    const store = await buildAbcStore();
    const a = { kind: "Person" as const, id: "a" };
    const b = { kind: "Person" as const, id: "b" };
    const c = { kind: "Person" as const, id: "c" };
    const same1 = await store.identity.assertSame(a, b);
    await store.identity.assertSame(b, c);
    await store.identity.retractAssertion(same1.assertion.id);
    await store.identity.assertSame(a, b);

    const ctx = storeRuntime(store).identityContext();
    const { transitions: whole, nextFrom: wholeNextFrom } =
      await identityTransitionsOf(ctx, a);
    expect(wholeNextFrom).toBeUndefined();
    const wholeBoundaries = new Set(
      whole.map((transition) => transition.recorded),
    );
    expect(wholeBoundaries.size).toBeGreaterThan(2);

    const paged: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page <= wholeBoundaries.size; page += 1) {
      const result = await identityTransitionsOf(ctx, a, {
        limit: 1,
        ...(cursor === undefined ? {} : { fromRecorded: cursor }),
      });
      // Exactly one boundary per page, and the boundary the cursor named.
      expect(
        new Set(result.transitions.map((transition) => transition.recorded))
          .size,
      ).toBe(1);
      paged.push(
        ...result.transitions.map((transition) => transition.transitionId),
      );
      cursor = result.nextFrom;
      if (cursor === undefined) break;
    }
    expect(cursor).toBeUndefined();
    expect(paged).toEqual(whole.map((transition) => transition.transitionId));

    // `replay` pages on the identical boundaries — the two must agree about
    // where a page ended, or an audit view pairing them would drift.
    const firstReplayPage = await identityReplay(ctx, a, { limit: 1 });
    const firstTransitionPage = await identityTransitionsOf(ctx, a, {
      limit: 1,
    });
    expect(firstReplayPage.nextFrom).toBe(firstTransitionPage.nextFrom);
    expect(
      firstReplayPage.steps.map((step) => step.transition.transitionId),
    ).toEqual(
      firstTransitionPage.transitions.map(
        (transition) => transition.transitionId,
      ),
    );
  });

  it("L3: replay's before/after never come from the transition log's own class columns", async () => {
    const { backend, db } = createLocalSqliteBackend();
    const [store] = await createAdapterStoreWithSchema(graph, backend, {
      history: true,
    });
    await store.nodes.Person.create({ name: "A" }, { id: "a" });
    await store.nodes.Person.create({ name: "B" }, { id: "b" });
    await store.nodes.Person.create({ name: "C" }, { id: "c" });
    const a = { kind: "Person" as const, id: "a" };
    const b = { kind: "Person" as const, id: "b" };
    const c = { kind: "Person" as const, id: "c" };
    const same1 = await store.identity.assertSame(a, b);
    await store.identity.assertSame(b, c);
    // The retract's note carries a REAL (non-null) `priorClassRef` (the old
    // canonical, `a`): corrupting only `class_kind`/`class_id` below leaves
    // that field intact, so the row stays discoverable through the reverse
    // lineage hop even once its own identity is garbage — exactly the
    // discoverability the exhaustive-diff design relies on (transition-log.ts).
    await store.identity.retractAssertion(same1.assertion.id);

    const ctx = storeRuntime(store).identityContext();
    const before = await identityReplay(ctx, a);
    expect(before.steps.length).toBeGreaterThanOrEqual(3);

    // Hand-corrupt every transition row's class_kind/class_id to a bogus
    // class that never existed. Written through the RAW drizzle handle, not
    // the store's capture-guarded backend, which refuses raw statement
    // execution while history capture is enabled.
    db.run(
      drizzleSql`UPDATE typegraph_identity_transitions SET class_kind = 'Bogus', class_id = 'nonexistent'`,
    );

    const after = await identityReplay(ctx, a);
    expect(after.steps.length).toBe(before.steps.length);
    for (const [index, step] of after.steps.entries()) {
      const originalStep = before.steps[index];
      if (originalStep === undefined) throw new Error("index mismatch");
      // The explanation changed (we corrupted it)...
      expect(step.transition.class.kind).toBe("Bogus");
      // ...but membership before/after did NOT, because it is reconstructed
      // through historicalIdentityReconstructionCtes, never read off the row.
      expect(step.before.map((ref) => ref.id).toSorted()).toEqual(
        originalStep.before.map((ref) => ref.id).toSorted(),
      );
      expect(step.after.map((ref) => ref.id).toSorted()).toEqual(
        originalStep.after.map((ref) => ref.id).toSorted(),
      );
    }
  });

  it("reports truncatedBefore once transitions are pruned, and throws when the requested range is entirely below the watermark", async () => {
    const store = await buildAbcStore();
    const a = { kind: "Person" as const, id: "a" };
    const b = { kind: "Person" as const, id: "b" };
    await store.identity.assertSame(a, b);
    const ctx = storeRuntime(store).identityContext();
    const beforePruneRecorded = await store.recordedNow();
    if (beforePruneRecorded === undefined) {
      throw new Error("expected a recorded instant");
    }
    const currentAssertions = await store.identity.assertionsOf(a);
    const assertionId = currentAssertions[0]?.id;
    if (assertionId === undefined) throw new Error("expected an assertion");
    await store.identity.retractAssertion(assertionId);
    const watermarkRecorded = await store.recordedNow();
    if (watermarkRecorded === undefined) {
      throw new Error("expected a recorded instant");
    }
    await pruneIdentityTransitionsForContext(ctx, {
      beforeRecorded: watermarkRecorded,
    });

    // Open-ended range: partial truncation is reported, not thrown.
    const partial = await identityReplay(ctx, a);
    expect(partial.truncatedBefore).toBeDefined();

    // Bounded entirely below the watermark: refused.
    await expect(
      identityReplay(ctx, a, {
        fromRecorded: beforePruneRecorded,
        toRecorded: beforePruneRecorded,
      }),
    ).rejects.toMatchObject({
      details: {
        code: "IDENTITY_REPLAY_HISTORY_TRUNCATED",
        requestedFrom: beforePruneRecorded,
        requestedTo: beforePruneRecorded,
      },
    });

    // G1R2-08: with no `fromRecorded` at all (an open start, closed only by
    // `toRecorded`), `requestedFrom` must be ABSENT — never fabricated from
    // `toRecorded`, which is the caller's range END, not its start.
    await expect(
      identityReplay(ctx, a, { toRecorded: beforePruneRecorded }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof IdentityReplayError)) return false;
      if (error.details.code !== "IDENTITY_REPLAY_HISTORY_TRUNCATED") {
        return false;
      }
      return (
        !("requestedFrom" in error.details) &&
        error.details.requestedTo === beforePruneRecorded
      );
    });
  });
});

/**
 * The public release surface: `store.identity.replay` / `transitionsOf` are
 * the package's own facade methods (`createIdentityFacade`), not merely the
 * internal `identityReplay` / `identityTransitionsOf` functions the suite
 * above reaches by path. Both live on `IdentityFacade` (store and
 * transaction) and deliberately NOT on `IdentityReadFacade`: a
 * coordinate-pinned read-only lens cannot honor a method that answers across
 * every recorded coordinate.
 */
describe("identity replay — public facade surface", () => {
  it("store.identity and tx.identity both expose replay and transitionsOf, agreeing on already-committed history", async () => {
    const store = await buildAbcStore();
    const a = { kind: "Person" as const, id: "a" };
    const b = { kind: "Person" as const, id: "b" };
    await store.identity.assertSame(a, b);

    const { transitions: storeTransitions } =
      await store.identity.transitionsOf(a);
    expect(storeTransitions.length).toBeGreaterThan(0);
    const storeReplay = await store.identity.replay(a);
    expect(storeReplay.steps.length).toBe(storeTransitions.length);

    await store.transaction(async (tx) => {
      const { transitions: txTransitions } = await tx.identity.transitionsOf(a);
      expect(txTransitions).toEqual(storeTransitions);
      const txReplay = await tx.identity.replay(a);
      expect(txReplay).toEqual(storeReplay);
    });
  });

  // Load-bearing (receipts, "enabled + history" arm): end-to-end wiring from
  // the recorded-capture flush through to `IdentityWriteSummary.transitions`,
  // beside the disabled/history-off arms covered by
  // `tests/transaction-receipt.test.ts` (recorder unit) and
  // `tests/backends/integration/identity.ts` (history: false). Revert check:
  // in `transactionOutcome` (`src/store/store.ts`), drop the
  // `recorder.recordIdentityTransitions(flushed.identityTransitions)` call —
  // `writes.identity.transitions` reports `0` here despite the assertSame
  // above having noted a transition, and this assertion fails.
  it("reports a nonzero writes.identity.transitions for a history-enabled graph", async () => {
    const store = await buildAbcStore();
    const a = { kind: "Person" as const, id: "a" };
    const b = { kind: "Person" as const, id: "b" };

    const outcome = await store.transactionWithReceipt(async (tx) => {
      await tx.identity.assertSame(a, b);
    });

    expect(outcome.receipt.writes.identity.transitions).toBeGreaterThan(0);
    expect(outcome.receipt.writes.identity.sameAssertions).toBe(1);
    expect(outcome.receipt.writes.total).toBe(
      outcome.receipt.writes.identity.sameAssertions +
        outcome.receipt.writes.identity.differentAssertions +
        outcome.receipt.writes.identity.retractions,
    );
  });

  // Load-bearing (API-surface): revert check — add `replay` and
  // `transitionsOf` to `createIdentityReadFacade`'s returned object (the
  // read-only lens `store.asOf(...).identity` is built from) and this test's
  // `"replay" in view.identity` / `"transitionsOf" in view.identity`
  // assertions flip to `true` and fail. `pnpm exec vitest run
  // tests/identity-replay.test.ts --maxWorkers=2`.
  it("a coordinate-pinned IdentityReadFacade (store.asOf(...).identity) does NOT expose replay or transitionsOf", async () => {
    const store = await buildAbcStore();
    const view = store.asOf(nowIso());
    expect("replay" in view.identity).toBe(false);
    expect("transitionsOf" in view.identity).toBe(false);
    // The full read surface is otherwise intact — this is a narrow exclusion,
    // not a broken lens.
    expect(typeof view.identity.membersOf).toBe("function");
    expect(typeof view.identity.assertionsOf).toBe("function");
  });
});
