/**
 * A history store over a backend whose `commands` getter hands out a new port
 * wrapper on every read.
 *
 * A custom backend may expose its command port through a getter that builds a
 * fresh wrapper object for the same pinned transaction each time it is read.
 * Nothing in the backend contract asks a property read to return the same
 * object twice, so recorded capture must not tie evidence it keeps for a
 * transaction session (the single-flight graph-lock memo) to the identity of
 * one value read off that property. Every lane runs the same writes: an
 * autocommit create, and a Store transaction that creates twice and updates,
 * which consults the session's memo on every write after the first.
 *
 * The same transaction also runs over a port getter that hands out ONE
 * wrapper per transaction, and the two must issue the same statements and
 * command calls: a memo the fresh wrappers lost would re-take the graph lock
 * on every write. The memo is consulted only under a keyed fence plan; an
 * engine-serialized backend issues the same statements either way.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";

const FreshPortItem = defineNode("FreshPortItem", {
  schema: z.object({ label: z.string() }),
});

function freshPortGraphOf(id: string) {
  return defineGraph({
    id,
    nodes: { FreshPortItem: { type: FreshPortItem } },
    edges: {},
  });
}

const freshPortGraph = freshPortGraphOf("fresh_command_port");

type TransactionCallback = (transaction: object) => unknown;
type TransactionMember = (
  callback: TransactionCallback,
  options?: unknown,
) => unknown;

/** How a wrapped backend hands out its command port. */
type PortReads = "fresh" | "stable";

/** Statement and command calls a wrapped transaction issued. */
interface CallCounts {
  statements: number;
  commands: number;
}

const STATEMENT_MEMBERS = ["execute", "executeRaw", "executeStatement"];

/** `value`'s own function members, each counted into `counts` under `key`. */
function countedMembers(
  value: object,
  names: readonly string[],
  counts: CallCounts,
  key: keyof CallCounts,
): PropertyDescriptorMap {
  const members: PropertyDescriptorMap = {};
  for (const name of names) {
    const member: unknown = Reflect.get(value, name);
    if (typeof member !== "function") continue;
    members[name] = {
      enumerable: true,
      value: (...args: unknown[]): unknown => {
        counts[key] += 1;
        return Reflect.apply(member, value, args) as unknown;
      },
    };
  }
  return members;
}

/**
 * A hand-written backend over `backend`: every member is `backend`'s own
 * (backend members are receiver-free by contract), except a `commands`
 * getter and a `transaction` member that hands its callback each
 * transaction it opens built the same way. Under `fresh` the getter returns
 * a new wrapper around the same port on every read; under `stable`, one
 * wrapper for the object's lifetime. With `counts`, a transaction's
 * statement members and command port members count their calls.
 */
function withCommandPorts<T extends object>(
  backend: T,
  reads: PortReads,
  counts?: CallCounts,
): T {
  const inTransaction = !("transaction" in backend);
  const counting = inTransaction ? counts : undefined;
  const wrapPort = (): unknown => {
    const commands: unknown = Reflect.get(backend, "commands");
    if (typeof commands !== "object" || commands === null) return commands;
    if (counting === undefined) return { ...commands };
    return Object.create(
      commands,
      countedMembers(commands, Object.keys(commands), counting, "commands"),
    ) as unknown;
  };
  let stablePort: unknown;
  const members: PropertyDescriptorMap = {
    ...(counting === undefined ?
      {}
    : countedMembers(backend, STATEMENT_MEMBERS, counting, "statements")),
    commands: {
      enumerable: true,
      get(): unknown {
        if (reads === "fresh") return wrapPort();
        stablePort ??= wrapPort();
        return stablePort;
      },
    },
  };
  const transaction: unknown = Reflect.get(backend, "transaction");
  if (typeof transaction === "function") {
    const open = transaction as TransactionMember;
    members["transaction"] = {
      enumerable: true,
      value: (callback: TransactionCallback, options?: unknown): unknown =>
        open(
          (opened: object) => callback(withCommandPorts(opened, reads, counts)),
          options,
        ),
    };
  }
  return Object.create(backend, members) as T;
}

/**
 * A history Store over `backend` wrapped with `reads`, after one autocommit
 * create; then the calls its transaction of two creates and an update issues.
 */
async function transactionCalls(
  backend: object,
  reads: PortReads,
  graphId: string,
): Promise<CallCounts> {
  const counts: CallCounts = { statements: 0, commands: 0 };
  const wrapped = withCommandPorts(
    backend as ReturnType<IntegrationTestContext["getStore"]>["backend"],
    reads,
    counts,
  );
  const [store] = await createStoreWithSchema(
    freshPortGraphOf(graphId),
    wrapped,
    { history: true },
  );
  await store.nodes.FreshPortItem.create({ label: "warm" });
  counts.statements = 0;
  counts.commands = 0;
  await store.transaction(async (tx) => {
    const created = await tx.nodes.FreshPortItem.create({ label: "second" });
    await tx.nodes.FreshPortItem.create({ label: "third" });
    await tx.nodes.FreshPortItem.update(created.id, { label: "second'" });
  });
  return { ...counts };
}

export function registerFreshCommandPortIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("History writes over a backend whose command port getter returns a new wrapper per read", () => {
    it("the getter hands out a new object on every read", () => {
      const backend = withCommandPorts(context.getStore().backend, "fresh");
      expect(backend.commands).toBeDefined();
      expect(backend.commands).not.toBe(backend.commands);
    });

    it("records an autocommit create and a multi-write transaction", async () => {
      const backend = withCommandPorts(context.getStore().backend, "fresh");
      const [store] = await createStoreWithSchema(freshPortGraph, backend, {
        history: true,
      });

      const first = await store.nodes.FreshPortItem.create({ label: "first" });
      const [second, third] = await store.transaction(async (tx) => {
        const created = await tx.nodes.FreshPortItem.create({
          label: "second",
        });
        const another = await tx.nodes.FreshPortItem.create({
          label: "third",
        });
        await tx.nodes.FreshPortItem.update(created.id, { label: "second'" });
        return [created, another] as const;
      });

      const recordedAt = requireDefined(await store.recordedNow());
      const recorded = store.asOfRecorded(recordedAt);
      const labels = await Promise.all(
        [first.id, second.id, third.id].map(async (id) => {
          const node = await recorded.nodes.FreshPortItem.getById(id);
          return node?.label;
        }),
      );
      expect(labels).toEqual(["first", "second'", "third"]);
    });

    it("issues the same statements as over a port getter with one wrapper per transaction", async () => {
      const backend = context.getStore().backend;
      const stable = await transactionCalls(
        backend,
        "stable",
        "fresh_command_port_stable",
      );
      const fresh = await transactionCalls(
        backend,
        "fresh",
        "fresh_command_port_fresh",
      );
      expect(stable.statements).toBeGreaterThan(0);
      expect(fresh).toEqual(stable);
    });
  });
}
