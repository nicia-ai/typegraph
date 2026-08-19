/**
 * T22 (rows a, b) — no verdict ever carries a function-valued field (I19).
 * A verdict crosses transaction boundaries safely BECAUSE it contains
 * nothing bound to a connection; a function slipping into a verdict would be
 * exactly the hazard `createRecordedTransactionBackend`'s overlay guards
 * against, generalized. Rows (c)/(d) are B7/B8's.
 */
import { describe, expect, it } from "vitest";

import {
  BATCH_POINT_READ,
  CLAIMS,
  CONTRIBUTION_HEALTH,
  RECORDED_REVISION_ORIGINS,
  STATEMENT_EXECUTION,
  UNIQUE_SIDECAR_BATCH,
} from "../src/backend/capabilities/bundle-registry";
import {
  type ExtraVerdict,
  type GatedBundleVerdict,
  type GraduatedBundleVerdict,
  resolveBundle,
} from "../src/backend/capabilities/resolve";
import { type Assert, type Equal } from "../src/utils/type-assert";
import { createTestBackend } from "./test-utils";

/** The type-level proof: no key of a verdict shape is ever function-valued. */
type FunctionValuedKeys<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never;
}[keyof T];

type SampleGatedVerdict = GatedBundleVerdict<
  "claimEdgeCardinality",
  Record<never, never>
>;
type SampleGraduatedVerdict = GraduatedBundleVerdict<
  Record<"getNodes", "getNodes">
>;
type SampleExtraVerdict = ExtraVerdict<"getNodes">;

// Each resolves to `never` independently — asserted separately (not unioned)
// because a union of three already-`never` constituents is itself flagged as
// redundant/duplicated, which would hide a REAL regression in any one of them
// behind a lint suppression instead of a compile failure naming it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time assertion
type _noFunctionValuedGatedVerdictFields = Assert<
  Equal<FunctionValuedKeys<SampleGatedVerdict>, never>
>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time assertion
type _noFunctionValuedGraduatedVerdictFields = Assert<
  Equal<FunctionValuedKeys<SampleGraduatedVerdict>, never>
>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time assertion
type _noFunctionValuedExtraVerdictFields = Assert<
  Equal<FunctionValuedKeys<SampleExtraVerdict>, never>
>;

function assertNoFunctions(value: unknown, path: string): void {
  if (typeof value === "function") {
    throw new TypeError(
      `Found a function at "${path}" — verdicts must carry names, never functions.`,
    );
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoFunctions(item, `${path}[${index}]`);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      assertNoFunctions(nested, `${path}.${key}`);
    }
  }
}

describe("capability verdicts never carry function-valued fields (T22)", () => {
  it("deep-walks all six resolved verdicts against a real SQLite backend", () => {
    const backend = createTestBackend();
    const verdicts = [
      resolveBundle(backend, CLAIMS),
      resolveBundle(backend, UNIQUE_SIDECAR_BATCH),
      resolveBundle(backend, BATCH_POINT_READ),
      resolveBundle(backend, STATEMENT_EXECUTION),
      resolveBundle(backend, CONTRIBUTION_HEALTH),
      resolveBundle(backend, RECORDED_REVISION_ORIGINS),
    ];
    expect(verdicts).toHaveLength(6);
    for (const [index, verdict] of verdicts.entries()) {
      assertNoFunctions(verdict, `verdicts[${index}]`);
    }
  });
});
