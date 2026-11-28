import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPgGraphProjection,
  createPgGraphQueries,
  type QueryRunner,
} from "./pggraph";

/** A runner that answers every statement with the given rows and records its name. */
function fakeRunner(rows: readonly Record<string, unknown>[]): Readonly<{
  run: QueryRunner;
  names: string[];
}> {
  const names: string[] = [];
  const run = (<Row>(name: string): Promise<readonly Row[]> => {
    names.push(name);
    return Promise.resolve(rows as readonly Row[]);
  }) as QueryRunner;
  return { run, names };
}

describe("pgGraph traversal circuit breakers", () => {
  it("refuses a BFS3 result graph.traverse marked capped", async () => {
    const { run } = fakeRunner([
      { node_id: "person:1", capped: false },
      { node_id: "person:2", capped: true },
    ]);
    await assert.rejects(
      createPgGraphQueries(run).BFS3("person:0"),
      /BFS3: graph\.traverse reported capped=true/,
    );
  });

  it("refuses capped whole-component GA_BFS and GA_SSSP aggregates", async () => {
    const { run } = fakeRunner([
      { reachable: "10", depth_sum: "20", capped: true },
    ]);
    const queries = createPgGraphQueries(run);
    await assert.rejects(queries.GA_BFS("person:0"), /GA_BFS: .*capped=true/);
    await assert.rejects(queries.GA_SSSP("person:0"), /GA_SSSP: .*capped=true/);
  });

  it("returns uncapped results unchanged", async () => {
    const queries = createPgGraphQueries(
      fakeRunner([{ node_id: "person:2", capped: false }]).run,
    );
    assert.equal((await queries.BFS3("person:0")).rowCount, 1);
    const aggregate = createPgGraphQueries(
      fakeRunner([{ reachable: "10", depth_sum: "20", capped: null }]).run,
    );
    assert.equal((await aggregate.GA_BFS("person:0")).rowCount, 10);
    assert.equal((await aggregate.GA_SSSP("person:0")).rowCount, 10);
  });
});

describe("pgGraph projection build", () => {
  it("gives knows its primary key before graph.add_edge registers it", async () => {
    const statements: string[] = [];
    await buildPgGraphProjection(
      (text) => {
        statements.push(text.replaceAll(/\s+/g, " ").trim());
        return Promise.resolve(
          text.includes("graph.build()") ?
            [{ nodes_loaded: "3", edges_loaded: "4" }]
          : [],
        );
      },
      () => undefined,
    );
    const primaryKey = statements.indexOf(
      "ALTER TABLE knows ADD PRIMARY KEY (from_id, to_id)",
    );
    const addEdge = statements.findIndex((statement) =>
      statement.includes("graph.add_edge( from_table := 'public.knows'"),
    );
    const build = statements.findIndex((statement) =>
      statement.includes("FROM graph.build()"),
    );
    assert.ok(primaryKey >= 0, "knows has no primary key");
    assert.ok(addEdge > primaryKey, "graph.add_edge ran before the knows key");
    assert.ok(build > addEdge, "graph.build() ran before the registrations");
  });
});
