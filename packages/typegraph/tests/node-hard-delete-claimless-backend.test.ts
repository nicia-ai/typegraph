/**
 * A port over a bundled backend that leaves the claim members out and
 * declares `constraintClaims: false` issues no claim statement from a node
 * hard delete's cascade.
 *
 * That declaration is how a database without the edge claim relation (one
 * bootstrapped before it existed, never migrated) keeps running a graph that
 * declares no claimed constraint: the store writes no claim, so there is
 * nothing to release, and releasing anyway names a relation that is not
 * there and fails the delete.
 *
 * Backend wiring, not query semantics: the shared suite's SQLite lanes cannot
 * take a capability override, so this runs on better-sqlite3 and PGlite
 * directly, each without the claim relation.
 */
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../src/backend/derive-backend";
import { generateVectorlessPostgresMigrationSQL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { type GraphBackend } from "../src/backend/types";

/** The claim members a claimless port leaves out, with its declaration. */
const CLAIM_MEMBERS = [
  "claimEdgeCardinality",
  "claimEdgeCardinalityBatch",
  "purgeEdgeClaims",
  "hardDeleteUniquesByConcreteKind",
  "claimEdgeCardinalityGuarded",
] as const;

function claimless(backend: GraphBackend): GraphBackend {
  const projected = projectBackendWithout(backend, [...CLAIM_MEMBERS]);
  return deriveBackend(projected, {
    capabilities: { ...backend.capabilities, constraintClaims: false },
  } as never);
}

const Hub = defineNode("NccHub", { schema: z.object({}) });
const Peer = defineNode("NccPeer", { schema: z.object({}) });
const links = defineEdge("nccLinks", { schema: z.object({}) });

/** Declares no claimed constraint, as a claimless backend requires. */
const graph = defineGraph({
  id: "node-hard-delete-claimless",
  nodes: {
    NccHub: { type: Hub, onDelete: "cascade" },
    NccPeer: { type: Peer },
  },
  edges: { nccLinks: { type: links, from: [Hub], to: [Peer] } },
});

type Engine = Readonly<{
  name: string;
  /** A claimless backend over a fresh database without the claim relation. */
  open: () => Promise<
    Readonly<{ backend: GraphBackend; close: () => Promise<void> }>
  >;
}>;

const ENGINES: readonly Engine[] = [
  {
    name: "better-sqlite3",
    open: () => {
      const { backend, db } = createLocalSqliteBackend();
      db.run(sql.raw("DROP TABLE typegraph_edge_claims"));
      return Promise.resolve({ backend, close: () => backend.close() });
    },
  },
  {
    name: "PGlite",
    open: async () => {
      const client = await PGlite.create();
      await client.exec(generateVectorlessPostgresMigrationSQL());
      await client.exec("DROP TABLE typegraph_edge_claims");
      const backend = createPostgresBackend(drizzle(client));
      return {
        backend,
        close: async () => {
          await backend.close();
          await client.close();
        },
      };
    },
  },
];

describe("node hard delete on a backend that declares constraintClaims: false", () => {
  for (const engine of ENGINES) {
    it(`removes nodes whose incident edges are tombstoned without touching the claim relation (${engine.name})`, async () => {
      const opened = await engine.open();
      try {
        const backend = claimless(opened.backend);
        expect(backend.capabilities.constraintClaims).toBe(false);
        const [store] = await createStoreWithSchema(graph, backend);
        const peer = await store.nodes.NccPeer.create({}, { id: "peer" });
        const edgeIds: string[] = [];
        for (const hubId of ["hub-1", "hub-2"]) {
          const hub = await store.nodes.NccHub.create({}, { id: hubId });
          const edge = await store.edges.nccLinks.create(hub, peer, {});
          await store.edges.nccLinks.delete(edge.id);
          edgeIds.push(edge.id);
        }

        await store.nodes.NccHub.hardDelete("hub-1" as never);
        await store.nodes.NccHub.bulkHardDelete(["hub-2"] as never);

        for (const hubId of ["hub-1", "hub-2"]) {
          expect(await backend.getNode(graph.id, "NccHub", hubId)).toBe(
            undefined,
          );
        }
        for (const edgeId of edgeIds) {
          expect(await backend.getEdge(graph.id, edgeId)).toBe(undefined);
        }
      } finally {
        await opened.close();
      }
    });
  }
  // MUTATION CHECK: release claims in the cascade whatever the backend
  // declares — both deletes fail with EDGE_CLAIM_RELATION_MISSING.
});
