import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { type Session } from "neo4j-driver";

import { streamSnbCsvDataset } from "../dataset/ldbc-csv";
import { importHeader } from "./neo4j-graph-shape";
import {
  assertBatchCreatedEveryRow,
  edgeCreateStatement,
  loadSnbDatasetOnline,
  nodeCreateStatement,
  toOnlineEdgeRow,
} from "./neo4j-online-load";

const SMOKE_FIXTURE = fileURLToPath(
  new URL("../../../fixtures/ldbc-snb-smoke", import.meta.url),
);

type Row = Readonly<Record<string, string>>;

/**
 * Just enough of a Neo4j session to run the online loader: node CREATEs add
 * each row's id under every label the statement names, and relationship
 * statements create one relationship per row whose two endpoints exist under
 * the matched labels — the semantics of `MATCH ... MATCH ... CREATE`, where a
 * missing endpoint silently creates nothing. `dropLabel` makes node writes to
 * one label vanish and say so (the server's counter reports 0); `forgetLabel`
 * reports them created but never stores them, so only the relationships that
 * need them come up short.
 */
function fakeGraphSession(
  faults: Readonly<{ dropLabel?: string; forgetLabel?: string }> = {},
): Readonly<{
  session: Session;
  ids: Map<string, Set<string>>;
  relationships: Map<string, number>;
  statements: string[];
}> {
  const ids = new Map<string, Set<string>>();
  const relationships = new Map<string, number>();
  const statements: string[] = [];
  const labelIds = (label: string): Set<string> => {
    const existing = ids.get(label);
    if (existing !== undefined) return existing;
    const created = new Set<string>();
    ids.set(label, created);
    return created;
  };

  function run(statement: string, rows: readonly Row[]) {
    statements.push(statement);
    let nodesCreated = 0;
    let relationshipsCreated = 0;
    const edge =
      /MATCH \(a:(\w+) \{id: row\.fromId\}\) MATCH \(b:(\w+) \{id: row\.toId\}\) CREATE \(a\)-\[:(\w+)/.exec(
        statement,
      );
    if (edge === null) {
      const labels = /CREATE \(:([\w:]+) \{/.exec(statement)![1]!.split(":");
      for (const row of rows) {
        if (labels.includes(faults.dropLabel ?? "")) continue;
        nodesCreated += 1;
        if (labels.includes(faults.forgetLabel ?? "")) continue;
        for (const label of labels) labelIds(label).add(row["id"]!);
      }
    } else {
      const [, fromLabel, toLabel, type] = edge;
      for (const row of rows) {
        if (
          labelIds(fromLabel!).has(row["fromId"]!) &&
          labelIds(toLabel!).has(row["toId"]!)
        ) {
          relationshipsCreated += 1;
        }
      }
      relationships.set(
        type!,
        (relationships.get(type!) ?? 0) + relationshipsCreated,
      );
    }
    return {
      summary: () =>
        Promise.resolve({
          counters: { updates: () => ({ nodesCreated, relationshipsCreated }) },
        }),
    };
  }

  const session = {
    executeWrite: <T>(
      work: (tx: { run: typeof run }) => Promise<T>,
    ): Promise<T> =>
      work({
        run: (statement: string, parameters: { rows: readonly Row[] }) =>
          run(statement, parameters.rows),
      } as unknown as { run: typeof run }),
  } as unknown as Session;
  return { session, ids, relationships, statements };
}

describe("Neo4j online load statements", () => {
  it("creates nodes with every label and property of their kind", () => {
    assert.equal(
      nodeCreateStatement("post"),
      "UNWIND $rows AS row CREATE (:Post:Message {id: row.id, content: row.content, creationDate: row.creationDate})",
    );
  });

  it("matches relationship endpoints by id on constrained labels", () => {
    assert.equal(
      edgeCreateStatement("knows"),
      "UNWIND $rows AS row MATCH (a:Person {id: row.fromId}) MATCH (b:Person {id: row.toId}) CREATE (a)-[:KNOWS {since: row.since}]->(b)",
    );
    assert.equal(
      edgeCreateStatement("containerOf"),
      "UNWIND $rows AS row MATCH (a:Forum {id: row.fromId}) MATCH (b:Message {id: row.toId}) CREATE (a)-[:CONTAINER_OF]->(b)",
    );
  });

  it("keeps the offline import header the container path always used", () => {
    assert.deepEqual(importHeader("person"), [
      "id:ID",
      "firstName:string",
      "lastName:string",
      "gender:string",
      "birthday:string",
      "creationDate:string",
      "locationIp:string",
      "browserUsed:string",
      "cityId:string",
    ]);
    assert.deepEqual(importHeader("forum"), [
      "id:ID",
      "title:string",
      "creationDate:string",
      "moderatorId:string",
    ]);
  });

  it("carries a knows edge's creation date as the since property", () => {
    assert.deepEqual(
      toOnlineEdgeRow({
        kind: "knows",
        fromId: "person:1",
        toId: "person:2",
        createdAt: "2010-01-01T00:00:00.000Z",
      }),
      {
        kind: "knows",
        row: {
          fromId: "person:1",
          toId: "person:2",
          since: "2010-01-01T00:00:00.000Z",
        },
      },
    );
  });

  it("refuses a batch that created fewer entities than it had rows", () => {
    assertBatchCreatedEveryRow("knows", 3, 3);
    assert.throws(
      () => assertBatchCreatedEveryRow("knows", 3, 2),
      /batch of 3 rows created 2/,
    );
  });
});

describe("loadSnbDatasetOnline", () => {
  it("writes every node and relationship of the smoke fixture", async () => {
    const expected = { nodes: 0, edges: new Map<string, number>() };
    const counted = await streamSnbCsvDataset(
      SMOKE_FIXTURE,
      {
        person: () => Promise.resolve(),
        forum: () => Promise.resolve(),
        post: () => Promise.resolve(),
        comment: () => Promise.resolve(),
        edge: (row) => {
          expected.edges.set(row.kind, (expected.edges.get(row.kind) ?? 0) + 1);
          return Promise.resolve();
        },
      },
      () => undefined,
    );
    expected.nodes =
      counted.pools.counts.persons +
      counted.pools.counts.posts +
      counted.pools.counts.comments;

    const fake = fakeGraphSession();
    const pools = await loadSnbDatasetOnline(
      fake.session,
      SMOKE_FIXTURE,
      () => undefined,
    );
    assert.deepEqual(pools.counts, counted.pools.counts);
    assert.equal(
      (fake.ids.get("Person")?.size ?? 0) +
        (fake.ids.get("Message")?.size ?? 0),
      expected.nodes,
    );
    assert.equal(fake.relationships.get("KNOWS"), expected.edges.get("knows"));
    assert.equal(
      fake.relationships.get("HAS_CREATOR"),
      expected.edges.get("hasCreator"),
    );
    assert.equal(
      fake.relationships.get("CONTAINER_OF"),
      expected.edges.get("containerOf"),
    );
    assert.equal(
      fake.relationships.get("REPLY_OF"),
      expected.edges.get("replyOf"),
    );
    // Every relationship write comes after every node write.
    const firstEdge = fake.statements.findIndex((statement) =>
      statement.includes("MATCH"),
    );
    const lastNode = fake.statements.findLastIndex(
      (statement) => !statement.includes("MATCH"),
    );
    assert.ok(firstEdge > lastNode);
  });

  it("fails the load when a node batch is not fully applied", async () => {
    const fake = fakeGraphSession({ dropLabel: "Forum" });
    await assert.rejects(
      loadSnbDatasetOnline(fake.session, SMOKE_FIXTURE, () => undefined),
      /online load: a forum batch of \d+ rows created 0/,
    );
  });

  it("fails the load when relationship endpoints are missing", async () => {
    const fake = fakeGraphSession({ forgetLabel: "Forum" });
    await assert.rejects(
      loadSnbDatasetOnline(fake.session, SMOKE_FIXTURE, () => undefined),
      /online load: a containerOf batch of \d+ rows created 0/,
    );
  });
});
