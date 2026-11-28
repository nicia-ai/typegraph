/**
 * An adopted merge apply from another copy of TypeGraph (the same release
 * loaded as both an ES module and a CommonJS build) inside a transaction this
 * copy's Store opened.
 *
 * The apply's collection writes run as children of its operation through a
 * child surface the transaction context's runtime carries under a
 * module-private key, which another copy cannot read. Another copy never
 * reaches that lookup: it cannot tell which Store owns the context, and
 * refuses the apply before any statement, as it did before child surfaces
 * existed.
 */
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import * as hostMerge from "../../src/graph-merge/merge";
import { unwrap } from "../../src/graph-merge/result";
import { asBranchId } from "../../src/graph-merge/types";

const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string() }),
});
const graph = defineGraph({
  id: "adopted_apply_foreign_copy",
  nodes: { Patient: { type: Patient } },
  edges: {},
});

/** A second module tree of the merge module: another copy of TypeGraph's. */
async function foreignMerge(): Promise<typeof hostMerge> {
  vi.resetModules();
  return import("../../src/graph-merge/merge");
}

describe("an adopted merge apply from another library copy", () => {
  it("is refused before any statement, naming the merge transaction's Store", async () => {
    const { backend } = createLocalSqliteBackend();
    const [target] = await createStoreWithSchema(graph, backend, {
      revisionTracking: true,
    });
    const source = unwrap(
      await branch(
        target,
        () => Promise.resolve(createLocalSqliteBackend().backend),
        {
          id: asBranchId("adopted-apply-foreign-copy"),
        },
      ),
    );
    await source.store.nodes.Patient.create({ name: "Ada" }, { id: "p1" });
    const artifact = unwrap(await hostMerge.planMerge(target, [source]));

    const foreign = await foreignMerge();
    expect(foreign.applyMergePlanInTransaction).not.toBe(
      hostMerge.applyMergePlanInTransaction,
    );
    const refusal = await target.transaction(async (tx) =>
      foreign.applyMergePlanInTransaction(target, tx, artifact).then(
        () => "applied",
        (error: unknown) =>
          error instanceof Error && "details" in error ?
            error.details
          : String(error),
      ),
    );

    expect({
      refusal,
      patients: (await target.nodes.Patient.find()).map((node) => node.id),
    }).toEqual({
      refusal: { capability: "mergeTransactionStore" },
      patients: [],
    });
    await backend.close();
  });
});
