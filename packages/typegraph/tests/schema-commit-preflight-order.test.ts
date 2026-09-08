/**
 * Guards that `composeSchemaCommitPreflight` — the one place the
 * schema-commit preflight step order is spelled — iterates its steps in the
 * canonical order: structural gates, then `edgeMatchIdentityPreflight`, then
 * the ontology-tightening preflight, then the identity preflight. This test
 * observes the COMPOSER's own FIFO iteration through four recording steps;
 * it says nothing about what order any real call site passes those steps
 * in, because it builds its own step array rather than importing one.
 *
 * The load-bearing guard for "ontology before the identity closure rebuild"
 * at each real call site lives in `tests/identity.test.ts`, end-to-end, one
 * case per path that can owe both preflights: `ensureSchema`'s auto-migrate
 * branch ("rejects contradictory existing groups before committing
 * enablement", "revalidates identity for ontology-only schema migrations"),
 * `migrateSchema` ("refuses the same tightening driven through
 * migrateSchema directly, before the identity closure rebuild"), and
 * `Store.evolve` ("refuses the same tightening driven through
 * Store.evolve(), before the identity closure rebuild"). Each constructs a
 * commit that is simultaneously an ontology-tightening violation AND an
 * identity contradiction and asserts it surfaces `MigrationError`
 * `"ontology-tightening-violated"`, not `ConfigurationError`
 * `"IDENTITY_SCHEMA_CONTRADICTION"` — reachable only if that call site's OWN
 * composed array orders the ontology preflight first. A call-site reorder
 * on any one of the three paths leaves this file green and fails only its
 * own case in `identity.test.ts`.
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
