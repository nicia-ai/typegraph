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
 * The distinction is DERIVED, not guessed: the cascade ends assertions at the
 * node's own `deleted_at`, so an ended assertion's end instant identifies what
 * ended it. These tests pin both halves — the state-diff's per-assertion cause
 * and the planner decision built on it — including the same-branch
 * retract-then-delete sequence, which a branch-level provenance heuristic
 * cannot separate from a pure cascade and therefore over-drops.
 */
import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
 * Waits until the wall clock has left the current millisecond.
 *
 * Assertion end instants are stored at millisecond resolution, so a retraction
 * issued in the SAME millisecond as the delete that follows it is
 * indistinguishable from that delete's cascade (documented on
 * `RetractionCause`, which resolves the tie conservatively). A test that means
 * "the branch retracted, and LATER deleted" has to make the two acts separable
 * — real branch edits are, back-to-back statements in a test are not.
 */
function nextMillisecond(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 2);
  });
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
    // one deletion, two retractions) and separable only by end instant.
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
    await forkBranch.store.identity.retractAssertion(
      asIdentityAssertionId("explicit-id"),
    );
    await nextMillisecond();
    await forkBranch.store.nodes.Anchor.delete("b" as never);

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

  it("derives a cascade cause from a hard delete, which leaves no end instant", async () => {
    // A hard delete removes the assertion ROWS along with the node, so no end
    // instant survives to compare. Nothing but that delete can have removed
    // them, so the cause is still exact.
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
    // Branch A retracts cascade-id EXPLICITLY and then deletes endpoint b —
    // one branch, both acts. Branch C modifies b, so the deletion is
    // overruled and b survives. A's retraction is not the deletion's side
    // effect (it closed the row before the delete ran, at its own instant),
    // so it must survive the deletion being overruled.
    //
    // Branch-level provenance cannot see this: A is the only contributor and
    // it did delete an overruled endpoint, so the pre-#367 heuristic
    // classified the retraction as cascade-only and dropped it, keeping truth
    // A had explicitly ended.
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
    await retractThenDelete.store.identity.retractAssertion(
      asIdentityAssertionId("cascade-id"),
    );
    await nextMillisecond();
    await retractThenDelete.store.nodes.Anchor.delete("b" as never);
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
    await retractBranch.store.identity.retractAssertion(
      asIdentityAssertionId("cascade-id"),
    );
    await nextMillisecond();
    await retractBranch.store.nodes.Anchor.delete("b" as never);
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
    // The undecidable end of the derivation: a hard delete leaves nothing to
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
});
