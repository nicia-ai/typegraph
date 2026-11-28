import { describe, expect, it } from "vitest";

import { type VectorCapabilities } from "../src/backend/types";
import { libsqlVectorStrategy } from "../src/query/dialect/vector/libsql-strategy";
import { pgvectorStrategy } from "../src/query/dialect/vector/pgvector-strategy";
import { sqliteVecStrategy } from "../src/query/dialect/vector/sqlite-vec-strategy";
import { resolveRepeatableApproximateSearch } from "../src/query/dialect/vector-strategy";

describe("resolveRepeatableApproximateSearch", () => {
  it("never assumes a strategy that declares nothing is repeatable", () => {
    const {
      repeatableApproximateSearch: _declared,
      ...undeclared
    }: VectorCapabilities = pgvectorStrategy.capabilities;
    expect(resolveRepeatableApproximateSearch(undeclared)).toEqual({
      repeatable: false,
      reason:
        "the vector strategy does not declare capabilities.repeatableApproximateSearch",
    });
  });

  it("reads each bundled strategy's own declaration", () => {
    expect(
      [pgvectorStrategy, sqliteVecStrategy, libsqlVectorStrategy].map(
        (strategy) =>
          resolveRepeatableApproximateSearch(strategy.capabilities).repeatable,
      ),
    ).toEqual([true, true, false]);
  });
});
