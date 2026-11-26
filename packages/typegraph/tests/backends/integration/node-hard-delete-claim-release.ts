/**
 * A node hard delete releases the claim rows of every incident edge it
 * removes, on every backend (#912).
 *
 * A node hard delete removes every incident edge row, live, ended or
 * tombstoned. The store's delete-behavior verdict removes the live ones first
 * and releases their claims; the backend's cascade then removes the rest. Each
 * case seeds one node with one incident edge per claim-holding axis — source
 * `one`, `unique` and `oneActive`, target `one` and `oneActive`, and the
 * relation-wide composition axis — in one state, deletes it through one path,
 * and counts, per claim axis, the claim rows left naming an edge row that no
 * longer exists. The answer is none, on every path.
 *
 * Each case names, in a comment, the mutation that must make it fail.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  partOf,
  RestrictedDeleteError,
} from "../../../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../../../src/backend/derive-backend";
import {
  type HardDeleteNodeParams,
  type TransactionBackend,
} from "../../../src/backend/types";
import { FORMAT_VERSION, importGraph } from "../../../src/interchange";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { compareClaimTargets } from "../../../src/store/claims/axis";
import { requireDefined } from "../../../src/utils/presence";
import { readEdgeClaimRows } from "../../edge-claim-rows";
import {
  prefixedTableNames,
  type TracedStatement,
} from "../../helpers/traced-connection";
import { type IntegrationTestContext } from "./test-context";

const NhcCascadeHub = defineNode("NhcCascadeHub", {
  schema: z.object({ name: z.string() }),
});
const NhcDisconnectHub = defineNode("NhcDisconnectHub", {
  schema: z.object({ name: z.string() }),
});
const NhcRestrictHub = defineNode("NhcRestrictHub", {
  schema: z.object({ name: z.string() }),
});
const NhcPeer = defineNode("NhcPeer", {
  schema: z.object({ name: z.string() }),
});
const NhcLeaf = defineNode("NhcLeaf", {
  schema: z.object({ name: z.string() }),
});

const HUBS = [NhcCascadeHub, NhcDisconnectHub, NhcRestrictHub] as const;

const nhcSourceOne = defineEdge("nhcSourceOne", { schema: z.object({}) });
const nhcSourceUnique = defineEdge("nhcSourceUnique", {
  schema: z.object({}),
});
const nhcSourceOneActive = defineEdge("nhcSourceOneActive", {
  schema: z.object({}),
});
const nhcTargetOne = defineEdge("nhcTargetOne", { schema: z.object({}) });
const nhcTargetOneActive = defineEdge("nhcTargetOneActive", {
  schema: z.object({}),
});
/**
 * Realizes `partOf(NhcLeaf, <hub>)`: holds the composition claim and, as a
 * composition edge must declare `cardinality: "one"`, a source `one` claim.
 */
const nhcLeafOf = defineEdge("nhcLeafOf", { schema: z.object({}) });

/** The hub-to-peer edge kinds, each holding one claim on its own axis. */
const PEER_EDGE_KINDS = [
  "nhcSourceOne",
  "nhcSourceUnique",
  "nhcSourceOneActive",
  "nhcTargetOne",
  "nhcTargetOneActive",
] as const;

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      NhcCascadeHub: { type: NhcCascadeHub, onDelete: "cascade" },
      NhcDisconnectHub: { type: NhcDisconnectHub, onDelete: "disconnect" },
      NhcRestrictHub: { type: NhcRestrictHub, onDelete: "restrict" },
      NhcPeer: { type: NhcPeer, onDelete: "cascade" },
      NhcLeaf: { type: NhcLeaf, onDelete: "cascade" },
    },
    edges: {
      nhcSourceOne: {
        type: nhcSourceOne,
        from: HUBS,
        to: [NhcPeer],
        cardinality: "one",
      },
      nhcSourceUnique: {
        type: nhcSourceUnique,
        from: HUBS,
        to: [NhcPeer],
        cardinality: "unique",
      },
      nhcSourceOneActive: {
        type: nhcSourceOneActive,
        from: HUBS,
        to: [NhcPeer],
        cardinality: "oneActive",
      },
      nhcTargetOne: {
        type: nhcTargetOne,
        from: HUBS,
        to: [NhcPeer],
        targetCardinality: "one",
      },
      nhcTargetOneActive: {
        type: nhcTargetOneActive,
        from: HUBS,
        to: [NhcPeer],
        targetCardinality: "oneActive",
      },
      nhcLeafOf: {
        type: nhcLeafOf,
        from: [NhcLeaf],
        to: HUBS,
        cardinality: "one",
      },
    },
    ontology: HUBS.map((hub) => partOf(NhcLeaf, hub, { via: nhcLeafOf })),
  });
}

