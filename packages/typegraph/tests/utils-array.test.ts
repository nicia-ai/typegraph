import { describe, expect, it } from "vitest";

import { chunk, groupBy } from "../src/utils/array";

describe("chunk", () => {
  it("splits values into bounded chunks", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
    expect(chunk([], 2)).toEqual([]);
  });

  it("rejects non-positive and non-finite chunk sizes", () => {
    for (const size of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => chunk([1, 2, 3], size)).toThrow(
        /chunk size must be a positive integer/u,
      );
    }
  });
});

describe("groupBy", () => {
  it("groups items by key and preserves input order inside each group", () => {
    const groups = groupBy(
      [
        { graphId: "a", id: 1 },
        { graphId: "b", id: 2 },
        { graphId: "a", id: 3 },
      ],
      (item) => item.graphId,
    );

    expect(groups.get("a")?.map((item) => item.id)).toEqual([1, 3]);
    expect(groups.get("b")?.map((item) => item.id)).toEqual([2]);
  });
});
