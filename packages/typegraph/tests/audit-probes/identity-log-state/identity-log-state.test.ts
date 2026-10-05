import { afterEach, describe, expect, it } from "vitest";

import { createStoreWithSchema } from "../../../src";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import { branch } from "../../../src/graph-merge/branch";
import { merge } from "../../../src/graph-merge/merge";
import { unwrap } from "../../../src/graph-merge/result";
import { asBranchId } from "../../../src/graph-merge/types";
import { asNodeId, graph, P } from "./harness";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
function openBackend() {
  const { backend } = createLocalSqliteBackend();
  cleanups.push(() => backend.close());
  return backend;
}

describe("identity transition log: history and discoverability", () => {
  it("merge-applied-node-write-decision", async () => {
    // Changeset: every transition a merge causes carries a decision naming the
    // branch. A merge-applied node delete's detach carries none.
    const [base] = await createStoreWithSchema(graph, openBackend(), {
      history: true,
    });
    for (const id of ["a", "b"])
      await base.nodes.Person.create({ name: id }, { id });
    await base.identity.assertSame(P("a"), P("b"));
    const source = unwrap(
      await branch(base, () => Promise.resolve(openBackend()), {
        id: asBranchId("br"),
      }),
    );
    await source.store.nodes.Person.delete(asNodeId("a"));
    unwrap(await merge(base, [source]));

    const { transitions } = await base.identity.transitionsOf(P("a"));
    const detach = transitions.find((transition) => transition.cause === "detach");
    expect(detach).toBeDefined();
    expect(detach?.decision?.branchId).toBe("br");
  });
});
