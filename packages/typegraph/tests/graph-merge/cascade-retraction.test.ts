/**
 * Cascade retractions as first-class staged operations.
 *
 * A node soft-delete ENDS every open identity assertion touching the node, so a
 * branch that deletes a node produces retractions it never asked for. The merge
 * has to tell those cascade endings apart from a branch's own retraction,
 * because their fates differ: a cascade belongs to its deletion (dropped when
 * delete/modify resolution overrules the deletion, applied when it survives),
 * while an explicit retraction is intent the deletion decision does not speak
 * to.
 *
 * The distinction is READ, not guessed: the cascade STAMPS the deleted node's
 * `(kind, id)` onto every assertion row it ends, so an ended row states its own
 * cause. These tests pin both halves — the state-diff's per-assertion cause and
 * the planner decision built on it — including the same-branch
 * retract-then-delete sequence, which a branch-level provenance heuristic
 * cannot separate from a pure cascade and therefore over-drops.
 *
 * Every retract-then-delete case here runs on a FROZEN clock, so the retraction
 * and the delete that follows it are stored at one identical instant. That is
 * the case the superseded derivation — comparing an assertion's `valid_to` to a
 * deleted endpoint's `deleted_at` — could not see through at all: it read the
 * collision as a cascade and dropped intent the branch had stated. Reading the
 * stamp makes the two acts separable no matter how close together they fall.
 */
import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { merge } from "../../src/graph-merge/merge";
import { RETRACTION_DELETION_OVERRULED_DROP_REASON } from "../../src/graph-merge/merge-identity";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import { diffAgainstBase } from "../../src/graph-merge/state-diff";
import { asBranchId } from "../../src/graph-merge/types";
import { asIdentityAssertionId } from "../../src/identity/types";
import { importGraph } from "../../src/interchange";
import { storeRuntime } from "../../src/store/runtime-port";
import { requireDefined } from "../../src/utils/presence";
import { backendMatrix, identityAssertionDocument } from "./test-utils";

const Anchor = defineNode("Anchor", {
  schema: z.object({ name: z.string() }),
});

const anchoredGraph = defineGraph({
  id: "cascade_retraction",
  nodes: { Anchor: { type: Anchor } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});

/**
 * Runs `body` with the app clock pinned to one instant, so every timestamp it
 * stamps is byte-identical.
 *
 * Back-to-back statements usually land in one millisecond anyway, but "usually"
 * is not a test: freezing the clock makes the collision certain on every run
 * and every backend. Only `Date` is faked, so driver timers keep working.
 */
async function atOneInstant(body: () => Promise<void>): Promise<void> {
  const instant = new Date();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instant);
  try {
    await body();
  } finally {
    vi.useRealTimers();
  }
}

const BRANCH_A = asBranchId("branch-a");
const BRANCH_B = asBranchId("branch-b");
const BRANCH_C = asBranchId("branch-c");

