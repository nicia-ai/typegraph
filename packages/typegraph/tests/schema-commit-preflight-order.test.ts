/**
 * Guards that `composeSchemaCommitPreflight` — the one place the
 * schema-commit preflight step order is spelled — runs its roles in the
 * canonical order: structural gates, then `edgeMatchIdentityPreflight`, then
 * the ontology-tightening preflight, then the identity preflight. Call sites
 * name each step by role rather than by position, so no commit path can
 * reorder them; this file therefore certifies the order every path runs.
 *
 * The end-to-end guards for "ontology before the identity closure rebuild"
 * live in `tests/identity.test.ts` (one case per path that can owe both
 * preflights), and the adopted path's tightening refusal lives in the shared
 * `tests/backends/integration/adopted-evolution.ts` suite.
 */
import { describe, expect, it } from "vitest";

import { type SchemaCommitPreflightBackend } from "../src/backend/types";
import { composeSchemaCommitPreflight } from "../src/schema/manager";
import { type SchemaTighteningPreflight } from "../src/schema/tightening-preflight";

function recordingStep(
  calls: string[],
  name: string,
): (target: SchemaCommitPreflightBackend) => Promise<void> {
  return () => {
    calls.push(name);
    return Promise.resolve();
  };
}

function recordingTightening(
  calls: string[],
  name: string,
): SchemaTighteningPreflight {
  return {
    run: recordingStep(calls, name),
    probedChanges: [],
    newlyConstrainedAxes: [],
    capabilityError: { code: "TEST", message: "test" },
  };
}

describe("composeSchemaCommitPreflight", () => {
  it("runs its roles in the canonical order: structural, edge-match-identity, ontology, identity", async () => {
    const calls: string[] = [];
    const preflight = composeSchemaCommitPreflight({
      identity: recordingStep(calls, "identity"),
      tightening: recordingTightening(calls, "ontology"),
      edgeMatchIdentity: recordingStep(calls, "edge-match-identity"),
      structural: recordingStep(calls, "structural"),
    });

    await preflight({} as SchemaCommitPreflightBackend);

    expect(calls).toEqual([
      "structural",
      "edge-match-identity",
      "ontology",
      "identity",
    ]);
  });

  // MUTATION CHECK: reordering the role list inside
  // `composeSchemaCommitPreflight` makes this assertion fail.

  it("drops undefined roles and returns undefined when every role is undefined", async () => {
    expect(
      composeSchemaCommitPreflight({
        structural: undefined,
        edgeMatchIdentity: undefined,
        tightening: undefined,
        identity: undefined,
      }),
    ).toBeUndefined();

    const calls: string[] = [];
    const preflight = composeSchemaCommitPreflight({
      structural: undefined,
      edgeMatchIdentity: undefined,
      tightening: recordingTightening(calls, "only-step"),
      identity: undefined,
    });
    await preflight?.({} as SchemaCommitPreflightBackend);
    expect(calls).toEqual(["only-step"]);
  });

  it("awaits each step before starting the next", async () => {
    const order: string[] = [];
    const preflight = composeSchemaCommitPreflight({
      structural: async () => {
        order.push("first-start");
        await Promise.resolve();
        order.push("first-end");
      },
      edgeMatchIdentity: undefined,
      tightening: undefined,
      identity: () => {
        order.push("second-start");
        return Promise.resolve();
      },
    });
    await preflight({} as SchemaCommitPreflightBackend);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });
});
