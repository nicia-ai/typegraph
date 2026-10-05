/**
 * Item D.2 — `acyclic: true` on an edge registration.
 *
 * Query-and-constraint semantics for the acyclicity fence, run on every
 * backend through the shared `integrationTestGraph` fixtures `dependsOn`
 * (`cardinality: "many", acyclic: true`) and `blockedBy` (`acyclic: true`,
 * default cardinality), both `Task -> Task`.
 *
 * Every case names the mutation that must make it fail — see
 * scratchpad/lane-D2-load-bearing.md for the verified revert/mutation runs.
 */
import { describe, expect, it } from "vitest";

import { EdgeAcyclicityError } from "../../../src";
import { MAX_EXPLICIT_RECURSIVE_DEPTH } from "../../../src/query/compiler/recursive";
import { edgeWriteNeedsConstraintFence } from "../../../src/store/constraints";
import { compareStrings } from "../../../src/utils/compare";
import { requireDefined } from "../../../src/utils/presence";
import { matchingObject } from "../../test-utils";
import { type IntegrationTestContext } from "./test-context";

type AcyclicIntegrationStore = ReturnType<IntegrationTestContext["getStore"]>;

/** `b → a` stored then soft-deleted: re-admitting it closes a cycle with `a → b`. */
async function tombstonedBackEdge(store: AcyclicIntegrationStore) {
  const a = await store.nodes.Task.create({ name: "a" });
  const b = await store.nodes.Task.create({ name: "b" });
  const c = await store.nodes.Task.create({ name: "c" });
  const back = await store.edges.dependsOn.create(b, a);
  await store.edges.dependsOn.delete(back.id);
  return { store, a, b, c, back };
}

/** `a → b` live, `b → c` and `c → a` tombstoned: only both together close a cycle. */
async function resurrectionsClosingACycleTogether(
  store: AcyclicIntegrationStore,
) {
  const a = await store.nodes.Task.create({ name: "a" });
  const b = await store.nodes.Task.create({ name: "b" });
  const c = await store.nodes.Task.create({ name: "c" });
  const bToC = await store.edges.dependsOn.create(b, c);
  const cToA = await store.edges.dependsOn.create(c, a);
  await store.edges.dependsOn.delete(bToC.id);
  await store.edges.dependsOn.delete(cToA.id);
  await store.edges.dependsOn.create(a, b);
  return { store, a, b, c, bToC, cToA };
}

async function refusalNamesWithin(
  store: AcyclicIntegrationStore,
  write: (
    edges: AcyclicIntegrationStore["edges"]["dependsOn"],
  ) => Promise<unknown>,
): Promise<readonly unknown[]> {
  const refusals: unknown[] = [];
  await store.transaction(async (tx) => {
    await write(tx.edges.dependsOn as never).catch((error: unknown) =>
      refusals.push(error instanceof Error ? error.name : error),
    );
  });
  return refusals;
}

async function storedEndpoints(
  store: AcyclicIntegrationStore,
): Promise<readonly string[]> {
  const edges = await store.edges.dependsOn.find({});
  return edges
    .map((edge) => `${edge.fromId}>${edge.toId}`)
    .toSorted(compareStrings);
}

export function registerEdgeAcyclicityIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("edge acyclicity (item D.2)", () => {
    it("refuses a direct two-cycle", async () => {
      const store = context.getStore();
      const a = await store.nodes.Task.create({ name: "a" });
      const b = await store.nodes.Task.create({ name: "b" });
      await store.edges.dependsOn.create(a, b);

      await expect(store.edges.dependsOn.create(b, a)).rejects.toThrow(
        expect.objectContaining({
          name: "EdgeAcyclicityError",
          details: matchingObject({
            edgeKind: "dependsOn",
            fromId: b.id,
            toId: a.id,
            selfLoop: false,
          }),
        }),
      );
    });

    it("refuses a self-loop as a cycle of length one", async () => {
      const store = context.getStore();
      const a = await store.nodes.Task.create({ name: "a" });

      await expect(store.edges.dependsOn.create(a, a)).rejects.toThrow(
        expect.objectContaining({
          name: "EdgeAcyclicityError",
          details: matchingObject({ selfLoop: true }),
        }),
      );
    });

    it("refuses a cycle longer than MAX_EXPLICIT_RECURSIVE_DEPTH, proving the check is not the bounded query path", async () => {
      const store = context.getStore();
      const chainLength = MAX_EXPLICIT_RECURSIVE_DEPTH + 200;
      const tasks = await store.nodes.Task.bulkCreate(
        Array.from({ length: chainLength + 1 }, (_unused, index) => ({
          props: { name: `t${String(index)}` },
        })),
      );

      await store.edges.dependsOn.bulkCreate(
        tasks.slice(0, -1).map((task, index) => ({
          from: task,
          to: requireDefined(tasks[index + 1]),
        })),
      );

      const first = requireDefined(tasks[0]);
      const last = requireDefined(tasks.at(-1));
      await expect(store.edges.dependsOn.create(last, first)).rejects.toThrow(
        EdgeAcyclicityError,
      );
    }, 30_000);

    it("accepts a DAG with ~2^30 distinct paths and refuses the edge that closes it, in bounded time", async () => {
      const store = context.getStore();
      // 30 stacked diamonds: each diamond doubles the path count from the
      // previous merge node, so the final merge node is reachable from the
      // root along 2^30 distinct paths through only ~120 edges. `UNION`
      // (never `UNION ALL`) is what keeps this bounded — see the mutation
      // note in scratchpad/lane-D2-load-bearing.md.
      const diamondCount = 30;
      const root = await store.nodes.Task.create({ name: "root" });
      let current = root;
      for (let diamond = 0; diamond < diamondCount; diamond += 1) {
        const left = await store.nodes.Task.create({
          name: `d${String(diamond)}-left`,
        });
        const right = await store.nodes.Task.create({
          name: `d${String(diamond)}-right`,
        });
        const merge = await store.nodes.Task.create({
          name: `d${String(diamond)}-merge`,
        });
        await store.edges.dependsOn.bulkCreate([
          { from: current, to: left },
          { from: current, to: right },
          { from: left, to: merge },
          { from: right, to: merge },
        ]);
        current = merge;
      }

      // An insert that does NOT close a cycle completes in bounded time.
      const unrelated = await store.nodes.Task.create({ name: "unrelated" });
      await expect(
        store.edges.dependsOn.create(current, unrelated),
      ).resolves.toBeDefined();

      // The closing edge from the final merge node back to the original
      // root — reachable along 2^30 distinct paths — must be refused, and
      // must not time out doing so.
      await expect(store.edges.dependsOn.create(current, root)).rejects.toThrow(
        EdgeAcyclicityError,
      );
    }, 30_000);

    it("does not count a soft-deleted edge in the relation's population", async () => {
      const store = context.getStore();
      const a = await store.nodes.Task.create({ name: "a" });
      const b = await store.nodes.Task.create({ name: "b" });
      const forward = await store.edges.dependsOn.create(a, b);
      await store.edges.dependsOn.delete(forward.id);

      await expect(store.edges.dependsOn.create(b, a)).resolves.toBeDefined();
    });

    it("still counts an edge whose validity window has ended", async () => {
      const store = context.getStore();
      const a = await store.nodes.Task.create({ name: "a" });
      const b = await store.nodes.Task.create({ name: "b" });
      // Born already ended, so no separate update-then-race with "now" is
      // needed to get an ended-but-not-deleted row.
      await store.edges.dependsOn.create(
        a,
        b,
        {},
        {
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2020-06-01T00:00:00.000Z",
        },
      );

      await expect(store.edges.dependsOn.create(b, a)).rejects.toThrow(
        EdgeAcyclicityError,
      );
    });

    it("checks a resurrected edge against the current population", async () => {
      const store = context.getStore();
      const a = await store.nodes.Task.create({ name: "a" });
      const b = await store.nodes.Task.create({ name: "b" });
      const forward = await store.edges.dependsOn.create(a, b);
      await store.edges.dependsOn.delete(forward.id);
      // Accepted: the forward edge is soft-deleted, so it frees the relation.
      await store.edges.dependsOn.create(b, a);

      // Resurrecting `a -> b` now closes the cycle `a -> b -> a`.
      await expect(
        store.edges.dependsOn.getOrCreateByEndpoints(
          a,
          b,
          {},
          { ifExists: "update" },
        ),
      ).rejects.toThrow(EdgeAcyclicityError);
    });

    it("clearValidTo alone runs no acyclicity probe (over-fencing guard)", async () => {
      const store = context.getStore();
      const a = await store.nodes.Task.create({ name: "a" });
      const b = await store.nodes.Task.create({ name: "b" });
      const forward = await store.edges.dependsOn.create(
        a,
        b,
        {},
        {
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2020-06-01T00:00:00.000Z",
        },
      );

      // Refused per the "ended window still counts" test above.
      await expect(store.edges.dependsOn.create(b, a)).rejects.toThrow(
        EdgeAcyclicityError,
      );

      // Clearing the end must not itself be checked, and must not change
      // the outcome of the (still-refused) opposite create.
      await store.edges.dependsOn.update(
        forward.id,
        {},
        { clearValidTo: true },
      );
      await expect(store.edges.dependsOn.create(b, a)).rejects.toThrow(
        EdgeAcyclicityError,
      );
    });

    it("refuses an in-batch cycle in bulkCreate with zero rows committed", async () => {
      const store = context.getStore();
      const a = await store.nodes.Task.create({ name: "a" });
      const b = await store.nodes.Task.create({ name: "b" });

      await expect(
        store.edges.dependsOn.bulkCreate([
          { from: a, to: b },
          { from: b, to: a },
        ]),
      ).rejects.toThrow(EdgeAcyclicityError);

      const remaining = await store.edges.dependsOn.find({});
      expect(remaining).toEqual([]);
    });

    it("leaves no cycle behind when a batch refusal is caught inside an enclosing transaction", async () => {
      const batchWrites = {
        bulkCreate: (edges, closing) => edges.bulkCreate([closing]),
        bulkInsert: (edges, closing) => edges.bulkInsert([closing]),
        bulkUpsertById: (edges, closing) =>
          edges.bulkUpsertById([
            { id: `closing-${closing.from.id}` as never, ...closing },
          ]),
        bulkGetOrCreateByEndpoints: (edges, closing) =>
          edges.bulkGetOrCreateByEndpoints([closing]),
      } satisfies Record<
        string,
        (
          edges: ReturnType<typeof context.getStore>["edges"]["dependsOn"],
          closing: Readonly<{
            from: Readonly<{ kind: "Task"; id: string }>;
            to: Readonly<{ kind: "Task"; id: string }>;
            props: Record<string, never>;
          }>,
        ) => Promise<unknown>
      >;

      const store = context.getStore();
      const outcomes: Record<string, unknown> = {};
      for (const [variant, write] of Object.entries(batchWrites)) {
        const a = await store.nodes.Task.create({ name: `${variant}-a` });
        const b = await store.nodes.Task.create({ name: `${variant}-b` });
        const c = await store.nodes.Task.create({ name: `${variant}-c` });
        await store.edges.dependsOn.create(a, b);
        await store.edges.dependsOn.create(b, c);

        const refusals: unknown[] = [];
        await store.transaction(async (tx) => {
          await write(tx.edges.dependsOn as never, {
            from: c,
            to: a,
            props: {},
          }).catch((error: unknown) => refusals.push(error));
        });

        outcomes[variant] = {
          refusals: refusals.map((error) =>
            error instanceof Error ? error.name : error,
          ),
          storedFromClosingSource: await store.edges.dependsOn.findFrom(c),
        };
      }
      expect(outcomes).toEqual(
        Object.fromEntries(
          Object.keys(batchWrites).map((variant) => [
            variant,
            { refusals: ["EdgeAcyclicityError"], storedFromClosingSource: [] },
          ]),
        ),
      );
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    describe("a batch that resurrects tombstoned edges", () => {
      it("bulkUpsertById stores no create when a resurrection in the same batch is refused", async () => {
        const { store, a, b, back } = await tombstonedBackEdge(
          context.getStore(),
        );

        const refusals = await refusalNamesWithin(store, (edges) =>
          edges.bulkUpsertById([
            { id: "fresh-a-b" as never, from: a, to: b, props: {} },
            { id: back.id, from: b, to: a, props: {} },
          ]),
        );

        expect(refusals).toEqual(["EdgeAcyclicityError"]);
        expect(await storedEndpoints(store)).toEqual([]);
        expect(await store.verifyConstraintFences()).toEqual([]);
      });

      it("bulkUpsertById stores no resurrection when a later one is refused", async () => {
        const { store, a, b, c, bToC, cToA } =
          await resurrectionsClosingACycleTogether(context.getStore());

        const refusals = await refusalNamesWithin(store, (edges) =>
          edges.bulkUpsertById([
            { id: bToC.id, from: b, to: c, props: {} },
            { id: cToA.id, from: c, to: a, props: {} },
          ]),
        );

        expect(refusals).toEqual(["EdgeAcyclicityError"]);
        expect(await storedEndpoints(store)).toEqual([`${a.id}>${b.id}`]);
        expect(await store.verifyConstraintFences()).toEqual([]);
      });

      it("bulkGetOrCreateByEndpoints stores no create when a resurrection in the same batch is refused", async () => {
        const { store, a, b, c } = await tombstonedBackEdge(context.getStore());

        const refusals = await refusalNamesWithin(store, (edges) =>
          edges.bulkGetOrCreateByEndpoints([
            { from: a, to: b, props: {} },
            { from: c, to: a, props: {} },
            { from: b, to: a, props: {} },
          ]),
        );

        expect(refusals).toEqual(["EdgeAcyclicityError"]);
        expect(await storedEndpoints(store)).toEqual([]);
        expect(await store.verifyConstraintFences()).toEqual([]);
      });

      it("bulkGetOrCreateByEndpoints stores no resurrection when a later one is refused", async () => {
        const { store, a, b, c } = await resurrectionsClosingACycleTogether(
          context.getStore(),
        );

        const refusals = await refusalNamesWithin(store, (edges) =>
          edges.bulkGetOrCreateByEndpoints([
            { from: b, to: c, props: {} },
            { from: c, to: a, props: {} },
          ]),
        );

        expect(refusals).toEqual(["EdgeAcyclicityError"]);
        expect(await storedEndpoints(store)).toEqual([`${a.id}>${b.id}`]);
        expect(await store.verifyConstraintFences()).toEqual([]);
      });
    });

    it("refuses a batch whose own rows close a cycle through a stored edge, before writing any of them", async () => {
      const store = context.getStore();
      const a = await store.nodes.Task.create({ name: "a" });
      const b = await store.nodes.Task.create({ name: "b" });
      const c = await store.nodes.Task.create({ name: "c" });
      await store.edges.dependsOn.create(b, c);

      const refusals: unknown[] = [];
      await store.transaction(async (tx) => {
        await tx.edges.dependsOn
          .bulkCreate([
            { from: a, to: b },
            { from: c, to: a },
          ])
          .catch((error: unknown) => refusals.push(error));
      });

      expect(refusals).toEqual([
        expect.objectContaining({ name: "EdgeAcyclicityError" }),
      ]);
      expect(await store.edges.dependsOn.find({})).toHaveLength(1);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("treats two acyclic edge kinds as two independent relations", async () => {
      const store = context.getStore();
      const a = await store.nodes.Task.create({ name: "a" });
      const b = await store.nodes.Task.create({ name: "b" });

      await store.edges.dependsOn.create(a, b);
      await expect(store.edges.blockedBy.create(b, a)).resolves.toBeDefined();
    });

    it("fences a many-cardinality acyclic edge under one transaction, both writes serialized", async () => {
      // The concurrency proof with two REAL sessions is
      // tests/backends/postgres/concurrent-edge-acyclicity.test.ts (§14.2);
      // this pins the classification the fence is taken FROM, and that
      // opposing creates inside one transaction serialize correctly (the
      // second sees the first's uncommitted insert).
      expect(
        edgeWriteNeedsConstraintFence({ cardinality: "many", acyclic: true }),
      ).toBe("edgeAcyclicity");

      const store = context.getStore();
      const a = await store.nodes.Task.create({ name: "lock-a" });
      const b = await store.nodes.Task.create({ name: "lock-b" });
      await expect(
        store.transaction(async (tx) => {
          await tx.edges.dependsOn.create(a, b);
          await tx.edges.dependsOn.create(b, a);
        }),
      ).rejects.toThrow(EdgeAcyclicityError);
    });

    it("reports a pre-existing cycle through verifyConstraintFences", async () => {
      const store = context.getStore();
      const a = await store.nodes.Task.create({ name: "a" });
      const b = await store.nodes.Task.create({ name: "b" });
      // Seeded directly through the backend, bypassing the fence: the
      // store's own writes are fenced and can never produce a cycle.
      const backend = context.getBackend();
      const forward = await backend.insertEdge({
        graphId: "integration_test",
        id: "seeded-forward",
        kind: "dependsOn",
        fromKind: "Task",
        fromId: a.id,
        toKind: "Task",
        toId: b.id,
        props: {},
      });
      const backward = await backend.insertEdge({
        graphId: "integration_test",
        id: "seeded-backward",
        kind: "dependsOn",
        fromKind: "Task",
        fromId: b.id,
        toKind: "Task",
        toId: a.id,
        props: {},
      });

      const violations = await store.verifyConstraintFences();
      const acyclicityViolations = violations.filter(
        (violation) => violation.family === "edgeAcyclicity",
      );
      expect(acyclicityViolations).toEqual([
        {
          family: "edgeAcyclicity",
          relation: "dependsOn",
          edgeIds: [forward.id, backward.id].toSorted(compareStrings),
        },
      ]);
    });
  });
}