describe.each(backendMatrix())("cascade retraction [$name]", (entry) => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    const outcomes = await Promise.allSettled(
      cleanups.toReversed().map((cleanup) => cleanup()),
    );
    const rejection = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    if (rejection !== undefined) {
      throw rejection.reason instanceof Error ?
          rejection.reason
        : new Error(String(rejection.reason));
    }
  });

  async function makeBackend(): Promise<GraphBackend> {
    const fixture = await entry.make();
    cleanups.push(fixture.cleanup);
    return fixture.backend;
  }

  /** A fork point holding anchors a..d and no assertions. */
  async function anchoredForkPoint() {
    const [forkPoint] = await createStoreWithSchema(
      anchoredGraph,
      await makeBackend(),
    );
    for (const id of ["a", "b", "c", "d"]) {
      await forkPoint.nodes.Anchor.create({ name: id }, { id });
    }
    return forkPoint;
  }

  function assertionDocument(
    id: string,
    a: string,
    b: string,
  ): Parameters<typeof importGraph>[1] {
    return identityAssertionDocument("Anchor", id, a, b);
  }

  it("derives the cause of every retraction in a fork's diff", async () => {
    // One fork, three assertions on the deleted endpoint b:
    //   explicit-id  — retracted by the branch, THEN b was deleted;
    //   cascade-id   — ended only by the deletion of b;
    //   untouched-id — not touching b at all, still current.
    // The first two are indistinguishable by branch provenance (one branch,
    // one deletion, two retractions), and both acts land on ONE instant, so
    // they are separable only by the stamp the cascade leaves behind.
    const forkPoint = await anchoredForkPoint();
    for (const [id, a, b] of [
      ["explicit-id", "a", "b"],
      ["cascade-id", "b", "c"],
      ["untouched-id", "a", "d"],
    ] as const) {
      const imported = await importGraph(
        forkPoint,
        assertionDocument(id, a, b),
        { onConflict: "skip" },
      );
      expect(imported.success).toBe(true);
    }
    const forkBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await atOneInstant(async () => {
      await forkBranch.store.identity.retractAssertion(
        asIdentityAssertionId("explicit-id"),
      );
      await forkBranch.store.nodes.Anchor.delete("b" as never);
    });

    const diff = await diffAgainstBase(forkPoint, forkBranch.store);

    expect(diff.identity.retracted.map((entry) => entry.assertion.id)).toEqual([
      "cascade-id",
      "explicit-id",
    ]);
    const causeById = new Map(
      diff.identity.retracted.map((entry) => [entry.assertion.id, entry.cause]),
    );
    expect(causeById.get("cascade-id")).toEqual({
      kind: "cascade",
      deletedNode: { kind: "Anchor", id: "b" },
    });
    expect(causeById.get("explicit-id")).toEqual({ kind: "explicit" });
  });

  it("treats a stamp from a deletion the fork itself undid as explicit", async () => {
    // The fork deleted b (stamping the cascade onto the assertion) and then
    // brought b back. Its final state stages no deletion for b, so there is no
    // deletion decision the ending can belong to — the ending stands on its
    // own and must not be droppable as some other branch's overruled cascade.
    const forkPoint = await anchoredForkPoint();
    const imported = await importGraph(
      forkPoint,
      assertionDocument("cascade-id", "a", "b"),
      { onConflict: "skip" },
    );
    expect(imported.success).toBe(true);
    const forkBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await forkBranch.store.nodes.Anchor.delete("b" as never);
    await forkBranch.store.nodes.Anchor.create({ name: "b" }, { id: "b" });

    const diff = await diffAgainstBase(forkPoint, forkBranch.store);

    expect(diff.nodes.deleted).toEqual([]);
    expect(requireDefined(diff.identity.retracted[0])).toMatchObject({
      assertion: { id: "cascade-id" },
      cause: { kind: "explicit" },
    });
  });

  it("derives a cascade cause from a hard delete, which leaves no stored cause", async () => {
    // A hard delete removes the assertion ROWS along with the node, taking the
    // stored cause with them. Nothing but that delete can have removed them,
    // so the cause is still exact — this is the one residue the stored column
    // does not remove, and it is by design.
    const forkPoint = await anchoredForkPoint();
    const imported = await importGraph(
      forkPoint,
      assertionDocument("cascade-id", "a", "b"),
      { onConflict: "skip" },
    );
    expect(imported.success).toBe(true);
    const forkBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await forkBranch.store.nodes.Anchor.hardDelete("b" as never);

    const diff = await diffAgainstBase(forkPoint, forkBranch.store);

    expect(requireDefined(diff.identity.retracted[0])).toMatchObject({
      assertion: { id: "cascade-id" },
      cause: { kind: "cascade", deletedNode: { kind: "Anchor", id: "b" } },
    });
    expect(
      requireDefined(diff.nodes.deleted.find((deletion) => deletion.id === "b"))
        .deletedAt,
    ).toBeUndefined();
  });

  it("keeps a retraction the deleting branch made before deleting the node", async () => {
    // THE SIGNATURE CASE. Branch A retracts cascade-id EXPLICITLY and then
    // deletes endpoint b — one branch, both acts, ONE stored instant. Branch C
    // modifies b, so the deletion is overruled and b survives. A's retraction
    // is not the deletion's side effect (it closed the row before the delete
    // ran, so the cascade never touched it and left no stamp), so it must
    // survive the deletion being overruled.
    //
    // Neither superseded rule can reach that answer here: branch-level
    // provenance sees A as the only contributor and it did delete an overruled
    // endpoint, and the timestamp derivation sees an end instant equal to b's
    // `deleted_at`. Both call it a cascade and drop truth A explicitly ended.
    const forkPoint = await anchoredForkPoint();
    const imported = await importGraph(
      forkPoint,
      assertionDocument("cascade-id", "a", "b"),
      { onConflict: "skip" },
    );
    expect(imported.success).toBe(true);
    const retractThenDelete = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await atOneInstant(async () => {
      await retractThenDelete.store.identity.retractAssertion(
        asIdentityAssertionId("cascade-id"),
      );
      await retractThenDelete.store.nodes.Anchor.delete("b" as never);
    });
    const modifyBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_C }),
    );
    await modifyBranch.store.nodes.Anchor.update("b" as never, {
      name: "b-modified",
    });

    const result = await merge(forkPoint, [retractThenDelete, modifyBranch], {
      branchOrder: [BRANCH_A, BRANCH_C],
    });
    if (isErr(result)) throw result.error;
    expect(isOk(result)).toBe(true);
    expect(result.data.deleteModifyConflicts.length).toBeGreaterThan(0);
    // The node survives the overruled deletion; A's explicit retraction
    // survives with it.
    expect(await forkPoint.nodes.Anchor.getById("b" as never)).toMatchObject({
      name: "b-modified",
    });
    const rows = await storeRuntime(forkPoint).identityAssertionRowsByIds([
      "cascade-id",
    ]);
    expect(rows.get("cascade-id")?.validTo).toBeDefined();
    expect(result.data.dropped.some((item) => item.id === "cascade-id")).toBe(
      false,
    );
  });

  it("keeps one branch's explicit retraction against another branch's cascade", async () => {
    // Cross-branch provenance: branch A retracts cascade-id explicitly and
    // then deletes b; branch B only deletes b, so it stages the SAME id as a
    // pure cascade. Branch C modifies b, overruling both deletions.
    //
    // The id therefore reaches the planner with two DIFFERENT causes. One
    // branch's cascade dying with its overruled deletion must not carry away
    // the other branch's intent, so the retraction is applied. Branch-level
    // provenance saw both contributors as "deleted an overruled endpoint" and
    // dropped it.
    const forkPoint = await anchoredForkPoint();
    const imported = await importGraph(
      forkPoint,
      assertionDocument("cascade-id", "a", "b"),
      { onConflict: "skip" },
    );
    expect(imported.success).toBe(true);
    const retractBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await atOneInstant(async () => {
      await retractBranch.store.identity.retractAssertion(
        asIdentityAssertionId("cascade-id"),
      );
      await retractBranch.store.nodes.Anchor.delete("b" as never);
    });
    const deleteBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_B }),
    );
    await deleteBranch.store.nodes.Anchor.delete("b" as never);
    const modifyBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_C }),
    );
    await modifyBranch.store.nodes.Anchor.update("b" as never, {
      name: "b-modified",
    });

    const result = await merge(
      forkPoint,
      [retractBranch, deleteBranch, modifyBranch],
      { branchOrder: [BRANCH_A, BRANCH_B, BRANCH_C] },
    );
    if (isErr(result)) throw result.error;
    expect(isOk(result)).toBe(true);
    const rows = await storeRuntime(forkPoint).identityAssertionRowsByIds([
      "cascade-id",
    ]);
    expect(rows.get("cascade-id")?.validTo).toBeDefined();
    expect(result.data.dropped.some((item) => item.id === "cascade-id")).toBe(
      false,
    );
  });

  it("drops a hard-delete cascade when the deletion is overruled", async () => {
    // The one undecidable case left: a hard delete leaves nothing to
    // separate cascade from intent, so the retraction is classified as the
    // cascade it must be and dropped with the overruled deletion — keeping
    // the resurrected node's identity truth.
    const forkPoint = await anchoredForkPoint();
    const imported = await importGraph(
      forkPoint,
      assertionDocument("cascade-id", "a", "b"),
      { onConflict: "skip" },
    );
    expect(imported.success).toBe(true);
    const deleteBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await deleteBranch.store.nodes.Anchor.hardDelete("b" as never);
    const modifyBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_B }),
    );
    await modifyBranch.store.nodes.Anchor.update("b" as never, {
      name: "b-modified",
    });

    const result = await merge(forkPoint, [deleteBranch, modifyBranch], {
      branchOrder: [BRANCH_A, BRANCH_B],
    });
    if (isErr(result)) throw result.error;
    expect(isOk(result)).toBe(true);
    expect(result.data.dropped).toContainEqual({
      kind: "identity",
      id: "cascade-id",
      reason: RETRACTION_DELETION_OVERRULED_DROP_REASON,
    });
    const rows = await storeRuntime(forkPoint).identityAssertionRowsByIds([
      "cascade-id",
    ]);
    expect(rows.get("cascade-id")?.validTo).toBeUndefined();
  });

  it("applies a cascade whose deletion survives the merge", async () => {
    // The other half of tying a cascade to its cause: nothing contests the
    // deletion, so the node dies and the ending it caused is applied.
    const forkPoint = await anchoredForkPoint();
    const imported = await importGraph(
      forkPoint,
      assertionDocument("cascade-id", "a", "b"),
      { onConflict: "skip" },
    );
    expect(imported.success).toBe(true);
    const deleteBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await deleteBranch.store.nodes.Anchor.delete("b" as never);

    const result = await merge(forkPoint, [deleteBranch], {
      branchOrder: [BRANCH_A],
    });
    if (isErr(result)) throw result.error;
    expect(isOk(result)).toBe(true);
    expect(await forkPoint.nodes.Anchor.getById("b" as never)).toBeUndefined();
    const rows = await storeRuntime(forkPoint).identityAssertionRowsByIds([
      "cascade-id",
    ]);
    expect(rows.get("cascade-id")?.validTo).toBeDefined();
    expect(result.data.dropped.some((item) => item.id === "cascade-id")).toBe(
      false,
    );
  });

  it("hands the cause on to the merge target, so a second diff still reads it", async () => {
    // The stored cause has to COMPOSE, or it only survives one merge. A merge
    // commits its node deletions BEFORE the identity applier, so the target's
    // own cascade stamps the row and the applier's retraction finds nothing
    // open left to end. Flip that order and the applier would close the row
    // unstamped, the later cascade would skip it (it only ends OPEN rows), and
    // every merged-through cascade would degrade to `explicit` — the exact
    // misclassification this ledger column exists to prevent, reintroduced one
    // merge downstream.
    const forkPoint = await anchoredForkPoint();
    const imported = await importGraph(
      forkPoint,
      assertionDocument("cascade-id", "a", "b"),
      { onConflict: "skip" },
    );
    expect(imported.success).toBe(true);
    // Taken BEFORE the merge, so it can serve as the base the merged target is
    // diffed against afterwards.
    const preMerge = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_C }),
    );
    const deleteBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await deleteBranch.store.nodes.Anchor.delete("b" as never);

    const result = await merge(forkPoint, [deleteBranch], {
      branchOrder: [BRANCH_A],
    });
    if (isErr(result)) throw result.error;
    const rows = await storeRuntime(forkPoint).identityAssertionRowsByIds([
      "cascade-id",
    ]);
    expect(rows.get("cascade-id")?.endedBy).toEqual({
      kind: "Anchor",
      id: "b",
    });
    // And the target now diffs the way the branch did.
    const secondDiff = await diffAgainstBase(preMerge.store, forkPoint);
    expect(requireDefined(secondDiff.identity.retracted[0])).toMatchObject({
      assertion: { id: "cascade-id" },
      cause: { kind: "cascade", deletedNode: { kind: "Anchor", id: "b" } },
    });
  });

  it("hands on an EXPLICIT retraction with no cause attached", async () => {
    // The contrast that makes the case above mean something: the applier ends
    // the target's row itself here, and an applier ending is nobody's cascade.
    const forkPoint = await anchoredForkPoint();
    const imported = await importGraph(
      forkPoint,
      assertionDocument("cascade-id", "a", "b"),
      { onConflict: "skip" },
    );
    expect(imported.success).toBe(true);
    const retractBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await retractBranch.store.identity.retractAssertion(
      asIdentityAssertionId("cascade-id"),
    );

    const result = await merge(forkPoint, [retractBranch], {
      branchOrder: [BRANCH_A],
    });
    if (isErr(result)) throw result.error;
    const row = requireDefined(
      (
        await storeRuntime(forkPoint).identityAssertionRowsByIds(["cascade-id"])
      ).get("cascade-id"),
    );
    expect(row.validTo).toBeDefined();
    expect(row.endedBy).toBeUndefined();
  });

  it("carries a branch-authored retrospective identity window through merge", async () => {
    const [forkPoint] = await createStoreWithSchema(
      anchoredGraph,
      await makeBackend(),
    );
    for (const id of ["historical-a", "historical-b"]) {
      await forkPoint.nodes.Anchor.create(
        { name: id },
        { id, validFrom: "2019-01-01T00:00:00.000Z" },
      );
    }
    const source = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    const assertion = await source.store.identity.assertSame(
      { kind: "Anchor", id: "historical-a" as never },
      { kind: "Anchor", id: "historical-b" as never },
      {
        validFrom: "2020-01-01T00:00:00.000Z",
        validTo: "2022-01-01T00:00:00.000Z",
      },
    );

    const diff = await diffAgainstBase(forkPoint, source.store);
    expect(diff.identity.new).toEqual([assertion.assertion]);

    const result = await merge(forkPoint, [source], {
      branchOrder: [BRANCH_A],
    });
    if (isErr(result)) throw result.error;
    expect(
      await forkPoint
        .asOf("2021-01-01T00:00:00.000Z")
        .identity.areSame(
          { kind: "Anchor", id: "historical-a" as never },
          { kind: "Anchor", id: "historical-b" as never },
        ),
    ).toBe(true);
    expect(
      await forkPoint.identity.areSame(
        { kind: "Anchor", id: "historical-a" as never },
        { kind: "Anchor", id: "historical-b" as never },
      ),
    ).toBe(false);
  });
});
