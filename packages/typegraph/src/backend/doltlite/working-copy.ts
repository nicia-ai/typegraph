import { DatabaseSync } from "@dolthub/doltlite";

import { type GraphDef } from "../../core/define-graph";
import { ConfigurationError } from "../../errors";
import { storeBackend } from "../../graph-merge/typegraph-internal";
import { forkedWorkingCopyStrategy } from "../../graph-merge/working-copy";
import { generateId } from "../../utils/id";
import { createDoltliteBackend, type DoltliteBackendOptions } from "./index";
import { resolveDoltliteSource } from "./registry";
import {
  commitDoltlite,
  executeDoltliteVersionControl,
} from "./version-control";

type DoltliteFork = Readonly<{
  options: DoltliteBackendOptions;
  dispose: () => Promise<void>;
}>;

/** Native branch allocation; graph changes still merge through TypeGraph's merge engine. */
export function doltliteWorkingCopyStrategy<G extends GraphDef>() {
  return forkedWorkingCopyStrategy<G, DoltliteFork>({
    fork(baseStore) {
      const source = resolveDoltliteSource(storeBackend(baseStore));
      const path = source.options.path;
      if (path === undefined || path === ":memory:")
        throw new ConfigurationError(
          "Native DoltLite working copies require a file-backed database",
          { code: "DOLTLITE_FILE_REQUIRED" },
        );
      const hash = commitDoltlite(
        baseStore,
        "TypeGraph working-copy checkpoint",
        true,
      );
      const branch = `typegraph_work_${generateId()}`;
      executeDoltliteVersionControl(
        source.connection,
        "SELECT dolt_branch(?,?) AS value",
        branch,
        hash,
      );
      return Promise.resolve({
        options: { ...source.options, path, branch },
        dispose() {
          const admin = new DatabaseSync(path);
          try {
            admin.exec("PRAGMA busy_timeout = 0");
            executeDoltliteVersionControl(
              admin,
              "SELECT dolt_branch('-D',?) AS value",
              branch,
            );
          } finally {
            admin.close();
          }
          return Promise.resolve();
        },
      });
    },
    async connect(fork) {
      const { backend } = await createDoltliteBackend(fork.options);
      return backend;
    },
  });
}
