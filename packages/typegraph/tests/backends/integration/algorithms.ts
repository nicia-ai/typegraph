/**
 * Graph Algorithms Integration Tests
 *
 * Tests `store.algorithms.*` and its temporal behavior against the shared
 * integration test graph. Runs against both SQLite and PostgreSQL so the
 * dialect-specific recursive-CTE path encoding (SQLite pipe-delimited
 * strings vs Postgres text arrays), cycle detection, and temporal filter
 * generation all get exercised on each backend.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createStore, GraphAlgorithmConvergenceError } from "../../../src";
import type {
  AdoptedTransaction,
  GraphBackend,
  TransactionBackend,
  TransactionOptions,
} from "../../../src/backend/types";
import type {
  CompiledRowsSql,
  CompiledTemporaryStatementSql,
} from "../../../src/query/sql-intent";
import { TEMPORAL_ANCHORS } from "../../test-utils";
import { type IntegrationStore, integrationTestGraph } from "./fixtures";
import { seedKnowsChain } from "./seed-helpers";
import { type IntegrationTestContext } from "./test-context";

type AlgorithmFixture = Readonly<{
  aliceId: string;
  bobId: string;
  charlieId: string;
  dianaId: string;
  eveId: string;
}>;

async function resolveAlgorithmFixture(
  store: IntegrationStore,
): Promise<AlgorithmFixture> {
  const byName = new Map<string, string>();
  const people = await store.nodes.Person.find();
  for (const person of people) {
    byName.set(person.name, person.id);
  }
  return {
    aliceId: byName.get("Alice")!,
    bobId: byName.get("Bob")!,
    charlieId: byName.get("Charlie")!,
    dianaId: byName.get("Diana")!,
    eveId: byName.get("Eve")!,
  };
}

type TemporalFixture = Readonly<{
  rootId: string;
  activeId: string;
  endedId: string;
  futureId: string;
}>;

async function seedTemporalGraph(
  store: IntegrationStore,
): Promise<TemporalFixture> {
  const { PAST, EDGE_ENDED, FUTURE } = TEMPORAL_ANCHORS;

  const [root, active, ended, future] = await Promise.all([
    store.nodes.Person.create({ name: "Root" }, { validFrom: PAST }),
    store.nodes.Person.create({ name: "Active" }, { validFrom: PAST }),
    store.nodes.Person.create(
      { name: "Ended" },
      { validFrom: PAST, validTo: EDGE_ENDED },
    ),
    store.nodes.Person.create({ name: "Future" }, { validFrom: FUTURE }),
  ]);

  await Promise.all([
    store.edges.knows.create(root, active, {}, { validFrom: PAST }),
    store.edges.knows.create(
      root,
      ended,
      {},
      { validFrom: PAST, validTo: EDGE_ENDED },
    ),
    store.edges.knows.create(root, future, {}),
  ]);

  return {
    rootId: root.id,
    activeId: active.id,
    endedId: ended.id,
    futureId: future.id,
  };
}

/**
 * Anna --(weight 5)--> Clara, and a cheaper detour through Bruno (1 + 1).
 * Unweighted shortest path takes the direct edge; weighted must take the
 * detour.
 */
async function seedWeightedTriangle(store: IntegrationStore) {
  const anna = await store.nodes.Person.create({ name: "Anna" });
  const bruno = await store.nodes.Person.create({ name: "Bruno" });
  const clara = await store.nodes.Person.create({ name: "Clara" });
  await store.edges.knows.create(anna, clara, { weight: 5 });
  await store.edges.knows.create(anna, bruno, { weight: 1 });
  await store.edges.knows.create(bruno, clara, { weight: 1 });
  return { anna, bruno, clara };
}

