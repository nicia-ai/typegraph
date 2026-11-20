import { describe, expect, it } from "vitest";

import { CandidateWriteSetSchema } from "../src/graph-merge/candidate-write-set";
import {
  InterchangeEdgeSchema,
  InterchangeNodeSchema,
} from "../src/interchange/types";
import { isPortableTimestamp } from "../src/utils/date";

/**
 * Canonical UTC text that every backend stores, and text that one of them
 * cannot: PostgreSQL's `timestamptz` cast refuses year 0000, which SQLite
 * stores and compares as text.
 */
const FIRST_PORTABLE = "0001-01-01T00:00:00.000Z";
const LAST_PORTABLE = "9999-12-31T23:59:59.999Z";
const YEAR_ZERO = "0000-12-31T23:59:59.999Z";

const candidateNodeSchema = CandidateWriteSetSchema.shape.nodes.element;
const candidateEdgeSchema = CandidateWriteSetSchema.shape.edges.element;

function interchangeNode(validFrom: string) {
  return { kind: "Item", id: "a", properties: {}, validFrom };
}

function interchangeEdge(validTo: string) {
  return {
    kind: "links",
    id: "e",
    from: { kind: "Item", id: "a" },
    to: { kind: "Item", id: "b" },
    properties: {},
    validTo,
  };
}

describe("portable timestamps", () => {
  it("accepts canonical text in the years 0001 to 9999 and refuses year 0000", () => {
    expect(
      [FIRST_PORTABLE, LAST_PORTABLE, YEAR_ZERO].map((value) =>
        isPortableTimestamp(value),
      ),
    ).toEqual([true, true, false]);
  });

  it("holds interchange and candidate write-set validity bounds to the portable range", () => {
    const outcomes = Object.fromEntries(
      [FIRST_PORTABLE, LAST_PORTABLE, YEAR_ZERO].map((value) => [
        value,
        {
          interchangeNode: InterchangeNodeSchema.safeParse(
            interchangeNode(value),
          ).success,
          interchangeEdge: InterchangeEdgeSchema.safeParse(
            interchangeEdge(value),
          ).success,
          candidateNode: candidateNodeSchema.safeParse(interchangeNode(value))
            .success,
          candidateEdge: candidateEdgeSchema.safeParse({
            ...interchangeEdge(value),
            // eslint-disable-next-line unicorn/no-null -- a candidate edge states an open-left window as null
            validFrom: null,
          }).success,
        },
      ]),
    );

    const accepted = {
      interchangeNode: true,
      interchangeEdge: true,
      candidateNode: true,
      candidateEdge: true,
    };
    expect(outcomes).toEqual({
      [FIRST_PORTABLE]: accepted,
      [LAST_PORTABLE]: accepted,
      [YEAR_ZERO]: {
        interchangeNode: false,
        interchangeEdge: false,
        candidateNode: false,
        candidateEdge: false,
      },
    });
  });
});
