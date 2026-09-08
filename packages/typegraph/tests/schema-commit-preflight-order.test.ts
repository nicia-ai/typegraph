/**
 * The load-bearing test for "ontology before the identity closure rebuild".
 *
 * `composeSchemaCommitPreflight` is the one place the schema-commit preflight
 * step order is spelled: structural gates, then `edgeMatchIdentityPreflight`,
 * then the ontology-tightening preflight, then the identity preflight. An
 * integration test that only observes "the commit rolled back" cannot tell
 * the two orders apart, because both roll back — this test observes the
 * order directly through four recording steps.
 *
 * `tests/identity.test.ts` ("rejects contradictory existing groups before
 * committing enablement", "revalidates identity for ontology-only schema
 * migrations") independently confirms the SAME order end-to-end: a
 * commit that is both an ontology-tightening violation AND an identity
 * contradiction surfaces `MigrationError` `"ontology-tightening-violated"`,
 * not `ConfigurationError` `"IDENTITY_SCHEMA_CONTRADICTION"` — which is
 * only possible if the ontology preflight runs first.
 */
import { describe, expect, it } from "vitest";

import { type SchemaCommitPreflightBackend } from "../src/backend/types";
import { composeSchemaCommitPreflight } from "../src/schema/manager";

function recordingStep(
  calls: string[],
  name: string,
): (target: SchemaCommitPreflightBackend) => Promise<void> {
  return () => {
    calls.push(name);
    return Promise.resolve();
  };
}

describe("composeSchemaCommitPreflight", () => {
  it("runs its steps in the canonical order: dropped-kinds, edge-match-identity, ontology, identity", async () => {
    const calls: string[] = [];
    const preflight = composeSchemaCommitPreflight([
      recordingStep(calls, "dropped-kinds"),
      recordingStep(calls, "edge-match-identity"),
      recordingStep(calls, "ontology"),
      recordingStep(calls, "identity"),
    ]);

    expect(preflight).toBeDefined();
    await preflight({} as SchemaCommitPreflightBackend);

    expect(calls).toEqual([
      "dropped-kinds",
      "edge-match-identity",
      "ontology",
      "identity",
    ]);
  });

  // MUTATION CHECK (recorded in lane-A-load-bearing.md): reversing the
  // iteration order inside `composeSchemaCommitPreflight` makes this
  // assertion fail.

  it("drops undefined steps and returns undefined when every step is undefined", async () => {
    expect(
      composeSchemaCommitPreflight([undefined, undefined]),
    ).toBeUndefined();

    const calls: string[] = [];
    const preflight = composeSchemaCommitPreflight([
      undefined,
      recordingStep(calls, "only-step"),
      undefined,
    ]);
    await preflight?.({} as SchemaCommitPreflightBackend);
    expect(calls).toEqual(["only-step"]);
  });

  it("awaits each step before starting the next", async () => {
    const order: string[] = [];
    const preflight = composeSchemaCommitPreflight([
      async () => {
        order.push("first-start");
        await Promise.resolve();
        order.push("first-end");
      },
      () => {
        order.push("second-start");
        return Promise.resolve();
      },
    ]);
    await preflight({} as SchemaCommitPreflightBackend);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });
});
