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
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";

const FreshPortItem = defineNode("FreshPortItem", {
  schema: z.object({ label: z.string() }),
});

const freshPortGraph = defineGraph({
  id: "fresh_command_port",
  nodes: { FreshPortItem: { type: FreshPortItem } },
  edges: {},
});

type TransactionCallback = (transaction: object) => unknown;
type TransactionMember = (
  callback: TransactionCallback,
  options?: unknown,
) => unknown;

/**
 * A hand-written backend over `backend`: every member is `backend`'s own
 * (backend members are receiver-free by contract), except a `commands` getter
 * that returns a new wrapper around the same port on every read, and a
 * `transaction` member that hands its callback each transaction it opens
 * built the same way.
 */
function withFreshCommandPorts<T extends object>(backend: T): T {
  const members: PropertyDescriptorMap = {
    commands: {
      enumerable: true,
      get(): unknown {
        const commands: unknown = Reflect.get(backend, "commands");
        return typeof commands === "object" && commands !== null ?
            { ...commands }
          : commands;
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
          (opened: object) => callback(withFreshCommandPorts(opened)),
          options,
        ),
    };
  }
  return Object.create(backend, members) as T;
}

export function registerFreshCommandPortIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("History writes over a backend whose command port getter returns a new wrapper per read", () => {
    it("the getter hands out a new object on every read", () => {
      const backend = withFreshCommandPorts(context.getStore().backend);
      expect(backend.commands).toBeDefined();
      expect(backend.commands).not.toBe(backend.commands);
    });

    it("records an autocommit create and a multi-write transaction", async () => {
      const backend = withFreshCommandPorts(context.getStore().backend);
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
  });
}
