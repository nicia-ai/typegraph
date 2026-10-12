/**
 * A merge option is applied or refused, never ignored. Normalization reads each
 * declared option by name, so a key `MergeOptions` does not declare — a typo,
 * or an option this release does not offer, such as an `identity` policy bag —
 * would otherwise be dropped and the merge would run as though the caller had
 * never stated it. Every entry point that accepts options refuses it instead,
 * naming the key, before anything is planned or written.
 *
 * Also pins the option evidence a review artifact stores: the frozen literal
 * below is what an options-free caller produced before identity-aware merges
 * existed, and such an artifact must keep revalidating `compatible`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../src";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import {
  branch,
  captureCandidateWriteSetTarget,
  InvalidMergeOptionsError,
  isErr,
  merge,
  MERGE_PLAN_FORMAT_VERSION,
  type MergeOptions,
  planCandidateWriteSetReview,
  planMerge,
  revalidateCandidateWriteSetReview,
  unwrap,
} from "../../src/graph-merge";
import { normalizeMergeOptions } from "../../src/graph-merge/options";
import { reviewOptionEvidence } from "../../src/graph-merge/review-evidence";
import { asBranchId } from "../../src/graph-merge/types";

const OPTION_EVIDENCE_WITHOUT_OPTIONS = [
  "object",
  [
    ["onBasePropertyConflict", ["literal", "flag"]],
    ["onComparisonCeiling", ["literal", "error"]],
    ["onDeleteModifyConflict", ["literal", "flag"]],
    ["onPropertyConflict", ["literal", "flag"]],
    ["persistProvenance", ["literal", false]],
    ["provenance", ["literal", true]],
    ["reconcileTypes", ["literal", "off"]],
    ["resolve", ["object", []]],
  ],
] as const;

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "undeclared_merge_options",
  nodes: { Item: { type: Item } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});
const BRANCH = asBranchId("branch-a");

/** An options bag stating a key the type does not declare, as an untyped caller would. */
function undeclared(
  options: Readonly<Record<string, unknown>>,
): MergeOptions<typeof graph> {
  return options;
}

const UNDECLARED_IDENTITY_OPTIONS = undeclared({
  identity: { onAssertionConflict: "assertWins" },
});
const REVIEW_POLICY = { id: "review-policy", context: {} } as const;

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function openBackend() {
  const { backend } = createLocalSqliteBackend();
  disposers.push(() => backend.close());
  return backend;
}

async function targetWithBranch() {
  const [target] = await createStoreWithSchema(graph, openBackend(), {
    history: true,
  });
  const source = unwrap(
    await branch(target, () => Promise.resolve(openBackend()), { id: BRANCH }),
  );
  await source.store.nodes.Item.create({ name: "Fresh" }, { id: "fresh" });
  await source.store.nodes.Item.create({ name: "Other" }, { id: "other" });
  await source.store.identity.assertSame(
    { kind: "Item", id: "fresh" },
    { kind: "Item", id: "other" },
  );
  return { target, source };
}

async function reviewArgs() {
  const [target] = await createStoreWithSchema(graph, openBackend(), {
    history: true,
  });
  return {
    target,
    makeBackend: () => Promise.resolve(createLocalSqliteBackend().backend),
    writeSet: {
      formatVersion: 1 as const,
      sourceId: "source",
      target: await captureCandidateWriteSetTarget(target),
      nodes: [
        {
          kind: "Item",
          id: "candidate",
          properties: { name: "New" },
          validFrom: "2026-01-01T00:00:00.000Z",
        },
      ],
      edges: [],
    },
    policy: REVIEW_POLICY,
  };
}

function expectUndeclaredOptionRefusal(error: unknown, option: string): void {
  console.info("refusal", error);
  expect(error).toBeInstanceOf(InvalidMergeOptionsError);
  expect((error as InvalidMergeOptionsError).details["option"]).toBe(option);
}