type NhcGraph = ReturnType<typeof buildGraph>;
type HubKind = "NhcCascadeHub" | "NhcDisconnectHub" | "NhcRestrictHub";

/**
 * What a seeded incident edge is when the hub is deleted: still live, ended
 * (`validTo` in the past, not deleted) or tombstoned (soft-deleted).
 */
type EdgeState = "live" | "ended" | "tombstoned";

/**
 * Which edges a seed gives the hub: one per hub-to-peer kind and one
 * composition edge, or the composition edge alone (a `restrict` hub keeps
 * live composition edges only, since any other live edge refuses its
 * delete).
 */
type EdgeSet = "all" | "composition";

/** How the hub is hard-deleted. */
type DeletePath = "hardDelete" | "bulkHardDelete" | "bulkHardDelete fallback";

const DELETE_PATHS: readonly DeletePath[] = [
  "hardDelete",
  "bulkHardDelete",
  "bulkHardDelete fallback",
];

type Scenario = Readonly<{
  hub: HubKind;
  state: EdgeState;
  edges: EdgeSet;
}>;

/**
 * Every combination under which a node hard delete removes incident edges:
 * each delete behavior with tombstoned and ended edges, and with live edges
 * under every behavior that removes them (`restrict` removes only live
 * composition edges; any other live edge refuses).
 */
const SCENARIOS: readonly Scenario[] = [
  { hub: "NhcCascadeHub", state: "live", edges: "all" },
  { hub: "NhcCascadeHub", state: "ended", edges: "all" },
  { hub: "NhcCascadeHub", state: "tombstoned", edges: "all" },
  { hub: "NhcDisconnectHub", state: "live", edges: "all" },
  { hub: "NhcDisconnectHub", state: "ended", edges: "all" },
  { hub: "NhcDisconnectHub", state: "tombstoned", edges: "all" },
  { hub: "NhcRestrictHub", state: "live", edges: "composition" },
  { hub: "NhcRestrictHub", state: "tombstoned", edges: "all" },
];

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `node_hard_delete_claims_${graphIdCounter}`;
}

type NhcStore = ReturnType<typeof createStore<NhcGraph>>;

type EdgeCollection = Readonly<{
  create: (
    from: unknown,
    to: unknown,
    props: Record<string, never>,
  ) => Promise<Readonly<{ id: string }>>;
  update: (
    id: string,
    props: Record<string, never>,
    options: Readonly<{ validTo: string }>,
  ) => Promise<unknown>;
  delete: (id: string) => Promise<void>;
}>;

type HubCollection = Readonly<{
  create: (
    props: Readonly<{ name: string }>,
    options: Readonly<{ id: string }>,
  ) => Promise<unknown>;
  hardDelete: (id: string) => Promise<void>;
  bulkHardDelete: (ids: readonly string[]) => Promise<void>;
}>;

function edgeCollection(store: NhcStore, kind: string): EdgeCollection {
  return requireDefined(
    (store.edges as unknown as Record<string, EdgeCollection | undefined>)[
      kind
    ],
  );
}

function hubCollection(store: NhcStore, kind: HubKind): HubCollection {
  return requireDefined(
    (store.nodes as unknown as Record<string, HubCollection | undefined>)[kind],
  );
}

/** Puts one created edge into `state`. */
async function settle(
  collection: EdgeCollection,
  id: string,
  state: EdgeState,
): Promise<void> {
  switch (state) {
    case "live": {
      return;
    }
    case "ended": {
      await collection.update(id, {}, { validTo: new Date().toISOString() });
      return;
    }
    case "tombstoned": {
      await collection.delete(id);
      return;
    }
  }
}

/**
 * Seeds `hubId` of `scenario.hub` with its incident edges, each in
 * `scenario.state`, every one of them on a fresh peer or leaf so each holds
 * its own claim row.
 */
