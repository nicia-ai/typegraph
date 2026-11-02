/**
 * The composition membership rule has one statement for readers
 * (`compositionPopulationMembership`, src/registry/composition-relation.ts)
 * and is reached by the composition CLAIM through its cardinality axis
 * (`axisRowMembership`, src/store/claims/edge-claims.ts). The claim SQL and
 * the cascade, the acyclicity relation and the composition reads must agree
 * on which rows bind, so the two are pinned together for every orientation
 * and population a composition pair can take.
 */
import { describe, expect, it } from "vitest";

import { compositionPopulationMembership } from "../src/registry/composition-relation";
import { axisRowMembership } from "../src/store/claims/edge-claims";

const POPULATIONS = ["one", "oneActive"] as const;
const DIRECTIONS = ["source", "target"] as const;

describe("composition row membership", () => {
  it("states the same rule as the composition claim's cardinality axis", () => {
    // MUTATION CHECK: make `compositionPopulationMembership` answer
    // "openRows" for "one" and this fails on both directions — verified and
    // reverted.
    for (const population of POPULATIONS) {
      for (const direction of DIRECTIONS) {
        expect(
          compositionPopulationMembership(population),
          `${direction}:${population}`,
        ).toBe(axisRowMembership({ direction, cardinality: population }));
      }
    }
  });

  it("binds a population 'one' row for its whole life and a 'oneActive' row only while open", () => {
    expect(compositionPopulationMembership("one")).toBe("allRows");
    expect(compositionPopulationMembership("oneActive")).toBe("openRows");
  });
});
