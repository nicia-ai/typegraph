/**
 * A durable plan under `reconcileTypes: "ontology"` with a CROSS-ID retype
 * cluster: `p` staged as both `P` and its subclass `E`, similarity-fused with
 * `c`. The cluster is written under the reconciled kind `E`, and the plan's
 * resolution names that same kind — the artifact's own resolution-evidence
 * check compares the two, so a resolution that still named the staged
 * survivor kind failed every such plan's self-validation.
 */
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  subClassOf,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import { branch } from "../../src/graph-merge/branch";
import { applyMergePlan, planMerge } from "../../src/graph-merge/merge";
import { isErr, unwrap } from "../../src/graph-merge/result";
import { asBranchId } from "../../src/graph-merge/types";
import { requireDefined } from "../../src/utils/presence";

const P = defineNode("P", { schema: z.object({ name: z.string() }) });
const E = defineNode("E", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "plan_retype_resolution",
  nodes: { P: { type: P }, E: { type: E } },
  edges: {},
  ontology: [subClassOf(E, P)],
});

describe("plan artifact — a cross-id retype cluster's resolution", () => {
  const disposers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
  });

  function makeBackend() {
    const result = createLocalSqliteBackend();
    disposers.push(() => result.backend.close());
    return result.backend;
  }

  it("names the reconciled kind, so the plan validates and applies", async () => {
    const [base] = await createStoreWithSchema(graph, makeBackend(), {
      history: true,
    });
    const source = unwrap(
      await branch(base, () => Promise.resolve(makeBackend()), {
        id: asBranchId("a"),
      }),
    );
    await source.store.nodes.P.create({ name: "C" }, { id: "c" });
    await source.store.nodes.P.create({ name: "P" }, { id: "p" });
    await source.store.nodes.E.create({ name: "P" }, { id: "p" });

    const planned = await planMerge(base, [source], {
      reconcileTypes: "ontology",
      resolve: {
        P: {
          block: () => "all",
          threshold: 0.5,
          similarity: { kind: "custom", score: () => 1 },
        },
      },
    });
    if (isErr(planned)) throw planned.error;
    const artifact = planned.data;
    const resolution = requireDefined(artifact.review.resolutions[0]);
    console.info(
      "resolution:",
      resolution,
      artifact.review.typeReconciliations,
    );
    expect(resolution.canonicalId).toBe("c");
    expect(resolution.kind).toBe("E");
    expect(artifact.review.typeReconciliations).toEqual([
      expect.objectContaining({ entityId: "c", toType: "E" }),
    ]);

    const applied = unwrap(await applyMergePlan(base, artifact));
    expect(requireDefined(applied.resolutions[0]).kind).toBe("E");
    expect((await base.nodes.E.find()).map((row) => row.id)).toEqual(["c"]);
    expect(await base.nodes.P.find()).toEqual([]);
  });
  // MUTATION CHECK: in `buildInternalMergePlan` (src/graph-merge/merge.ts)
  // drop the retype map lookup from the returned `resolutions` (name the
  // staged survivor kind `P` again) — `planMerge` then fails its own artifact
  // validation with "A resolution must name its complete guarded cluster and
  // carry exactly N-1 decisive edges." and `throw planned.error` fails this
  // test.
});