async function seedHub(
  store: NhcStore,
  scenario: Scenario,
  hubId: string,
): Promise<void> {
  await hubCollection(store, scenario.hub).create(
    { name: hubId },
    { id: hubId },
  );
  const hubRef = { kind: scenario.hub, id: hubId };
  if (scenario.edges === "all") {
    for (const kind of PEER_EDGE_KINDS) {
      const peer = await store.nodes.NhcPeer.create(
        { name: `${hubId}-${kind}` },
        { id: `${hubId}-${kind}` },
      );
      const collection = edgeCollection(store, kind);
      const edge = await collection.create(hubRef, peer, {});
      await settle(collection, edge.id, scenario.state);
    }
  }
  const leaf = await store.nodes.NhcLeaf.create(
    { name: `${hubId}-leaf` },
    { id: `${hubId}-leaf` },
  );
  const leafOf = edgeCollection(store, "nhcLeafOf");
  const composition = await leafOf.create(leaf, hubRef, {});
  await settle(leafOf, composition.id, scenario.state);
}

/**
 * The claim rows of this graph whose holder edge row is gone, counted per
 * claim axis (the separator rendered as `/`). Empty when every claim names an
 * edge row that still exists.
 */
async function orphanClaimsByAxis(
  backend: Pick<GraphBackend, "execute" | "tableNames">,
  graphId: string,
): Promise<Readonly<Record<string, number>>> {
  const schema = createSqlSchema(backend.tableNames);
  const rows = await backend.execute<Readonly<{ axis: string }>>(
    asCompiledRowsSql(sql`
      SELECT claims.axis AS axis
      FROM ${sql.identifier(schema.tables.edgeClaims)} claims
      WHERE claims.graph_id = ${graphId}
        AND NOT EXISTS (
          SELECT 1 FROM ${schema.edgesTable} edges
          WHERE edges.graph_id = claims.graph_id
            AND edges.id = claims.edge_id
        )
    `),
  );
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const label = row.axis.replaceAll("\u001E", "/");
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

/** The claim rows of this graph, by axis, for the seed sanity check. */
async function claimAxes(
  backend: Pick<GraphBackend, "execute" | "tableNames">,
  graphId: string,
): Promise<readonly string[]> {
  const rows = await readEdgeClaimRows(backend, graphId);
  return rows.map((row) => row.axis.replaceAll("\u001E", "/")).toSorted();
}

const BATCH_MEMBERS = [
  "hardDeleteNodesBatch",
  "findEdgesConnectedToNodes",
] as const;

class InjectedHardDeleteFailure extends Error {}

/**
 * A custom port over the lane's backend that has no batch members, on the
 * root and on every transaction target, so a node `bulkHardDelete` takes its
 * per-node `hardDeleteNode` fallback; optionally throwing on the
 * `failOnHardDeleteNode`-th `hardDeleteNode` after the real one ran.
 */
function withoutBatchMembers(
  backend: GraphBackend,
  options: Readonly<{ failOnHardDeleteNode?: number }> = {},
): Readonly<{ backend: GraphBackend; hardDeleteNodeCalls: () => number }> {
  let hardDeleteNodeCalls = 0;
  function project<T extends GraphBackend | TransactionBackend>(target: T): T {
    const base = projectBackendWithout(target, [...BATCH_MEMBERS]) as T;
    return deriveBackend(base, {
      async hardDeleteNode(params: HardDeleteNodeParams): Promise<void> {
        hardDeleteNodeCalls += 1;
        await target.hardDeleteNode(params);
        if (hardDeleteNodeCalls === options.failOnHardDeleteNode) {
          throw new InjectedHardDeleteFailure();
        }
      },
    } as never);
  }
  const derived: GraphBackend = deriveBackend(project(backend), {
    transaction: (fn, transactionOptions) =>
      backend.transaction((tx) => fn(project(tx)), transactionOptions),
  });
  return { backend: derived, hardDeleteNodeCalls: () => hardDeleteNodeCalls };
}

const TRACED_TABLES = prefixedTableNames("nhc_trace");

/** How many statements of `statements` delete from the traced claim relation. */
function claimDeleteCount(statements: readonly TracedStatement[]): number {
  return statements.filter((statement) => {
    const text = statement.text.trimStart();
    return (
      text.startsWith("DELETE") &&
      text.includes(`"${TRACED_TABLES.edgeClaims}"`)
    );
  }).length;
}

/**
 * A port whose every transaction target's `hardDeleteNode` runs the real
 * cascade and then throws: a failure after the cascade's statements ran, as a
 * failing claim release would be.
 */
function failingAfterCascade(backend: GraphBackend): GraphBackend {
  function wrap<T extends GraphBackend | TransactionBackend>(target: T): T {
    return deriveBackend(target, {
      async hardDeleteNode(params: HardDeleteNodeParams): Promise<void> {
        await target.hardDeleteNode(params);
        throw new InjectedHardDeleteFailure();
      },
    } as never);
  }
  return deriveBackend(wrap(backend), {
    transaction: (fn, transactionOptions) =>
      backend.transaction((tx) => fn(wrap(tx)), transactionOptions),
  });
}

const NhcPart = defineNode("NhcPart", {
  schema: z.object({ code: z.string() }),
});
const NhcWhole = defineNode("NhcWhole", { schema: z.object({}) });
const NhcTag = defineNode("NhcTag", { schema: z.object({}) });
const nhcPartOf = defineEdge("nhcPartOf", { schema: z.object({}) });
const nhcTagged = defineEdge("nhcTagged", { schema: z.object({}) });

/** A required composition, for import's purge of a refused part. */
function requiredPartGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      NhcPart: {
        type: NhcPart,
        unique: [
          {
            name: "nhc_part_code",
            fields: ["code"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      NhcWhole: { type: NhcWhole },
      NhcTag: { type: NhcTag },
    },
    edges: {
      nhcPartOf: {
        type: nhcPartOf,
        from: [NhcPart],
        to: [NhcWhole],
        cardinality: "one",
      },
      nhcTagged: { type: nhcTagged, from: [NhcTag], to: [NhcPart] },
    },
    ontology: [
      partOf(NhcPart, NhcWhole, { via: nhcPartOf, existence: "required" }),
    ],
  });
}

function describeScenario(scenario: Scenario): string {
  const edges =
    scenario.edges === "all" ? "every claim axis" : "the composition axis";
  return `${scenario.hub} with ${scenario.state} incident edges on ${edges}`;
}

export function registerNodeHardDeleteClaimReleaseIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("node hard delete releases the claims of the incident edges it removes (#912)", () => {
    for (const path of DELETE_PATHS) {
      for (const scenario of SCENARIOS) {
        it(`${path}: ${describeScenario(scenario)}`, async () => {
          const graphId = nextGraphId();
          const seeded = await context.createStore(buildGraph(graphId));
          await seedHub(seeded, scenario, "hub-1");
          await seedHub(seeded, scenario, "hub-2");

          // Every seeded edge holds its claim before the delete (a born-live
          // `oneActive` edge ended by update keeps it until taken over).
          const seededAxes = await claimAxes(seeded.backend, graphId);
          const perHub = scenario.edges === "all" ? 7 : 2;
          expect(seededAxes).toHaveLength(perHub * 2);
          expect(await orphanClaimsByAxis(seeded.backend, graphId)).toEqual({});

          const store =
            path === "bulkHardDelete fallback" ?
              createStore(
                buildGraph(graphId),
                withoutBatchMembers(seeded.backend).backend,
              )
            : seeded;
          const hubs = hubCollection(store, scenario.hub);
          if (path === "hardDelete") {
            await hubs.hardDelete("hub-1");
          } else {
            await hubs.bulkHardDelete(["hub-1"]);
          }

          expect(
            await seeded.backend.getNode(graphId, scenario.hub, "hub-1"),
          ).toBeUndefined();
          expect(await orphanClaimsByAxis(seeded.backend, graphId)).toEqual({});
          // hub-2's claims are untouched: the release is keyed by the edges
          // the delete removed, not by kind or axis.
          expect(await claimAxes(seeded.backend, graphId)).toHaveLength(perHub);
        });
      }
    }
    // MUTATION CHECK: drop the claim purge from `hardDeleteNode` /
    // `hardDeleteNodesBatch` in `operation-backend-core.ts` — every ended and
    // tombstoned case leaves one orphan per seeded axis of hub-1.

    it("the per-node fallback of a custom port without the batch members leaves no partial write when a later node fails", async () => {
      const graphId = nextGraphId();
      const seeded = await context.createStore(buildGraph(graphId));
      const scenario: Scenario = {
        hub: "NhcCascadeHub",
        state: "tombstoned",
        edges: "all",
      };
      await seedHub(seeded, scenario, "hub-1");
      await seedHub(seeded, scenario, "hub-2");
      const claimsBefore = await readEdgeClaimRows(seeded.backend, graphId);

      // The first `hardDeleteNode` runs; the second removes hub-2's rows and
      // claims, then throws. The batch's one transaction rolls both back.
      const failing = withoutBatchMembers(seeded.backend, {
        failOnHardDeleteNode: 2,
      });
      await expect(
        createStore(
          buildGraph(graphId),
          failing.backend,
        ).nodes.NhcCascadeHub.bulkHardDelete(["hub-1", "hub-2"] as never),
      ).rejects.toBeInstanceOf(InjectedHardDeleteFailure);
      expect(failing.hardDeleteNodeCalls()).toBe(2);
      expect(await readEdgeClaimRows(seeded.backend, graphId)).toEqual(
        claimsBefore,
      );
      for (const hubId of ["hub-1", "hub-2"]) {
        expect(
          await seeded.backend.getNode(graphId, "NhcCascadeHub", hubId),
        ).toBeDefined();
      }

      const fallback = withoutBatchMembers(seeded.backend);
      await createStore(
        buildGraph(graphId),
        fallback.backend,
      ).nodes.NhcCascadeHub.bulkHardDelete(["hub-1", "hub-2"] as never);
      expect(fallback.hardDeleteNodeCalls()).toBe(2);
      expect(await readEdgeClaimRows(seeded.backend, graphId)).toEqual([]);
    });
    // MUTATION CHECK: as above; the final assertion sees hub-1's and hub-2's
    // tombstoned edges' claims left behind.

    it("runs one claim DELETE when the cascade removes incident edges and none when it removes nothing", async () => {
      const connection = await context.openTracedConnection([TRACED_TABLES]);
      try {
        const graphId = nextGraphId();
        const [store] = await createAdapterStoreWithSchema(
          buildGraph(graphId),
          connection.backends[0] as never,
        );
        const tombstoned: Scenario = {
          hub: "NhcCascadeHub",
          state: "tombstoned",
          edges: "all",
        };
        for (const hubId of ["edged-1", "edged-2"]) {
          await seedHub(store, tombstoned, hubId);
        }
        for (const hubId of ["bare-1", "bare-2"]) {
          await store.nodes.NhcCascadeHub.create(
            { name: hubId },
            { id: hubId },
          );
        }
        const counts: Record<string, number> = {};
        const hubs = store.nodes.NhcCascadeHub;
        const runs = [
          ["hardDelete bare", () => hubs.hardDelete("bare-1" as never)],
          [
            "bulkHardDelete bare",
            () => hubs.bulkHardDelete(["bare-2"] as never),
          ],
          ["hardDelete edged", () => hubs.hardDelete("edged-1" as never)],
          [
            "bulkHardDelete edged",
            () => hubs.bulkHardDelete(["edged-2"] as never),
          ],
        ] as const;
        for (const [name, run] of runs) {
          connection.reset();
          await run();
          counts[name] = claimDeleteCount(connection.statements());
        }
        expect(counts).toEqual({
          "hardDelete bare": 0,
          "bulkHardDelete bare": 0,
          "hardDelete edged": 1,
          "bulkHardDelete edged": 1,
        });
      } finally {
        await connection.close();
      }
    });
    // MUTATION CHECK: drop the release from the cascades in
    // `operation-backend-core.ts` — the edged deletes run no claim DELETE.
    // The bare counts hold the other side: a release that ran whatever the
    // edge DELETE returned would show one there.

    it("import keeps a refused required part whole when its purge fails part-way", async () => {
      const graphId = nextGraphId();
      const seeded = await context.createStore(requiredPartGraph(graphId));
      await seeded.nodes.NhcTag.create({}, { id: "t1" });
      const store = createStore(
        requiredPartGraph(graphId),
        failingAfterCascade(seeded.backend),
      );
      // p1 is written with a composition edge that attaches nothing and a tag
      // edge onto it, then refused and purged; the purge fails after the
      // cascade removed p1's rows.
      const result = await importGraph(
        store,
        {
          formatVersion: FORMAT_VERSION,
          exportedAt: "2026-01-01T00:00:00.000Z",
          source: { type: "external", description: "failing purge" },
          nodes: [{ kind: "NhcPart", id: "p1", properties: { code: "c1" } }],
          edges: [
            {
              kind: "nhcPartOf",
              id: "po-1",
              from: { kind: "NhcPart", id: "p1" },
              to: { kind: "NhcWhole", id: "w-missing" },
              properties: {},
            },
            {
              kind: "nhcTagged",
              id: "tag-1",
              from: { kind: "NhcTag", id: "t1" },
              to: { kind: "NhcPart", id: "p1" },
              properties: {},
            },
          ],
        },
        {
          onConflict: "error",
          onUnknownProperty: "error",
          validateReferences: false,
          batchSize: 100,
          refreshStatistics: false,
        },
      );

      expect(result.errors).toEqual([
        expect.objectContaining({ entityType: "node", id: "p1" }),
      ]);
      // The failed purge left the part, its edges, their claims and its
      // uniqueness entry exactly as the import wrote them.
      expect(await seeded.backend.getNode(graphId, "NhcPart", "p1")).toEqual(
        expect.objectContaining({ id: "p1" }),
      );
      for (const edgeId of ["po-1", "tag-1"]) {
        expect(await seeded.backend.getEdge(graphId, edgeId)).toEqual(
          expect.objectContaining({ id: edgeId }),
        );
      }
      const claimsAfter = await readEdgeClaimRows(seeded.backend, graphId);
      expect(claimsAfter.map((row) => row.edge_id)).toEqual(["po-1", "po-1"]);
      await expect(
        seeded.nodes.NhcPart.create({ code: "c1" }, { id: "p2" }),
      ).rejects.toThrow();
    });
    // MUTATION CHECK: call `frame.session.purgeNode` directly in
    // `purgeUnattachedRequiredPart` instead of through `purgeAsUnit` — the
    // row error is recorded while p1's node row, edges, claims and uniqueness
    // entry are gone.

    it("orders claim targets as the database orders the claim relation", async () => {
      // Code-unit order puts the astral character's surrogate pair below
      // U+E000; code-point order, which the database's claim-target ORDER BY
      // uses, puts it above. A purge and a claim writer that disagree lock
      // the same two rows in opposite orders.
      const keys = ["\u{10000}", "\uE000", "a"];
      const graphId = nextGraphId();
      const store = await context.createStore(buildGraph(graphId));
      const schema = createSqlSchema(store.backend.tableNames);
      for (const key of keys) {
        await store.backend.execute(
          asCompiledRowsSql(sql`
            INSERT INTO ${sql.identifier(schema.tables.edgeClaims)}
              (graph_id, axis, "key", edge_id, updated_at)
            VALUES (${graphId}, 'axis', ${key}, ${`e-${key}`}, '2026-01-01T00:00:00.000Z')
            RETURNING "key"
          `),
        );
      }
      const claimOrder = keys.toSorted((left, right) =>
        compareClaimTargets(
          { relation: "edgeClaims", graphId, axis: "axis", key: left },
          { relation: "edgeClaims", graphId, axis: "axis", key: right },
        ),
      );
      // The order the purge's ORDER BY locks in: byte (code-point) order,
      // `COLLATE "C"` on PostgreSQL and the BINARY default on SQLite.
      const orderedRows = await store.backend.execute<
        Readonly<{ key: string }>
      >(
        asCompiledRowsSql(sql`
          SELECT "key" FROM ${sql.identifier(schema.tables.edgeClaims)}
          WHERE graph_id = ${graphId}
          ORDER BY ${sql.raw(store.backend.dialect === "postgres" ? '"key" COLLATE "C"' : '"key"')}
        `),
      );
      const databaseOrder = orderedRows.map((row) => row.key);
      expect(claimOrder).toEqual(databaseOrder);
      expect(databaseOrder).toEqual(["a", "\uE000", "\u{10000}"]);
    });
    // MUTATION CHECK: compare with `compareStrings` (UTF-16 code units) in
    // `compareClaimTargets` — the astral key sorts first in JS and last in
    // the database.

    it("a refused batch releases no claim", async () => {
      const graphId = nextGraphId();
      const store = await context.createStore(buildGraph(graphId));
      await seedHub(
        store,
        { hub: "NhcRestrictHub", state: "tombstoned", edges: "all" },
        "hub-1",
      );
      await seedHub(
        store,
        { hub: "NhcRestrictHub", state: "live", edges: "all" },
        "hub-2",
      );
      const claimsBefore = await readEdgeClaimRows(store.backend, graphId);
      expect(claimsBefore).toHaveLength(14);

      await expect(
        store.nodes.NhcRestrictHub.bulkHardDelete(["hub-1", "hub-2"] as never),
      ).rejects.toBeInstanceOf(RestrictedDeleteError);
      expect(await readEdgeClaimRows(store.backend, graphId)).toEqual(
        claimsBefore,
      );
      expect(
        await store.backend.getNode(graphId, "NhcRestrictHub", "hub-1"),
      ).toBeDefined();
    });
  });
}