describe("an undeclared merge option is refused, never ignored", () => {
  it("normalization refuses an `identity` bag, naming the key", () => {
    let thrown: unknown;
    try {
      normalizeMergeOptions(UNDECLARED_IDENTITY_OPTIONS);
    } catch (error) {
      thrown = error;
    }
    expectUndeclaredOptionRefusal(thrown, "identity");
  });

  it("the options type refuses it at compile time too", () => {
    const typed: MergeOptions<typeof graph> = {
      // @ts-expect-error -- `identity` is not a declared merge option.
      identity: { onAssertionConflict: "assertWins" },
    };
    expect(() => normalizeMergeOptions(typed)).toThrow(
      InvalidMergeOptionsError,
    );
  });

  it("normalization refuses a mistyped option rather than running without it", () => {
    let thrown: unknown;
    try {
      normalizeMergeOptions(undeclared({ reconcileType: "ontology" }));
    } catch (error) {
      thrown = error;
    }
    expectUndeclaredOptionRefusal(thrown, "reconcileType");
  });

  it("normalization still accepts every declared option", () => {
    expect(
      normalizeMergeOptions({
        reconcileTypes: "ontology",
        onDeleteModifyConflict: "deleteWins",
        branchOrder: [BRANCH],
        candidateDiagnostics: { limit: 1 },
      }),
    ).toMatchObject({
      reconcileTypes: "ontology",
      onDeleteModifyConflict: "deleteWins",
    });
  });

  it("merge() refuses it and writes nothing", async () => {
    const { target, source } = await targetWithBranch();
    const result = await merge(target, [source], UNDECLARED_IDENTITY_OPTIONS);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expectUndeclaredOptionRefusal(result.error, "identity");
    expect(await target.nodes.Item.find()).toEqual([]);
  });

  it("planMerge() refuses it", async () => {
    const { target, source } = await targetWithBranch();
    const result = await planMerge(
      target,
      [source],
      UNDECLARED_IDENTITY_OPTIONS,
    );
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expectUndeclaredOptionRefusal(result.error, "identity");
  });

  it("review evidence refuses it rather than digesting an option the merge would drop", () => {
    let thrown: unknown;
    try {
      reviewOptionEvidence(UNDECLARED_IDENTITY_OPTIONS);
    } catch (error) {
      thrown = error;
    }
    expectUndeclaredOptionRefusal(thrown, "identity");
  });

  it("a candidate write-set review refuses it", async () => {
    const result = await planCandidateWriteSetReview({
      ...(await reviewArgs()),
      options: UNDECLARED_IDENTITY_OPTIONS,
    });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expectUndeclaredOptionRefusal(result.error, "identity");
  });
});

describe("stored review and plan artifacts stay compatible", () => {
  it("an options-free bag encodes to the frozen option evidence, field for field", () => {
    expect(reviewOptionEvidence({})).toEqual(OPTION_EVIDENCE_WITHOUT_OPTIONS);
  });

  it("a review stored with the frozen option evidence still revalidates compatible", async () => {
    const planned = await reviewArgs();
    const review = unwrap(await planCandidateWriteSetReview(planned));
    // Both sides computed by the current code could not fail; the stored side
    // is the frozen literal.
    const stored = {
      ...(JSON.parse(JSON.stringify(review)) as typeof review),
      options: OPTION_EVIDENCE_WITHOUT_OPTIONS,
    };
    const revalidated = unwrap(
      await revalidateCandidateWriteSetReview({
        ...(await reviewArgs()),
        target: planned.target,
        review: stored,
      }),
    );
    expect(revalidated.status).toBe("compatible");
  });

  it("a merge that writes identity assertions plans a format-version-2 artifact with no identity review entries", async () => {
    const { target, source } = await targetWithBranch();
    const artifact = unwrap(await planMerge(target, [source]));
    expect(MERGE_PLAN_FORMAT_VERSION).toBe(2);
    expect(artifact.formatVersion).toBe(MERGE_PLAN_FORMAT_VERSION);
    expect(artifact.writes.identityAssertions).toHaveLength(1);
    expect(Object.keys(artifact.review)).not.toContain("identityConflicts");
    expect(Object.keys(artifact.review)).not.toContain(
      "identityReconciliations",
    );
  });
});
