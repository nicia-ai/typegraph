import { DatabaseSync } from "@dolthub/doltlite";

const path = process.argv[2];
if (path === undefined) throw new Error("Expected a disposable probe database");
const connection = new DatabaseSync(path);
try {
  connection.exec("PRAGMA busy_timeout = 0");
  try {
    connection.exec(
      "BEGIN; UPDATE probe SET value = value + 1 WHERE id = 'counter'; COMMIT;",
    );
    console.log(JSON.stringify({ outcome: "committed" }));
  } catch (error) {
    if (connection.inTransaction) connection.exec("ROLLBACK");
    if (!(error instanceof Error) || error.message !== "database is locked") {
      throw error;
    }
    console.log(JSON.stringify({ outcome: "blocked" }));
  }
} finally {
  connection.close();
}
