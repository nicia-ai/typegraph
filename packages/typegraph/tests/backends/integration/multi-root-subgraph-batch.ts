import { beforeEach, describe, expect, it, vi } from "vitest";

import { collectAllEdges } from "../../test-utils";
import type { IntegrationTestContext } from "./test-context";

function normalizeSubgraphCollections(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeSubgraphCollections(item))
      .toSorted((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
  }
  if (value instanceof Map) {
    return new Map(
      [...value.entries()]
        .toSorted(([left], [right]) =>
          String(left).localeCompare(String(right)),
        )
        .map(([key, item]) => [key, normalizeSubgraphCollections(item)]),
    );
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      normalizeSubgraphCollections(item),
    ]),
  );
}

async function seedMultiRootSubgraphData(
  store: ReturnType<IntegrationTestContext["getStore"]>,
): Promise<
  Readonly<{
    aliceId: string;
    bobId: string;
    charlieId: string;
    daveId: string;
    erinId: string;
    acmeId: string;
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

  return {
    aliceId: alice.id,
    bobId: bob.id,
    charlieId: charlie.id,
    daveId: dave.id,
    erinId: erin.id,
    acmeId: acme.id,
  };
}

export function registerMultiRootSubgraphBatchIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe.each([false, true])(
    "Multi-root subgraph batching (shareSubgraphs=%s)",
    (shareSubgraphs) => {
      let ids: Awaited<ReturnType<typeof seedMultiRootSubgraphData>>;

      beforeEach(async () => {
        ids = await seedMultiRootSubgraphData(context.getStore());
      });

      it("preserves independent result slots for duplicate, missing, overlapping, and cyclic roots", async () => {
        const store = context.getStore();
        const roots = [
          ids.aliceId,
          ids.bobId,
          ids.aliceId,
          "missing-multi-root",
          ids.charlieId,
        ] as const;
        const options = {
          edges: ["knows", "worksAt"],
          maxDepth: 3,
        } as const;

        const independent = await Promise.all(
          roots.map((rootId) => store.subgraph(rootId as never, options)),
        );
        const batched = await store.batchOnce(
          (read) =>
            roots.map((rootId) => read.subgraph(rootId as never, options)),
          { shareSubgraphs },
        );

        expect(
          batched.map((result) => normalizeSubgraphCollections(result)),
        ).toEqual(
          independent.map((result) => normalizeSubgraphCollections(result)),
        );
        expect(batched).toHaveLength(roots.length);
        expect(normalizeSubgraphCollections(batched[0])).toEqual(
          normalizeSubgraphCollections(batched[2]),
        );
        expect(batched[0]).not.toBe(batched[2]);
        expect(batched[0]?.nodes).not.toBe(batched[2]?.nodes);
        const duplicateBob = batched[2]?.nodes.get(ids.bobId);
        expect(duplicateBob).toBeDefined();
        if (duplicateBob === undefined) throw new Error("Bob must be present");
        Reflect.set(duplicateBob, "name", "Changed in duplicate");
        expect(batched[0]?.nodes.get(ids.bobId)).toHaveProperty("name", "Bob");
        Map.prototype.delete.call(batched[2]?.nodes, ids.bobId);
        expect(batched[0]?.nodes.has(ids.bobId)).toBe(true);
        expect(batched[2]?.nodes.has(ids.bobId)).toBe(false);
        expect(batched[0]?.nodes.has(ids.charlieId)).toBe(true);
        expect(batched[1]?.nodes.has(ids.aliceId)).toBe(true);
        expect(batched[3]?.root).toBeUndefined();
        expect(batched[3]?.nodes.size).toBe(0);
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

        const independent = await Promise.all([
          store.subgraph(ids.aliceId as never, projectedWindow),
          store.subgraph(ids.bobId as never, peopleWithoutRoot),
          store.subgraph(ids.acmeId as never, incomingEmployment),
          store.subgraph("missing-with-options" as never, rootOnly),
        ]);
        const batched = await store.batchOnce(
          (read) => [
            read.subgraph(ids.aliceId as never, projectedWindow),
            read.subgraph(ids.bobId as never, peopleWithoutRoot),
            read.subgraph(ids.acmeId as never, incomingEmployment),
            read.subgraph("missing-with-options" as never, rootOnly),
          ],
          { shareSubgraphs },
        );

        expect(
          batched.map((result) => normalizeSubgraphCollections(result)),
        ).toEqual(
          independent.map((result) => normalizeSubgraphCollections(result)),
        );
        expect(batched[0].nodes.has(ids.bobId)).toBe(true);
        expect(batched[0].nodes.has(ids.charlieId)).toBe(true);
        expect(batched[0].nodes.has(ids.daveId)).toBe(false);
        expect(batched[0].nodes.has(ids.erinId)).toBe(false);
        expect(batched[1].nodes.has(ids.bobId)).toBe(false);
        expect(batched[2].nodes.has(ids.aliceId)).toBe(true);
        expect(batched[2].nodes.has(ids.bobId)).toBe(true);
        expect(batched[3].nodes.size).toBe(0);

        const projectedAlice = batched[0].nodes.get(ids.aliceId);
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
          ids.aliceId as never,
          compatibleOptions,
        );
        const independentProjected = await store.subgraph(
          ids.aliceId as never,
          incompatibleProjection,
        );
        const independentBob = await store.subgraph(
          ids.bobId as never,
          compatibleOptions,
        );
        const [names, alice, projectedAlice, bob, aliceAgain] =
          await store.batchOnce(
            (read) => [
              namesQuery,
              read.subgraph(ids.aliceId as never, compatibleOptions),
              read.subgraph(ids.aliceId as never, incompatibleProjection),
              read.subgraph(ids.bobId as never, compatibleOptions),
              read.subgraph(ids.aliceId as never, compatibleOptions),
            ],
            { shareSubgraphs },
          );

        expect(names).toEqual(independentNames);
        expect(normalizeSubgraphCollections(alice)).toEqual(
          normalizeSubgraphCollections(independentAlice),
        );
        expect(normalizeSubgraphCollections(projectedAlice)).toEqual(
          normalizeSubgraphCollections(independentProjected),
        );
        expect(normalizeSubgraphCollections(bob)).toEqual(
          normalizeSubgraphCollections(independentBob),
        );
        expect(normalizeSubgraphCollections(aliceAgain)).toEqual(
          normalizeSubgraphCollections(independentAlice),
        );

        const aliceEdgeIds = collectAllEdges(alice.adjacency)
          .map((edge) => edge.id)
          .toSorted();
        const bobEdgeIds = collectAllEdges(bob.adjacency)
          .map((edge) => edge.id)
          .toSorted();
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
              const firstCurrent = read.subgraph(futureRoot.id, {
                edges: ["knows"],
                maxDepth: 0,
              });
              vi.setSystemTime(new Date(afterBoundary));
              return [
                firstCurrent,
                read.subgraph(futureRoot.id, {
                  edges: ["knows"],
                  maxDepth: 0,
                }),
                read.subgraph(futureRoot.id, {
                  edges: ["knows"],
                  maxDepth: 0,
                  temporalMode: "asOf",
                  asOf: beforeBoundary,
                }),
                read.subgraph(futureRoot.id, {
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
