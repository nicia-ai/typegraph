/**
 * Compile-time type tests for C.1 (typed subsumption).
 *
 * Tests marked with @ts-expect-error verify that an incompatible
 * `subClassOf` / `equivalentTo` / `sameAs` pair is refused AT COMPILE TIME,
 * with the failure carrier (`StructuralSubtypeMismatch`) naming the
 * offending fields. Load-bearing: see
 * tests/property/typed-subsumption-agreement.test.ts for the runtime-side
 * agreement pin, and lane-C13-load-bearing.md for the revert/mutation check
 * performed on this file.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { defineNode, equivalentTo, sameAs, subClassOf } from "../src";
import type {
  IncompatibleKeys,
  StructuralSubtypeMismatch,
} from "../src/ontology/types";

// ============================================================
// Fixtures
// ============================================================

const Media = defineNode("Media", {
  schema: z.object({ title: z.string() }),
});

const Podcast = defineNode("Podcast", {
  schema: z.object({ title: z.string(), rssUrl: z.string() }),
});

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const Employee = defineNode("Employee", {
  schema: z.object({ name: z.string(), employeeId: z.string() }),
});

const Status = defineNode("Status", {
  schema: z.object({ state: z.enum(["active", "inactive", "pending"]) }),
});

const ActiveStatus = defineNode("ActiveStatus", {
  schema: z.object({ state: z.literal("active") }),
});

const RequiredWidget = defineNode("RequiredWidget", {
  schema: z.object({ label: z.string() }),
});

const OptionalWidget = defineNode("OptionalWidget", {
  schema: z.object({ label: z.string().optional() }),
});

describe("C.1 — subClassOf structural contract", () => {
  it("compiles when the child's schema extends the parent's", () => {
    const relation = subClassOf(Podcast, Media);
    expect(relation.metaEdge.name).toBe("subClassOf");
    expect(relation.from).toBe(Podcast);
    expect(relation.to).toBe(Media);
  });

  it("refuses a child missing a required parent property, naming the field", () => {
    expectTypeOf<
      IncompatibleKeys<
        z.infer<(typeof Person)["schema"]>,
        z.infer<(typeof Employee)["schema"]>
      >
    >().toEqualTypeOf<"employeeId">();

    // @ts-expect-error - Person lacks Employee's required employeeId field
    subClassOf(Person, Employee);
  });

  it("accepts a child narrowing a parent enum to a literal", () => {
    const relation = subClassOf(ActiveStatus, Status);
    expect(relation.from).toBe(ActiveStatus);
  });

  it("refuses a child relaxing a parent-required property to optional", () => {
    // @ts-expect-error - OptionalWidget relaxes RequiredWidget's required label
    subClassOf(OptionalWidget, RequiredWidget);
  });

  it("accepts width subtyping — the child may add properties", () => {
    // Podcast adds rssUrl on top of Media's title; already exercised above,
    // pinned again here for the width-subtyping-by-name test in §5.1.
    const relation = subClassOf(Podcast, Media);
    expect(relation.to).toBe(Media);
  });

  it("names the message in StructuralSubtypeMismatch", () => {
    expectTypeOf<
      StructuralSubtypeMismatch<"Person", "Employee", "employeeId">
    >().toHaveProperty("__typegraphSubClassOfError");
  });
});

describe("C.1 — equivalentTo mutual structural contract", () => {
  it("compiles both directions for an identical pair", () => {
    const Alpha = defineNode("Alpha", { schema: z.object({ x: z.string() }) });
    const Beta = defineNode("Beta", { schema: z.object({ x: z.string() }) });
    const forward = equivalentTo(Alpha, Beta);
    const backward = equivalentTo(Beta, Alpha);
    expect(forward.from).toBe(Alpha);
    expect(backward.from).toBe(Beta);
  });

  it("refuses the direction that fails for an asymmetric pair", () => {
    // Employee has an extra required field over Person; Employee -> Person
    // holds (Employee narrows to Person's shape is false, but
    // Person -> Employee holds mutual-subtype only if BOTH directions
    // extend). Person lacks employeeId, so neither direction is a full
    // equivalence.
    // @ts-expect-error - Person is missing Employee's employeeId field
    equivalentTo(Person, Employee);
  });

  it("allows the IRI form with no schema check", () => {
    const relation = equivalentTo(Person, "https://schema.org/Person");
    expect(relation.to).toBe("https://schema.org/Person");
  });
});

describe("C.1 — sameAs carries the same contract as equivalentTo", () => {
  it("compiles for an identical pair", () => {
    const Gamma = defineNode("Gamma", {
      schema: z.object({ y: z.number() }),
    });
    const Delta = defineNode("Delta", {
      schema: z.object({ y: z.number() }),
    });
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const relation = sameAs(Gamma, Delta);
    expect(relation.metaEdge.name).toBe("sameAs");
  });

  it("refuses an incompatible pair — the deprecated alias is not an escape hatch", () => {
    // @ts-expect-error - Person is missing Employee's employeeId field
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    sameAs(Person, Employee);
  });
});
