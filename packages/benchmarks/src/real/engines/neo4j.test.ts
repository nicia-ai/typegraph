import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { podmanLikeRuntime } from "../harness/podman-like-runtime";
import {
  describeNonEmptyNeo4jDatabase,
  removeNeo4jContainer,
  runNeo4jAdminImport,
  runNeo4jContainer,
} from "./neo4j";

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

describe("Neo4j container command sequence", () => {
  const memory = { heapSize: "1g", pageCacheSize: "1g" } as const;

  it("creates the data volume once, before the import, and never again", async () => {
    const fake = podmanLikeRuntime();
    await runNeo4jAdminImport(
      fake.runtime,
      "/stage",
      "run-data",
      () => undefined,
    );
    await runNeo4jContainer(
      fake.runtime,
      "run-server",
      "run-data",
      "/plugins",
      7999,
      memory,
    );

    const lines = fake.commands.map((command) => command.join(" "));
    const creates = lines.filter((line) => line.startsWith("volume create"));
    assert.deepEqual(creates, ["volume create run-data"]);
    const firstUse = lines.findIndex((line) =>
      line.includes("-v run-data:/data"),
    );
    assert.ok(lines.indexOf("volume create run-data") < firstUse);
    assert.equal(
      lines.filter((line) => line.includes("-v run-data:/data")).length,
      2,
    );
  });

  it("tears down after a load that failed before the server started", async () => {
    const fake = podmanLikeRuntime();
    await runNeo4jAdminImport(
      fake.runtime,
      "/stage",
      "run-data",
      () => undefined,
    );
    await removeNeo4jContainer(fake.runtime, "run-server", "run-data");
    await removeNeo4jContainer(fake.runtime, "run-server", "run-data");
    assert.equal(fake.volumes.size, 0);
  });
});
