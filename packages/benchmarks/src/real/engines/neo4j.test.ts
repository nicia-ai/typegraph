import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeNonEmptyNeo4jDatabase } from "./neo4j";

const EMPTY = {
  nodeCount: 0,
  constraintNames: [],
  indexNames: [],
  gdsGraphNames: [],
} as const;

describe("describeNonEmptyNeo4jDatabase", () => {
  it("accepts a database with nothing a run could collide with", () => {
    assert.equal(describeNonEmptyNeo4jDatabase(EMPTY), undefined);
  });

  it("names every kind of existing content it refuses", () => {
    assert.equal(
      describeNonEmptyNeo4jDatabase({ ...EMPTY, nodeCount: 3 }),
      "3 nodes",
    );
    assert.equal(
      describeNonEmptyNeo4jDatabase({
        ...EMPTY,
        constraintNames: ["snb_person_id"],
        indexNames: ["by_name"],
        gdsGraphNames: ["someone_elses_graph"],
      }),
      "constraints snb_person_id; indexes by_name; GDS projections someone_elses_graph",
    );
  });
});
