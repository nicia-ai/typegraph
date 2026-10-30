import { beforeEach, describe, expect, it, vi } from "vitest";

import { indexSubgraph } from "../../../src";
import { ConfigurationError } from "../../../src/errors";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";

/**
 * Hydrating 500 subgraphs in one statement takes about 3.5s alone on
 * PostgreSQL, too close to the 15s default on a loaded CI host.
 */
const FULL_BATCH_CAP_TIMEOUT_MS = 60_000;

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

      it(
        "composes the full 500-read cap into one statement or refuses it by bind budget",
        async () => {
          const store = context.getStore();
          const people = [seeded.alice, seeded.bob, seeded.charlie] as const;
          const roots = Array.from(
            { length: 500 },
            (_, index) => people[index % people.length] ?? seeded.alice,
          );

          // Composing 500 reads must never overflow the call stack. A backend
          // whose bind budget cannot hold the statement refuses it with the
          // typed budget error instead; every other backend runs it.
          const outcome = await store
            .batchOnce(
              (read) =>
                roots.map((rootNode) =>
                  read.subgraph(rootNode, {
                    edges: ["knows", "worksAt"],
                    maxDepth: 2,
                  }),
                ),
              { shareSubgraphs },
            )
            .then(
              (results) => ({ results }) as const,
              (error: unknown) => ({ error }) as const,
            );

          const observed =
            "error" in outcome ?
              {
                outcome: "refused",
                typedBudgetRefusal:
                  outcome.error instanceof ConfigurationError &&
                  outcome.error.details["operation"] === "batchOnce" &&
                  Number(outcome.error.details["bindCount"]) >
                    Number(outcome.error.details["bindBudget"]),
              }
            : {
                outcome: "ran",
                rootIds: outcome.results.map((result) => result.root?.id),
              };
          expect(observed).toEqual(
            observed.outcome === "refused" ?
              { outcome: "refused", typedBudgetRefusal: true }
            : { outcome: "ran", rootIds: roots.map((rootNode) => rootNode.id) },
          );
        },
        FULL_BATCH_CAP_TIMEOUT_MS,
      );

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

        expect(batched).toEqual(independent);
        expect(batched).toHaveLength(roots.length);
        expect(batched[0]).toEqual(batched[2]);
        expect(batched[0]).not.toBe(batched[2]);
        expect(batched[0]?.nodes).not.toBe(batched[2]?.nodes);
        const duplicateBob = indexSubgraph(requireDefined(batched[2])).node(
          seeded.bob,
        );
        expect(duplicateBob).toBeDefined();
        if (duplicateBob === undefined) throw new Error("Bob must be present");
        Reflect.set(duplicateBob, "name", "Changed in duplicate");
        const firstIndex = indexSubgraph(requireDefined(batched[0]));
        expect(firstIndex.node(seeded.bob)).toHaveProperty("name", "Bob");
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
        expect(firstIndex.node(seeded.bob)).toBeDefined();
        expect(firstIndex.node(seeded.charlie)).toBeDefined();
        expect(
          indexSubgraph(requireDefined(batched[1])).node(seeded.alice),
        ).toBeDefined();
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

        expect(batched).toEqual(independent);
        const projectedWindowIndex = indexSubgraph(requireDefined(batched[0]));
        const withoutRootIndex = indexSubgraph(requireDefined(batched[1]));
        const incomingIndex = indexSubgraph(requireDefined(batched[2]));
        expect(projectedWindowIndex.node(seeded.bob)).toBeDefined();
        expect(projectedWindowIndex.node(seeded.charlie)).toBeDefined();
        expect(projectedWindowIndex.node(seeded.dave)).toBeUndefined();
        expect(projectedWindowIndex.node(seeded.erin)).toBeUndefined();
        expect(withoutRootIndex.node(seeded.bob)).toBeUndefined();
        expect(incomingIndex.node(seeded.alice)).toBeDefined();
        expect(incomingIndex.node(seeded.bob)).toBeDefined();
        expect(batched[3].nodes).toHaveLength(0);

        const projectedAlice = projectedWindowIndex.node(seeded.alice);
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
        expect(alice).toEqual(independentAlice);
        expect(projectedAlice).toEqual(independentProjected);
        expect(bob).toEqual(independentBob);
        expect(aliceAgain).toEqual(independentAlice);

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
          expect(currentAfterAdvance).toEqual(currentBeforeAdvance);
          expect(explicitBefore.root).toBeUndefined();
          expect(explicitAfter.root?.id).toBe(futureRoot.id);
        } finally {
          vi.useRealTimers();
        }
      });
    },
  );
}
