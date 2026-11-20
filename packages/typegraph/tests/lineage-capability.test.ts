/**
 * The optional `lineage` capability module — the refusal `requireLineage`
 * gives a caller when a backend declares no `lineage`, and that it returns
 * the backend's own member, unchanged, when one is present.
 *
 * No bundled backend implements `lineage` yet (that lands with the store's
 * own recorded-relations lineage), so the "present" cases here overlay a
 * scripted `LineageMembers` directly, the same shape a future engine
 * profile would supply through `EngineProvisioning.lineage`.
 */
import { describe, expect, it } from "vitest";

import { requireLineage } from "../src/backend/capabilities/lineage";
import { deriveBackend } from "../src/backend/derive-backend";
import {
  type EngineRevision,
  type GraphBackend,
  type LineageDelta,
  type LineageMembers,
} from "../src/backend/types";
import { ConfigurationError } from "../src/errors";
import { createTestBackend } from "./test-utils";

function scriptedLineage(
  revision: string,
  delta: LineageDelta,
): LineageMembers {
  return {
    revision: () => Promise.resolve(revision as EngineRevision),
    changesSince: () => Promise.resolve(delta),
  };
}

describe("requireLineage refusals", () => {
  it("refuses a backend with no lineage member, naming both lineage and the caller's operation", () => {
    const backendWithNoLineage: Pick<GraphBackend, "lineage"> = {
      lineage: undefined,
    };

    let thrown: unknown;
    try {
      requireLineage(backendWithNoLineage, "pruned diff");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const configurationError = thrown as ConfigurationError;
    expect(configurationError.details["code"]).toBe("LINEAGE_UNAVAILABLE");
    expect(configurationError.message).toContain("lineage");
    expect(configurationError.message).toContain("pruned diff");
  });

  it("returns the backend's own lineage member, unchanged, when present", () => {
    const lineage = scriptedLineage("r1", { kind: "unbounded" });
    const backend = deriveBackend(createTestBackend(), { lineage });

    expect(requireLineage(backend, "test")).toBe(lineage);
  });

  it("is absent by default on a bundled backend, since neither dialect implements it yet", () => {
    const backend = createTestBackend();

    expect(backend.lineage).toBeUndefined();
    expect(() => requireLineage(backend, "test")).toThrow(ConfigurationError);
  });
});
