/**
 * Contract B: the plan-artifact apply accounts for a staged identity retraction
 * exactly as the direct merge does. A branch retracts an identity assertion and
 * then ends one endpoint's validity window (the only order the store accepts).
 * merge() lands both; planMerge() + applyMergePlan() (and so
 * applyMergePlanInTransaction / applyDurableMergePlan) refuses the same plan with
 * IDENTITY_ENDPOINT_VALIDITY, because applyWireMergeWrites writes node rows
 * before the retraction while applyInternalMergePlan retracts first.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import {
  applyMergePlan,
  branch,
  isErr,
  merge,
  planMerge,
  unwrap,
} from "../../../src/graph-merge";
import { asBranchId } from "../../../src/graph-merge/types";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "audit_apply_wire_retraction_order",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});
const LATE = "2030-01-01T00:00:00.000Z";
const ref = (id: string) => ({ kind: "Person", id }) as const;

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});
function openBackend() {
  const { backend } = createLocalSqliteBackend();
  disposers.push(() => backend.close());
  return backend;
}

async function scenario() {
  const [target] = await createStoreWithSchema(graph, openBackend(), {
    history: true,
  });
  await target.nodes.Person.create({ name: "a" }, { id: "a" });
  await target.nodes.Person.create({ name: "b" }, { id: "b" });
  const { assertion } = await target.identity.assertSame(ref("a"), ref("b"));
  const source = unwrap(
    await branch(target, () => Promise.resolve(openBackend()), {
      id: asBranchId("src"),
    }),
  );
  await source.store.identity.retractAssertion(assertion.id);
  await source.store.nodes.Person.update("b" as never, {}, { validTo: LATE });
  return { target, source };
}

describe("apply-wire-retraction-order", () => {
  it("planMerge + applyMergePlan lands a retraction plus an endpoint window end that merge() lands", async () => {
    const direct = await scenario();
    const directResult = await merge(direct.target, [direct.source]);
    expect(isErr(directResult)).toBe(false);

    const planned = await scenario();
    const plan = unwrap(await planMerge(planned.target, [planned.source]));
    const applied = await applyMergePlan(planned.target, plan);
    if (isErr(applied)) {
      console.info("apply refused:", applied.error.code, applied.error.message);
    }
    expect(isErr(applied)).toBe(false);
    expect(await planned.target.identity.areSame(ref("a"), ref("b"))).toBe(
      false,
    );
  });
});