function withBindLimit(backend: GraphBackend, maxBindParameters: number) {
  return {
    ...backend,
    capabilities: { ...backend.capabilities, maxBindParameters },
    transaction<T>(
      fn: (tx: TransactionBackend, sql: AdoptedTransaction) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> {
      return backend.transaction(async (tx, adoptedTransaction) => {
        const constrainedTransaction: TransactionBackend = {
          ...tx,
          capabilities: { ...tx.capabilities, maxBindParameters },
          execute<Result>(query: CompiledRowsSql): Promise<readonly Result[]> {
            assertWithinBindLimit(backend, query, maxBindParameters);
            return tx.execute<Result>(query);
          },
          async executeTemporaryStatement(
            query: CompiledTemporaryStatementSql,
          ): Promise<void> {
            assertWithinBindLimit(backend, query, maxBindParameters);
            await tx.executeTemporaryStatement!(query);
          },
        };
        return fn(constrainedTransaction, adoptedTransaction);
      }, options);
    },
  } satisfies GraphBackend;
}

function assertWithinBindLimit(
  backend: GraphBackend,
  query: CompiledRowsSql | CompiledTemporaryStatementSql,
  maxBindParameters: number,
): void {
  const parameterCount = backend.compileSql!(query).params.length;
  if (parameterCount <= maxBindParameters) return;
  throw new Error(
    `Statement used ${parameterCount} bind parameters; limit is ${maxBindParameters}.`,
  );
}

function withoutTemporaryStatements(backend: GraphBackend): GraphBackend {
  const { executeTemporaryStatement, ...inlineBackend } = backend;
  void executeTemporaryStatement;
  return inlineBackend;
}

export function registerAlgorithmIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Graph Algorithms", () => {
    describe("core behaviors (seedKnowsChain: Alice→Bob→Charlie→Diana→Eve + Alice→Charlie)", () => {
      let ids: AlgorithmFixture;

      beforeEach(async () => {
        const store = context.getStore();
        await seedKnowsChain(store);
        ids = await resolveAlgorithmFixture(store);
      });

      it("shortestPath finds the direct edge, not the longer route", async () => {
        const store = context.getStore();
        const path = await store.algorithms.shortestPath(
          ids.aliceId,
          ids.charlieId,
          { edges: ["knows"] },
        );
        expect(path?.depth).toBe(1);
        expect(path?.nodes.map((n) => n.id)).toEqual([
          ids.aliceId,
          ids.charlieId,
        ]);
      });

      it("shortestPath finds a multi-hop path", async () => {
        const store = context.getStore();
        const path = await store.algorithms.shortestPath(
          ids.aliceId,
          ids.eveId,
          { edges: ["knows"] },
        );
        expect(path?.depth).toBe(3);
        expect(path?.nodes.at(0)?.id).toBe(ids.aliceId);
        expect(path?.nodes.at(-1)?.id).toBe(ids.eveId);
      });

      it("uses the same code-point predecessor tie-break in both execution paths", async () => {
        const store = context.getStore();
        const [source, bmpPredecessor, astralPredecessor, target] =
          await Promise.all([
            store.nodes.Person.create(
              { name: "Collation source" },
              { id: "bfs-collation-source" },
            ),
            store.nodes.Person.create(
              { name: "BMP predecessor" },
              { id: "bfs-collation-\uE000" },
            ),
            store.nodes.Person.create(
              { name: "Astral predecessor" },
              { id: "bfs-collation-\u{10000}" },
            ),
            store.nodes.Person.create(
              { name: "Collation target" },
              { id: "bfs-collation-target" },
            ),
          ]);
        await Promise.all([
          store.edges.knows.create(source, bmpPredecessor, {}),
          store.edges.knows.create(source, astralPredecessor, {}),
          store.edges.knows.create(bmpPredecessor, target, {}),
          store.edges.knows.create(astralPredecessor, target, {}),
        ]);

        const options = { edges: ["knows"] } as const;
        const workingTablePath = await store.algorithms.shortestPath(
          source,
          target,
          options,
        );
        const inlineStore = createStore(
          integrationTestGraph,
          withoutTemporaryStatements(store.backend),
        );
        const inlinePath = await inlineStore.algorithms.shortestPath(
          source,
          target,
          options,
        );

        const expectedIds = [source.id, bmpPredecessor.id, target.id];
        expect(workingTablePath?.nodes.map((node) => node.id)).toEqual(
          expectedIds,
        );
        expect(inlinePath).toEqual(workingTablePath);
      });

      it("shortestPath returns undefined for an unreachable target", async () => {
        const store = context.getStore();
        const path = await store.algorithms.shortestPath(
          ids.eveId,
          ids.aliceId,
          { edges: ["knows"] },
        );
        expect(path).toBeUndefined();
      });

      it("reachable returns every node reachable from source", async () => {
        const store = context.getStore();
        const reached = await store.algorithms.reachable(ids.aliceId, {
          edges: ["knows"],
        });
        const reachedIds = reached.map((r) => r.id).toSorted();
        expect(reachedIds).toEqual(
          [
            ids.aliceId,
            ids.bobId,
            ids.charlieId,
            ids.dianaId,
            ids.eveId,
          ].toSorted(),
        );
      });

      it("reachable respects maxHops", async () => {
        const store = context.getStore();
        const reached = await store.algorithms.reachable(ids.aliceId, {
          edges: ["knows"],
          maxHops: 1,
        });
        const reachedIds = reached.map((r) => r.id).toSorted();
        expect(reachedIds).toEqual(
          [ids.aliceId, ids.bobId, ids.charlieId].toSorted(),
        );
      });

      it("canReach returns true for a reachable target", async () => {
        const store = context.getStore();
        const reaches = await store.algorithms.canReach(
          ids.aliceId,
          ids.eveId,
          { edges: ["knows"] },
        );
        expect(reaches).toBe(true);
      });

      it("canReach returns false when no path exists", async () => {
        const store = context.getStore();
        const reaches = await store.algorithms.canReach(
          ids.eveId,
          ids.aliceId,
          { edges: ["knows"] },
        );
        expect(reaches).toBe(false);
      });

      it("neighbors returns the 1-hop neighborhood, source excluded", async () => {
        const store = context.getStore();
        const neighbors = await store.algorithms.neighbors(ids.aliceId, {
          edges: ["knows"],
        });
        const neighborIds = neighbors.map((n) => n.id).toSorted();
        expect(neighborIds).toEqual([ids.bobId, ids.charlieId].toSorted());
      });

      it("degree counts outgoing edges", async () => {
        const store = context.getStore();
        const degree = await store.algorithms.degree(ids.aliceId, {
          edges: ["knows"],
          direction: "out",
        });
        expect(degree).toBe(2);
      });

      it("degree counts edges in both directions (undirected)", async () => {
        const store = context.getStore();
        const degree = await store.algorithms.degree(ids.bobId, {
          edges: ["knows"],
          direction: "both",
        });
        // Alice→Bob (incoming), Bob→Charlie (outgoing)
        expect(degree).toBe(2);
      });
    });

    describe("weightedShortestPath", () => {
      it("finds the minimum-weight path, not the minimum-hop path", async () => {
        const store = context.getStore();
        const ids = await seedWeightedTriangle(store);

        const weighted = await store.algorithms.weightedShortestPath(
          ids.anna,
          ids.clara,
          { edges: ["knows"], weightProperty: "weight" },
        );
        expect(weighted?.totalWeight).toBe(2);
        expect(weighted?.depth).toBe(2);
        expect(weighted?.nodes.map((node) => node.id)).toEqual([
          ids.anna.id,
          ids.bruno.id,
          ids.clara.id,
        ]);

        const unweighted = await store.algorithms.shortestPath(
          ids.anna,
          ids.clara,
          { edges: ["knows"] },
        );
        expect(unweighted?.depth).toBe(1);
      });

      it("traverses undirected with direction 'both'", async () => {
        const store = context.getStore();
        const ids = await seedWeightedTriangle(store);

        const path = await store.algorithms.weightedShortestPath(
          ids.clara,
          ids.anna,
          { edges: ["knows"], weightProperty: "weight", direction: "both" },
        );
        expect(path?.totalWeight).toBe(2);
        expect(path?.nodes.map((node) => node.id)).toEqual([
          ids.clara.id,
          ids.bruno.id,
          ids.anna.id,
        ]);
      });

      it("fails fast on missing weights unless defaultWeight is provided", async () => {
        const store = context.getStore();
        const ids = await seedWeightedTriangle(store);
        const dora = await store.nodes.Person.create({ name: "Dora" });
        await store.edges.knows.create(ids.clara, dora, {});

        await expect(
          store.algorithms.weightedShortestPath(ids.anna, dora.id, {
            edges: ["knows"],
            weightProperty: "weight",
          }),
        ).rejects.toMatchObject({
          name: "InvalidEdgeWeightError",
          details: { reason: "missing", property: "weight" },
        });

        const withDefault = await store.algorithms.weightedShortestPath(
          ids.anna,
          dora.id,
          { edges: ["knows"], weightProperty: "weight", defaultWeight: 10 },
        );
        expect(withDefault?.totalWeight).toBe(12);
      });

      it("rejects a non-numeric weight property identically on both backends", async () => {
        const store = context.getStore();
        const anna = await store.nodes.Person.create({ name: "TextAnna" });
        const bruno = await store.nodes.Person.create({ name: "TextBruno" });
        await store.edges.knows.create(anna, bruno, { since: "2020" });

        await expect(
          store.algorithms.weightedShortestPath(anna, bruno, {
            edges: ["knows"],
            weightProperty: "since",
          }),
        ).rejects.toMatchObject({
          name: "InvalidEdgeWeightError",
          details: { reason: "non_numeric", value: "2020" },
        });
      });

      it('classifies the JSON string "null" as non-numeric, not missing', async () => {
        // Regression: PostgreSQL's text-comparison null check cannot tell a
        // JSON string "null" from a JSON null; the type-based audit must.
        const store = context.getStore();
        const anna = await store.nodes.Person.create({ name: "StrNullAnna" });
        const bruno = await store.nodes.Person.create({ name: "StrNullBruno" });
        await store.edges.knows.create(anna, bruno, { since: "null" });

        await expect(
          store.algorithms.weightedShortestPath(anna, bruno, {
            edges: ["knows"],
            weightProperty: "since",
            defaultWeight: 1,
          }),
        ).rejects.toMatchObject({
          name: "InvalidEdgeWeightError",
          details: { reason: "non_numeric", value: "null" },
        });
      });

      it("treats a JSON null weight as missing on both backends", async () => {
        const store = context.getStore();
        const anna = await store.nodes.Person.create({ name: "NullAnna" });
        const bruno = await store.nodes.Person.create({ name: "NullBruno" });
        // eslint-disable-next-line unicorn/no-null -- the JSON null value is the case under test
        await store.edges.knows.create(anna, bruno, { weight: null });

        await expect(
          store.algorithms.weightedShortestPath(anna, bruno, {
            edges: ["knows"],
            weightProperty: "weight",
          }),
        ).rejects.toMatchObject({
          name: "InvalidEdgeWeightError",
          details: { reason: "missing", property: "weight" },
        });

        const withDefault = await store.algorithms.weightedShortestPath(
          anna,
          bruno,
          { edges: ["knows"], weightProperty: "weight", defaultWeight: 4 },
        );
        expect(withDefault?.totalWeight).toBe(4);
      });

      it("accumulates fractional weights identically on both backends", async () => {
        const store = context.getStore();
        const anna = await store.nodes.Person.create({ name: "FracAnna" });
        const bruno = await store.nodes.Person.create({ name: "FracBruno" });
        const clara = await store.nodes.Person.create({ name: "FracClara" });
        await store.edges.knows.create(anna, bruno, { weight: 0.1 });
        await store.edges.knows.create(bruno, clara, { weight: 0.2 });

        const path = await store.algorithms.weightedShortestPath(anna, clara, {
          edges: ["knows"],
          weightProperty: "weight",
        });
        // Both backends must do IEEE 754 double arithmetic — a decimal
        // NUMERIC accumulation would yield exactly 0.3 and diverge.
        expect(path?.totalWeight).toBe(0.1 + 0.2);
      });

      it("honors the temporal coordinate, including through a pinned StoreView", async () => {
        const store = context.getStore();
        const { PAST, BEFORE, EDGE_ENDED } = TEMPORAL_ANCHORS;
        const anna = await store.nodes.Person.create(
          { name: "TemporalAnna" },
          { validFrom: PAST },
        );
        const bruno = await store.nodes.Person.create(
          { name: "TemporalBruno" },
          { validFrom: PAST },
        );
        // A cheap edge that ended, and a pricier one still valid.
        await store.edges.knows.create(
          anna,
          bruno,
          { weight: 1 },
          { validFrom: PAST, validTo: EDGE_ENDED },
        );
        await store.edges.knows.create(
          anna,
          bruno,
          { weight: 8 },
          { validFrom: PAST },
        );

        const current = await store.algorithms.weightedShortestPath(
          anna,
          bruno,
          { edges: ["knows"], weightProperty: "weight" },
        );
        expect(current?.totalWeight).toBe(8);

        const pinned = await store
          .asOf(BEFORE)
          .algorithms.weightedShortestPath(anna, bruno, {
            edges: ["knows"],
            weightProperty: "weight",
          });
        expect(pinned?.totalWeight).toBe(1);
      });
    });

    describe("weaklyConnectedComponents", () => {
      it("returns deterministic memberships, sizes, isolated nodes, and cross-kind identities", async () => {
        const store = context.getStore();
        const [alpha, beta, gamma, company, isolated] = await Promise.all([
          store.nodes.Person.create({ name: "WCC alpha" }, { id: "wcc-A" }),
          store.nodes.Person.create({ name: "WCC beta" }, { id: "wcc-b" }),
          store.nodes.Person.create({ name: "WCC gamma" }, { id: "wcc-c" }),
          store.nodes.Company.create({ name: "WCC company" }, { id: "wcc-b" }),
          store.nodes.Person.create({ name: "WCC isolated" }, { id: "wcc-z" }),
        ]);
        await Promise.all([
          // Reverse the intuitive order to pin weak/undirected semantics.
          store.edges.knows.create(beta, alpha, {}),
          store.edges.knows.create(beta, alpha, {}),
          store.edges.knows.create(gamma, beta, {}),
          store.edges.knows.create(gamma, gamma, {}),
          store.edges.worksAt.create(gamma, company, { role: "Founder" }),
        ]);

        const memberships = await store.algorithms.weaklyConnectedComponents({
          edges: ["knows", "worksAt"],
        });

        expect(memberships).toEqual([
          {
            id: "wcc-A",
            kind: "Person",
            componentId: "wcc-A",
            componentKind: "Person",
            size: 4,
          },
          {
            id: "wcc-b",
            kind: "Company",
            componentId: "wcc-A",
            componentKind: "Person",
            size: 4,
          },
          {
            id: "wcc-b",
            kind: "Person",
            componentId: "wcc-A",
            componentKind: "Person",
            size: 4,
          },
          {
            id: "wcc-c",
            kind: "Person",
            componentId: "wcc-A",
            componentKind: "Person",
            size: 4,
          },
          {
            id: isolated.id,
            kind: "Person",
            componentId: isolated.id,
            componentKind: "Person",
            size: 1,
          },
        ]);

        const personMemberships =
          await store.algorithms.weaklyConnectedComponents({
            edges: ["knows", "worksAt"],
            nodeKinds: ["Person"],
          });
        expect(personMemberships).toEqual([
          {
            id: "wcc-A",
            kind: "Person",
            componentId: "wcc-A",
            componentKind: "Person",
            size: 3,
          },
          {
            id: "wcc-b",
            kind: "Person",
            componentId: "wcc-A",
            componentKind: "Person",
            size: 3,
          },
          {
            id: "wcc-c",
            kind: "Person",
            componentId: "wcc-A",
            componentKind: "Person",
            size: 3,
          },
          {
            id: isolated.id,
            kind: "Person",
            componentId: isolated.id,
            componentKind: "Person",
            size: 1,
          },
        ]);
      });

      it("chooses exact binary representatives across ids and kinds", async () => {
        const store = context.getStore();
        const [upper, lower, bmp, astral, person, company] = await Promise.all([
          store.nodes.Person.create(
            { name: "Uppercase representative" },
            { id: "wcc-collation-A" },
          ),
          store.nodes.Person.create(
            { name: "Lowercase member" },
            { id: "wcc-collation-a" },
          ),
          store.nodes.Person.create(
            { name: "BMP representative" },
            { id: "wcc-collation-\uE000" },
          ),
          store.nodes.Person.create(
            { name: "Astral member" },
            { id: "wcc-collation-\u{10000}" },
          ),
          store.nodes.Person.create(
            { name: "Kind tie person" },
            { id: "wcc-collation-shared" },
          ),
          store.nodes.Company.create(
            { name: "Kind tie company" },
            { id: "wcc-collation-shared" },
          ),
        ]);
        await Promise.all([
          store.edges.knows.create(upper, lower, {}),
          store.edges.knows.create(bmp, astral, {}),
          store.edges.worksAt.create(person, company, { role: "Member" }),
        ]);

        const allMemberships = await store.algorithms.weaklyConnectedComponents(
          {
            edges: ["knows", "worksAt"],
          },
        );
        const memberships = allMemberships.filter((membership) =>
          membership.id.startsWith("wcc-collation-"),
        );

        expect(memberships).toEqual([
          {
            id: upper.id,
            kind: "Person",
            componentId: upper.id,
            componentKind: "Person",
            size: 2,
          },
          {
            id: lower.id,
            kind: "Person",
            componentId: upper.id,
            componentKind: "Person",
            size: 2,
          },
          {
            id: company.id,
            kind: "Company",
            componentId: company.id,
            componentKind: "Company",
            size: 2,
          },
          {
            id: person.id,
            kind: "Person",
            componentId: company.id,
            componentKind: "Company",
            size: 2,
          },
          {
            id: bmp.id,
            kind: "Person",
            componentId: bmp.id,
            componentKind: "Person",
            size: 2,
          },
          {
            id: astral.id,
            kind: "Person",
            componentId: bmp.id,
            componentKind: "Person",
            size: 2,
          },
        ]);
      });

      it("preserves synchronous convergence across edge-kind chunks", async () => {
        const store = context.getStore();
        const [alpha, beta, gamma] = await Promise.all([
          store.nodes.Person.create(
            { name: "Chunk alpha" },
            { id: "wcc-chunk-a" },
          ),
          store.nodes.Person.create(
            { name: "Chunk beta" },
            { id: "wcc-chunk-b" },
          ),
          store.nodes.Company.create(
            { name: "Chunk gamma" },
            { id: "wcc-chunk-c" },
          ),
        ]);
        await store.edges.knows.create(alpha, beta, {});
        await store.edges.worksAt.create(beta, gamma, { role: "Member" });

        const constrainedStore = createStore(
          integrationTestGraph,
          withBindLimit(store.backend, 28),
        );
        const limitedOptions = {
          edges: ["knows", "worksAt"],
          nodeKinds: ["Person", "Company"],
          maxIterations: 2,
        } as const;
        await expect(
          store.algorithms.weaklyConnectedComponents(limitedOptions),
        ).rejects.toMatchObject({
          code: "GRAPH_ALGORITHM_CONVERGENCE_ERROR",
          details: {
            algorithm: "weaklyConnectedComponents",
            maxIterations: 2,
          },
        });
        await expect(
          constrainedStore.algorithms.weaklyConnectedComponents(limitedOptions),
        ).rejects.toMatchObject({
          code: "GRAPH_ALGORITHM_CONVERGENCE_ERROR",
          details: {
            algorithm: "weaklyConnectedComponents",
            maxIterations: 2,
          },
        });

        const convergingOptions = { ...limitedOptions, maxIterations: 3 };
        const expected = [
          {
            id: alpha.id,
            kind: "Person",
            componentId: alpha.id,
            componentKind: "Person",
            size: 3,
          },
          {
            id: beta.id,
            kind: "Person",
            componentId: alpha.id,
            componentKind: "Person",
            size: 3,
          },
          {
            id: gamma.id,
            kind: "Company",
            componentId: alpha.id,
            componentKind: "Person",
            size: 3,
          },
        ];
        await expect(
          store.algorithms.weaklyConnectedComponents(convergingOptions),
        ).resolves.toEqual(expected);
        await expect(
          constrainedStore.algorithms.weaklyConnectedComponents(
            convergingOptions,
          ),
        ).resolves.toEqual(expected);
      });

      it("returns an empty induced subgraph for an empty node-kind scope", async () => {
        const store = context.getStore();
        await store.nodes.Person.create(
          { name: "Outside empty WCC scope" },
          { id: "empty-scope" },
        );

        await expect(
          store.algorithms.weaklyConnectedComponents({
            edges: ["knows"],
            nodeKinds: [],
          }),
        ).resolves.toEqual([]);
      });

      it("honors an explicit workingMemory budget for iterative rounds", async () => {
        // PostgreSQL applies the value as a transaction-scoped work_mem via
        // set_config(..., is_local => true); SQLite validates and ignores it.
        // Results must be identical on both backends either way.
        const store = context.getStore();
        const [left, right] = await Promise.all([
          store.nodes.Person.create({ name: "Memory left" }, { id: "mem-a" }),
          store.nodes.Person.create({ name: "Memory right" }, { id: "mem-b" }),
        ]);
        await store.edges.knows.create(left, right, {});

        const memberships = await store.algorithms.weaklyConnectedComponents({
          edges: ["knows"],
          workingMemory: "32MB",
        });
        const byId = new Map(memberships.map((row) => [row.id, row]));
        expect(byId.get("mem-a")?.componentId).toBe("mem-a");
        expect(byId.get("mem-b")?.componentId).toBe("mem-a");

        const reached = await store.algorithms.reachable("mem-a", {
          edges: ["knows"],
          workingMemory: "32MB",
        });
        expect(reached.map((row) => row.id)).toContain("mem-b");
      });

      it("throws instead of returning partial labels at the iteration limit", async () => {
        const store = context.getStore();
        const [alpha, beta, gamma] = await Promise.all([
          store.nodes.Person.create({ name: "Limit alpha" }, { id: "limit-a" }),
          store.nodes.Person.create({ name: "Limit beta" }, { id: "limit-b" }),
          store.nodes.Person.create({ name: "Limit gamma" }, { id: "limit-c" }),
        ]);
        await Promise.all([
          store.edges.knows.create(alpha, beta, {}),
          store.edges.knows.create(beta, gamma, {}),
        ]);

        await expect(
          store.algorithms.weaklyConnectedComponents({
            edges: ["knows"],
            maxIterations: 1,
          }),
        ).rejects.toBeInstanceOf(GraphAlgorithmConvergenceError);
      });
    });

    describe("labelPropagation", () => {
      it("is exact, synchronous, and independent of edge-kind chunking", async () => {
        const store = context.getStore();
        const [alpha, beta, company, delta, echo, foxtrot, isolated] =
          await Promise.all([
            store.nodes.Person.create(
              { name: "Label alpha" },
              { id: "label-a" },
            ),
            store.nodes.Person.create(
              { name: "Label beta" },
              { id: "label-b" },
            ),
            store.nodes.Company.create(
              { name: "Label company" },
              { id: "label-c" },
            ),
            store.nodes.Person.create(
              { name: "Label delta" },
              { id: "label-d" },
            ),
            store.nodes.Person.create(
              { name: "Label echo" },
              { id: "label-e" },
            ),
            store.nodes.Person.create(
              { name: "Label foxtrot" },
              { id: "label-f" },
            ),
            store.nodes.Person.create(
              { name: "Label isolated" },
              { id: "label-z" },
            ),
          ]);
        await Promise.all([
          store.edges.knows.create(alpha, beta, {}),
          store.edges.worksAt.create(beta, company, { role: "Member" }),
          store.edges.worksAt.create(alpha, company, { role: "Member" }),
          store.edges.knows.create(delta, echo, {}),
          store.edges.knows.create(echo, foxtrot, {}),
          store.edges.knows.create(foxtrot, delta, {}),
          // A duplicate and a self-loop must not multiply neighbor votes.
          store.edges.knows.create(alpha, beta, {}),
          store.edges.knows.create(alpha, alpha, {}),
        ]);
        const limitedOptions = {
          edges: ["knows", "worksAt"],
          nodeKinds: ["Person", "Company"],
          maxIterations: 2,
        } as const;
        const constrainedStore = createStore(
          integrationTestGraph,
          withBindLimit(store.backend, 28),
        );

        for (const algorithmStore of [store, constrainedStore]) {
          await expect(
            algorithmStore.algorithms.labelPropagation(limitedOptions),
          ).rejects.toMatchObject({
            code: "GRAPH_ALGORITHM_CONVERGENCE_ERROR",
            details: { algorithm: "labelPropagation", maxIterations: 2 },
          });
        }

        const expected = [
          {
            id: alpha.id,
            kind: "Person",
            labelId: alpha.id,
            labelKind: "Person",
          },
          {
            id: beta.id,
            kind: "Person",
            labelId: alpha.id,
            labelKind: "Person",
          },
          {
            id: company.id,
            kind: "Company",
            labelId: alpha.id,
            labelKind: "Person",
          },
          {
            id: delta.id,
            kind: "Person",
            labelId: delta.id,
            labelKind: "Person",
          },
          {
            id: echo.id,
            kind: "Person",
            labelId: delta.id,
            labelKind: "Person",
          },
          {
            id: foxtrot.id,
            kind: "Person",
            labelId: delta.id,
            labelKind: "Person",
          },
          {
            id: isolated.id,
            kind: "Person",
            labelId: isolated.id,
            labelKind: "Person",
          },
        ];
        const convergingOptions = { ...limitedOptions, maxIterations: 3 };
        await expect(
          store.algorithms.labelPropagation(convergingOptions),
        ).resolves.toEqual(expected);
        await expect(
          constrainedStore.algorithms.labelPropagation(convergingOptions),
        ).resolves.toEqual(expected);
      });

      it("uses binary full-node-identity ordering for label ties", async () => {
        const store = context.getStore();
        const [
          upper,
          lower,
          upperTail,
          bmp,
          astral,
          astralTail,
          person,
          company,
          kindTail,
        ] = await Promise.all([
          store.nodes.Person.create({ name: "Upper" }, { id: "label-case-A" }),
          store.nodes.Person.create({ name: "Lower" }, { id: "label-case-a" }),
          store.nodes.Person.create(
            { name: "Case tail" },
            { id: "label-case-z" },
          ),
          store.nodes.Person.create(
            { name: "BMP" },
            { id: "label-unicode-\uE000" },
          ),
          store.nodes.Person.create(
            { name: "Astral" },
            { id: "label-unicode-\u{10000}" },
          ),
          store.nodes.Person.create(
            { name: "Astral tail" },
            { id: "label-unicode-\u{10000}x" },
          ),
          store.nodes.Person.create(
            { name: "Kind tie person" },
            { id: "label-kind-shared" },
          ),
          store.nodes.Company.create(
            { name: "Kind tie company" },
            { id: "label-kind-shared" },
          ),
          store.nodes.Person.create(
            { name: "Kind tie tail" },
            { id: "label-kind-z" },
          ),
        ]);
        await Promise.all([
          store.edges.knows.create(upper, lower, {}),
          store.edges.knows.create(lower, upperTail, {}),
          store.edges.knows.create(upperTail, upper, {}),
          store.edges.knows.create(bmp, astral, {}),
          store.edges.knows.create(astral, astralTail, {}),
          store.edges.knows.create(astralTail, bmp, {}),
          store.edges.worksAt.create(person, company, { role: "Member" }),
          store.edges.knows.create(person, kindTail, {}),
          store.edges.worksAt.create(kindTail, company, { role: "Member" }),
        ]);

        const memberships = await store.algorithms.labelPropagation({
          edges: ["knows", "worksAt"],
          nodeKinds: ["Person", "Company"],
        });
        const byIdentity = new Map(
          memberships.map((row) => [`${row.kind}\u0000${row.id}`, row]),
        );
        const labelFor = (kind: string, id: string) =>
          byIdentity.get(`${kind}\u0000${id}`)?.labelId;
        expect(labelFor("Person", upper.id)).toBe(upper.id);
        expect(labelFor("Person", lower.id)).toBe(upper.id);
        expect(labelFor("Person", upperTail.id)).toBe(upper.id);
        expect(labelFor("Person", bmp.id)).toBe(bmp.id);
        expect(labelFor("Person", astral.id)).toBe(bmp.id);
        expect(labelFor("Person", astralTail.id)).toBe(bmp.id);
        for (const node of [person, company, kindTail]) {
          const membership = byIdentity.get(`${node.kind}\u0000${node.id}`);
          expect(membership?.labelId).toBe(company.id);
          expect(membership?.labelKind).toBe("Company");
        }
      });

      it("throws for the explicit two-node oscillation", async () => {
        const store = context.getStore();
        const [left, right] = await Promise.all([
          store.nodes.Person.create({ name: "Left" }, { id: "oscillate-a" }),
          store.nodes.Person.create({ name: "Right" }, { id: "oscillate-b" }),
        ]);
        await store.edges.knows.create(left, right, {});

        await expect(
          store.algorithms.labelPropagation({
            edges: ["knows"],
            nodeKinds: ["Person"],
            maxIterations: 4,
          }),
        ).rejects.toBeInstanceOf(GraphAlgorithmConvergenceError);

        // The fixed-round contract is parity-exact on both backends: a dyad
        // holds its initial labels after even round counts and the swapped
        // labels after odd round counts.
        for (const [maxIterations, expectedLeft, expectedRight] of [
          [4, left.id, right.id],
          [5, right.id, left.id],
        ] as const) {
          const memberships = await store.algorithms.labelPropagation({
            edges: ["knows"],
            nodeKinds: ["Person"],
            maxIterations,
            onMaxIterations: "return",
          });
          const labelOf = (id: string) =>
            memberships.find((row) => row.id === id)?.labelId;
          expect(labelOf(left.id)).toBe(expectedLeft);
          expect(labelOf(right.id)).toBe(expectedRight);
        }
      });
    });

    describe("PageRank", () => {
      it("matches analytic global and personalized scores", async () => {
        const store = context.getStore();
        const [alpha, beta, gamma] = await Promise.all([
          store.nodes.Person.create({ name: "Rank alpha" }, { id: "rank-a" }),
          store.nodes.Person.create({ name: "Rank beta" }, { id: "rank-b" }),
          store.nodes.Person.create({ name: "Rank gamma" }, { id: "rank-c" }),
        ]);
        await Promise.all([
          store.edges.knows.create(alpha, beta, {}),
          store.edges.knows.create(beta, gamma, {}),
          store.edges.knows.create(gamma, alpha, {}),
        ]);

        const globalScores = await store.algorithms.pageRank({
          edges: ["knows"],
          nodeKinds: ["Person"],
          tolerance: 1e-12,
        });
        expect(globalScores.map((row) => row.id)).toEqual([
          "rank-a",
          "rank-b",
          "rank-c",
        ]);
        for (const row of globalScores) {
          expect(row.score).toBeCloseTo(1 / 3, 12);
        }

        const personalizedScores = await store.algorithms.personalizedPageRank({
          edges: ["knows"],
          nodeKinds: ["Person"],
          seeds: [{ id: alpha.id, kind: "Person" }],
          tolerance: 1e-12,
          maxIterations: 200,
        });
        const byId = new Map(
          personalizedScores.map((row) => [row.id, row.score]),
        );
        const normalization = 1 + 0.85 + 0.85 ** 2;
        expect(byId.get(alpha.id)).toBeCloseTo(1 / normalization, 10);
        expect(byId.get(beta.id)).toBeCloseTo(0.85 / normalization, 10);
        expect(byId.get(gamma.id)).toBeCloseTo(0.85 ** 2 / normalization, 10);
      });

      it("preserves physical-edge and self-loop weights across chunking", async () => {
        const store = context.getStore();
        const [alpha, beta, company] = await Promise.all([
          store.nodes.Person.create({ name: "Rank alpha" }, { id: "rank-a" }),
          store.nodes.Person.create({ name: "Rank beta" }, { id: "rank-b" }),
          store.nodes.Company.create(
            { name: "Rank company" },
            { id: "rank-c" },
          ),
        ]);
        await Promise.all([
          store.edges.knows.create(alpha, alpha, {}),
          store.edges.knows.create(alpha, beta, {}),
          store.edges.knows.create(alpha, beta, {}),
          store.edges.worksAt.create(beta, company, { role: "Member" }),
        ]);
        const options = {
          edges: ["knows", "worksAt"],
          nodeKinds: ["Person", "Company"],
          direction: "both",
          tolerance: 1e-12,
        } as const;

        const expected = await store.algorithms.pageRank(options);
        await expect(store.algorithms.pageRank(options)).resolves.toEqual(
          expected,
        );
        const constrainedStore = createStore(
          integrationTestGraph,
          withBindLimit(store.backend, 28),
        );
        const constrained = await constrainedStore.algorithms.pageRank(options);

        expect(constrained.map((row) => `${row.kind}\u0000${row.id}`)).toEqual(
          expected.map((row) => `${row.kind}\u0000${row.id}`),
        );
        for (const expectedRow of expected) {
          const actual = constrained.find(
            (row) => row.id === expectedRow.id && row.kind === expectedRow.kind,
          );
          expect(actual?.score).toBeCloseTo(expectedRow.score, 12);
        }
        expect(
          expected.reduce((total, row) => total + row.score, 0),
        ).toBeCloseTo(1, 10);
        const byId = new Map(expected.map((row) => [row.id, row.score]));
        expect(byId.get(alpha.id)).toBeCloseTo(0.405344795365352, 10);
        expect(byId.get(beta.id)).toBeCloseTo(0.4244066529620634, 10);
        expect(byId.get(company.id)).toBeCloseTo(0.17024855167258443, 10);
      });

      it("chunks large personalization vectors within the bind budget", async () => {
        const store = context.getStore();
        const people = await store.nodes.Person.bulkCreate(
          Array.from({ length: 12 }, (_, index) => ({
            id: `rank-seed-${String(index).padStart(2, "0")}`,
            props: { name: `Rank seed ${index}` },
          })),
        );
        const seeds = people.map((person, index) => ({
          id: person.id,
          kind: "Person" as const,
          weight: index + 1,
        }));
        const constrainedStore = createStore(
          integrationTestGraph,
          withBindLimit(store.backend, 28),
        );

        const scores = await constrainedStore.algorithms.personalizedPageRank({
          edges: ["knows"],
          nodeKinds: ["Person"],
          dampingFactor: 0,
          seeds,
        });

        expect(scores).toHaveLength(12);
        expect(scores.reduce((total, row) => total + row.score, 0)).toBeCloseTo(
          1,
          12,
        );
        expect(scores[0]?.id).toBe("rank-seed-11");
        expect(scores.at(-1)?.id).toBe("rank-seed-00");
      });

      it("qualifies personalization by full node identity", async () => {
        const store = context.getStore();
        const [person, company] = await Promise.all([
          store.nodes.Person.create(
            { name: "Rank person" },
            { id: "rank-shared" },
          ),
          store.nodes.Company.create(
            { name: "Rank company" },
            { id: "rank-shared" },
          ),
        ]);
        await store.edges.worksAt.create(person, company, { role: "Member" });

        const scores = await store.algorithms.personalizedPageRank({
          edges: ["worksAt"],
          nodeKinds: ["Person", "Company"],
          direction: "both",
          dampingFactor: 0,
          seeds: [{ id: "rank-shared", kind: "Company" }],
        });

        expect(scores).toEqual([
          { id: "rank-shared", kind: "Company", score: 1 },
          { id: "rank-shared", kind: "Person", score: 0 },
        ]);
      });

      it("throws rather than returning unconverged scores", async () => {
        const store = context.getStore();
        const [alpha, beta] = await Promise.all([
          store.nodes.Person.create({ name: "Rank alpha" }, { id: "rank-a" }),
          store.nodes.Person.create({ name: "Rank beta" }, { id: "rank-b" }),
        ]);
        await store.edges.knows.create(alpha, beta, {});

        await expect(
          store.algorithms.pageRank({
            edges: ["knows"],
            nodeKinds: ["Person"],
            maxIterations: 1,
            tolerance: 1e-15,
          }),
        ).rejects.toBeInstanceOf(GraphAlgorithmConvergenceError);
      });
    });

    describe("dense cyclic graph", () => {
      it("visits each node once instead of enumerating simple paths", async () => {
        const store = context.getStore();
        const people = await store.nodes.Person.bulkCreate(
          Array.from({ length: 9 }, (_, index) => ({
            props: { name: `Dense ${index}` },
          })),
        );
        await store.edges.knows.bulkCreate(
          people.flatMap((from) =>
            people
              .filter((to) => to.id !== from.id)
              .map((to) => ({ from, to, props: { since: "2020" } })),
          ),
        );

        const source = people[0]!;
        const target = people.at(-1)!;
        const reached = await store.algorithms.reachable(source, {
          edges: ["knows"],
          maxHops: 8,
        });
        const neighbors = await store.algorithms.neighbors(source, {
          edges: ["knows"],
          depth: 8,
        });
        const path = await store.algorithms.shortestPath(source, target, {
          edges: ["knows"],
          maxHops: 8,
        });

        expect(reached).toHaveLength(9);
        expect(reached.filter((node) => node.depth === 1)).toHaveLength(8);
        expect(neighbors).toHaveLength(8);
        expect(path).toEqual({
          nodes: [
            { id: source.id, kind: "Person" },
            { id: target.id, kind: "Person" },
          ],
          depth: 1,
        });
        await expect(
          store.algorithms.canReach(source, target, {
            edges: ["knows"],
            maxHops: 8,
          }),
        ).resolves.toBe(true);
      });
    });

    describe("node identity", () => {
      it("keeps different node kinds that share an ID", async () => {
        const store = context.getStore();
        const source = await store.nodes.Person.create(
          { name: "Identity source" },
          { id: "algorithm-identity-source" },
        );
        const person = await store.nodes.Person.create(
          { name: "Shared person" },
          { id: "algorithm-shared-id" },
        );
        const company = await store.nodes.Company.create(
          { name: "Shared company" },
          { id: "algorithm-shared-id" },
        );
        await Promise.all([
          store.edges.knows.create(source, person, {}),
          store.edges.worksAt.create(source, company, { role: "Founder" }),
        ]);

        const reached = await store.algorithms.reachable(source, {
          edges: ["knows", "worksAt"],
          maxHops: 1,
          excludeSource: true,
        });

        expect(reached).toEqual([
          { id: "algorithm-shared-id", kind: "Company", depth: 1 },
          { id: "algorithm-shared-id", kind: "Person", depth: 1 },
        ]);
      });
    });

    describe("temporal behavior", () => {
      const { BEFORE } = TEMPORAL_ANCHORS;
      let ids: TemporalFixture;

      beforeEach(async () => {
        const store = context.getStore();
        ids = await seedTemporalGraph(store);
      });

      it("reachable defaults to current mode", async () => {
        const store = context.getStore();
        const reached = await store.algorithms.reachable(ids.rootId, {
          edges: ["knows"],
          excludeSource: true,
        });
        const reachedIds = reached.map((r) => r.id).toSorted();
        expect(reachedIds).toEqual([ids.activeId].toSorted());
      });

      it("reachable under asOf surfaces historically-valid rows", async () => {
        const store = context.getStore();
        const reached = await store.algorithms.reachable(ids.rootId, {
          edges: ["knows"],
          excludeSource: true,
          temporalMode: "asOf",
          asOf: BEFORE,
        });
        const reachedIds = reached.map((r) => r.id);
        expect(reachedIds).toContain(ids.activeId);
        expect(reachedIds).toContain(ids.endedId);
        expect(reachedIds).not.toContain(ids.futureId);
      });

      it("exposes WCC through the StoreView algorithms facade", async () => {
        const store = context.getStore();
        const current = await store.algorithms.weaklyConnectedComponents({
          edges: ["knows"],
        });
        const historical = await store
          .asOf(BEFORE)
          .algorithms.weaklyConnectedComponents({ edges: ["knows"] });

        const currentRoot = current.find((row) => row.id === ids.rootId);
        const historicalRoot = historical.find((row) => row.id === ids.rootId);
        expect(currentRoot?.size).toBe(2);
        expect(historicalRoot?.size).toBe(3);
        expect(historical.some((row) => row.id === ids.endedId)).toBe(true);
        expect(historical.some((row) => row.id === ids.futureId)).toBe(false);
      });

      it("exposes label propagation through pinned StoreView coordinates", async () => {
        const store = context.getStore();
        const people = await store.nodes.Person.find(undefined, {
          temporalMode: "includeEnded",
        });
        const active = people.find((person) => person.id === ids.activeId);
        const ended = people.find((person) => person.id === ids.endedId);
        const root = people.find((person) => person.id === ids.rootId);
        if (active === undefined || ended === undefined || root === undefined) {
          throw new Error("Temporal label-propagation fixture is incomplete.");
        }
        const currentThird = await store.nodes.Person.create({
          name: "Current label third",
        });
        await Promise.all([
          store.edges.knows.create(
            active,
            ended,
            {},
            {
              validFrom: TEMPORAL_ANCHORS.PAST,
              validTo: TEMPORAL_ANCHORS.EDGE_ENDED,
            },
          ),
          store.edges.knows.create(root, currentThird, {}),
          store.edges.knows.create(active, currentThird, {}),
        ]);

        const current = await store.algorithms.labelPropagation({
          edges: ["knows"],
          nodeKinds: ["Person"],
        });
        const historicalView = store.asOf(BEFORE);
        const historical = await historicalView.labelPropagation({
          edges: ["knows"],
          nodeKinds: ["Person"],
        });
        await expect(
          historicalView.algorithms.labelPropagation({
            edges: ["knows"],
            nodeKinds: ["Person"],
          }),
        ).resolves.toEqual(historical);

        expect(current.map((row) => row.id).toSorted()).toEqual(
          [ids.activeId, currentThird.id, ids.rootId].toSorted(),
        );
        expect(historical.map((row) => row.id).toSorted()).toEqual(
          [ids.activeId, ids.endedId, ids.rootId].toSorted(),
        );
        expect(new Set(current.map((row) => row.labelId)).size).toBe(1);
        expect(new Set(historical.map((row) => row.labelId)).size).toBe(1);
      });

      it("exposes PageRank through the StoreView algorithms facade", async () => {
        const store = context.getStore();
        const current = await store.algorithms.pageRank({ edges: ["knows"] });
        const historical = await store
          .asOf(BEFORE)
          .algorithms.personalizedPageRank({
            edges: ["knows"],
            seeds: [{ id: ids.rootId, kind: "Person" }],
          });

        expect(current.map((row) => row.id).toSorted()).toEqual(
          [ids.activeId, ids.rootId].toSorted(),
        );
        expect(historical.map((row) => row.id).toSorted()).toEqual(
          [ids.activeId, ids.endedId, ids.rootId].toSorted(),
        );
        expect(
          historical.reduce((total, row) => total + row.score, 0),
        ).toBeCloseTo(1, 10);
      });

      it("reachable under includeEnded includes validity-ended nodes and edges", async () => {
        const store = context.getStore();
        const reached = await store.algorithms.reachable(ids.rootId, {
          edges: ["knows"],
          excludeSource: true,
          temporalMode: "includeEnded",
        });
        const reachedIds = reached.map((r) => r.id).toSorted();
        expect(reachedIds).toEqual(
          [ids.activeId, ids.endedId, ids.futureId].toSorted(),
        );
      });

      it("shortestPath under asOf traverses the historical edge", async () => {
        const store = context.getStore();
        const path = await store.algorithms.shortestPath(
          ids.rootId,
          ids.endedId,
          { edges: ["knows"], temporalMode: "asOf", asOf: BEFORE },
        );
        expect(path?.depth).toBe(1);
        expect(path?.nodes.at(-1)?.id).toBe(ids.endedId);
      });

      it("canReach self-path honors the resolved temporal filter", async () => {
        const store = context.getStore();
        // Future node is not visible under current mode — canReach(a, a)
        // should return false, matching shortestPath(a, a).
        const currentSelf = await store.algorithms.canReach(
          ids.futureId,
          ids.futureId,
          { edges: ["knows"] },
        );
        expect(currentSelf).toBe(false);

        const endedSelf = await store.algorithms.canReach(
          ids.futureId,
          ids.futureId,
          { edges: ["knows"], temporalMode: "includeEnded" },
        );
        expect(endedSelf).toBe(true);
      });

      it("degree honors temporalMode for the edge count", async () => {
        const store = context.getStore();
        // Current mode excludes only the expired root→ended edge. The
        // root→future edge (no explicit validFrom) defaults to "now" at
        // creation, so it's already valid.
        const current = await store.algorithms.degree(ids.rootId, {
          edges: ["knows"],
          direction: "out",
        });
        expect(current).toBe(2);

        // includeEnded lifts the validity filter and counts all three edges.
        const ended = await store.algorithms.degree(ids.rootId, {
          edges: ["knows"],
          direction: "out",
          temporalMode: "includeEnded",
        });
        expect(ended).toBe(3);
      });

      it("rejects temporalMode: 'asOf' without asOf timestamp", async () => {
        const store = context.getStore();
        await expect(
          store.algorithms.reachable(ids.rootId, {
            edges: ["knows"],
            temporalMode: "asOf",
          }),
        ).rejects.toThrow(/asOf/);
      });
    });
  });
}
