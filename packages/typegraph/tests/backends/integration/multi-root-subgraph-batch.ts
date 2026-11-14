import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  asNodeId,
  createStore,
  defineGraph,
  indexSubgraph,
  type Store,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { ConfigurationError } from "../../../src/errors";
import type { OneStatementBatchableQuery } from "../../../src/query/builder/types";
import type { CompiledRowsSql } from "../../../src/query/sql-intent";
import { recursivePlanCount } from "../../../src/query/sql-intent";
import { requireDefined } from "../../../src/utils/presence";
import { integrationTestGraph } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

/** Allow slow CI hosts to execute the full portable request cap. */
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

// Use a small graph and narrow SQL projections so libsql's JSON-key binds
// fit its separate 999-parameter allowance at the planner boundary.
const recursiveBatchGraph = defineGraph({
  id: "recursive_batch_budget",
  nodes: { Person: { type: integrationTestGraph.nodes.Person.type } },
  edges: {
    knows: {
      type: integrationTestGraph.edges.knows.type,
      from: [integrationTestGraph.nodes.Person.type],
      to: [integrationTestGraph.nodes.Person.type],
    },
  },
});
type RecursiveBudgetStore = Store<typeof recursiveBatchGraph>;
type RecursiveBudgetPerson = Awaited<
  ReturnType<RecursiveBudgetStore["nodes"]["Person"]["create"]>
>;

function recursiveRead(store: Pick<RecursiveBudgetStore, "query">) {
  return store
    .query()
    .from("Person", "person")
    .whereNode("person", (person) => person.name.eq("Alice"))
    .traverse("knows", "edge")
    .recursive({ maxHops: 2 })
    .to("Person", "friend");
}

async function recursiveBatchOutcome(batch: Promise<readonly unknown[]>) {
  return batch.then(
    (results) => ({ resultCount: results.length }),
    (error: unknown) => ({
      typed: error instanceof ConfigurationError,
      details: error instanceof ConfigurationError ? error.details : undefined,
    }),
  );
}

export function registerMultiRootSubgraphBatchIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Fluent recursive batch planner budget", () => {
    let budgetStore: RecursiveBudgetStore;
    let budgetRoot: RecursiveBudgetPerson;

    beforeEach(async () => {
      budgetStore = await context.createStore(recursiveBatchGraph);
      budgetRoot = await budgetStore.nodes.Person.create({ name: "Alice" });
      const bob = await budgetStore.nodes.Person.create({ name: "Bob" });
      const charlie = await budgetStore.nodes.Person.create({
        name: "Charlie",
      });
      await budgetStore.edges.knows.create(budgetRoot, bob, {});
      await budgetStore.edges.knows.create(bob, charlie, {});
    });
    it.each([false, true])(
      "refuses 26 fluent plans before execution (shareSubgraphs=%s)",
      async (shareSubgraphs) => {
        const backend = context.getBackend();
        const execute = vi.fn();
        const store = createStore(
          recursiveBatchGraph,
          deriveBackend(backend, {
            async execute<Row>(
              query: CompiledRowsSql,
            ): Promise<readonly Row[]> {
              execute();
              return backend.execute<Row>(query);
            },
          }),
        );
        const read = recursiveRead(store).project((fields) => ({
          name: fields.friend.name,
        }));
        const batch = store.batchOnce(
          () => Array.from({ length: 26 }, () => read),
          { shareSubgraphs },
        );
        expect(await recursiveBatchOutcome(batch)).toEqual(
          backend.dialect === "postgres" ?
            {
              typed: true,
              details: {
                operation: "batchOnce",
                recursivePlans: 26,
                maxRecursivePlans: 25,
                backend: "postgres",
              },
            }
          : { resultCount: 26 },
        );
        expect(execute).toHaveBeenCalledTimes(
          backend.dialect === "postgres" ? 0 : 1,
        );
      },
    );

    it("allows 25 fluent plans plus nonrecursive reads with ordered result slots", async () => {
      const store = budgetStore;
      const read = recursiveRead(store).project((fields) => ({
        name: fields.friend.name,
      }));
      const expected = await read.execute();
      const plain = store
        .query()
        .from("Person", "person")
        .project((fields) => ({ name: fields.person.name }));
      const expectedPlain = await plain.execute();
      const results = await store.batchOnce(() => [
        plain,
        ...Array.from({ length: 25 }, () => read),
      ]);
      expect(
        results.map((rows) => rows.map((row) => row.name).toSorted()),
      ).toEqual([
        expectedPlain.map((row) => row.name).toSorted(),
        ...Array.from({ length: 25 }, () =>
          expected.map((row) => row.name).toSorted(),
        ),
      ]);
    });

    it("does not charge recursive syntax lowered to a fixed single hop", async () => {
      const store = budgetStore;
      const query = store
        .query()
        .from("Person", "person")
        .traverse("knows", "edge")
        .recursive({ minHops: 1, maxHops: 1 })
        .to("Person", "friend")
        .project((fields) => ({ name: fields.friend.name }));
      const item = query.compileOneStatementBatchItem();
      expect(recursivePlanCount(item.query)).toBe(0);
      expect(
        await store.batchOnce(() => Array.from({ length: 26 }, () => query)),
      ).toHaveLength(26);
    });

    it("shares one allowance between fluent stages and combined subgraphs", async () => {
      const store = budgetStore;
      const alice = budgetRoot;
      const read = recursiveRead(store).project((fields) => ({
        name: fields.friend.name,
      }));
      const reads = Array.from({ length: 24 }, () => read);
      const results = await store.batchOnce((helpers) => [
        ...reads,
        helpers.subgraph(alice, { edges: ["knows"], maxDepth: 1 }),
        helpers.subgraph(alice, { edges: ["knows"], maxDepth: 1 }),
      ]);
      expect(results).toHaveLength(26);
      const oversized = store.batchOnce((helpers) => [
        ...reads,
        helpers.subgraph(alice, { edges: ["knows"], maxDepth: 1 }),
        helpers.subgraph(alice, { edges: ["knows"], maxDepth: 2 }),
      ]);
      expect(await recursiveBatchOutcome(oversized)).toMatchObject(
        context.getBackend().dialect === "postgres" ?
          {
            typed: true,
            details: { recursivePlans: 26, maxRecursivePlans: 25 },
          }
        : { resultCount: 26 },
      );
    });

    it("counts stages inside chained traversals, set operations, and relation wrappers", async () => {
      const store = budgetStore;
      const single = recursiveRead(store).select(
        (fields) => fields.friend.name,
      );
      const chained = recursiveRead(store)
        .traverse("knows", "nextEdge")
        .recursive({ maxHops: 2 })
        .to("Person", "next")
        .project((fields) => ({ name: fields.next.name }));
      const union = single.unionAll(single);
      const nested = store
        .query()
        .from("Person", "outerPerson")
        .where((fields) =>
          fields.$exists((query) =>
            query
              .from("Person", "seed")
              .traverse("knows", "nestedEdge")
              .recursive({ maxHops: 2 })
              .to("Person", "nestedFriend")
              .project((inner) => ({ id: inner.nestedFriend.id })),
          ),
        )
        .select((fields) => fields.outerPerson.name);
      const nestedItem = requireDefined(
        nested.compileOneStatementBatchItem?.(),
      );
      expect(recursivePlanCount(nestedItem.query)).toBe(1);
      const relation = recursiveRead(store)
        .project((fields) => ({ name: fields.friend.name }))
        .asRelation()
        .unionAll(
          recursiveRead(store)
            .project((fields) => ({ name: fields.friend.name }))
            .asRelation(),
        );
      for (const read of [chained, union, relation, nested.unionAll(nested)]) {
        const batchRead: OneStatementBatchableQuery<unknown> = read;
        const item = requireDefined(batchRead.compileOneStatementBatchItem?.());
        expect(recursivePlanCount(item.query)).toBe(2);
        const batch = store.batchOnce(() =>
          Array.from({ length: 13 }, () => read),
        );
        expect(await recursiveBatchOutcome(batch)).toMatchObject(
          context.getBackend().dialect === "postgres" ?
            {
              typed: true,
              details: { recursivePlans: 26, maxRecursivePlans: 25 },
            }
          : { resultCount: 13 },
        );
      }
    });
  });

  it("keeps the unshared JSON payload budget per request while sharing traversal", async () => {
    const backend = context.getBackend();
    const sizes: number[] = [];
    const observedBackend = deriveBackend(backend, {
      async execute<Row>(query: CompiledRowsSql): Promise<readonly Row[]> {
        const rows = await backend.execute<Row>(query);
        const statement = requireDefined(backend.compileSql)(query).sql;
        if (statement.includes("typegraph_batch_envelope")) {
          for (const row of rows) {
            if (typeof row !== "object" || row === null || !("payload" in row))
              throw new Error("Expected a batch payload envelope");
            const encoded =
              typeof row.payload === "string" ?
                row.payload
              : JSON.stringify(row.payload);
            const size = Buffer.byteLength(encoded);
            // Scale the engine's per-JSON-value ceiling down for this fixture.
            // Eight individually small requests must fit even when their sum does not.
            if (size > 8192)
              throw new Error("Per-envelope fixture budget exceeded");
            sizes.push(size);
          }
        }
        return rows;
      },
    });
    const store = createStore(integrationTestGraph, observedBackend);
    const root = await store.nodes.Document.create({ title: "x".repeat(4096) });
    const results = await store.batchOnce((read) =>
      Array.from({ length: 8 }, () =>
        read.subgraph(root, {
          edges: [],
          maxDepth: 0,
          includeKinds: ["Document"],
        }),
      ),
    );
    expect(sizes).toHaveLength(8);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeGreaterThan(8192);
    expect(results.map((result) => result.root?.title)).toEqual(
      Array.from({ length: 8 }, () => root.title),
    );
  });

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
          const statements: string[] = [];
          const store = await context.createStore(integrationTestGraph, {
            hooks: {
              onQueryStart: (query) => {
                statements.push(query.sql);
              },
            },
          });
          const people = [seeded.alice, seeded.bob, seeded.charlie] as const;
          const roots = Array.from(
            { length: 500 },
            (_, index) => people[index % people.length] ?? seeded.alice,
          );

          statements.length = 0;

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

          const statement = statements[0] ?? "";

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
                statementCount: statements.length,
                recursivePlans: (statement.match(/WITH RECURSIVE/gi) ?? [])
                  .length,
                sourcePlans: (
                  statement.match(/typegraph_batch_source_\d+"? AS/g) ?? []
                ).length,
                compactSql: statement.length < 100_000,
                sharedPayload: statement.includes(
                  "typegraph_shared_memberships",
                ),
              };
          expect(observed).toEqual(
            observed.outcome === "refused" ?
              { outcome: "refused", typedBudgetRefusal: true }
            : {
                outcome: "ran",
                rootIds: roots.map((rootNode) => rootNode.id),
                statementCount: 1,
                recursivePlans: 1,
                sourcePlans: 1,
                compactSql: true,
                sharedPayload: shareSubgraphs,
              },
          );
        },
        FULL_BATCH_CAP_TIMEOUT_MS,
      );

      it("bounds independent PostgreSQL subgraph plans before executing SQL", async () => {
        const statements: string[] = [];
        const store = await context.createStore(integrationTestGraph, {
          hooks: {
            onQueryStart: (query) => {
              statements.push(query.sql);
            },
          },
        });
        const outcome = await store
          .batchOnce(
            (read) =>
              Array.from({ length: 26 }, (_, index) =>
                read.subgraph(seeded.alice, {
                  edges: ["knows"],
                  maxDepth: index,
                }),
              ),
            { shareSubgraphs },
          )
          .then(
            (results) => ({
              resultCount: results.length,
              statements: statements.length,
            }),
            (error: unknown) => ({
              typed: error instanceof ConfigurationError,
              details:
                error instanceof ConfigurationError ? error.details : undefined,
              statements: statements.length,
            }),
          );
        expect(outcome).toEqual(
          context.getBackend().dialect === "postgres" ?
            {
              typed: true,
              details: {
                operation: "batchOnce",
                subgraphPlans: 26,
                maxSubgraphPlans: 25,
                backend: "postgres",
              },
              statements: 0,
            }
          : { resultCount: 26, statements: 1 },
        );
      });

      it("allows 25 distinct subgraph plans and does not count relational reads toward that budget", async () => {
        const store = context.getStore();
        const names = store
          .query()
          .from("Person", "person")
          .select((fields) => fields.person.name);
        const results = await store.batchOnce(
          (read) => [
            ...Array.from({ length: 25 }, (_, index) =>
              read.subgraph(seeded.alice, {
                edges: ["knows"],
                maxDepth: index,
              }),
            ),
            names,
          ],
          { shareSubgraphs },
        );
        expect(results).toHaveLength(26);
      });

      it("uses one recursive plan for compatible roots with independent payload modes", async () => {
        const statements: string[] = [];
        const store = await context.createStore(integrationTestGraph, {
          hooks: {
            onQueryStart: (query) => {
              statements.push(query.sql);
            },
          },
        });
        const options = {
          edges: ["knows", "worksAt"],
          maxDepth: 2,
          edgeWindows: {
            knows: { limit: 1, orderBy: { field: "id", direction: "asc" } },
          },
        } as const;
        const roots = [
          seeded.alice,
          seeded.bob,
          seeded.charlie,
          seeded.acme,
          {
            kind: "Person",
            id: asNodeId<typeof integrationTestGraph.nodes.Person.type>(
              "missing-compact-root",
            ),
          },
          seeded.alice,
        ] as const;
        const independent = await Promise.all(
          roots.map((root) => store.subgraph(root, options)),
        );
        statements.length = 0;
        const batched = await store.batchOnce(
          (read) => roots.map((root) => read.subgraph(root, options)),
          { shareSubgraphs },
        );
        expect(batched).toEqual(independent);
        expect(statements).toHaveLength(1);
        const statement = requireDefined(statements[0]);
        expect(statement.match(/WITH RECURSIVE/gi)).toHaveLength(1);
        expect(statement.includes("typegraph_shared_memberships")).toBe(
          shareSubgraphs,
        );
        expect(statement.includes("typegraph_subgraph_request")).toBe(
          !shareSubgraphs,
        );
      });

      it("preserves independent result slots for duplicate, missing, overlapping, and cyclic roots", async () => {
        const store = context.getStore();
        const roots = [
          seeded.alice,
          seeded.bob,
          seeded.alice,
          {
            kind: "Person",
            id: asNodeId<typeof integrationTestGraph.nodes.Person.type>(
              "missing-multi-root",
            ),
          },
          seeded.charlie,
        ] as const;
        const options = {
          edges: ["knows", "worksAt"],
          maxDepth: 3,
        } as const;

        const independent = await Promise.all(
          roots.map((rootRef) => store.subgraph(rootRef, options)),
        );
        const batched = await store.batchOnce(
          (read) => roots.map((rootRef) => read.subgraph(rootRef, options)),
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
        const missingRoot = {
          kind: "Person",
          id: asNodeId<typeof integrationTestGraph.nodes.Person.type>(
            "missing-with-options",
          ),
        } as const;

        const independent = await Promise.all([
          store.subgraph(seeded.alice, projectedWindow),
          store.subgraph(seeded.bob, peopleWithoutRoot),
          store.subgraph(seeded.acme, incomingEmployment),
          store.subgraph(missingRoot, rootOnly),
        ]);
        const batched = await store.batchOnce(
          (read) => [
            read.subgraph(seeded.alice, projectedWindow),
            read.subgraph(seeded.bob, peopleWithoutRoot),
            read.subgraph(seeded.acme, incomingEmployment),
            read.subgraph(missingRoot, rootOnly),
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
