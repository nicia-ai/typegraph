/**
 * Opt-in DoltLite spike, analogous to the Doltgres walk in PR #372. Uses only
 * disposable databases. GAP means a measured limitation, never a passing
 * declaration of support. No version-control operation is a TypeGraph merge.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DatabaseSync } from "@dolthub/doltlite";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { isSqliteStaleSnapshotError } from "../src/utils/sql-errors";
import { openDoltlite, runVersionControl } from "./doltlite/adapter";

type Outcome = Readonly<{
  status: "PASS" | "GAP" | "FAIL";
  name: string;
  detail: string;
}>;
const outcomes: Outcome[] = [];

async function step(
  name: string,
  run: () => void | Promise<void>,
  gap?: string,
): Promise<void> {
  try {
    await run();
    outcomes.push({
      status: gap === undefined ? "PASS" : "GAP",
      name,
      detail: gap ?? "",
    });
  } catch (error) {
    outcomes.push({
      status: "FAIL",
      name,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function scalar(
  connection: DatabaseSync,
  sql: string,
  ...params: unknown[]
): unknown {
  const row = connection.prepare(sql).get(...params);
  assert.ok(
    row !== undefined && !Array.isArray(row),
    "Expected one object row",
  );
  return row["value"];
}

function peerWrite(databasePath: string): unknown {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("doltlite/writer-probe.ts", import.meta.url)),
      databasePath,
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  const result: unknown = JSON.parse(output);
  return result;
}

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), count: z.number() }),
});
const knows = defineEdge("knows");
const graph = defineGraph({
  id: "doltlite_smoke",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

const directory = await mkdtemp(path.join(tmpdir(), "typegraph-doltlite-"));
const databasePath = path.join(directory, "smoke.db");
const primary = await openDoltlite(databasePath);
try {
  const peer = await openDoltlite(databasePath);
  try {
    const connection = primary.connection;
    console.log(
      "DoltLite engine:",
      scalar(connection, "SELECT dolt_version() AS value"),
    );

    await step("SQLite SQL surface", () => {
      connection.exec(
        "CREATE TABLE probe(id TEXT PRIMARY KEY, value INTEGER NOT NULL)",
      );
      assert.equal(
        scalar(
          connection,
          "INSERT INTO probe VALUES ('counter', 0) RETURNING value",
        ),
        0,
      );
      assert.equal(
        scalar(connection, "SELECT json_extract('{\"a\":1}', '$.a') AS value"),
        1,
      );
      assert.equal(
        scalar(
          connection,
          "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<3) SELECT sum(x) AS value FROM n",
        ),
        6,
      );
      connection.exec(
        "CREATE VIRTUAL TABLE probe_fts USING fts5(body); INSERT INTO probe_fts(body) VALUES ('graph database')",
      );
      assert.equal(
        scalar(
          connection,
          "SELECT count(*) AS value FROM probe_fts WHERE probe_fts MATCH 'graph'",
        ),
        1,
      );
    });

    await step("Writer-slot exclusion across processes and fresh retry", () => {
      connection.exec("BEGIN");
      try {
        // This is the same no-op UPDATE used by TypeGraph's engine fence.
        connection.exec(
          "UPDATE typegraph_nodes SET graph_id = graph_id WHERE 0",
        );
        assert.deepEqual(peerWrite(databasePath), { outcome: "blocked" });
        connection.exec(
          "UPDATE probe SET value = value + 1 WHERE id = 'counter'",
        );
        connection.exec("COMMIT");
      } finally {
        if (connection.inTransaction) connection.exec("ROLLBACK");
      }
      assert.deepEqual(peerWrite(databasePath), { outcome: "committed" });
      assert.equal(
        scalar(connection, "SELECT value FROM probe WHERE id = 'counter'"),
        2,
      );
    });

    await step("Stale read snapshot refuses upgrade", () => {
      connection.exec("BEGIN");
      try {
        assert.equal(
          scalar(connection, "SELECT value FROM probe WHERE id = 'counter'"),
          2,
        );
        peer.connection.exec("UPDATE probe SET value = 3 WHERE id = 'counter'");
        assert.throws(() => {
          connection.exec("UPDATE probe SET value = 4 WHERE id = 'counter'");
        }, /database is locked/);
      } finally {
        if (connection.inTransaction) connection.exec("ROLLBACK");
      }
      assert.equal(
        scalar(connection, "SELECT value FROM probe WHERE id = 'counter'"),
        3,
      );
    });

    await step("Structured busy errors", () => {
      connection.exec("BEGIN");
      try {
        scalar(connection, "SELECT value FROM probe WHERE id = 'counter'");
        peer.connection.exec("UPDATE probe SET value = 4 WHERE id = 'counter'");
        assert.throws(
          () => {
            connection.exec("UPDATE probe SET value = 5 WHERE id = 'counter'");
          },
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, "database is locked");
            assert.equal(isSqliteStaleSnapshotError(error), true);
            assert.equal(Reflect.get(error, "code"), "ERR_SQLITE_ERROR");
            return true;
          },
        );
      } finally {
        if (connection.inTransaction) connection.exec("ROLLBACK");
      }
    });

    await step("Structured constraint errors", () => {
      assert.throws(
        () => {
          connection.prepare("INSERT INTO probe VALUES ('counter', 99)").run();
        },
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /UNIQUE constraint failed: probe.id/);
          assert.equal(Reflect.get(error, "code"), "ERR_SQLITE_ERROR");
          return true;
        },
      );
    });

    const [store] = await createStoreWithSchema(graph, primary.backend, {
      history: true,
      revisionTracking: true,
    });

    await step(
      "Typed CRUD, traversal, transaction commit and rollback",
      async () => {
        const alice = await store.nodes.Person.create({
          name: "Alice",
          count: 0,
        });
        const bob = await store.nodes.Person.create({ name: "Bob", count: 0 });
        await store.edges.knows.create(alice, bob, {});
        assert.deepEqual(
          await store
            .query()
            .from("Person", "p")
            .traverse("knows", "e")
            .to("Person", "q")
            .select((context) => ({ name: context.q.name }))
            .execute(),
          [{ name: "Bob" }],
        );
        await store.transaction(async (transaction) => {
          await transaction.nodes.Person.update(alice.id, { count: 1 });
        });
        await assert.rejects(
          store.transaction(async (transaction) => {
            await transaction.nodes.Person.update(alice.id, { count: 9 });
            throw new Error("rollback probe");
          }),
          /rollback probe/,
        );
        const committed = await store.nodes.Person.getById(alice.id);
        assert.equal(committed?.count, 1);
      },
    );

    await step("Recorded history and historical read", async () => {
      const person = await store.nodes.Person.create({
        name: "Before",
        count: 0,
      });
      const instant = await store.recordedNow();
      assert.ok(instant);
      await store.nodes.Person.update(person.id, { name: "After" });
      const historical = await store
        .asOfRecorded(instant)
        .nodes.Person.getById(person.id);
      const current = await store.nodes.Person.getById(person.id);
      assert.equal(historical?.name, "Before");
      assert.equal(current?.name, "After");
    });

    await step("Revision journal records a write", async () => {
      const journalGraph = defineGraph({
        id: "doltlite_journal",
        nodes: { Person: { type: Person } },
        edges: {},
      });
      const [journalStore] = await createStoreWithSchema(
        journalGraph,
        primary.backend,
        { revisionTracking: true },
      );
      await journalStore.nodes.Person.create({ name: "Journal", count: 0 });
      assert.equal(
        scalar(
          connection,
          "SELECT count(*) AS value FROM typegraph_revision_changes WHERE graph_id = ?",
          journalGraph.id,
        ),
        1,
      );
      assert.ok(await journalStore.lineageRevisionNow());
    });

    await step("Commit, branch isolation, diff and fast-forward merge", () => {
      runVersionControl(connection, "SELECT dolt_commit('-Am', 'base')");
      runVersionControl(connection, "SELECT dolt_branch('feature')");
      runVersionControl(peer.connection, "SELECT dolt_checkout('feature')");
      peer.connection.exec("UPDATE probe SET value = 10 WHERE id = 'counter'");
      runVersionControl(
        peer.connection,
        "SELECT dolt_commit('-am', 'feature')",
      );
      assert.equal(
        scalar(connection, "SELECT value FROM probe WHERE id = 'counter'"),
        4,
      );
      assert.equal(
        scalar(peer.connection, "SELECT value FROM probe WHERE id = 'counter'"),
        10,
      );
      assert.equal(
        scalar(
          connection,
          "SELECT count(*) AS value FROM dolt_diff_probe('main', 'feature')",
        ),
        1,
      );
      runVersionControl(connection, "SELECT dolt_merge('feature')");
      assert.equal(
        scalar(connection, "SELECT value FROM probe WHERE id = 'counter'"),
        10,
      );
    });

    await step(
      "Version-control helper refuses an open SQL transaction",
      async () => {
        const before = scalar(
          connection,
          "SELECT count(*) AS value FROM typegraph_nodes",
        );
        await assert.rejects(
          store.transaction(async (transaction) => {
            await transaction.nodes.Person.create({
              name: "Must roll back",
              count: 0,
            });
            runVersionControl(
              connection,
              "SELECT dolt_commit('-am', 'refused')",
            );
          }),
          /outside TypeGraph\/SQL transactions/,
        );
        assert.equal(
          scalar(connection, "SELECT count(*) AS value FROM typegraph_nodes"),
          before,
        );
        assert.equal(
          scalar(connection, "SELECT value FROM probe WHERE id = 'counter'"),
          10,
        );
      },
    );

    await step(
      "Raw dolt_commit crosses the SQL transaction boundary",
      () => {
        connection.exec(
          "BEGIN; UPDATE probe SET value = 20 WHERE id = 'counter'",
        );
        try {
          connection
            .prepare("SELECT dolt_commit('-am', 'raw boundary probe')")
            .get();
          if (connection.inTransaction) connection.exec("ROLLBACK");
          assert.equal(
            scalar(connection, "SELECT value FROM probe WHERE id = 'counter'"),
            20,
          );
        } finally {
          if (connection.inTransaction) connection.exec("ROLLBACK");
        }
      },
      "Native version-control commands can commit an enclosing SQL transaction; raw access bypasses the helper",
    );

    await step(
      "Independent typed branch writes conflict on recorded clock",
      async () => {
        runVersionControl(connection, "SELECT dolt_branch('typed-feature')");
        runVersionControl(
          peer.connection,
          "SELECT dolt_checkout('typed-feature')",
        );
        const [branchStore] = await createStoreWithSchema(graph, peer.backend, {
          history: true,
          revisionTracking: true,
        });
        await store.nodes.Person.create({ name: "Main only", count: 1 });
        // Different clock generations make the conflict independent of wall time.
        await store.nodes.Person.create({ name: "Main second", count: 2 });
        runVersionControl(
          connection,
          "SELECT dolt_commit('-am', 'main typed write')",
        );
        const branchPerson = await branchStore.nodes.Person.create({
          name: "Feature only",
          count: 2,
        });
        runVersionControl(
          peer.connection,
          "SELECT dolt_commit('-am', 'branch typed write')",
        );
        connection.exec("BEGIN");
        try {
          assert.throws(
            () =>
              connection.prepare("SELECT dolt_merge('typed-feature')").get(),
            /conflict/,
          );
          assert.deepEqual(
            connection.prepare("SELECT * FROM dolt_conflicts").all(),
            [{ table: "typegraph_recorded_clock", num_conflicts: 1 }],
          );
        } finally {
          if (connection.inTransaction) connection.exec("ROLLBACK");
        }
        assert.equal(
          scalar(connection, "SELECT count(*) AS value FROM dolt_conflicts"),
          0,
        );
        const absentOnMain = await store.nodes.Person.getById(branchPerson.id);
        const retainedOnBranch = await branchStore.nodes.Person.getById(
          branchPerson.id,
        );
        assert.equal(absentOnMain, undefined);
        assert.equal(retainedOnBranch?.name, "Feature only");
      },
      "Disjoint node writes collide on history metadata; automatic native graph merge is not supported",
    );
  } finally {
    await peer.backend.close();
  }
} finally {
  await primary.backend.close();
  await rm(directory, { recursive: true, force: true });
}

for (const outcome of outcomes) {
  console.log(
    `${outcome.status}: ${outcome.name}${outcome.detail === "" ? "" : ` — ${outcome.detail}`}`,
  );
}
function count(status: Outcome["status"]): number {
  return outcomes.filter((outcome) => outcome.status === status).length;
}
console.log(
  `${count("PASS")} passed, ${count("GAP")} known gaps, ${count("FAIL")} failed`,
);
if (count("FAIL") > 0) process.exitCode = 1;
