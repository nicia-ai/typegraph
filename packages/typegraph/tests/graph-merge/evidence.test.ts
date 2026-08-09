import { describe, expect, it } from "vitest";

import {
  describeMatchStrategy,
  normalizeMatchSources,
} from "../../src/graph-merge/evidence";

describe("merge evidence", () => {
  it("deduplicates and canonically orders structured source attribution", () => {
    expect(
      normalizeMatchSources([
        {
          kind: "unique",
          sourceId: "unique",
          constraintName: "z_constraint",
        },
        { kind: "block", sourceId: "exactKey" },
        {
          kind: "unique",
          sourceId: "unique",
          constraintName: "a_constraint",
        },
        { kind: "block", sourceId: "exactKey" },
      ]),
    ).toEqual([
      { kind: "block", sourceId: "exactKey" },
      {
        kind: "unique",
        sourceId: "unique",
        constraintName: "a_constraint",
      },
      {
        kind: "unique",
        sourceId: "unique",
        constraintName: "z_constraint",
      },
    ]);
  });

  it("describes effective hybrid configuration without retaining functions", () => {
    expect(
      describeMatchStrategy({
        kind: "hybrid",
        fields: ["familyName", "givenName"],
        weights: { vector: 3, fulltext: 1 },
      }),
    ).toEqual({
      kind: "hybrid",
      fields: ["familyName", "givenName"],
      weights: { vector: 0.75, fulltext: 0.25 },
    });
    expect(describeMatchStrategy({ kind: "custom", score: () => 0.5 })).toEqual(
      { kind: "custom" },
    );
  });
});
