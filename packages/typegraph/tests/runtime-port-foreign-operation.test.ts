/**
 * A Store runtime port member handed an operation another copy of TypeGraph
 * minted: the same release loaded twice (an ESM and a CommonJS build in one
 * process) shares the port's global symbol, so one copy's caller reaches the
 * other copy's Store, but not that copy's private operation keys. The member
 * cannot run in a session it cannot see; the operation's handle joins as a
 * binding of its own, as a bare transaction always did, and the call
 * succeeds.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAdapterStoreWithSchema, defineGraph, defineNode } from "../src";
import type * as OperationScopeModule from "../src/store/operation-scope";
import { enterTransactionOperation } from "../src/store/operation-scope";
import { storeRuntime } from "../src/store/runtime-port";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "runtime_port_foreign_operation",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

/**
 * A second instance of the operation-scope module: another copy's mints. The
 * module registry is reset first, so the import evaluates the module afresh,
 * while the Store imported above keeps the first copy.
 */
async function foreignOperationScope(): Promise<typeof OperationScopeModule> {
  vi.resetModules();
  return import("../src/store/operation-scope");
}

describe("a port member handed another copy's operation", () => {
  it("joins the operation's handle as a binding of its own and answers as for its own operation", async () => {
    const foreign = await foreignOperationScope();
    expect(foreign.enterTransactionOperation).not.toBe(
      enterTransactionOperation,
    );
    const [store] = await createAdapterStoreWithSchema(
      graph,
      createTestBackend(),
    );
    await store.nodes.Person.create({ name: "Ada" }, { id: "a" });
    await store.nodes.Person.create({ name: "Bea" }, { id: "b" });
    await store.identity.assertSame(
      { kind: "Person", id: "a" },
      { kind: "Person", id: "b" },
    );
    const runtime = storeRuntime(store);
    const answers = await store.transaction(async (tx) => {
      const own = await runtime.identityAssertionsAtTarget(
        enterTransactionOperation(tx),
      );
      const fromAnotherCopy = await runtime.identityAssertionsAtTarget(
        foreign.enterTransactionOperation(tx),
      );
      return { own, fromAnotherCopy };
    });
    expect(answers.own).toHaveLength(1);
    expect(answers.fromAnotherCopy).toEqual(answers.own);
  });
});
