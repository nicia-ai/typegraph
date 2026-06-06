/**
 * Unit regression guards for two adversarial-review findings (core-readiness pass):
 *
 *   #2 — `writeWouldChangeRow` must model the commit's RE-VALIDATING write, not a raw
 *        structural merge. The real node/edge update stores `schema.safeParse({...
 *        committed, ...planned})`, which STRIPS undeclared keys + applies defaults. A
 *        heterogeneous committed row (a key the current schema strips — which
 *        `mergeIncremental` permits via "advanced target content") must be seen as
 *        CHANGED, not a silent no-op (the data-loss hole).
 *
 *   #3 — `provenanceNodeId` must include `canonicalKind`, so two different-kind
 *        contributions that share a bare id (e.g. base `Patient:x` and `Encounter:x`)
 *        get DISTINCT sidecar rows instead of clobbering each other.
 *
 * Pure unit tests — no backend.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { writeWouldChangeRow } from "../../src/graph-merge/merge";
import { provenanceNodeId } from "../../src/graph-merge/provenance-store";
import type { ProvenanceRecord } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";

describe("writeWouldChangeRow (faithful to the re-validating write)", () => {
  const schema = z.object({ name: z.string(), mrn: z.string() });

  it("DATA-LOSS GUARD: a committed-only key the schema strips counts as a CHANGE", () => {
    // The committed row carries `legacy`, which the current schema does not declare.
    // The real write re-validates {...committed, ...planned} -> strips `legacy` -> the
    // stored row changes. A structural merge would wrongly call this a no-op.
    expect(
      writeWouldChangeRow(
        schema,
        { name: "Alice", mrn: "M1", legacy: "KEEP-ME" },
        { name: "Alice", mrn: "M1" },
      ),
    ).toBe(true);
  });

  it("no-op: an exactly-equal re-add does not change the row", () => {
    expect(
      writeWouldChangeRow(
        schema,
        { name: "Alice", mrn: "M1" },
        { name: "Alice", mrn: "M1" },
      ),
    ).toBe(false);
  });

  it("no-op: a subset re-add (planned ⊆ committed, schema-normalized) is preserved", () => {
    // committed is already in current-schema form; the patch validates back to the same
    // bytes, so this stays the allowed idempotent re-run (the E3/E5 behaviour).
    const optional = z.object({ name: z.string(), tag: z.string().optional() });
    expect(
      writeWouldChangeRow(
        optional,
        { name: "Alice", tag: "vip" },
        { name: "Alice" },
      ),
    ).toBe(false);
  });

  it("CHANGE: overwriting an existing committed value", () => {
    expect(
      writeWouldChangeRow(
        schema,
        { name: "Alice", mrn: "M1" },
        { name: "Bob", mrn: "M1" },
      ),
    ).toBe(true);
  });

  it("does not mask a validation error: an unvalidatable merge is reported as no-change", () => {
    // {...{name}, ...{}} = {name} is missing required `mrn` -> the real write would THROW
    // a ValidationError at commit; the guard returns false so it never masks that with a
    // stale-overwrite error.
    expect(writeWouldChangeRow(schema, { name: "Alice" }, {})).toBe(false);
  });

  it("falls back to the structural comparison when no schema is reachable", () => {
    expect(writeWouldChangeRow(undefined, { a: 1 }, { a: 1 })).toBe(false);
    expect(writeWouldChangeRow(undefined, { a: 1 }, { a: 2 })).toBe(true);
  });
});

describe("provenanceNodeId (cross-kind identity)", () => {
  const base = (kind: string): ProvenanceRecord => ({
    role: "node",
    canonicalId: "x",
    canonicalKind: kind,
    branchId: asBranchId("provider-a"),
    sourceId: "x",
  });

  it("distinguishes two different-kind contributions that share a bare id", () => {
    const patient = provenanceNodeId("g", base("Patient"));
    const encounter = provenanceNodeId("g", base("Encounter"));
    expect(patient).not.toBe(encounter);
  });

  it("is stable for the same record (deterministic upsert key)", () => {
    expect(provenanceNodeId("g", base("Patient"))).toBe(
      provenanceNodeId("g", base("Patient")),
    );
  });
});
