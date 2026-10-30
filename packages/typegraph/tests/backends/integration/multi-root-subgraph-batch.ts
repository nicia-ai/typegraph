import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";

function snapshotOf(result: {
  root: unknown;
  nodes: readonly unknown[];
  edges: readonly unknown[];
}): unknown {
  return { root: result.root, nodes: result.nodes, edges: result.edges };
}

type MultiRootTestStore = ReturnType<IntegrationTestContext["getStore"]>;
type PersonNode = Awaited<
  ReturnType<MultiRootTestStore["nodes"]["Person"]["create"]>
>;
type CompanyNode = Awaited<
  ReturnType<MultiRootTestStore["nodes"]["Company"]["create"]>
>;

async function seedMultiRootSubgraphData(store: MultiRootTestStore): Promise<
  Readonly<{
    alice: PersonNode;
    bob: PersonNode;
    charlie: PersonNode;
    dave: PersonNode;
    erin: PersonNode;
    acme: CompanyNode;
  }>
> {
  const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
  const bob = await store.nodes.Person.create({ name: "Bob", age: 31 });
  const charlie = await store.nodes.Person.create({ name: "Charlie", age: 32 });
  const dave = await store.nodes.Person.create({ name: "Dave", age: 33 });
  const erin = await store.nodes.Person.create({ name: "Erin", age: 34 });
  const acme = await store.nodes.Company.create({
    name: "Acme",
    industry: "Technology",
  });

  await store.edges.knows.create(alice, bob, {}, { id: "01-alice-bob" });
  await store.edges.knows.create(bob, charlie, {}, { id: "02-bob-charlie" });
  await store.edges.knows.create(
    charlie,
    alice,
    {},
    { id: "03-charlie-alice" },
  );
  await store.edges.knows.create(alice, dave, {}, { id: "04-alice-dave" });
  await store.edges.knows.create(bob, erin, {}, { id: "05-bob-erin" });
  await store.edges.worksAt.create(
    alice,
    acme,
    { role: "Engineer" },
    { id: "06-alice-acme" },
  );
  await store.edges.worksAt.create(
    bob,
    acme,
    { role: "Manager" },
    { id: "07-bob-acme" },
  );

  return { alice, bob, charlie, dave, erin, acme };
}

export function registerMultiRootSubgraphBatchIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe.each([false, true])(
    "Multi-root subgraph batching (shareSubgraphs=%s)",
    (shareSubgraphs) => {
      let seeded: Awaited<ReturnType<typeof seedMultiRootSubgraphData>>;

      beforeEach(async () => {
        seeded = await seedMultiRootSubgraphData(context.getStore());
      });

      it("preserves independent result slots for duplicate, missing, overlapping, and cyclic roots", async () => {
        const store = context.getStore();
        const roots = [
          seeded.alice,
          seeded.bob,
          seeded.alice,
          { kind: "Person", id: "missing-multi-root" },
          seeded.charlie,
        ] as const;
        const options = {
          edges: ["knows", "worksAt"],
          maxDepth: 3,
        } as const;

        const independent = await Promise.all(
          roots.map((rootRef) => store.subgraph(rootRef as never, options)),
        );
        const batched = await store.batchOnce(
          (read) =>
            roots.map((rootRef) => read.subgraph(rootRef as never, options)),
          { shareSubgraphs },
        );

        expect(batched.map((result) => snapshotOf(result))).toEqual(
          independent.map((result) => snapshotOf(result)),
        );
        expect(batched).toHaveLength(roots.length);
        expect(snapshotOf(requireDefined(batched[0]))).toEqual(
          snapshotOf(requireDefined(batched[2])),
        );
        expect(batched[0]).not.toBe(batched[2]);
        expect(batched[0]?.nodes).not.toBe(batched[2]?.nodes);
        const duplicateBob = batched[2]?.node(seeded.bob);
        expect(duplicateBob).toBeDefined();
        if (duplicateBob === undefined) throw new Error("Bob must be present");
        Reflect.set(duplicateBob, "name", "Changed in duplicate");
        expect(batched[0]?.node(seeded.bob)).toHaveProperty("name", "Bob");
        const duplicateNodes = requireDefined(batched[2]).nodes;
        const duplicateBobIndex = duplicateNodes.findIndex(
          (node) => node.id === seeded.bob.id,
        );
        Array.prototype.splice.call(duplicateNodes, duplicateBobIndex, 1);
        expect(
          batched[0]?.nodes.some((node) => node.id === seeded.bob.id),
        ).toBe(true);
        expect(
          batched[2]?.nodes.some((node) => node.id === seeded.bob.id),
        ).toBe(false);
        expect(batched[0]?.node(seeded.bob)).toBeDefined();
        expect(batched[0]?.node(seeded.charlie)).toBeDefined();
        expect(batched[1]?.node(seeded.alice)).toBeDefined();
        expect(batched[3]?.root).toBeUndefined();
        expect(batched[3]?.nodes).toHaveLength(0);
      });

      it("keeps projections, traversal policies, and per-endpoint windows isolated per root", async () => {
        const store = context.getStore();
        const projectedWindow = {
          edges: ["knows", "worksAt"],
          maxDepth: 2,
          edgeWindows: {
            knows: {
              limit: 1,
              orderBy: { field: "id", direction: "asc" },
            },
          },
          project: {
            nodes: { Person: ["name"], Company: ["name"] },
            edges: { knows: [], worksAt: ["role"] },
          },
        } as const;
        const peopleWithoutRoot = {
          edges: ["knows"],
          maxDepth: 1,
          includeKinds: ["Person"],
          excludeRoot: true,
        } as const;
        const incomingEmployment = {
          edges: ["worksAt"],
          maxDepth: 1,
          direction: "both",
        } as const;
        const rootOnly = { edges: [], maxDepth: 0 } as const;
        const missingRoot = { kind: "Person", id: "missing-with-options" };

        const independent = await Promise.all([
          store.subgraph(seeded.alice, projectedWindow),
          store.subgraph(seeded.bob, peopleWithoutRoot),
          store.subgraph(seeded.acme, incomingEmployment),
          store.subgraph(missingRoot as never, rootOnly),
        ]);
        const batched = await store.batchOnce(
          (read) => [
            read.subgraph(seeded.alice, projectedWindow),
            read.subgraph(seeded.bob, peopleWithoutRoot),
            read.subgraph(seeded.acme, incomingEmployment),
            read.subgraph(missingRoot as never, rootOnly),
          ],
          { shareSubgraphs },
        );

        expect(batched.map((result) => snapshotOf(result))).toEqual(
          independent.map((result) => snapshotOf(result)),
        );
        expect(batched[0].node(seeded.bob)).toBeDefined();
        expect(batched[0].node(seeded.charlie)).toBeDefined();
        expect(batched[0].node(seeded.dave)).toBeUndefined();
        expect(batched[0].node(seeded.erin)).toBeUndefined();
        expect(batched[1].node(seeded.bob)).toBeUndefined();
        expect(batched[2].node(seeded.alice)).toBeDefined();
        expect(batched[2].node(seeded.bob)).toBeDefined();
        expect(batched[3].nodes).toHaveLength(0);

        const projectedAlice = batched[0].node(seeded.alice);
        expect(projectedAlice).toHaveProperty("name", "Alice");
        expect(projectedAlice).not.toHaveProperty("age");
        expect(projectedAlice).not.toHaveProperty("meta");
      });

      it("preserves output order around compatible and incompatible shared groups without leaking edges", async () => {
        const store = context.getStore();
        const namesQuery = store
          .query()
          .from("Person", "person")
          .orderBy("person", "name", "asc")
          .select((fields) => fields.person.name);
        const compatibleOptions = {
          edges: ["knows", "worksAt"],
          maxDepth: 1,
        } as const;
        const incompatibleProjection = {
          ...compatibleOptions,
          project: {
            nodes: { Person: ["name"], Company: ["name"] },
            edges: { knows: [], worksAt: ["role"] },
          },
        } as const;

        const independentNames = await namesQuery.execute();
        const independentAlice = await store.subgraph(
          seeded.alice,
          compatibleOptions,
        );
        const independentProjected = await store.subgraph(
          seeded.alice,
          incompatibleProjection,
        );
        const independentBob = await store.subgraph(
          seeded.bob,
          compatibleOptions,
        );
        const [names, alice, projectedAlice, bob, aliceAgain] =
          await store.batchOnce(
            (read) => [
              namesQuery,
              read.subgraph(seeded.alice, compatibleOptions),
              read.subgraph(seeded.alice, incompatibleProjection),
              read.subgraph(seeded.bob, compatibleOptions),
              read.subgraph(seeded.alice, compatibleOptions),
            ],
            { shareSubgraphs },
          );

        expect(names).toEqual(independentNames);
        expect(snapshotOf(alice)).toEqual(snapshotOf(independentAlice));
        expect(snapshotOf(projectedAlice)).toEqual(
          snapshotOf(independentProjected),
        );
        expect(snapshotOf(bob)).toEqual(snapshotOf(independentBob));
        expect(snapshotOf(aliceAgain)).toEqual(snapshotOf(independentAlice));

        const aliceEdgeIds = alice.edges.map((edge) => edge.id).toSorted();
        const bobEdgeIds = bob.edges.map((edge) => edge.id).toSorted();
        expect(aliceEdgeIds).toEqual([
          "01-alice-bob",
          "04-alice-dave",
          "06-alice-acme",
          "07-bob-acme",
        ]);
        expect(bobEdgeIds).toEqual([
          "02-bob-charlie",
          "05-bob-erin",
          "07-bob-acme",
        ]);
        expect(aliceEdgeIds).not.toContain("02-bob-charlie");
        expect(bobEdgeIds).not.toContain("01-alice-bob");
      });

      it("pins one current-time coordinate while preserving explicit as-of coordinates", async () => {
        const store = context.getStore();
        const beforeBoundary = "2099-01-01T00:00:00.000Z";
        const boundary = "2099-01-01T00:00:01.000Z";
        const afterBoundary = "2099-01-01T00:00:02.000Z";
        const futureRoot = await store.nodes.Person.create(
          { name: "Future root" },
          { validFrom: boundary },
        );

        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          vi.setSystemTime(new Date(beforeBoundary));
          const [
            currentBeforeAdvance,
            currentAfterAdvance,
            explicitBefore,
            explicitAfter,
          ] = await store.batchOnce(
            (read) => {
              const firstCurrent = read.subgraph(futureRoot, {
                edges: ["knows"],
                maxDepth: 0,
              });
              vi.setSystemTime(new Date(afterBoundary));
              return [
                firstCurrent,
                read.subgraph(futureRoot, {
                  edges: ["knows"],
                  maxDepth: 0,
                }),
                read.subgraph(futureRoot, {
                  edges: ["knows"],
                  maxDepth: 0,
                  temporalMode: "asOf",
                  asOf: beforeBoundary,
                }),
                read.subgraph(futureRoot, {
                  edges: ["knows"],
                  maxDepth: 0,
                  temporalMode: "asOf",
                  asOf: afterBoundary,
                }),
              ];
            },
            { shareSubgraphs },
          );

          expect(currentBeforeAdvance.root).toBeUndefined();
          expect(snapshotOf(currentAfterAdvance)).toEqual(
            snapshotOf(currentBeforeAdvance),
          );
          expect(explicitBefore.root).toBeUndefined();
          expect(explicitAfter.root?.id).toBe(futureRoot.id);
        } finally {
          vi.useRealTimers();
        }
      });
    },
  );
}
