import { type DatabaseSync } from "@dolthub/doltlite";

import { type GraphDef } from "../../core/define-graph";
import { ConfigurationError } from "../../errors";
import { storeBackend } from "../../graph-merge/typegraph-internal";
import { type Store } from "../../store/store";
import { resolveDoltliteSource } from "./registry";

export function executeDoltliteVersionControl(
  connection: DatabaseSync,
  sql: string,
  ...params: unknown[]
): unknown {
  if (connection.inTransaction) {
    throw new ConfigurationError(
      "DoltLite version control must run outside TypeGraph/SQL transactions",
      { code: "DOLTLITE_VERSION_CONTROL_IN_TRANSACTION" },
    );
  }
  const row = connection.prepare(sql).get(...params);
  if (row === undefined || Array.isArray(row)) return undefined;
  return row["value"];
}

/** Checkpoint the entire database branch, including every graph and its sidecars. */
export function commitDoltlite<G extends GraphDef>(
  store: Store<G>,
  message: string,
  allowEmpty = false,
): string {
  const { connection } = resolveDoltliteSource(storeBackend(store));
  const hash = executeDoltliteVersionControl(
    connection,
    allowEmpty ?
      "SELECT dolt_commit('-A', '--allow-empty', '-m', ?) AS value"
    : "SELECT dolt_commit('-A', '-m', ?) AS value",
    message,
  );
  if (typeof hash !== "string" || hash.length === 0)
    throw new ConfigurationError("DoltLite did not return a commit hash");
  return hash;
}
