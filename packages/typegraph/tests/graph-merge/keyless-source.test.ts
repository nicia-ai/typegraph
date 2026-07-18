/**
 * `keyless` source contract (design §6.2): the bounded coarse source for the NO-KEY
 * case. A kind whose `block()` returns `undefined` for every node lands them all in the
 * shared `"unblocked"` bucket — otherwise compared ALL-vs-all (O(n²)) and then
 * TRUNCATED to id-only by `maxComparisonsPerKind`. Setting `keyless: { window }` bounds
 * that bucket by single-pass sorted-neighbourhood instead.
 *
 * The headline test proves it CLOSES THE CLIFF: a node set whose all-vs-all pair count
 * exceeds the ceiling (so the default path errors) merges cleanly under a small window,
 * because windowing keeps the comparison count under the budget — and the near-
 * duplicates that are adjacent in the similarity-text sort still merge. Plus a
 * determinism check (shuffled creation order → identical committed graph). Both backends.
 */
import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { merge } from "../../src/graph-merge/merge";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import type { GraphBranch, MergeOptions } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { requireDefined } from "../../src/utils/presence";
import { backendMatrix } from "./test-utils";

// No unique constraint, no block key → every node falls into the "unblocked" bucket.
const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string() }),
});
const careGraph = defineGraph({
  id: "keyless-care",
  nodes: { Patient: { type: Patient } },
  edges: {},
});
type CareGraph = typeof careGraph;
type CareStore = GraphBranch<CareGraph>["store"];

const BRANCH = asBranchId("provider-x");

// Six unblocked patients; sorted by lowercased name they are:
//   "ana rivera", "anna rivera", "bob lee", "carol king", "dave poe", "eve stone".
// The two Riveras are ADJACENT (and Dice ≈ 0.857 ≥ 0.85), so even window=1 compares —
// and merges — them, while nothing else is similar.
const PATIENTS: readonly { id: string; name: string }[] = [
  { id: "p-ana", name: "Ana Rivera" },
  { id: "p-anna", name: "Anna Rivera" },
  { id: "p-bob", name: "Bob Lee" },
  { id: "p-carol", name: "Carol King" },
  { id: "p-dave", name: "Dave Poe" },
  { id: "p-eve", name: "Eve Stone" },
];
// All-vs-all over 6 nodes = 15 pairs; a ceiling of 10 truncates it. window=1 over the
// 6 sorted nodes = 5 pairs, comfortably under the ceiling.
const CEILING = 10;

function options(
  overrides: Partial<MergeOptions<CareGraph>> = {},
): MergeOptions<CareGraph> {
  return {
    resolve: {
      Patient: {
        // No `block` → every node is unblocked.
        keyless: { window: 1 },
        similarity: { kind: "fulltext", fields: ["name"] },
        threshold: 0.85,
      },
    },
    maxComparisonsPerKind: CEILING,
    onComparisonCeiling: "error",
    branchOrder: [BRANCH],
    ...overrides,
  };
}

describe.each(backendMatrix())("keyless source [$name]", (entry) => {
  let cleanups: (() => Promise<void>)[];

  afterEach(async () => {
    for (const cleanup of cleanups ?? []) {
      await cleanup();
    }
    cleanups = [];
  });

  async function makeBackend(): Promise<GraphBackend> {
    const fixture = await entry.make();
    cleanups.push(fixture.cleanup);
    return fixture.backend;
  }

  async function emptyStore(): Promise<CareStore> {
    const [store] = await createStoreWithSchema(careGraph, await makeBackend());
    return store;
  }

  /** A branch off `base` that stages `patients` as new Patient nodes (in `order`). */
  async function branchWith(
    base: CareStore,
    order: readonly { id: string; name: string }[],
  ): Promise<GraphBranch<CareGraph>> {
    const provider = unwrap(
      await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH }),
    );
    await provider.store.nodes.Patient.bulkCreate(
      order.map((patient) => ({
        id: patient.id,
        props: { name: patient.name },
      })),
    );
    return provider;
  }

  it("CLOSES THE CLIFF: all-vs-all would exceed the ceiling, but windowing merges under it", async () => {
    cleanups = [];

    // Default path (no keyless): 15 all-vs-all pairs > ceiling 10 → the configured
    // "error" ceiling fires. This is the quadratic cliff keyless exists to close.
    const cliffBase = await emptyStore();
    const cliffProvider = await branchWith(cliffBase, PATIENTS);
    const cliff = await merge<CareGraph>(cliffBase, [cliffProvider], {
      resolve: {
        Patient: {
          similarity: { kind: "fulltext", fields: ["name"] },
          threshold: 0.85,
        },
      },
      maxComparisonsPerKind: CEILING,
      onComparisonCeiling: "error",
      branchOrder: [BRANCH],
    });
    expect(isErr(cliff)).toBe(true);
    if (isErr(cliff)) {
      expect(cliff.error.message).toMatch(/ceiling/i);
    }

    // Keyless path: window=1 over the same 6 nodes = 5 pairs < 10 → no ceiling, and the
    // adjacent Riveras still merge.
    const base = await emptyStore();
    const provider = await branchWith(base, PATIENTS);
    const result = await merge<CareGraph>(base, [provider], options());
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) {
      return;
    }
    const names = (await base.nodes.Patient.find())
      .map((patient) => patient.name)
      .sort();
    // 6 staged → 5 committed (the two Riveras collapsed into one).
    expect(names).toHaveLength(5);
    expect(names.filter((name) => name.includes("Rivera"))).toHaveLength(1);
    expect(result.data.resolutions.length).toBeGreaterThanOrEqual(1);
  });

  it("is DETERMINISTIC: shuffled creation order yields the same committed graph", async () => {
    cleanups = [];
    const shuffled = [
      requireDefined(PATIENTS[3]),
      requireDefined(PATIENTS[0]),
      requireDefined(PATIENTS[5]),
      requireDefined(PATIENTS[1]),
      requireDefined(PATIENTS[4]),
      requireDefined(PATIENTS[2]),
    ];

    const baseNatural = await emptyStore();
    const natural = await merge<CareGraph>(
      baseNatural,
      [await branchWith(baseNatural, PATIENTS)],
      options(),
    );
    const baseShuffled = await emptyStore();
    const reordered = await merge<CareGraph>(
      baseShuffled,
      [await branchWith(baseShuffled, shuffled)],
      options(),
    );
    expect(isOk(natural) && isOk(reordered)).toBe(true);

    const namesOf = async (store: CareStore): Promise<readonly string[]> =>
      (await store.nodes.Patient.find()).map((patient) => patient.name).sort();
    expect(await namesOf(baseShuffled)).toEqual(await namesOf(baseNatural));
  });
});
